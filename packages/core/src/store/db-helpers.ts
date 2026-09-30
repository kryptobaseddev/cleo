/**
 * Shared database helper functions for SQLite store modules.
 *
 * Consolidates upsert and dependency patterns used across
 * sqlite-data-accessor.ts, tasks-sqlite.ts, and session-store.ts.
 *
 * @epic T4454
 */

import type { ArchiveReasonValue, Session, Task, TaskInsertIdentity } from '@cleocode/contracts';
import { ExitCode } from '@cleocode/contracts';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { NodeSQLiteDatabase } from 'drizzle-orm/node-sqlite';
import { CleoError } from '../errors.js';
import { getLogger } from '../logger.js';
import { birthFingerprint, mintedRowUid } from './row-identity.js';
import { rowUidFillEnabled } from './row-identity-flag.js';
import type { NewTaskRow } from './tasks-schema.js';
import * as schema from './tasks-schema.js';

const log = getLogger('db-helpers');

/** Drizzle database instance type. */
type DrizzleDb = NodeSQLiteDatabase;

/** Archive-specific fields for task upsert. */
export interface ArchiveFields {
  archivedAt?: string;
  /**
   * T11578 · AC1: typed to the canonical {@link ArchiveReasonValue} enum so
   * writes conform to the consolidated `tasks_tasks.archive_reason` CHECK
   * constraint (the bare legacy `tasks` table had no CHECK, masking
   * out-of-enum values such as the historical `'completed'` literal).
   */
  archiveReason?: ArchiveReasonValue;
  cycleTimeDays?: number | null;
}

/**
 * Upsert a single task row into the tasks table.
 * Handles both active task upsert and archived task upsert via optional archiveFields.
 *
 * When `allowOrphanParent` is true (bulk/migration mode, T5034): silently nulls out
 * parentId if the referenced parent does not exist, preventing FK violations.
 * When false (normal single-task writes, default): logs a warning but still proceeds
 * so that FK enforcement at the DB level provides the final safety net.
 *
 * Callers that perform bulk imports or archive restoration should pass
 * `allowOrphanParent: true` to enable the lenient behavior.
 */
export async function upsertTask(
  db: DrizzleDb,
  row: NewTaskRow,
  archiveFields?: ArchiveFields,
  allowOrphanParent = false,
): Promise<void> {
  await writeTaskRow(db, row, archiveFields, allowOrphanParent, false);
}

/**
 * Insert a NEW task row. Never overwrites: when a row with the same id is
 * already stored, it throws `ExitCode.ID_COLLISION` and writes nothing.
 *
 * Every path that creates a task under a freshly allocated or computed id
 * (`cleo add` and `add-batch`, the task imports, snapshot restore of a
 * missing task) uses this instead of {@link upsertTask}. An id collision (an
 * older build, or any writer that took the same id between allocation and
 * insert) must fail loudly, never silently replace a different task. The
 * existence check gives the typed error; the plain INSERT (no ON CONFLICT)
 * is the backstop, since the primary key rejects a duplicate the check missed.
 *
 * @param db - The tasks Drizzle handle, inside the caller's transaction.
 * @param row - The new task row.
 * @throws CleoError `ID_COLLISION` when `row.id` is already stored.
 * @task T12724
 */
export async function insertNewTask(
  db: DrizzleDb,
  row: NewTaskRow,
  identity: TaskInsertIdentity = { origin: 'new' },
): Promise<void> {
  await writeTaskRow(
    db,
    { ...row, ...(await importedIdentity(db, identity, row)) },
    undefined,
    false,
    true,
  );
}

/**
 * An import or restore named a row this store already holds: same uid AND
 * same birth fingerprint (possibly under another display id after a re-mint,
 * re-keyed, or held in the identity quarantine). Writing it again would
 * duplicate the work, so the caller skips it and reports the conflict
 * (T12806 review).
 */
export class SameRowPresentError extends CleoError {
  /** Where the row already is: its display id, or `held` when quarantined. */
  readonly presentAs: string;

  constructor(taskId: string, presentAs: string) {
    super(
      ExitCode.ID_COLLISION,
      `Task ${taskId} is already in this store (${presentAs === 'held' ? 'held for sync' : `as ${presentAs}`}): same uid and birth fingerprint; not written again`,
      { details: { field: 'taskId', actual: taskId, expected: presentAs } },
    );
    this.presentAs = presentAs;
  }
}

async function tableExists(db: DrizzleDb, table: string): Promise<boolean> {
  const rows = await db.all<{ x: number }>(
    sql`SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ${table}`,
  );
  return rows.length > 0;
}

/**
 * The identity columns of an IMPORTED task (T12341 spec §5.1, T12806), only
 * while row uids are on (`CLEO_ROW_UID_FILL=1`; off, nothing changes):
 *
 * - the source's `uid` + `birth_fp`, followed through `tasks_uid_aliases`
 *   when it was re-keyed here, when no row holds it;
 * - {@link SameRowPresentError} when a row with that uid AND fingerprint is
 *   here already (another display id, or held in the quarantine);
 * - otherwise an explicit NULL uid for the deterministic recipe (the TEMP
 *   trigger, else the next open), from the row's own key and birth. A source
 *   without a birth (`birthKnown: false`) gets the recipe's unknown-birth
 *   values now, never an identity stamped with the import time.
 */
async function importedIdentity(
  db: DrizzleDb,
  identity: TaskInsertIdentity,
  row: NewTaskRow,
): Promise<Pick<NewTaskRow, 'uid' | 'birthFp'>> {
  if (identity.origin === 'new' || !rowUidFillEnabled()) return {};
  const fp = identity.birthFp ?? null;
  const carried = identity.uid ?? null;
  if (carried !== null && fp !== null) {
    let uid: string = carried;
    if (await tableExists(db, 'tasks_uid_aliases')) {
      for (let hop = 0; hop < 32; hop++) {
        const found: Array<{ uid: string }> = await db.all<{ uid: string }>(
          sql`SELECT new_uid AS uid FROM tasks_uid_aliases
               WHERE entity_table = 'tasks_tasks' AND old_uid = ${uid} AND old_birth_fp = ${fp}`,
        );
        const next = found[0];
        if (!next) break;
        uid = next.uid;
      }
    }
    const [holder] = await db
      .select({ id: schema.tasks.id, birthFp: schema.tasks.birthFp })
      .from(schema.tasks)
      .where(eq(schema.tasks.uid, uid))
      .limit(1)
      .all();
    if (holder && holder.birthFp === fp) throw new SameRowPresentError(row.id, holder.id);
    if (await tableExists(db, 'tasks_identity_quarantine')) {
      const [held] = await db.all<{ x: number }>(
        sql`SELECT 1 AS x FROM tasks_identity_quarantine
             WHERE entity_table = 'tasks_tasks' AND uid = ${uid} AND birth_fp = ${fp}`,
      );
      if (held) throw new SameRowPresentError(row.id, 'held');
    }
    if (!holder) return { uid, birthFp: fp };
    // Another row holds the uid with another fingerprint: derive instead.
  }
  if (identity.birthKnown === false) {
    return {
      uid: mintedRowUid('project', 'tasks_tasks', [row.id], null),
      birthFp: birthFingerprint('tasks_tasks', null, [row.title ?? null, row.type ?? null]),
    };
  }
  return { uid: null, birthFp: null };
}

/** The shared write behind {@link upsertTask} and {@link insertNewTask}. */
async function writeTaskRow(
  db: DrizzleDb,
  row: NewTaskRow,
  archiveFields: ArchiveFields | undefined,
  allowOrphanParent: boolean,
  insertOnly: boolean,
): Promise<void> {
  // Validate parentId exists before writing (T5034, T585).
  // In bulk/archive mode (allowOrphanParent=true) we silently null it out to
  // avoid FK violations during migrations. In normal mode we log a warning so
  // the data integrity issue surfaces without breaking the write.
  // T12307: a row that parents itself is never legitimate, and BOTH production
  // triggers miss it on INSERT — `tasks_parent_type_matrix_insert` and
  // `tasks_parent_cycle_guard_insert` each resolve the parent with
  // `WHERE parent.id = NEW.parent_id`, which matches nothing while the row is
  // still being inserted, so their WHEN clauses are vacuously false. The
  // self-edge then reached the recursive ancestor/subtree CTEs and recursed
  // forever in native SQLite memory. Those CTEs now carry their own guards, so
  // this is defence in depth — but the write is the right place to refuse it.
  if (row.parentId && row.parentId === row.id) {
    throw new Error(
      `E_TASK_PARENT_SELF: task ${row.id} cannot be its own parent — ` +
        'containment must form a tree. Pass the real parent id, or omit --parent for a root.',
    );
  }

  if (row.parentId) {
    const parent = await db
      .select({ id: schema.tasks.id })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, row.parentId))
      .limit(1)
      .all();
    if (parent.length === 0) {
      if (allowOrphanParent) {
        row = { ...row, parentId: null };
      } else {
        // Log a warning — the FK constraint will reject the write if enabled,
        // or the task will be stored without a parent if FKs are off (test mode).
        log.warn(
          { taskId: row.id, parentId: row.parentId },
          'upsertTask: parentId references a non-existent task — parent relationship may be lost',
        );
      }
    }
  }

  const values = archiveFields ? { ...row, ...archiveFields, status: 'archived' as const } : row;
  if (insertOnly) {
    const clash = await db
      .select({ id: schema.tasks.id, title: schema.tasks.title })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, row.id))
      .limit(1)
      .all();
    if (clash.length > 0) {
      throw new CleoError(
        ExitCode.ID_COLLISION,
        `Task id ${row.id} is already taken by "${clash[0]?.title}" (another writer stored it after the id was chosen); nothing was written and no task was overwritten`,
        {
          fix: 'Run the command again: the allocator skips every stored id for `cleo add` and for the new ids an import assigns, and imports re-read every stored id, archived included, so the task now holding this id counts as existing (skipped, or replaced only with an explicit overwrite). If `cleo add` repeats this, run `cleo sequence repair`.',
        },
      );
    }
    await db.insert(schema.tasks).values(values).run();
    await updateTaskLabels(db, row.id, parseLabels(row.labelsJson));
    return;
  }
  // The canonical converter defines the write surface for both INSERT and
  // conflict UPDATE. Destructuring identity prevents an upsert from moving a
  // row; spreading the remaining fields prevents newly accepted fields from
  // disappearing on conflict (GH #401 / T12198).
  const { id: _identity, ...mutableRow } = row;
  const set = {
    ...mutableRow,
    status: archiveFields ? ('archived' as const) : row.status,
    archivedAt: archiveFields?.archivedAt ?? null,
    archiveReason: archiveFields?.archiveReason ?? null,
    cycleTimeDays: archiveFields?.cycleTimeDays ?? null,
  };
  await db
    .insert(schema.tasks)
    .values(values)
    .onConflictDoUpdate({ target: schema.tasks.id, set })
    .run();

  // T11356: keep the task_labels junction in sync with the labels_json column.
  // The junction is the index-backed membership SSoT for label filters; reads
  // join it instead of running `labels_json LIKE '%label%'` (which matched
  // across JSON array boundaries and could not use an index).
  await updateTaskLabels(db, row.id, parseLabels(row.labelsJson));
}

/**
 * Parse a `labels_json` text column into a deduplicated string-array.
 *
 * Invalid / non-array JSON yields an empty list — the junction is then emptied
 * for that task, matching the "no labels" state.
 *
 * @param labelsJson - The serialized JSON array from `tasks.labels_json`.
 * @returns Deduplicated, non-empty label strings.
 */
export function parseLabels(labelsJson: string | null | undefined): string[] {
  if (!labelsJson) return [];
  try {
    const parsed: unknown = JSON.parse(labelsJson);
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    for (const l of parsed) {
      if (typeof l === 'string' && l.length > 0) seen.add(l);
    }
    return [...seen];
  } catch {
    return [];
  }
}

/**
 * Make the {@link schema.taskLabels} junction rows for one task exactly mirror
 * its label set (T11356).
 *
 * A diff write (T12341): only labels that left the set are deleted and only
 * new ones inserted, so a save that keeps the set writes nothing. Deleting and
 * re-inserting a kept label would replicate as a tombstone plus a re-insert of
 * the same row uid, which lets a stale save resurrect a label another device
 * removed. Callers run inside the task transaction, so the read and the writes
 * see one state. Called from {@link upsertTask} and from raw-SQL proposal
 * inserters that bypass it.
 *
 * @param db - Drizzle tasks.db handle.
 * @param taskId - The owning task id.
 * @param labels - The full label set the junction should reflect.
 */
export async function updateTaskLabels(
  db: DrizzleDb,
  taskId: string,
  labels: string[],
): Promise<void> {
  const want = new Set(labels);
  const current = new Set(
    (
      await db
        .select({ label: schema.taskLabels.label })
        .from(schema.taskLabels)
        .where(eq(schema.taskLabels.taskId, taskId))
        .all()
    ).map((row) => row.label),
  );
  const removed = [...current].filter((label) => !want.has(label));
  const added = [...want].filter((label) => !current.has(label));
  if (removed.length > 0) {
    await db
      .delete(schema.taskLabels)
      .where(and(eq(schema.taskLabels.taskId, taskId), inArray(schema.taskLabels.label, removed)))
      .run();
  }
  if (added.length === 0) return;
  await db
    .insert(schema.taskLabels)
    .values(added.map((label) => ({ taskId, label })))
    .onConflictDoNothing()
    .run();
}

/**
 * Upsert a single session row into the sessions table.
 */
export async function upsertSession(db: DrizzleDb, session: Session): Promise<void> {
  const sessionName = session.name || `session-${session.id}`;
  const values = {
    id: session.id,
    name: sessionName,
    status: session.status,
    scopeJson: JSON.stringify(session.scope ?? { type: 'global' }),
    currentTask: session.taskWork?.taskId ?? null,
    taskStartedAt: session.taskWork?.setAt ?? null,
    agent: session.agent ?? null,
    notesJson: session.notes ? JSON.stringify(session.notes) : '[]',
    tasksCompletedJson: session.tasksCompleted ? JSON.stringify(session.tasksCompleted) : '[]',
    tasksCreatedJson: session.tasksCreated ? JSON.stringify(session.tasksCreated) : '[]',
    handoffJson: session.handoffJson ?? null,
    startedAt: session.startedAt,
    endedAt: session.endedAt ?? null,
    // Session chain fields (T4959)
    previousSessionId: session.previousSessionId ?? null,
    nextSessionId: session.nextSessionId ?? null,
    // Fork-tree parent edge (T11639) — sourced from CLEO_PARENT_SESSION_ID at start.
    parentSessionId: session.parentSessionId ?? null,
    // `spawnedBySessionId` is deliberately ABSENT (T12502): it is the trusted
    // spawn edge the claim chokepoint relies on, written only by the spawn
    // through `setSessionSpawnedBy`. A whole-row upsert from a session record
    // must neither wipe nor forge it.
    agentIdentifier: session.agentIdentifier ?? null,
    handoffConsumedAt: session.handoffConsumedAt ?? null,
    handoffConsumedBy: session.handoffConsumedBy ?? null,
    debriefJson: session.debriefJson ?? null,
    // Session stats fields
    statsJson: session.stats ? JSON.stringify(session.stats) : null,
    resumeCount: session.resumeCount ?? null,
    // T11578 · AC1: the consolidated `tasks_sessions.grade_mode` column is
    // `integer({ mode: 'boolean' })`, so the writer passes a boolean (drizzle
    // serializes true→1 / null→NULL) rather than the legacy raw `1`.
    gradeMode: session.gradeMode ? true : null,
    // T9975 — per-agent session isolation fields
    agentHandle: session.agentHandle ?? null,
    scopeKind: session.scopeKind ?? null,
    scopeId: session.scopeId ?? null,
    lastActivity: session.lastActivity ?? null,
  };
  const { id: _id, ...setFields } = values;
  await db
    .insert(schema.sessions)
    .values(values)
    .onConflictDoUpdate({ target: schema.sessions.id, set: setFields })
    .run();
}

/**
 * Append-able session id-list / notes columns (T11357).
 *
 * These three columns are JSON arrays that grow on session events. The
 * append-in-SQL helper below targets exactly this set.
 */
export type AppendableSessionColumn = 'notesJson' | 'tasksCompletedJson' | 'tasksCreatedJson';

/** Maps the Drizzle field name to its physical SQLite column name. */
const APPENDABLE_SESSION_COLUMNS: Record<AppendableSessionColumn, string> = {
  notesJson: 'notes_json',
  tasksCompletedJson: 'tasks_completed_json',
  tasksCreatedJson: 'tasks_created_json',
};

/**
 * Append one element to a session's JSON-array column **in SQL** via
 * `json_insert(col, '$[#]', ?)` — no app-side read-modify-write of the whole
 * array (T11357 · AC4).
 *
 * ## Why `json_insert` (TEXT) and not `jsonb_insert` (BLOB)
 *
 * `sessions.{notes,tasks_completed,tasks_created}_json` are read WHOLE by
 * `rowToSession` (`safeParseJsonArray(row.notesJson)`) and by backup/export
 * paths. Storing them as a JSONB BLOB would force every one of those readers
 * onto `json(col)` and break the plain-column reads. `json_insert` performs the
 * same `$[#]` end-of-array append the audit calls for while keeping the column
 * canonical TEXT, so existing whole-value readers stay correct. The `$[#]`
 * path is the SQLite idiom for "append to the end of the array".
 *
 * The column is coalesced to `'[]'` first so an append onto a NULL/empty column
 * yields a single-element array rather than NULL.
 *
 * @param db - Drizzle sessions.db handle (tasks.db schema).
 * @param sessionId - Target session id.
 * @param column - Which appendable array column to grow.
 * @param value - The string element to append.
 */
export async function appendSessionListItem(
  db: DrizzleDb,
  sessionId: string,
  column: AppendableSessionColumn,
  value: string,
): Promise<void> {
  const physicalColumn = APPENDABLE_SESSION_COLUMNS[column];
  // T11578 · AC1: append into the PREFIXED consolidated sessions table.
  db.run(
    sql`UPDATE tasks_sessions
        SET ${sql.raw(physicalColumn)} = json_insert(
          COALESCE(${sql.raw(physicalColumn)}, '[]'), '$[#]', ${value}
        )
        WHERE id = ${sessionId}`,
  );
}

/**
 * Make a task's dependency rows equal `depends` (optionally filtered by a set
 * of valid IDs) with a diff write (T12341): only removed edges are deleted and
 * only new ones inserted, so an unchanged set writes nothing and a kept edge is
 * never deleted and re-inserted (see {@link updateTaskLabels}).
 */
export async function updateDependencies(
  db: DrizzleDb,
  taskId: string,
  depends: string[],
  validIds?: Set<string>,
): Promise<void> {
  await batchUpdateDependencies(db, [{ taskId, deps: depends }], validIds);
}

/**
 * Batch-update dependencies for multiple tasks with one read and bulk writes.
 * A diff write (T12341): one SELECT of the current edges of these tasks, then
 * one DELETE per task for the edges that left its set, and one INSERT for all
 * new edges. Edges kept in the set are never touched.
 *
 * Callers are responsible for wrapping this in a transaction if needed.
 */
export async function batchUpdateDependencies(
  db: DrizzleDb,
  tasks: Array<{ taskId: string; deps: string[] }>,
  validIds?: Set<string>,
): Promise<void> {
  if (tasks.length === 0) return;

  const allTaskIds = tasks.map((t) => t.taskId);
  const current = new Map<string, Set<string>>();
  for (const row of await db
    .select({
      taskId: schema.taskDependencies.taskId,
      dependsOn: schema.taskDependencies.dependsOn,
    })
    .from(schema.taskDependencies)
    .where(inArray(schema.taskDependencies.taskId, allTaskIds))
    .all()) {
    const set = current.get(row.taskId) ?? new Set<string>();
    set.add(row.dependsOn);
    current.set(row.taskId, set);
  }

  const added: Array<{ taskId: string; dependsOn: string }> = [];
  for (const { taskId, deps } of tasks) {
    const want = new Set(deps.filter((depId) => !validIds || validIds.has(depId)));
    const have = current.get(taskId) ?? new Set<string>();
    const removed = [...have].filter((depId) => !want.has(depId));
    if (removed.length > 0) {
      await db
        .delete(schema.taskDependencies)
        .where(
          and(
            eq(schema.taskDependencies.taskId, taskId),
            inArray(schema.taskDependencies.dependsOn, removed),
          ),
        )
        .run();
    }
    for (const depId of want) if (!have.has(depId)) added.push({ taskId, dependsOn: depId });
  }

  if (added.length > 0) {
    await db.insert(schema.taskDependencies).values(added).onConflictDoNothing().run();
  }
}

/**
 * Batch-load persisted hard dependencies for selected tasks in-place.
 *
 * @remarks
 * Missing targets remain explicit dependency identifiers so readiness and
 * integrity checks can diagnose them. A caller's known population cannot prove
 * an omitted target is satisfied. This reader does not repair or delete edges;
 * database failures propagate to the caller. Soft relations are read separately.
 *
 * @param db - Canonical project database handle.
 * @param tasks - Selected task records to enrich with their stored hard edges.
 * @param _validationIds - Legacy argument retained for compatibility; no longer filters evidence.
 * @returns Resolves after dependencies have been read successfully.
 *
 * @example
 * ```ts
 * await loadDependenciesForTasks(db, selectedTasks);
 * // A missing target remains in depends for explicit readiness diagnostics.
 * ```
 */
export async function loadDependenciesForTasks(
  db: DrizzleDb,
  tasks: Task[],
  _validationIds?: Set<string>,
): Promise<void> {
  if (tasks.length === 0) return;
  const taskIds = tasks.map((t) => t.id);

  const allDeps = await db
    .select()
    .from(schema.taskDependencies)
    .where(inArray(schema.taskDependencies.taskId, taskIds))
    .all();

  const depMap = new Map<string, string[]>();
  for (const dep of allDeps) {
    let arr = depMap.get(dep.taskId);
    if (!arr) {
      arr = [];
      depMap.set(dep.taskId, arr);
    }
    arr.push(dep.dependsOn);
  }

  for (const task of tasks) {
    const deps = depMap.get(task.id);
    if (deps && deps.length > 0) {
      task.depends = deps;
    }
  }
}

/**
 * Batch-load relations for a list of tasks and apply them in-place.
 * Mirrors loadDependenciesForTasks pattern for task_relations table (T5168).
 */
export async function loadRelationsForTasks(db: DrizzleDb, tasks: Task[]): Promise<void> {
  if (tasks.length === 0) return;
  const taskIds = tasks.map((t) => t.id);

  const allRels = await db
    .select()
    .from(schema.taskRelations)
    .where(inArray(schema.taskRelations.taskId, taskIds))
    .all();

  const relMap = new Map<string, Array<{ taskId: string; type: string; reason?: string }>>();
  for (const rel of allRels) {
    let arr = relMap.get(rel.taskId);
    if (!arr) {
      arr = [];
      relMap.set(rel.taskId, arr);
    }
    arr.push({
      taskId: rel.relatedTo,
      type: rel.relationType,
      reason: rel.reason ?? undefined,
    });
  }

  for (const task of tasks) {
    const relations = relMap.get(task.id);
    // Always set relates from DB — overrides stale JSON blob value
    task.relates = relations && relations.length > 0 ? relations : [];
  }
}
