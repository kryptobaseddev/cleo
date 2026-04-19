/**
 * Task rollup — canonical view of a task's execution + pipeline + children state.
 *
 * `computeTaskRollup` is the SINGLE source of truth consumed by Studio, the
 * SDK, and the CLI for answering "what is the state of this task?" Prior to
 * T943 each surface independently stitched together `tasks.status`,
 * `tasks.pipelineStage`, child counts, and gate results, producing divergent
 * views (e.g. `/tasks` vs `/tasks/pipeline` disagreeing about epic progress).
 *
 * Design contract:
 *   - Pure read — no writes, no side effects.
 *   - `pipelineStage` reads `tasks.pipelineStage` directly until T947 migrates
 *     it to the derived lifecycle view.
 *   - Archived children are EXCLUDED from both `childrenTotal` and
 *     `childrenDone` so epic-progress bars reflect in-flight scope.
 *   - `gatesVerified` is populated only when `lifecycle_gate_results` has at
 *     least one `result='pass'` row linked to a stage owned by this task's
 *     pipeline. Missing rows → empty array.
 *   - `blockedBy` parses `tasks.blocked_by` robustly: JSON array, falling back
 *     to comma-separated tokens, falling back to the raw string, and
 *     collapsing to `[]` on empty/null.
 *   - Batch API (`computeTaskRollups`) preserves input order and returns the
 *     entries for missing task IDs as `null`-free by filtering them out. The
 *     caller can re-align using the returned `id`s.
 *
 * @task T943
 */

import type { DataAccessor, Task, TaskStatus } from '@cleocode/contracts';
import { getNativeTasksDb } from '../store/sqlite.js';

/**
 * Canonical execution status exposed on a {@link TaskRollup}.
 *
 * Mirrors {@link TaskStatus} from contracts plus the forward-looking
 * `'proposed'` value that upcoming task-intake work (T947+) will emit before
 * a task is admitted to the active board.
 */
export type RollupExecStatus =
  | 'pending'
  | 'active'
  | 'blocked'
  | 'done'
  | 'cancelled'
  | 'archived'
  | 'proposed';

/**
 * Canonical task rollup consumed by Studio, SDK and CLI surfaces.
 *
 * Every field is derived deterministically from the tasks table plus
 * `lifecycle_gate_results`. No persisted `_rollup` blob exists — the rollup
 * is recomputed on demand so it stays in sync with the underlying rows.
 */
export interface TaskRollup {
  /** Task identifier (e.g. `T123`). */
  id: string;
  /** Canonical execution status. Mirrors `tasks.status`. */
  execStatus: RollupExecStatus;
  /**
   * RCASD-IVTR+C pipeline stage this task is parked on.
   *
   * Reads `tasks.pipelineStage` verbatim. `null` when the task has never been
   * associated with a pipeline. A future wave (T947) will derive this value
   * from `lifecycle_stages` for epics that own a pipeline record.
   */
  pipelineStage: string | null;
  /**
   * Names of gates that have at least one `pass` result against this task's
   * pipeline. Empty when no gate rows exist yet.
   */
  gatesVerified: string[];
  /** Count of non-archived direct children whose status is `done`. */
  childrenDone: number;
  /** Count of non-archived direct children (any non-archived status). */
  childrenTotal: number;
  /** Tokens parsed from `tasks.blocked_by`. Empty when the column is null/blank. */
  blockedBy: string[];
  /**
   * ISO timestamp of the most recent activity on the task — `max(updatedAt,
   * completedAt)`. `null` when neither is set.
   */
  lastActivityAt: string | null;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

// Raw SQL output rows are consumed with inline `as Array<{...}>` casts below,
// matching the idiom used elsewhere in packages/core (see `upgrade.ts`,
// `sqlite-data-accessor.ts`). Named interfaces trip TS's stricter
// `Record<string, SQLOutputValue>` → interface conversion check.

/**
 * Parse the `tasks.blocked_by` text column into a canonical string array.
 *
 * Strategy (first match wins):
 *   1. Non-empty JSON array of strings → use as-is after trimming.
 *   2. Comma-separated list → split + trim + drop empties.
 *   3. Single non-empty token → wrap in a one-element array.
 *   4. Null / empty / whitespace-only → empty array.
 *
 * Never throws; silently falls back to the next strategy on parse error.
 */
function parseBlockedBy(raw: string | null | undefined): string[] {
  if (raw === null || raw === undefined) return [];
  const trimmed = raw.trim();
  if (trimmed.length === 0) return [];

  if (trimmed.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed
          .filter((v): v is string => typeof v === 'string')
          .map((v) => v.trim())
          .filter((v) => v.length > 0);
      }
    } catch {
      // fall through to csv / single-token handling
    }
  }

  if (trimmed.includes(',')) {
    return trimmed
      .split(',')
      .map((v) => v.trim())
      .filter((v) => v.length > 0);
  }

  return [trimmed];
}

/**
 * Compute the `lastActivityAt` timestamp.
 *
 * Preference order: `completedAt` vs `updatedAt`, whichever is lexicographically
 * greater (ISO-8601 strings sort correctly when both use the same zone).
 * Returns `null` when neither is set.
 */
function computeLastActivityAt(
  updatedAt: string | null | undefined,
  completedAt: string | null | undefined,
): string | null {
  const u = updatedAt ?? null;
  const c = completedAt ?? null;
  if (u === null && c === null) return null;
  if (u === null) return c;
  if (c === null) return u;
  return u >= c ? u : c;
}

/**
 * Normalise a raw `tasks.status` enum value into a {@link RollupExecStatus}.
 *
 * Every value the DB CHECK constraint allows is already a member of the
 * rollup union, so this is a pure widening cast — but we keep it centralised
 * so the T947 migration (`proposed` from external intake) has one place to
 * hook into.
 */
function toRollupExecStatus(status: TaskStatus): RollupExecStatus {
  return status;
}

/**
 * Aggregate non-archived children per parent in a single query.
 *
 * Returns a map keyed by parent_id with `{ total, done }` counts. Parents with
 * zero non-archived children are omitted so the caller defaults to 0.
 */
function fetchChildAggregates(taskIds: string[]): Map<string, { total: number; done: number }> {
  const empty = new Map<string, { total: number; done: number }>();
  if (taskIds.length === 0) return empty;

  const native = getNativeTasksDb();
  if (!native) return empty;

  const placeholders = taskIds.map(() => '?').join(', ');
  const sqlText = `
    SELECT
      parent_id           AS parent_id,
      COUNT(*)            AS children_total,
      SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS children_done
    FROM tasks
    WHERE parent_id IN (${placeholders})
      AND status != 'archived'
    GROUP BY parent_id
  `;

  const rows = native.prepare(sqlText).all(...taskIds) as Array<{
    parent_id: string | null;
    children_total: number | bigint | null;
    children_done: number | bigint | null;
  }>;

  const map = new Map<string, { total: number; done: number }>();
  for (const row of rows) {
    if (row.parent_id === null) continue;
    map.set(row.parent_id, {
      total: Number(row.children_total ?? 0),
      done: Number(row.children_done ?? 0),
    });
  }
  return map;
}

/**
 * Fetch gate names with `result='pass'` for every task in a single query.
 *
 * Joins `lifecycle_gate_results` → `lifecycle_stages` → `lifecycle_pipelines`
 * and filters by `pipelines.task_id`. Returns `[]` per-task when the task has
 * no pipeline or when every gate result is non-pass.
 */
function fetchPassedGateNames(taskIds: string[]): Map<string, string[]> {
  const empty = new Map<string, string[]>();
  if (taskIds.length === 0) return empty;

  const native = getNativeTasksDb();
  if (!native) return empty;

  const placeholders = taskIds.map(() => '?').join(', ');
  const sqlText = `
    SELECT DISTINCT
      p.task_id   AS task_id,
      g.gate_name AS gate_name
    FROM lifecycle_gate_results g
    INNER JOIN lifecycle_stages s     ON s.id = g.stage_id
    INNER JOIN lifecycle_pipelines p  ON p.id = s.pipeline_id
    WHERE p.task_id IN (${placeholders})
      AND g.result = 'pass'
    ORDER BY g.gate_name ASC
  `;

  let rows: Array<{ task_id: string | null; gate_name: string | null }>;
  try {
    rows = native.prepare(sqlText).all(...taskIds) as Array<{
      task_id: string | null;
      gate_name: string | null;
    }>;
  } catch {
    // lifecycle_gate_results may not exist on freshly migrated DBs — degrade
    // gracefully rather than propagating a low-level driver error.
    return empty;
  }

  const map = new Map<string, string[]>();
  for (const row of rows) {
    if (row.task_id === null || row.gate_name === null) continue;
    const list = map.get(row.task_id);
    if (list === undefined) {
      map.set(row.task_id, [row.gate_name]);
    } else if (!list.includes(row.gate_name)) {
      list.push(row.gate_name);
    }
  }
  return map;
}

/**
 * Assemble a {@link TaskRollup} from its raw inputs.
 */
function buildRollup(
  task: Task,
  childAggregate: { total: number; done: number } | undefined,
  gatesVerified: string[],
): TaskRollup {
  return {
    id: task.id,
    execStatus: toRollupExecStatus(task.status),
    pipelineStage: task.pipelineStage ?? null,
    gatesVerified,
    childrenTotal: childAggregate?.total ?? 0,
    childrenDone: childAggregate?.done ?? 0,
    blockedBy: parseBlockedBy(task.blockedBy),
    lastActivityAt: computeLastActivityAt(task.updatedAt, task.completedAt),
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compute the canonical {@link TaskRollup} for a single task.
 *
 * Performs three reads:
 *   1. `accessor.loadSingleTask` → the target row.
 *   2. One aggregated SQL query → direct-child counts.
 *   3. One aggregated SQL query → passed gate names (may be empty).
 *
 * Returns `null` when the task does not exist. The rollup of an archived task
 * is still returned — consumers filter on `execStatus` themselves.
 *
 * @param taskId - Identifier of the task to roll up (e.g. `T123`).
 * @param dataAccessor - Storage accessor used for the task lookup.
 * @returns The rollup or `null` when the task is missing.
 */
export async function computeTaskRollup(
  taskId: string,
  dataAccessor: DataAccessor,
): Promise<TaskRollup | null> {
  const task = await dataAccessor.loadSingleTask(taskId);
  if (task === null) return null;

  const childMap = fetchChildAggregates([taskId]);
  const gateMap = fetchPassedGateNames([taskId]);

  return buildRollup(task, childMap.get(taskId), gateMap.get(taskId) ?? []);
}

/**
 * Compute rollups for many tasks in a single batch.
 *
 * Issues exactly one task load, one child-aggregate query, and one gate query
 * regardless of batch size. Results preserve the input order of `taskIds`.
 * Missing IDs are omitted from the return array — the caller can detect them
 * by comparing `taskIds.length` vs `result.length` or by mapping on `id`.
 *
 * @param taskIds - Ordered list of task identifiers to roll up.
 * @param dataAccessor - Storage accessor used for the batched task load.
 * @returns Rollups in the same order as `taskIds`, minus any missing ids.
 */
export async function computeTaskRollups(
  taskIds: string[],
  dataAccessor: DataAccessor,
): Promise<TaskRollup[]> {
  if (taskIds.length === 0) return [];

  const loaded = await dataAccessor.loadTasks(taskIds);
  const byId = new Map<string, Task>();
  for (const task of loaded) {
    byId.set(task.id, task);
  }

  const presentIds = taskIds.filter((id) => byId.has(id));
  const childMap = fetchChildAggregates(presentIds);
  const gateMap = fetchPassedGateNames(presentIds);

  const rollups: TaskRollup[] = [];
  for (const id of taskIds) {
    const task = byId.get(id);
    if (task === undefined) continue;
    rollups.push(buildRollup(task, childMap.get(id), gateMap.get(id) ?? []));
  }
  return rollups;
}
