/**
 * Shared database helper functions for SQLite store modules.
 *
 * Consolidates upsert and dependency patterns used across
 * sqlite-data-accessor.ts, tasks-sqlite.ts, and session-store.ts.
 *
 * @epic T4454
 */

import type { ArchiveReasonValue, Session, Task } from '@cleocode/contracts';
import { eq, inArray, sql } from 'drizzle-orm';
import type { NodeSQLiteDatabase } from 'drizzle-orm/node-sqlite';
import { getLogger } from '../logger.js';
import type { NewTaskRow } from './tasks-schema.js';
import * as schema from './tasks-schema.js';

const log = getLogger('db-helpers');

/** Drizzle database instance type. */
type DrizzleDb = NodeSQLiteDatabase<typeof schema>;

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
  // Validate parentId exists before writing (T5034, T585).
  // In bulk/archive mode (allowOrphanParent=true) we silently null it out to
  // avoid FK violations during migrations. In normal mode we log a warning so
  // the data integrity issue surfaces without breaking the write.
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
  // GH #401 / T9839: the `set` clause defines which columns are updated on
  // ON CONFLICT (id) DO UPDATE. Any column omitted from this object is
  // SILENTLY DROPPED on update — INSERT carries the field, but UPDATE does
  // not. This caused a critical data-integrity bug where `severity`, `kind`,
  // and `scope` (added by T944/T9072/T9073 but never appended to the SET
  // clause) appeared to update in the response envelope while the underlying
  // DB row was unchanged. Treat this list as load-bearing: any new column on
  // the `tasks` table MUST be mirrored here.
  const set: Record<string, unknown> = {
    title: row.title,
    description: row.description,
    status: archiveFields ? 'archived' : row.status,
    priority: row.priority,
    type: row.type,
    // T944 / GH #401: kind axis (DB col 'role') — must be in set clause
    // so update persists changes. Undefined skips the column (preserves DB
    // value); a concrete value overwrites it.
    kind: row.kind,
    // T944 / GH #401: scope axis — same persistence requirement.
    scope: row.scope,
    // T9073 / GH #401: severity — owner-write-only axis (nullable).
    // Same undefined-skips-update semantics as the other axes.
    severity: row.severity,
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
    // T060: pipeline stage name (RCASD-IVTR+C)
    pipelineStage: row.pipelineStage ?? null,
    assignee: row.assignee ?? null,
    // Always include archive metadata so unarchive clears stale values (T5034)
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
 * Replace the {@link schema.taskLabels} junction rows for one task so they
 * exactly mirror its label set (T11356).
 *
 * Delete-then-insert keeps the junction authoritative without read-modify-write
 * races: the prior label set is dropped and the supplied set re-inserted. Called
 * from {@link upsertTask} and from raw-SQL proposal inserters that bypass it.
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
  await db.delete(schema.taskLabels).where(eq(schema.taskLabels.taskId, taskId)).run();
  if (labels.length === 0) return;
  await db
    .insert(schema.taskLabels)
    .values(labels.map((label) => ({ taskId, label })))
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
 * Update dependencies for a task: delete existing, then re-insert.
 * Optionally filters by a set of valid IDs.
 */
export async function updateDependencies(
  db: DrizzleDb,
  taskId: string,
  depends: string[],
  validIds?: Set<string>,
): Promise<void> {
  await db.delete(schema.taskDependencies).where(eq(schema.taskDependencies.taskId, taskId)).run();
  for (const depId of depends) {
    if (!validIds || validIds.has(depId)) {
      await db
        .insert(schema.taskDependencies)
        .values({ taskId, dependsOn: depId })
        .onConflictDoNothing()
        .run();
    }
  }
}

/**
 * Batch-update dependencies for multiple tasks in two bulk SQL operations.
 * Replaces per-task updateDependencies() loops with:
 * 1. Single DELETE for all task IDs
 * 2. Single INSERT for all dependency rows
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

  // Single DELETE: remove all existing dependencies for these tasks
  await db
    .delete(schema.taskDependencies)
    .where(inArray(schema.taskDependencies.taskId, allTaskIds))
    .run();

  // Collect all valid dependency rows
  const allDepRows: Array<{ taskId: string; dependsOn: string }> = [];
  for (const { taskId, deps } of tasks) {
    for (const depId of deps) {
      if (!validIds || validIds.has(depId)) {
        allDepRows.push({ taskId, dependsOn: depId });
      }
    }
  }

  // Single INSERT for all dependency rows
  if (allDepRows.length > 0) {
    await db.insert(schema.taskDependencies).values(allDepRows).onConflictDoNothing().run();
  }
}

/**
 * Batch-load dependencies for a list of tasks and apply them in-place.
 * Uses inArray for efficient querying. Optionally filters by a set of valid IDs.
 */
export async function loadDependenciesForTasks(
  db: DrizzleDb,
  tasks: Task[],
  validationIds?: Set<string>,
): Promise<void> {
  if (tasks.length === 0) return;
  const taskIds = tasks.map((t) => t.id);
  const taskIdSet = validationIds ?? new Set(taskIds);

  const allDeps = await db
    .select()
    .from(schema.taskDependencies)
    .where(inArray(schema.taskDependencies.taskId, taskIds))
    .all();

  const depMap = new Map<string, string[]>();
  for (const dep of allDeps) {
    if (taskIdSet.has(dep.dependsOn)) {
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
