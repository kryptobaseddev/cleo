/**
 * SQLite-based implementation of the DataAccessor interface.
 *
 * Materializes TaskFile/ArchiveFile/SessionsFile from SQLite tables,
 * allowing core modules to continue using whole-file data structures
 * while storage is backed by the relational database.
 *
 * Uses existing sqlite.ts engine (node:sqlite / drizzle-orm) and
 * task-store.ts / session-store.ts for row-level operations.
 *
 * @epic T4454
 */

import { eq, ne } from 'drizzle-orm';
import type { DataAccessor, ArchiveFile, SessionsFile } from './data-accessor.js';
import type { TaskFile, Task, ProjectMeta, TaskWorkState, FileMeta } from '../types/task.js';
import type { Session } from '../types/session.js';
import type { ArchiveFields } from './db-helpers.js';
import { getDb, closeDb } from './sqlite.js';
import * as schema from './schema.js';
import { computeChecksum } from './json.js';
import { rowToTask, taskToRow, archivedTaskToRow, rowToSession } from './converters.js';
import { upsertTask, upsertSession, updateDependencies, loadDependenciesForTasks } from './db-helpers.js';

/**
 * Generate a unique audit log entry ID.
 * @task T4837
 */
function generateAuditLogId(): string {
  const epoch = Math.floor(Date.now() / 1000);
  const rand = Math.random().toString(36).slice(2, 8);
  return `log-${epoch}-${rand}`;
}

// ---- Schema meta helpers ----

/** Read a JSON blob from the schema_meta table by key. */
async function getMetaValue<T>(cwd: string | undefined, key: string): Promise<T | null> {
  const db = await getDb(cwd);
  const rows = await db
    .select()
    .from(schema.schemaMeta)
    .where(eq(schema.schemaMeta.key, key))
    .all();
  if (rows.length === 0 || !rows[0]) return null;
  try {
    return JSON.parse(rows[0].value) as T;
  } catch {
    return null;
  }
}

/** Write a JSON blob to the schema_meta table by key. */
export async function setMetaValue(cwd: string | undefined, key: string, value: unknown): Promise<void> {
  const db = await getDb(cwd);
  const json = JSON.stringify(value);
  await db.insert(schema.schemaMeta)
    .values({ key, value: json })
    .onConflictDoUpdate({
      target: schema.schemaMeta.key,
      set: { value: json },
    })
    .run();
}

// ---- Default structures ----

const DEFAULT_PROJECT_META: ProjectMeta = {
  name: 'project',
  currentPhase: null,
  phases: {},
  phaseHistory: [],
  releases: [],
};

const DEFAULT_FILE_META: FileMeta = {
  schemaVersion: '2.10.0',
  checksum: '',
  configVersion: '1.0.0',
};

const DEFAULT_WORK_STATE: TaskWorkState = {
  currentTask: null,
  currentPhase: null,
  blockedUntil: null,
  sessionNote: null,
  sessionNotes: [],
  nextAction: null,
  primarySession: null,
};

// ---- Accessor factory ----

/**
 * Create a SQLite-backed DataAccessor.
 *
 * Opens (or creates) the SQLite database at `.cleo/tasks.db` and returns
 * a DataAccessor that materializes/dematerializes whole-file structures
 * from the relational tables.
 *
 * @param cwd - Working directory for path resolution (defaults to process.cwd())
 */
export async function createSqliteDataAccessor(cwd?: string): Promise<DataAccessor> {
  // Eagerly initialize the database to ensure tables exist
  await getDb(cwd);

  const accessor: DataAccessor = {
    engine: 'sqlite' as const,

    // ---- loadTaskFile ----

    async loadTaskFile(): Promise<TaskFile> {
      const db = await getDb(cwd);

      // 1. Query all non-archived tasks
      const taskRows = await db
        .select()
        .from(schema.tasks)
        .where(ne(schema.tasks.status, 'archived'))
        .all();

      const tasks: Task[] = taskRows.map(rowToTask);

      // 2. Load dependencies for all tasks (batch query), filtering orphaned refs
      if (tasks.length > 0) {
        await loadDependenciesForTasks(db, tasks);
      }

      // 3. Load project metadata from schema_meta
      const projectMeta =
        (await getMetaValue<ProjectMeta>(cwd, 'project_meta')) ?? DEFAULT_PROJECT_META;

      // 4. Load work state from schema_meta
      const workState =
        (await getMetaValue<TaskWorkState>(cwd, 'focus_state')) ?? DEFAULT_WORK_STATE;

      // 5. Load labels from schema_meta
      const labels =
        (await getMetaValue<Record<string, string[]>>(cwd, 'labels')) ?? undefined;

      // 6. Load file meta from schema_meta
      const storedMeta = await getMetaValue<FileMeta>(cwd, 'file_meta');

      // 7. Compute checksum over task data
      const checksum = computeChecksum(tasks);

      const fileMeta: FileMeta = {
        ...(storedMeta ?? DEFAULT_FILE_META),
        checksum,
      };

      // 8. Build and return the TaskFile
      const taskFile: TaskFile = {
        version: storedMeta?.schemaVersion ?? DEFAULT_FILE_META.schemaVersion,
        project: projectMeta,
        lastUpdated: new Date().toISOString(),
        _meta: fileMeta,
        focus: workState,
        tasks,
      };

      if (labels) {
        taskFile.labels = labels;
      }

      return taskFile;
    },

    // ---- saveTaskFile ----

    async saveTaskFile(data: TaskFile): Promise<void> {
      const db = await getDb(cwd);

      // 1. Determine which task IDs are in the incoming data
      const incomingIds = new Set(data.tasks.map((t) => t.id));

      // 2. Get existing non-archived task IDs from DB
      const existingRows = await db
        .select({ id: schema.tasks.id })
        .from(schema.tasks)
        .where(ne(schema.tasks.status, 'archived'))
        .all();
      const existingIds = new Set(existingRows.map((r) => r.id));

      // 3. Delete tasks that are in DB but NOT in incoming data (non-archived only)
      for (const eid of existingIds) {
        if (!incomingIds.has(eid)) {
          await db.delete(schema.taskDependencies)
            .where(eq(schema.taskDependencies.taskId, eid))
            .run();
          await db.delete(schema.tasks).where(eq(schema.tasks.id, eid)).run();
        }
      }

      // 4. Upsert all tasks from data.tasks
      for (const task of data.tasks) {
        const row = taskToRow(task);
        await upsertTask(db, row);
        await updateDependencies(db, task.id, task.depends ?? [], incomingIds);
      }

      // 5. Store project metadata, focus state, labels, and file meta in schema_meta
      await setMetaValue(cwd, 'project_meta', data.project);
      if (data.focus) {
        await setMetaValue(cwd, 'focus_state', data.focus);
      }
      if (data.labels) {
        await setMetaValue(cwd, 'labels', data.labels);
      }
      await setMetaValue(cwd, 'file_meta', {
        ...data._meta,
        checksum: computeChecksum(data.tasks),
      });
    },

    // ---- loadArchive ----

    async loadArchive(): Promise<ArchiveFile | null> {
      const db = await getDb(cwd);

      // Query tasks where status = 'archived'
      const archivedRows = await db
        .select()
        .from(schema.tasks)
        .where(eq(schema.tasks.status, 'archived'))
        .all();

      if (archivedRows.length === 0) return null;

      const archivedTasks: Task[] = archivedRows.map((row) => {
        const task = rowToTask(row);
        // Restore the original terminal status for the archive representation
        // but keep the archived metadata accessible
        return {
          ...task,
          // In archive files, tasks retain their pre-archive status if available,
          // but since we store as 'archived' in DB, use the archived info
          archivedAt: row.archivedAt ?? undefined,
          archiveReason: row.archiveReason ?? undefined,
          cycleTimeDays: row.cycleTimeDays ?? undefined,
        } as Task & { archivedAt?: string; archiveReason?: string; cycleTimeDays?: number };
      });

      // Load dependencies for archived tasks, filtering orphaned refs
      if (archivedTasks.length > 0) {
        // Also load all active task IDs so we can validate cross-references
        const activeRows = await db
          .select({ id: schema.tasks.id })
          .from(schema.tasks)
          .where(ne(schema.tasks.status, 'archived'))
          .all();
        const allKnownIds = new Set([
          ...archivedTasks.map(t => t.id),
          ...activeRows.map(r => r.id),
        ]);
        await loadDependenciesForTasks(db, archivedTasks, allKnownIds);
      }

      return {
        archivedTasks,
        version: '1.0.0',
      };
    },

    // ---- saveArchive ----

    async saveArchive(data: ArchiveFile): Promise<void> {
      const db = await getDb(cwd);

      // Pre-compute archive IDs + active task IDs for dependency validation
      const archiveIds = new Set(data.archivedTasks.map(t => t.id));
      const activeRows = await db
        .select({ id: schema.tasks.id })
        .from(schema.tasks)
        .where(ne(schema.tasks.status, 'archived'))
        .all();
      const validDepIds = new Set([...archiveIds, ...activeRows.map(r => r.id)]);

      for (const task of data.archivedTasks) {
        const row = archivedTaskToRow(task);

        // Extract archive-specific fields if they exist on the task object
        const taskAny = task as Task & {
          archivedAt?: string;
          archiveReason?: string;
          cycleTimeDays?: number;
        };

        const archiveFields = {
          archivedAt: taskAny.archivedAt ?? row.completedAt ?? new Date().toISOString(),
          archiveReason: taskAny.archiveReason ?? 'completed',
          cycleTimeDays: taskAny.cycleTimeDays ?? null,
        };

        await upsertTask(db, row, archiveFields);
        await updateDependencies(db, task.id, task.depends ?? [], validDepIds);
      }
    },

    // ---- loadSessions ----

    async loadSessions(): Promise<SessionsFile> {
      const db = await getDb(cwd);

      const sessionRows = await db.select().from(schema.sessions).all();
      const sessions: Session[] = sessionRows.map(rowToSession);

      return {
        sessions,
        version: '1.0.0',
        _meta: { schemaVersion: '1.0.0', lastUpdated: new Date().toISOString() },
      };
    },

    // ---- saveSessions ----

    async saveSessions(data: SessionsFile): Promise<void> {
      const db = await getDb(cwd);

      // Get existing session IDs
      const existingRows = await db.select({ id: schema.sessions.id }).from(schema.sessions).all();
      const existingIds = new Set(existingRows.map((r) => r.id));
      const incomingIds = new Set(data.sessions.map((s) => s.id));

      // Delete sessions that are no longer in the data
      for (const eid of existingIds) {
        if (!incomingIds.has(eid)) {
          await db.delete(schema.sessions).where(eq(schema.sessions.id, eid)).run();
        }
      }

      // Upsert all sessions
      for (const session of data.sessions) {
        await upsertSession(db, session);
      }
    },

    // ---- appendLog ----

    async appendLog(entry: Record<string, unknown>): Promise<void> {
      const db = await getDb(cwd);
      await db.insert(schema.auditLog).values({
        id: (entry.id as string) ?? generateAuditLogId(),
        timestamp: (entry.timestamp as string) ?? new Date().toISOString(),
        action: (entry.action as string) ?? (entry.operation as string) ?? 'unknown',
        taskId: (entry.taskId as string) ?? 'unknown',
        actor: (entry.actor as string) ?? 'system',
        detailsJson: entry.details ? JSON.stringify(entry.details) : '{}',
        beforeJson: entry.before ? JSON.stringify(entry.before) : null,
        afterJson: entry.after ? JSON.stringify(entry.after) : null,
      }).run();
    },

    // ---- Fine-grained task operations (T5034) ----

    async upsertSingleTask(task: Task): Promise<void> {
      const db = await getDb(cwd);
      const row = taskToRow(task);
      await upsertTask(db, row);
      await updateDependencies(db, task.id, task.depends ?? []);
    },

    async archiveSingleTask(taskId: string, fields: ArchiveFields): Promise<void> {
      const db = await getDb(cwd);
      // Verify the task exists before archiving
      const rows = await db.select({ id: schema.tasks.id }).from(schema.tasks)
        .where(eq(schema.tasks.id, taskId))
        .all();
      if (rows.length === 0) return;
      await db.update(schema.tasks)
        .set({
          status: 'archived',
          archivedAt: fields.archivedAt ?? new Date().toISOString(),
          archiveReason: fields.archiveReason ?? 'completed',
          cycleTimeDays: fields.cycleTimeDays ?? null,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(schema.tasks.id, taskId))
        .run();
    },

    async removeSingleTask(taskId: string): Promise<void> {
      const db = await getDb(cwd);
      // Delete dependencies first (both directions)
      await db.delete(schema.taskDependencies)
        .where(eq(schema.taskDependencies.taskId, taskId))
        .run();
      await db.delete(schema.taskDependencies)
        .where(eq(schema.taskDependencies.dependsOn, taskId))
        .run();
      // Delete the task itself
      await db.delete(schema.tasks)
        .where(eq(schema.tasks.id, taskId))
        .run();
    },

    // ---- close ----

    async close(): Promise<void> {
      closeDb();
    },

    // ---- Metadata ----

    async getMetaValue<T>(key: string): Promise<T | null> {
      return getMetaValue<T>(cwd, key);
    },

    async setMetaValue(key: string, value: unknown): Promise<void> {
      return setMetaValue(cwd, key, value);
    },

    async getSchemaVersion(): Promise<string | null> {
      const meta = await getMetaValue<{ schemaVersion?: string }>(cwd, 'file_meta');
      return meta?.schemaVersion ?? null;
    },

  };

  return accessor;
}
