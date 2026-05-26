/**
 * SQLite-based implementation of the DataAccessor interface.
 *
 * Materializes TaskFile/ArchiveFile/SessionsFile from SQLite tables,
 * allowing core modules to continue using whole-file data structures
 * while storage is backed by the relational database.
 *
 * Uses existing sqlite.ts engine (node:sqlite / drizzle-orm) and
 * tasks-sqlite.ts / session-store.ts for row-level operations.
 *
 * @epic T4454
 */

import type { Session, Task, TaskStatus } from '@cleocode/contracts';
import { and, eq, inArray, isNull, like, ne, notInArray, or, sql } from 'drizzle-orm';
import { archivedTaskToRow, rowToSession, rowToTask, taskToRow } from './converters.js';
import { cleanupBrainRefsOnSessionDelete } from './cross-db-cleanup.js';
import type {
  ArchiveFile,
  DataAccessor,
  QueryTasksResult,
  TaskFieldUpdates,
  TaskQueryFilters,
  TransactionAccessor,
} from './data-accessor.js';
import type { ArchiveFields } from './db-helpers.js';
import {
  batchUpdateDependencies,
  loadDependenciesForTasks,
  loadRelationsForTasks,
  updateDependencies,
  upsertSession,
  upsertTask,
} from './db-helpers.js';
import { closeDb, getDb, getNativeTasksDb } from './sqlite.js';
import { TERMINAL_TASK_STATUSES } from './status-registry.js';
import * as schema from './tasks-schema.js';
import { withWriteRetry } from './with-retry.js';

/**
 * Per-process monotonic counter for unique nested SAVEPOINT names (T9814).
 * Only used when DataAccessor.transaction() is called from within an
 * already-open outer transaction (depth > 0). Outer transactions use
 * BEGIN IMMEDIATE/COMMIT/ROLLBACK (depth = 0).
 */
let _txSavepointCounter = 0;

/**
 * Generate a unique audit log entry ID.
 * @task T4837
 */
function generateAuditLogId(): string {
  const epoch = Math.floor(Date.now() / 1000);
  const rand = Math.random().toString(36).slice(2, 8);
  return `log-${epoch}-${rand}`;
}

/**
 * Native SQLite handle subset used by the BEGIN IMMEDIATE helper.
 *
 * Avoids dragging the whole `node:sqlite` `DatabaseSync` typings through
 * the file when all we need is `.prepare(sql).run()`. The accessor
 * always retrieves the real handle via `getNativeTasksDb()`.
 */
interface ImmediateTxNativeDb {
  prepare(sql: string): { run: () => unknown };
}

/**
 * Run `fn` inside an outermost `BEGIN IMMEDIATE` transaction, wrapped
 * in {@link withWriteRetry} so SQLITE_BUSY contention is absorbed at the
 * transaction boundary rather than mid-statement.
 *
 * - Acquires a RESERVED lock immediately so concurrent writers queue
 *   politely (or fall through to retry after `busy_timeout` expires).
 * - Commits on success; rolls back on any thrown error before
 *   propagating it. If the thrown error is SQLITE_BUSY,
 *   {@link withWriteRetry} re-runs the WHOLE function (BEGIN included)
 *   after backoff — better-sqlite3 / node:sqlite forbids nesting
 *   `BEGIN IMMEDIATE` inside an open transaction, so retry MUST start
 *   from this outer boundary.
 *
 * DO NOT call this from inside an already-open transaction. For nested
 * writes use `accessor.transaction()` which uses SAVEPOINTs (T9814).
 *
 * @bug gh-391 — SQLITE_BUSY contention on parallel writes.
 * @task T9839
 */
async function runInImmediateTx<T>(
  nativeDb: ImmediateTxNativeDb,
  fn: () => T | Promise<T>,
): Promise<T> {
  return withWriteRetry(async () => {
    nativeDb.prepare('BEGIN IMMEDIATE').run();
    try {
      const result = await fn();
      nativeDb.prepare('COMMIT').run();
      return result;
    } catch (err) {
      try {
        nativeDb.prepare('ROLLBACK').run();
      } catch {
        // Secondary rollback failures are non-fatal — propagate the original
        // error which captures the actual cause.
      }
      throw err;
    }
  });
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
export async function setMetaValue(
  cwd: string | undefined,
  key: string,
  value: unknown,
): Promise<void> {
  const db = await getDb(cwd);
  const json = JSON.stringify(value);
  await db
    .insert(schema.schemaMeta)
    .values({ key, value: json })
    .onConflictDoUpdate({
      target: schema.schemaMeta.key,
      set: { value: json },
    })
    .run();
}

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

  /** Load all task IDs for cross-task dependency validation. */
  async function getAllTaskIds(): Promise<Set<string>> {
    const db = await getDb(cwd);
    const rows = await db.select({ id: schema.tasks.id }).from(schema.tasks).all();
    return new Set(rows.map((r) => r.id));
  }

  // Per-accessor transaction nesting depth (T9814).
  // Tracks how many DataAccessor.transaction() calls are active on this
  // accessor instance. Used to choose BEGIN IMMEDIATE (outer, depth=0) vs
  // SAVEPOINT (nested, depth>0) so we preserve BEGIN IMMEDIATE locking
  // semantics at the outermost level while enabling batch-insert nesting.
  let _txDepth = 0;

  const accessor: DataAccessor = {
    engine: 'sqlite' as const,

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

      // Load dependencies and relations for archived tasks, filtering orphaned refs
      if (archivedTasks.length > 0) {
        // Also load all active task IDs so we can validate cross-references
        const activeRows = await db
          .select({ id: schema.tasks.id })
          .from(schema.tasks)
          .where(ne(schema.tasks.status, 'archived'))
          .all();
        const allKnownIds = new Set([
          ...archivedTasks.map((t) => t.id),
          ...activeRows.map((r) => r.id),
        ]);
        await loadDependenciesForTasks(db, archivedTasks, allKnownIds);
        await loadRelationsForTasks(db, archivedTasks);
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
      const archiveIds = new Set(data.archivedTasks.map((t) => t.id));
      const activeRows = await db
        .select({ id: schema.tasks.id })
        .from(schema.tasks)
        .where(ne(schema.tasks.status, 'archived'))
        .all();
      const validDepIds = new Set([...archiveIds, ...activeRows.map((r) => r.id)]);

      // Wrap all upserts + dependency updates in a single transaction.
      // Retry on SQLITE_BUSY contention via runInImmediateTx (gh#391).
      const nativeDb = getNativeTasksDb();
      if (!nativeDb) {
        throw new Error('Native database not initialized');
      }

      await runInImmediateTx(nativeDb, async () => {
        // Collect dependency data for batch update
        const depBatch: Array<{ taskId: string; deps: string[] }> = [];

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

          // allowOrphanParent=true: bulk archive writes tolerate missing parents (T5034)
          await upsertTask(db, row, archiveFields, true);
          depBatch.push({ taskId: task.id, deps: task.depends ?? [] });
        }

        // Single batch operation for all dependency updates
        await batchUpdateDependencies(db, depBatch, validDepIds);
      });
    },

    // ---- loadSessions ----

    async loadSessions(): Promise<Session[]> {
      const db = await getDb(cwd);
      const sessionRows = await db.select().from(schema.sessions).all();
      return sessionRows.map(rowToSession);
    },

    // ---- saveSessions ----

    async saveSessions(sessions: Session[]): Promise<void> {
      const db = await getDb(cwd);

      // Get existing session IDs
      const existingRows = await db.select({ id: schema.sessions.id }).from(schema.sessions).all();
      const existingIds = new Set(existingRows.map((r) => r.id));
      const incomingIds = new Set(sessions.map((s) => s.id));

      // Delete sessions that are no longer in the data
      for (const eid of existingIds) {
        if (!incomingIds.has(eid)) {
          await db.delete(schema.sessions).where(eq(schema.sessions.id, eid)).run();
        }
      }

      // Upsert all sessions
      for (const session of sessions) {
        await upsertSession(db, session);
      }
    },

    // ---- appendLog ----

    async appendLog(entry: Record<string, unknown>): Promise<void> {
      const db = await getDb(cwd);
      // gh#391: every task mutation appends one audit row; retry on contention.
      await withWriteRetry(() =>
        db
          .insert(schema.auditLog)
          .values({
            id: (entry.id as string) ?? generateAuditLogId(),
            timestamp: (entry.timestamp as string) ?? new Date().toISOString(),
            action: (entry.action as string) ?? (entry.operation as string) ?? 'unknown',
            taskId: (entry.taskId as string) ?? 'unknown',
            actor: (entry.actor as string) ?? 'system',
            detailsJson: entry.details ? JSON.stringify(entry.details) : '{}',
            beforeJson: entry.before ? JSON.stringify(entry.before) : null,
            afterJson: entry.after ? JSON.stringify(entry.after) : null,
          })
          .run(),
      );
    },

    // ---- Fine-grained task operations (T5034) ----

    async upsertSingleTask(task: Task): Promise<void> {
      const db = await getDb(cwd);
      const row = taskToRow(task);
      // gh#391: wrap multi-statement write (task row + dependency rows) in
      // a retry loop. SQLite implicitly auto-commits each statement, but
      // concurrent writers can still observe SQLITE_BUSY mid-sequence.
      await withWriteRetry(async () => {
        await upsertTask(db, row);
        await updateDependencies(db, task.id, task.depends ?? []);
      });
    },

    async addRelation(
      taskId: string,
      relatedTo: string,
      relationType: string,
      reason?: string,
    ): Promise<void> {
      const db = await getDb(cwd);
      // Validate relation type - throw on invalid (T5168)
      const validTypes = [
        'related',
        'blocks',
        'duplicates',
        'absorbs',
        'fixes',
        'extends',
        'supersedes',
        'groups', // ADR-073: Saga member linkage
      ] as const;
      if (!validTypes.includes(relationType as (typeof validTypes)[number])) {
        throw new Error(
          `Invalid relation type: ${relationType}. Valid types: ${validTypes.join(', ')}`,
        );
      }
      // gh#391: retry on SQLITE_BUSY contention.
      await withWriteRetry(() =>
        db
          .insert(schema.taskRelations)
          .values({
            taskId,
            relatedTo,
            relationType: relationType as (typeof validTypes)[number],
            reason: reason ?? null,
          })
          .onConflictDoNothing()
          .run(),
      );
    },

    async removeRelation(taskId: string, relatedTo: string, relationType?: string): Promise<void> {
      const db = await getDb(cwd);
      const conditions = [
        eq(schema.taskRelations.taskId, taskId),
        eq(schema.taskRelations.relatedTo, relatedTo),
      ];
      if (relationType !== undefined) {
        const validTypes = [
          'related',
          'blocks',
          'duplicates',
          'absorbs',
          'fixes',
          'extends',
          'supersedes',
          'groups', // ADR-073: Saga member linkage
        ] as const;
        if (!validTypes.includes(relationType as (typeof validTypes)[number])) {
          throw new Error(
            `Invalid relation type: ${relationType}. Valid types: ${validTypes.join(', ')}`,
          );
        }
        conditions.push(
          eq(schema.taskRelations.relationType, relationType as (typeof validTypes)[number]),
        );
      }
      // gh#391: retry on SQLITE_BUSY contention.
      await withWriteRetry(() =>
        db
          .delete(schema.taskRelations)
          .where(and(...conditions))
          .run(),
      );
    },

    // ---- AC rows (T10508) ----

    async getAcRows(taskId: string) {
      const db = await getDb(cwd);
      const rows = await db
        .select({
          id: schema.taskAcceptanceCriteria.id,
          taskId: schema.taskAcceptanceCriteria.taskId,
          ordinal: schema.taskAcceptanceCriteria.ordinal,
          kind: schema.taskAcceptanceCriteria.kind,
          sourceKey: schema.taskAcceptanceCriteria.sourceKey,
          targetTaskId: schema.taskAcceptanceCriteria.targetTaskId,
          projection: schema.taskAcceptanceCriteria.projection,
          text: schema.taskAcceptanceCriteria.text,
          createdAt: schema.taskAcceptanceCriteria.createdAt,
          updatedAt: schema.taskAcceptanceCriteria.updatedAt,
          contentHash: schema.taskAcceptanceCriteria.contentHash,
        })
        .from(schema.taskAcceptanceCriteria)
        .where(eq(schema.taskAcceptanceCriteria.taskId, taskId))
        .orderBy(schema.taskAcceptanceCriteria.ordinal)
        .all();
      return rows.map((r) => ({
        id: r.id,
        taskId: r.taskId,
        ordinal: r.ordinal,
        kind: r.kind,
        sourceKey: r.sourceKey ?? `text:${r.ordinal}`,
        targetTaskId: r.targetTaskId ?? null,
        projection: r.projection,
        text: r.text,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt ?? null,
        contentHash: r.contentHash ?? null,
      }));
    },

    // ---- AC bindings (T10509 — AC-coverage gate) ----

    async getAcBindings(acIds: readonly string[]) {
      if (acIds.length === 0) return [];
      const db = await getDb(cwd);
      const rows = await db
        .select({
          id: schema.evidenceAcBindings.id,
          evidenceAtomId: schema.evidenceAcBindings.evidenceAtomId,
          acId: schema.evidenceAcBindings.acId,
          bindingType: schema.evidenceAcBindings.bindingType,
          createdAt: schema.evidenceAcBindings.createdAt,
        })
        .from(schema.evidenceAcBindings)
        .where(inArray(schema.evidenceAcBindings.acId, acIds as string[]))
        .all();
      return rows.map((r) => ({
        id: r.id,
        evidenceAtomId: r.evidenceAtomId,
        acId: r.acId,
        bindingType: r.bindingType,
        createdAt: r.createdAt,
      }));
    },

    async archiveSingleTask(taskId: string, fields: ArchiveFields): Promise<void> {
      const db = await getDb(cwd);
      // Verify the task exists before archiving
      const rows = await db
        .select({ id: schema.tasks.id })
        .from(schema.tasks)
        .where(eq(schema.tasks.id, taskId))
        .all();
      if (rows.length === 0) return;
      // gh#391: retry on SQLITE_BUSY contention.
      await withWriteRetry(() =>
        db
          .update(schema.tasks)
          .set({
            status: 'archived',
            archivedAt: fields.archivedAt ?? new Date().toISOString(),
            archiveReason: fields.archiveReason ?? 'completed',
            cycleTimeDays: fields.cycleTimeDays ?? null,
            updatedAt: new Date().toISOString(),
          })
          .where(eq(schema.tasks.id, taskId))
          .run(),
      );
    },

    async removeSingleTask(taskId: string): Promise<void> {
      const db = await getDb(cwd);
      // gh#391: wrap the three-statement delete sequence in one retry
      // boundary. SQLITE_BUSY mid-sequence would leak dangling task_dependencies
      // rows; retrying the whole sequence keeps the cleanup atomic at the
      // application level (foreign-key cascade catches edge cases regardless).
      await withWriteRetry(async () => {
        // Delete dependencies first (both directions)
        await db
          .delete(schema.taskDependencies)
          .where(eq(schema.taskDependencies.taskId, taskId))
          .run();
        await db
          .delete(schema.taskDependencies)
          .where(eq(schema.taskDependencies.dependsOn, taskId))
          .run();
        // Delete the task itself
        await db.delete(schema.tasks).where(eq(schema.tasks.id, taskId)).run();
      });
    },

    async loadSingleTask(taskId: string): Promise<Task | null> {
      const db = await getDb(cwd);
      const rows = await db
        .select()
        .from(schema.tasks)
        .where(eq(schema.tasks.id, taskId))
        .limit(1)
        .all();
      if (rows.length === 0 || !rows[0]) return null;
      const task = rowToTask(rows[0]);
      // Load all task IDs so dependency validation doesn't filter out cross-task refs
      const allIdRows = await db.select({ id: schema.tasks.id }).from(schema.tasks).all();
      const allIds = new Set(allIdRows.map((r) => r.id));
      await loadDependenciesForTasks(db, [task], allIds);
      await loadRelationsForTasks(db, [task]);
      return task;
    },

    async getActiveSession(): Promise<Session | null> {
      const db = await getDb(cwd);
      const rows = await db
        .select()
        .from(schema.sessions)
        .where(eq(schema.sessions.status, 'active'))
        .orderBy(sql`${schema.sessions.startedAt} DESC`)
        .limit(1)
        .all();
      if (rows.length === 0 || !rows[0]) return null;
      return rowToSession(rows[0]);
    },

    async upsertSingleSession(session: Session): Promise<void> {
      const db = await getDb(cwd);
      await upsertSession(db, session);
    },

    async removeSingleSession(sessionId: string): Promise<void> {
      const db = await getDb(cwd);
      await db.delete(schema.sessions).where(eq(schema.sessions.id, sessionId)).run();
      // Best-effort cross-db cleanup: nullify brain.db references to this session
      void cleanupBrainRefsOnSessionDelete(sessionId, cwd);
    },

    // ---- Targeted query methods (Phase 2 modernization) ----

    async queryTasks(filters: TaskQueryFilters): Promise<QueryTasksResult> {
      const db = await getDb(cwd);
      const conditions = [];

      // Exclude archived by default unless explicitly requested
      if (filters.status) {
        const statuses = Array.isArray(filters.status) ? filters.status : [filters.status];
        if (!statuses.includes('archived')) {
          conditions.push(ne(schema.tasks.status, 'archived'));
        }
        conditions.push(inArray(schema.tasks.status, statuses));
      } else if (filters.excludeStatus) {
        const excluded = Array.isArray(filters.excludeStatus)
          ? filters.excludeStatus
          : [filters.excludeStatus];
        for (const s of excluded) {
          conditions.push(ne(schema.tasks.status, s));
        }
      } else {
        conditions.push(ne(schema.tasks.status, 'archived'));
      }

      if (filters.priority) conditions.push(eq(schema.tasks.priority, filters.priority));
      if (filters.type) conditions.push(eq(schema.tasks.type, filters.type));
      if (filters.phase) conditions.push(eq(schema.tasks.phase, filters.phase));

      if (filters.parentId !== undefined) {
        if (filters.parentId === null) {
          conditions.push(isNull(schema.tasks.parentId));
        } else {
          conditions.push(eq(schema.tasks.parentId, filters.parentId));
        }
      }

      if (filters.search) {
        const pattern = `%${filters.search}%`;
        conditions.push(
          or(
            like(schema.tasks.title, pattern),
            like(schema.tasks.description, pattern),
            like(schema.tasks.id, pattern),
          )!,
        );
      }

      if (filters.label) {
        // label stored in JSON array — use LIKE on the serialized column
        conditions.push(like(schema.tasks.labelsJson, `%${JSON.stringify(filters.label)}%`));
      }

      const where = conditions.length > 0 ? and(...conditions) : undefined;

      // Count total matching rows (before pagination)
      const countResult = await db
        .select({ count: sql<number>`count(*)` })
        .from(schema.tasks)
        .where(where)
        .get();
      const total = countResult?.count ?? 0;

      // Build ordered query
      let orderClause: ReturnType<typeof sql>;
      switch (filters.orderBy) {
        case 'createdAt':
          orderClause = sql`${schema.tasks.createdAt} ASC`;
          break;
        case 'updatedAt':
          orderClause = sql`${schema.tasks.updatedAt} DESC NULLS LAST`;
          break;
        case 'priority': {
          // Map priority to numeric sort: critical=0, high=1, medium=2, low=3
          orderClause = sql`CASE ${schema.tasks.priority}
            WHEN 'critical' THEN 0 WHEN 'high' THEN 1
            WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END ASC`;
          break;
        }
        default:
          // position ASC, createdAt ASC (default)
          orderClause = sql`${schema.tasks.position} ASC, ${schema.tasks.createdAt} ASC`;
      }

      let query = db.select().from(schema.tasks).where(where).orderBy(orderClause);

      if (filters.limit !== undefined) {
        query = query.limit(filters.limit) as typeof query;
      }
      if (filters.offset !== undefined) {
        query = query.offset(filters.offset) as typeof query;
      }

      const rows = await query.all();
      const tasks = rows.map(rowToTask);

      // Load dependencies and relations with full ID set for cross-task refs
      if (tasks.length > 0) {
        const allIds = await getAllTaskIds();
        await loadDependenciesForTasks(db, tasks, allIds);
        await loadRelationsForTasks(db, tasks);
      }

      return { tasks, total };
    },

    async countTasks(filters?: {
      status?: TaskStatus | TaskStatus[];
      parentId?: string;
    }): Promise<number> {
      const db = await getDb(cwd);
      const conditions = [];

      if (filters?.status) {
        const statuses = Array.isArray(filters.status) ? filters.status : [filters.status];
        conditions.push(inArray(schema.tasks.status, statuses));
      } else {
        conditions.push(ne(schema.tasks.status, 'archived'));
      }

      if (filters?.parentId) {
        conditions.push(eq(schema.tasks.parentId, filters.parentId));
      }

      const where = conditions.length > 0 ? and(...conditions) : undefined;
      const result = await db
        .select({ count: sql<number>`count(*)` })
        .from(schema.tasks)
        .where(where)
        .get();
      return result?.count ?? 0;
    },

    async getChildren(parentId: string): Promise<Task[]> {
      const db = await getDb(cwd);
      const rows = await db
        .select()
        .from(schema.tasks)
        .where(and(eq(schema.tasks.parentId, parentId), ne(schema.tasks.status, 'archived')))
        .orderBy(sql`${schema.tasks.position} ASC, ${schema.tasks.createdAt} ASC`)
        .all();
      const tasks = rows.map(rowToTask);
      if (tasks.length > 0) {
        const allIds = await getAllTaskIds();
        await loadDependenciesForTasks(db, tasks, allIds);
        await loadRelationsForTasks(db, tasks);
      }
      return tasks;
    },

    async countChildren(parentId: string): Promise<number> {
      const db = await getDb(cwd);
      const result = await db
        .select({ count: sql<number>`count(*)` })
        .from(schema.tasks)
        .where(and(eq(schema.tasks.parentId, parentId), ne(schema.tasks.status, 'archived')))
        .get();
      return result?.count ?? 0;
    },

    async countActiveChildren(parentId: string): Promise<number> {
      const db = await getDb(cwd);
      const result = await db
        .select({ count: sql<number>`count(*)` })
        .from(schema.tasks)
        .where(
          and(
            eq(schema.tasks.parentId, parentId),
            notInArray(schema.tasks.status, [...TERMINAL_TASK_STATUSES]),
          ),
        )
        .get();
      return result?.count ?? 0;
    },

    async getAncestorChain(taskId: string): Promise<Task[]> {
      const nativeDb = getNativeTasksDb();
      if (!nativeDb) return [];

      const idRows = nativeDb
        .prepare(
          `WITH RECURSIVE ancestor_ids(id, depth) AS (
            SELECT parent_id, 0 FROM tasks WHERE id = ? AND parent_id IS NOT NULL
            UNION ALL
            SELECT t.parent_id, a.depth + 1 FROM tasks t
            JOIN ancestor_ids a ON t.id = a.id
            WHERE t.parent_id IS NOT NULL
          )
          SELECT id FROM ancestor_ids ORDER BY depth DESC`,
        )
        .all(taskId) as Array<{ id: string }>;

      if (idRows.length === 0) return [];

      const db = await getDb(cwd);
      const ids = idRows.map((r: { id: string }) => r.id);
      const taskRows = await db
        .select()
        .from(schema.tasks)
        .where(inArray(schema.tasks.id, ids))
        .all();

      const tasks = taskRows.map(rowToTask);
      if (tasks.length > 0) {
        const allIds = await getAllTaskIds();
        await loadDependenciesForTasks(db, tasks, allIds);
        await loadRelationsForTasks(db, tasks);
      }
      // Preserve depth order (ancestors from root down)
      const orderMap = new Map(ids.map((id: string, i: number) => [id, i]));
      tasks.sort((a, b) => (orderMap.get(a.id) ?? 0) - (orderMap.get(b.id) ?? 0));
      return tasks;
    },

    async getSubtree(rootId: string): Promise<Task[]> {
      const nativeDb = getNativeTasksDb();
      if (!nativeDb) return [];

      // Get IDs from the CTE, then load via Drizzle for proper conversion
      const idRows = nativeDb
        .prepare(
          `WITH RECURSIVE subtree AS (
            SELECT id FROM tasks WHERE id = ?
            UNION ALL
            SELECT t.id FROM tasks t
            JOIN subtree s ON t.parent_id = s.id
          )
          SELECT id FROM subtree`,
        )
        .all(rootId) as Array<{ id: string }>;

      if (idRows.length === 0) return [];

      const db = await getDb(cwd);
      const ids = idRows.map((r) => r.id);
      const rows = await db.select().from(schema.tasks).where(inArray(schema.tasks.id, ids)).all();

      const tasks = rows.map(rowToTask);
      if (tasks.length > 0) {
        const allIds = await getAllTaskIds();
        await loadDependenciesForTasks(db, tasks, allIds);
        await loadRelationsForTasks(db, tasks);
      }
      return tasks;
    },

    async getDependents(taskId: string): Promise<Task[]> {
      const db = await getDb(cwd);
      // Find tasks whose depends list includes taskId (reverse lookup)
      const depRows = await db
        .select()
        .from(schema.taskDependencies)
        .where(eq(schema.taskDependencies.dependsOn, taskId))
        .all();

      if (depRows.length === 0) return [];

      const dependentIds = depRows.map((r) => r.taskId);
      const rows = await db
        .select()
        .from(schema.tasks)
        .where(inArray(schema.tasks.id, dependentIds))
        .all();

      const tasks = rows.map(rowToTask);
      if (tasks.length > 0) {
        const allIds = await getAllTaskIds();
        await loadDependenciesForTasks(db, tasks, allIds);
        await loadRelationsForTasks(db, tasks);
      }
      return tasks;
    },

    async getDependencyChain(taskId: string): Promise<string[]> {
      const nativeDb = getNativeTasksDb();
      if (!nativeDb) return [];

      const rows = nativeDb
        .prepare(
          `WITH RECURSIVE dep_chain(id) AS (
            SELECT depends_on FROM task_dependencies WHERE task_id = ?
            UNION
            SELECT td.depends_on FROM task_dependencies td
            JOIN dep_chain dc ON td.task_id = dc.id
          )
          SELECT id FROM dep_chain`,
        )
        .all(taskId) as Array<{ id: string }>;

      return rows.map((r) => r.id);
    },

    async taskExists(taskId: string): Promise<boolean> {
      const db = await getDb(cwd);
      const result = await db
        .select({ id: schema.tasks.id })
        .from(schema.tasks)
        .where(eq(schema.tasks.id, taskId))
        .limit(1)
        .get();
      return !!result;
    },

    async loadTasks(taskIds: string[]): Promise<Task[]> {
      if (taskIds.length === 0) return [];
      const db = await getDb(cwd);
      const rows = await db
        .select()
        .from(schema.tasks)
        .where(inArray(schema.tasks.id, taskIds))
        .all();

      const tasks = rows.map(rowToTask);
      if (tasks.length > 0) {
        const allIds = await getAllTaskIds();
        await loadDependenciesForTasks(db, tasks, allIds);
        await loadRelationsForTasks(db, tasks);
      }
      return tasks;
    },

    // ---- Position helpers (T024/T025) ----

    async getNextPosition(parentId: string | null): Promise<number> {
      const nativeDb = getNativeTasksDb();
      if (!nativeDb) {
        throw new Error('Native database not initialized');
      }
      const row =
        parentId === null
          ? (nativeDb
              .prepare(
                `SELECT COALESCE(MAX(position), 0) + 1 AS next_pos FROM tasks WHERE parent_id IS NULL AND status != 'archived'`,
              )
              .get() as { next_pos: number } | undefined)
          : (nativeDb
              .prepare(
                `SELECT COALESCE(MAX(position), 0) + 1 AS next_pos FROM tasks WHERE parent_id = ? AND status != 'archived'`,
              )
              .get(parentId) as { next_pos: number } | undefined);
      return row?.next_pos ?? 1;
    },

    async shiftPositions(
      parentId: string | null,
      fromPosition: number,
      delta: number,
    ): Promise<void> {
      const nativeDb = getNativeTasksDb();
      if (!nativeDb) {
        throw new Error('Native database not initialized');
      }
      if (parentId === null) {
        nativeDb
          .prepare(
            `UPDATE tasks SET position = position + ?, position_version = position_version + 1, updated_at = ? WHERE parent_id IS NULL AND position >= ? AND status != 'archived'`,
          )
          .run(delta, new Date().toISOString(), fromPosition);
      } else {
        nativeDb
          .prepare(
            `UPDATE tasks SET position = position + ?, position_version = position_version + 1, updated_at = ? WHERE parent_id = ? AND position >= ? AND status != 'archived'`,
          )
          .run(delta, new Date().toISOString(), parentId, fromPosition);
      }
    },

    // ---- Targeted write methods ----

    async updateTaskFields(taskId: string, fields: TaskFieldUpdates): Promise<void> {
      const db = await getDb(cwd);
      const updateRow: Record<string, unknown> = {
        updatedAt: fields.updatedAt ?? new Date().toISOString(),
      };

      // Copy only provided fields
      const fieldMap: Array<[keyof TaskFieldUpdates, string]> = [
        ['title', 'title'],
        ['description', 'description'],
        ['status', 'status'],
        ['priority', 'priority'],
        ['type', 'type'],
        ['parentId', 'parentId'],
        ['phase', 'phase'],
        ['size', 'size'],
        ['position', 'position'],
        ['positionVersion', 'positionVersion'],
        ['labelsJson', 'labelsJson'],
        ['notesJson', 'notesJson'],
        ['acceptanceJson', 'acceptanceJson'],
        ['filesJson', 'filesJson'],
        ['origin', 'origin'],
        ['blockedBy', 'blockedBy'],
        ['epicLifecycle', 'epicLifecycle'],
        ['noAutoComplete', 'noAutoComplete'],
        ['completedAt', 'completedAt'],
        ['cancelledAt', 'cancelledAt'],
        ['cancellationReason', 'cancellationReason'],
        ['verificationJson', 'verificationJson'],
        ['createdBy', 'createdBy'],
        ['modifiedBy', 'modifiedBy'],
        ['sessionId', 'sessionId'],
        ['assignee', 'assignee'],
        ['pipelineStage', 'pipelineStage'],
      ];

      for (const [key, col] of fieldMap) {
        if (fields[key] !== undefined) {
          updateRow[col] = fields[key];
        }
      }

      // gh#391: this is the chokepoint for `cleo update <id> --add-labels`.
      // Parallel invocations from a single shell used to lose ~50% of writes
      // to SQLITE_BUSY; withWriteRetry recovers them.
      await withWriteRetry(() =>
        db.update(schema.tasks).set(updateRow).where(eq(schema.tasks.id, taskId)).run(),
      );
    },

    async transaction<T>(fn: (tx: TransactionAccessor) => Promise<T>): Promise<T> {
      // Await getDb first so _nativeDb is guaranteed to be the correct instance
      // before we capture it. Capturing before the await is a race condition:
      // another async cleanup could close the DB during the await, leaving us
      // with a stale (closed) nativeDb reference. (T1718 flake fix)
      const db = await getDb(cwd);
      const nativeDb = getNativeTasksDb();
      if (!nativeDb) {
        throw new Error('Native database not initialized');
      }

      // Nested-transaction support (T9814 — batch insert):
      // - Outermost call (depth=0): use BEGIN IMMEDIATE — preserves the
      //   RESERVED lock semantics that callers and tests depend on.
      // - Nested calls (depth>0): use SAVEPOINT — creates a logical
      //   checkpoint inside the already-open transaction.
      const isOuter = _txDepth === 0;
      const spName = isOuter ? null : `_cleo_tx_${(_txSavepointCounter++).toString(36)}`;
      if (isOuter) {
        nativeDb.prepare('BEGIN IMMEDIATE').run();
      } else {
        nativeDb.prepare(`SAVEPOINT ${spName}`).run();
      }
      _txDepth++;
      try {
        const tx: TransactionAccessor = {
          async upsertSingleTask(task: Task): Promise<void> {
            const row = taskToRow(task);
            await upsertTask(db, row);
            await updateDependencies(db, task.id, task.depends ?? []);
          },
          async archiveSingleTask(taskId: string, fields: ArchiveFields): Promise<void> {
            await db
              .update(schema.tasks)
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
            await db
              .delete(schema.taskDependencies)
              .where(eq(schema.taskDependencies.taskId, taskId))
              .run();
            await db
              .delete(schema.taskDependencies)
              .where(eq(schema.taskDependencies.dependsOn, taskId))
              .run();
            await db.delete(schema.tasks).where(eq(schema.tasks.id, taskId)).run();
          },
          async setMetaValue(key: string, value: unknown): Promise<void> {
            await setMetaValue(cwd, key, value);
          },
          async updateTaskFields(taskId: string, flds: TaskFieldUpdates): Promise<void> {
            // Delegate to the outer accessor's implementation
            await accessor.updateTaskFields(taskId, flds);
          },
          async getChildren(parentId: string): Promise<Task[]> {
            const rows = await db
              .select()
              .from(schema.tasks)
              .where(and(eq(schema.tasks.parentId, parentId), ne(schema.tasks.status, 'archived')))
              .orderBy(sql`${schema.tasks.position} ASC, ${schema.tasks.createdAt} ASC`)
              .all();
            return rows.map(rowToTask);
          },
          async appendLog(entry: Record<string, unknown>): Promise<void> {
            await accessor.appendLog(entry);
          },
          // T9514: persist relates mutations inside the transaction
          async addRelation(
            taskId: string,
            relatedTo: string,
            relationType: string,
            reason?: string,
          ): Promise<void> {
            await accessor.addRelation(taskId, relatedTo, relationType, reason);
          },
          async removeRelation(
            taskId: string,
            relatedTo: string,
            relationType?: string,
          ): Promise<void> {
            await accessor.removeRelation(taskId, relatedTo, relationType);
          },
          async clearRelations(taskId: string): Promise<void> {
            await db
              .delete(schema.taskRelations)
              .where(eq(schema.taskRelations.taskId, taskId))
              .run();
          },
          // ---- AC rows (T10508) ----
          async insertAcRows(
            rows: Array<{
              id: string;
              taskId: string;
              ordinal: number;
              text: string;
              kind?: 'text' | 'child_task' | 'evidence_bound';
              sourceKey?: string;
              targetTaskId?: string | null;
              projection?: string;
              contentHash?: string | null;
            }>,
          ): Promise<void> {
            if (rows.length === 0) return;
            await db
              .insert(schema.taskAcceptanceCriteria)
              .values(
                rows.map((r) => ({
                  id: r.id,
                  taskId: r.taskId,
                  ordinal: r.ordinal,
                  kind: r.kind ?? 'text',
                  sourceKey: r.sourceKey ?? `text:${r.ordinal}`,
                  targetTaskId: r.targetTaskId ?? null,
                  projection: r.projection ?? 'legacy',
                  text: r.text,
                  contentHash: r.contentHash ?? null,
                })),
              )
              .run();
          },
          async getAcRows(taskId: string) {
            const out = await db
              .select({
                id: schema.taskAcceptanceCriteria.id,
                taskId: schema.taskAcceptanceCriteria.taskId,
                ordinal: schema.taskAcceptanceCriteria.ordinal,
                kind: schema.taskAcceptanceCriteria.kind,
                sourceKey: schema.taskAcceptanceCriteria.sourceKey,
                targetTaskId: schema.taskAcceptanceCriteria.targetTaskId,
                projection: schema.taskAcceptanceCriteria.projection,
                text: schema.taskAcceptanceCriteria.text,
                createdAt: schema.taskAcceptanceCriteria.createdAt,
                updatedAt: schema.taskAcceptanceCriteria.updatedAt,
                contentHash: schema.taskAcceptanceCriteria.contentHash,
              })
              .from(schema.taskAcceptanceCriteria)
              .where(eq(schema.taskAcceptanceCriteria.taskId, taskId))
              .orderBy(schema.taskAcceptanceCriteria.ordinal)
              .all();
            return out.map((r) => ({
              id: r.id,
              taskId: r.taskId,
              ordinal: r.ordinal,
              kind: r.kind,
              sourceKey: r.sourceKey ?? `text:${r.ordinal}`,
              targetTaskId: r.targetTaskId ?? null,
              projection: r.projection,
              text: r.text,
              createdAt: r.createdAt,
              updatedAt: r.updatedAt ?? null,
              contentHash: r.contentHash ?? null,
            }));
          },
          async deleteAcRowsForTask(taskId: string): Promise<void> {
            await db
              .delete(schema.taskAcceptanceCriteria)
              .where(eq(schema.taskAcceptanceCriteria.taskId, taskId))
              .run();
          },
          async appendAcHistory(
            rows: Array<{ acId: string; previousText: string; reason: string }>,
          ): Promise<void> {
            if (rows.length === 0) return;
            await db
              .insert(schema.taskAcceptanceCriteriaHistory)
              .values(
                rows.map((r) => ({
                  acId: r.acId,
                  previousText: r.previousText,
                  reason: r.reason,
                })),
              )
              .run();
          },
          // ---- AC bindings (T10509 — AC-coverage gate) ----
          async getAcBindings(acIds: readonly string[]) {
            if (acIds.length === 0) return [];
            const out = await db
              .select({
                id: schema.evidenceAcBindings.id,
                evidenceAtomId: schema.evidenceAcBindings.evidenceAtomId,
                acId: schema.evidenceAcBindings.acId,
                bindingType: schema.evidenceAcBindings.bindingType,
                createdAt: schema.evidenceAcBindings.createdAt,
              })
              .from(schema.evidenceAcBindings)
              .where(inArray(schema.evidenceAcBindings.acId, acIds as string[]))
              .all();
            return out.map((r) => ({
              id: r.id,
              evidenceAtomId: r.evidenceAtomId,
              acId: r.acId,
              bindingType: r.bindingType,
              createdAt: r.createdAt,
            }));
          },
          // ---- AC bindings — writer (T10511, Validator SDK tools) ----
          async insertAcBindings(
            rows: Array<{
              id: string;
              evidenceAtomId: string;
              acId: string;
              bindingType: 'direct' | 'satisfies' | 'coverage';
            }>,
          ): Promise<void> {
            if (rows.length === 0) return;
            // Idempotent insert — UNIQUE (evidence_atom_id, ac_id, binding_type)
            // index collapses re-inserts of the same triple via DO NOTHING.
            await db
              .insert(schema.evidenceAcBindings)
              .values(
                rows.map((r) => ({
                  id: r.id,
                  evidenceAtomId: r.evidenceAtomId,
                  acId: r.acId,
                  bindingType: r.bindingType,
                })),
              )
              .onConflictDoNothing({
                target: [
                  schema.evidenceAcBindings.evidenceAtomId,
                  schema.evidenceAcBindings.acId,
                  schema.evidenceAcBindings.bindingType,
                ],
              })
              .run();
          },
        };

        const result = await fn(tx);
        _txDepth--;
        if (isOuter) {
          nativeDb.prepare('COMMIT').run();
        } else {
          nativeDb.prepare(`RELEASE SAVEPOINT ${spName}`).run();
        }
        return result;
      } catch (err) {
        _txDepth--;
        try {
          if (isOuter) {
            nativeDb.prepare('ROLLBACK').run();
          } else {
            nativeDb.prepare(`ROLLBACK TO SAVEPOINT ${spName}`).run();
            nativeDb.prepare(`RELEASE SAVEPOINT ${spName}`).run();
          }
        } catch {
          /* ignore secondary rollback errors */
        }
        throw err;
      }
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

    // ---- Agent instances ----

    async listAgentInstances(filters) {
      const { listAgentInstances: listAgents } = await import('../agents/registry.js');
      // Cast generic string filters to the specific union types expected by the agents module
      return listAgents(filters as Parameters<typeof listAgents>[0], cwd);
    },

    async getAgentInstance(agentId) {
      const { getAgentInstance: getAgent } = await import('../agents/registry.js');
      return getAgent(agentId, cwd);
    },

    // ---- Agent task claiming ----

    async claimTask(taskId: string, agentId: string): Promise<void> {
      const nativeDb = getNativeTasksDb();
      if (!nativeDb) {
        throw new Error('Native database not initialized');
      }

      // Verify the task exists first
      const existsRow = nativeDb.prepare('SELECT assignee FROM tasks WHERE id = ?').get(taskId) as
        | { assignee: string | null }
        | undefined;
      if (!existsRow) {
        throw new Error(`Task not found: ${taskId}`);
      }

      // Atomic claim: only succeeds if assignee IS NULL or already claimed by this agent.
      // This prevents race conditions between concurrent agents.
      const result = nativeDb
        .prepare(
          'UPDATE tasks SET assignee = ?, updated_at = ? WHERE id = ? AND (assignee IS NULL OR assignee = ?)',
        )
        .run(agentId, new Date().toISOString(), taskId, agentId) as { changes: number };

      if (result.changes === 0) {
        // Row was not updated — task is claimed by a different agent
        const currentRow = nativeDb
          .prepare('SELECT assignee FROM tasks WHERE id = ?')
          .get(taskId) as { assignee: string | null } | undefined;
        throw new Error(
          `Task ${taskId} is already claimed by agent: ${currentRow?.assignee ?? 'unknown'}`,
        );
      }
    },

    async unclaimTask(taskId: string): Promise<void> {
      const nativeDb = getNativeTasksDb();
      if (!nativeDb) {
        throw new Error('Native database not initialized');
      }

      // Verify the task exists
      const existsRow = nativeDb.prepare('SELECT id FROM tasks WHERE id = ?').get(taskId) as
        | { id: string }
        | undefined;
      if (!existsRow) {
        throw new Error(`Task not found: ${taskId}`);
      }

      // Clear the assignee — no-op if already null
      nativeDb
        .prepare('UPDATE tasks SET assignee = NULL, updated_at = ? WHERE id = ?')
        .run(new Date().toISOString(), taskId);
    },
  };

  return accessor;
}
