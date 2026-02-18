/**
 * SQLite-based implementation of the DataAccessor interface.
 *
 * Materializes TodoFile/ArchiveFile/SessionsFile from SQLite tables,
 * allowing core modules to continue using whole-file data structures
 * while storage is backed by the relational database.
 *
 * Uses existing sqlite.ts engine (sql.js / drizzle-orm) and
 * task-store.ts / session-store.ts for row-level operations.
 *
 * @epic T4454
 */

import { eq, ne } from 'drizzle-orm';
import type { DataAccessor, ArchiveFile, SessionsFile } from './data-accessor.js';
import type { TodoFile, Task, ProjectMeta, FocusState, FileMeta } from '../types/task.js';
import type { Session } from '../types/session.js';
import { getDb, saveToFile, closeDb } from './sqlite.js';
import * as schema from './schema.js';
import { appendJsonl, saveJson, computeChecksum } from './json.js';
import { getTodoPath, getLogPath, getBackupDir } from '../core/paths.js';

// ---- Schema meta helpers ----

/** Read a JSON blob from the schema_meta table by key. */
async function getMetaValue<T>(cwd: string | undefined, key: string): Promise<T | null> {
  const db = await getDb(cwd);
  const rows = db
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
async function setMetaValue(cwd: string | undefined, key: string, value: unknown): Promise<void> {
  const db = await getDb(cwd);
  const json = JSON.stringify(value);
  db.insert(schema.schemaMeta)
    .values({ key, value: json })
    .onConflictDoUpdate({
      target: schema.schemaMeta.key,
      set: { value: json },
    })
    .run();
}

// ---- Row <-> Domain conversion ----

/** Convert a database TaskRow to a domain Task. */
function rowToTask(row: schema.TaskRow): Task {
  return {
    id: row.id,
    title: row.title,
    status: row.status as Task['status'],
    priority: row.priority as Task['priority'],
    type: (row.type as Task['type']) ?? undefined,
    parentId: row.parentId ?? undefined,
    phase: row.phase ?? undefined,
    size: (row.size as Task['size']) ?? undefined,
    position: row.position ?? undefined,
    positionVersion: row.positionVersion ?? undefined,
    description: row.description ?? undefined,
    labels: safeParseJsonArray(row.labelsJson),
    notes: safeParseJsonArray(row.notesJson),
    acceptance: safeParseJsonArray(row.acceptanceJson),
    files: safeParseJsonArray(row.filesJson),
    depends: undefined, // Populated separately from task_dependencies
    origin: (row.origin as Task['origin']) ?? undefined,
    blockedBy: row.blockedBy ?? undefined,
    epicLifecycle: (row.epicLifecycle as Task['epicLifecycle']) ?? undefined,
    noAutoComplete: row.noAutoComplete ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt ?? undefined,
    completedAt: row.completedAt ?? undefined,
    cancelledAt: row.cancelledAt ?? undefined,
    cancellationReason: row.cancellationReason ?? undefined,
    verification: row.verificationJson ? safeParseJson(row.verificationJson) : undefined,
    provenance:
      row.createdBy || row.modifiedBy || row.sessionId
        ? {
            createdBy: row.createdBy ?? null,
            modifiedBy: row.modifiedBy ?? null,
            sessionId: row.sessionId ?? null,
          }
        : undefined,
  };
}

/** Convert a domain Task to a database row for insert/upsert. */
function taskToRow(task: Task): schema.NewTaskRow {
  return {
    id: task.id,
    title: task.title,
    description: task.description ?? null,
    status: task.status,
    priority: task.priority,
    type: task.type ?? null,
    parentId: task.parentId ?? null,
    phase: task.phase ?? null,
    size: task.size ?? null,
    position: task.position ?? null,
    positionVersion: task.positionVersion ?? 0,
    labelsJson: task.labels ? JSON.stringify(task.labels) : '[]',
    notesJson: task.notes ? JSON.stringify(task.notes) : '[]',
    acceptanceJson: task.acceptance ? JSON.stringify(task.acceptance) : '[]',
    filesJson: task.files ? JSON.stringify(task.files) : '[]',
    origin: task.origin ?? null,
    blockedBy: task.blockedBy ?? null,
    epicLifecycle: task.epicLifecycle ?? null,
    noAutoComplete: task.noAutoComplete ?? null,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt ?? null,
    completedAt: task.completedAt ?? null,
    cancelledAt: task.cancelledAt ?? null,
    cancellationReason: task.cancellationReason ?? null,
    verificationJson: task.verification ? JSON.stringify(task.verification) : null,
    createdBy: task.provenance?.createdBy ?? null,
    modifiedBy: task.provenance?.modifiedBy ?? null,
    sessionId: task.provenance?.sessionId ?? null,
  };
}

/** Convert a domain Task to a row suitable for archived tasks. */
function archivedTaskToRow(task: Task): schema.NewTaskRow {
  const row = taskToRow(task);
  // Ensure archived status and metadata
  row.status = 'archived';
  if (!(row as Record<string, unknown>)['archivedAt']) {
    (row as Record<string, unknown>)['archivedAt'] = task.completedAt ?? new Date().toISOString();
  }
  return row;
}

/** Convert a SessionRow to a domain Session. */
function rowToSession(row: schema.SessionRow): Session {
  return {
    id: row.id,
    name: row.name,
    status: row.status as Session['status'],
    scope: safeParseJson(row.scopeJson) ?? { type: 'global' as const },
    focus: {
      taskId: row.currentFocus ?? null,
      setAt: row.focusSetAt ?? null,
    },
    startedAt: row.startedAt,
    endedAt: row.endedAt ?? undefined,
    agent: row.agent ?? undefined,
    notes: safeParseJsonArray(row.notesJson),
    tasksCompleted: safeParseJsonArray(row.tasksCompletedJson),
    tasksCreated: safeParseJsonArray(row.tasksCreatedJson),
  };
}

// ---- JSON parse helpers ----

function safeParseJson<T>(str: string | null | undefined): T | undefined {
  if (!str) return undefined;
  try {
    return JSON.parse(str) as T;
  } catch {
    return undefined;
  }
}

function safeParseJsonArray<T = string>(str: string | null | undefined): T[] | undefined {
  if (!str) return undefined;
  try {
    const arr = JSON.parse(str);
    if (Array.isArray(arr) && arr.length === 0) return undefined;
    return arr as T[];
  } catch {
    return undefined;
  }
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

const DEFAULT_FOCUS_STATE: FocusState = {
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

  return {
    engine: 'sqlite' as const,

    // ---- loadTodoFile ----

    async loadTodoFile(): Promise<TodoFile> {
      const db = await getDb(cwd);

      // 1. Query all non-archived tasks
      const taskRows = db
        .select()
        .from(schema.tasks)
        .where(ne(schema.tasks.status, 'archived'))
        .all();

      const tasks: Task[] = taskRows.map(rowToTask);

      // 2. Load dependencies for all tasks (batch query)
      if (tasks.length > 0) {
        const taskIds = tasks.map((t) => t.id);
        const allDeps = db.select().from(schema.taskDependencies).all();

        // Build lookup: taskId -> [dependsOn]
        const depMap = new Map<string, string[]>();
        for (const dep of allDeps) {
          if (taskIds.includes(dep.taskId)) {
            let arr = depMap.get(dep.taskId);
            if (!arr) {
              arr = [];
              depMap.set(dep.taskId, arr);
            }
            arr.push(dep.dependsOn);
          }
        }

        for (const task of tasks) {
          const deps = depMap.get(task.id);
          if (deps && deps.length > 0) {
            task.depends = deps;
          }
        }
      }

      // 3. Load project metadata from schema_meta
      const projectMeta =
        (await getMetaValue<ProjectMeta>(cwd, 'project_meta')) ?? DEFAULT_PROJECT_META;

      // 4. Load focus state from schema_meta
      const focusState =
        (await getMetaValue<FocusState>(cwd, 'focus_state')) ?? DEFAULT_FOCUS_STATE;

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

      // 8. Build and return the TodoFile
      const todoFile: TodoFile = {
        version: storedMeta?.schemaVersion ?? DEFAULT_FILE_META.schemaVersion,
        project: projectMeta,
        lastUpdated: new Date().toISOString(),
        _meta: fileMeta,
        focus: focusState,
        tasks,
      };

      if (labels) {
        todoFile.labels = labels;
      }

      return todoFile;
    },

    // ---- saveTodoFile ----

    async saveTodoFile(data: TodoFile): Promise<void> {
      const db = await getDb(cwd);

      // 1. Determine which task IDs are in the incoming data
      const incomingIds = new Set(data.tasks.map((t) => t.id));

      // 2. Get existing non-archived task IDs from DB
      const existingRows = db
        .select({ id: schema.tasks.id })
        .from(schema.tasks)
        .where(ne(schema.tasks.status, 'archived'))
        .all();
      const existingIds = new Set(existingRows.map((r) => r.id));

      // 3. Delete tasks that are in DB but NOT in incoming data (non-archived only)
      for (const eid of existingIds) {
        if (!incomingIds.has(eid)) {
          db.delete(schema.taskDependencies)
            .where(eq(schema.taskDependencies.taskId, eid))
            .run();
          db.delete(schema.tasks).where(eq(schema.tasks.id, eid)).run();
        }
      }

      // 4. Upsert all tasks from data.tasks
      for (const task of data.tasks) {
        const row = taskToRow(task);
        db.insert(schema.tasks)
          .values(row)
          .onConflictDoUpdate({
            target: schema.tasks.id,
            set: {
              title: row.title,
              description: row.description,
              status: row.status,
              priority: row.priority,
              type: row.type,
              parentId: row.parentId,
              phase: row.phase,
              size: row.size,
              position: row.position,
              positionVersion: row.positionVersion,
              labelsJson: row.labelsJson,
              notesJson: row.notesJson,
              acceptanceJson: row.acceptanceJson,
              filesJson: row.filesJson,
              origin: row.origin,
              blockedBy: row.blockedBy,
              epicLifecycle: row.epicLifecycle,
              noAutoComplete: row.noAutoComplete,
              createdAt: row.createdAt,
              updatedAt: row.updatedAt,
              completedAt: row.completedAt,
              cancelledAt: row.cancelledAt,
              cancellationReason: row.cancellationReason,
              verificationJson: row.verificationJson,
              createdBy: row.createdBy,
              modifiedBy: row.modifiedBy,
              sessionId: row.sessionId,
            },
          })
          .run();

        // Update dependencies: delete old, insert new
        db.delete(schema.taskDependencies)
          .where(eq(schema.taskDependencies.taskId, task.id))
          .run();

        if (task.depends && task.depends.length > 0) {
          for (const depId of task.depends) {
            db.insert(schema.taskDependencies)
              .values({ taskId: task.id, dependsOn: depId })
              .onConflictDoNothing()
              .run();
          }
        }
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

      // 6. Persist to disk
      saveToFile();

      // 7. Also persist the todo.json for backward compatibility
      try {
        await saveJson(getTodoPath(cwd), data, { backupDir: getBackupDir(cwd) });
      } catch {
        // Non-fatal: SQLite is the source of truth in sqlite mode
      }
    },

    // ---- loadArchive ----

    async loadArchive(): Promise<ArchiveFile | null> {
      const db = await getDb(cwd);

      // Query tasks where status = 'archived'
      const archivedRows = db
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

      // Load dependencies for archived tasks
      if (archivedTasks.length > 0) {
        const taskIds = archivedTasks.map((t) => t.id);
        const allDeps = db.select().from(schema.taskDependencies).all();

        const depMap = new Map<string, string[]>();
        for (const dep of allDeps) {
          if (taskIds.includes(dep.taskId)) {
            let arr = depMap.get(dep.taskId);
            if (!arr) {
              arr = [];
              depMap.set(dep.taskId, arr);
            }
            arr.push(dep.dependsOn);
          }
        }

        for (const task of archivedTasks) {
          const deps = depMap.get(task.id);
          if (deps && deps.length > 0) {
            task.depends = deps;
          }
        }
      }

      return {
        archivedTasks,
        version: '1.0.0',
      };
    },

    // ---- saveArchive ----

    async saveArchive(data: ArchiveFile): Promise<void> {
      const db = await getDb(cwd);

      for (const task of data.archivedTasks) {
        const row = archivedTaskToRow(task);

        // Extract archive-specific fields if they exist on the task object
        const taskAny = task as Task & {
          archivedAt?: string;
          archiveReason?: string;
          cycleTimeDays?: number;
        };

        db.insert(schema.tasks)
          .values({
            ...row,
            archivedAt: taskAny.archivedAt ?? row.completedAt ?? new Date().toISOString(),
            archiveReason: taskAny.archiveReason ?? 'completed',
            cycleTimeDays: taskAny.cycleTimeDays ?? null,
          })
          .onConflictDoUpdate({
            target: schema.tasks.id,
            set: {
              status: 'archived',
              title: row.title,
              description: row.description,
              priority: row.priority,
              type: row.type,
              parentId: row.parentId,
              phase: row.phase,
              size: row.size,
              labelsJson: row.labelsJson,
              notesJson: row.notesJson,
              acceptanceJson: row.acceptanceJson,
              filesJson: row.filesJson,
              origin: row.origin,
              createdAt: row.createdAt,
              updatedAt: row.updatedAt,
              completedAt: row.completedAt,
              cancelledAt: row.cancelledAt,
              cancellationReason: row.cancellationReason,
              verificationJson: row.verificationJson,
              createdBy: row.createdBy,
              modifiedBy: row.modifiedBy,
              sessionId: row.sessionId,
              archivedAt:
                taskAny.archivedAt ?? row.completedAt ?? new Date().toISOString(),
              archiveReason: taskAny.archiveReason ?? 'completed',
              cycleTimeDays: taskAny.cycleTimeDays ?? null,
            },
          })
          .run();

        // Upsert dependencies for archived tasks too
        db.delete(schema.taskDependencies)
          .where(eq(schema.taskDependencies.taskId, task.id))
          .run();

        if (task.depends && task.depends.length > 0) {
          for (const depId of task.depends) {
            db.insert(schema.taskDependencies)
              .values({ taskId: task.id, dependsOn: depId })
              .onConflictDoNothing()
              .run();
          }
        }
      }

      saveToFile();
    },

    // ---- loadSessions ----

    async loadSessions(): Promise<SessionsFile> {
      const db = await getDb(cwd);

      const sessionRows = db.select().from(schema.sessions).all();
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
      const existingRows = db.select({ id: schema.sessions.id }).from(schema.sessions).all();
      const existingIds = new Set(existingRows.map((r) => r.id));
      const incomingIds = new Set(data.sessions.map((s) => s.id));

      // Delete sessions that are no longer in the data
      for (const eid of existingIds) {
        if (!incomingIds.has(eid)) {
          db.delete(schema.sessions).where(eq(schema.sessions.id, eid)).run();
        }
      }

      // Upsert all sessions
      for (const session of data.sessions) {
        db.insert(schema.sessions)
          .values({
            id: session.id,
            name: session.name,
            status: session.status,
            scopeJson: JSON.stringify(session.scope ?? { type: 'global' }),
            currentFocus: session.focus?.taskId ?? null,
            focusSetAt: session.focus?.setAt ?? null,
            agent: session.agent ?? null,
            notesJson: session.notes ? JSON.stringify(session.notes) : '[]',
            tasksCompletedJson: session.tasksCompleted
              ? JSON.stringify(session.tasksCompleted)
              : '[]',
            tasksCreatedJson: session.tasksCreated
              ? JSON.stringify(session.tasksCreated)
              : '[]',
            startedAt: session.startedAt,
            endedAt: session.endedAt ?? null,
          })
          .onConflictDoUpdate({
            target: schema.sessions.id,
            set: {
              name: session.name,
              status: session.status,
              scopeJson: JSON.stringify(session.scope ?? { type: 'global' }),
              currentFocus: session.focus?.taskId ?? null,
              focusSetAt: session.focus?.setAt ?? null,
              agent: session.agent ?? null,
              notesJson: session.notes ? JSON.stringify(session.notes) : '[]',
              tasksCompletedJson: session.tasksCompleted
                ? JSON.stringify(session.tasksCompleted)
                : '[]',
              tasksCreatedJson: session.tasksCreated
                ? JSON.stringify(session.tasksCreated)
                : '[]',
              startedAt: session.startedAt,
              endedAt: session.endedAt ?? null,
            },
          })
          .run();
      }

      saveToFile();
    },

    // ---- appendLog ----

    async appendLog(entry: Record<string, unknown>): Promise<void> {
      // Logs stay as JSONL files, not in SQLite
      await appendJsonl(getLogPath(cwd), entry);
    },

    // ---- close ----

    async close(): Promise<void> {
      closeDb();
    },
  };
}
