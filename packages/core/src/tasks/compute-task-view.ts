/**
 * Canonical task view derivation — the single source of truth for task state.
 *
 * `computeTaskView` is the SINGLE derivation function consumed by the SDK,
 * CLI, and REST surfaces. Prior to T943, `/tasks` read `status`+child-rollup,
 * `/tasks/pipeline` read `pipelineStage`, and neither consulted
 * `lifecycle_pipelines`. This function unifies all three reads into one
 * deterministic projection so every surface returns identical state.
 *
 * Design contract:
 *   - Pure read — no writes, no side effects.
 *   - `pipelineStage` reads `tasks.pipelineStage` directly (Option B cached
 *     projection). Dropping the column is deferred to the follow-up epic.
 *   - `lifecycleProgress` is derived from `lifecycle_pipelines` +
 *     `lifecycle_stages` when a pipeline record exists; graceful empty default
 *     when the task has no pipeline.
 *   - `childRollup` counts non-archived direct children only.
 *   - `gatesStatus` is populated from `tasks.verification.gates`; optional
 *     gates (`documented`) use `undefined` when absent.
 *   - `readyToComplete` requires all required gates green, no blocking deps,
 *     and non-terminal status.
 *   - `nextAction` is derived via a priority ladder so agents always know what
 *     to do next without extra logic in the caller.
 *
 * @task T943
 */

import type { DataAccessor, Task, TaskStatus } from '@cleocode/contracts';
import { getNativeTasksDb } from '../store/sqlite.js';

// =============================================================================
// TYPE DEFINITIONS
// =============================================================================

/**
 * Pipeline stages surfaced in `TaskView.pipelineStage`.
 *
 * Subset of the full RCASD-IVTR+C stage list that is relevant to a task view
 * consumer. The underlying DB allows all 10 PIPELINE_STAGES plus `cancelled`;
 * this union narrows to the 8 stages a non-cancellation task will occupy.
 *
 * @task T943
 */
export type TaskViewPipelineStage =
  | 'research'
  | 'specification'
  | 'decomposition'
  | 'implementation'
  | 'validation'
  | 'testing'
  | 'release'
  | 'contribution';

/**
 * Canonical next-action tokens emitted by `TaskView.nextAction`.
 *
 * Consumers pattern-match on these to drive their own agent guidance without
 * duplicating the priority-ladder logic.
 *
 * @task T943
 */
export type TaskViewNextAction =
  | 'verify'
  | 'advance-lifecycle'
  | 'spawn-worker'
  | 'blocked-on-deps'
  | 'awaiting-children'
  | 'already-complete'
  | 'no-action';

/**
 * Lifecycle progress derived from `lifecycle_pipelines` + `lifecycle_stages`.
 *
 * When a task has no pipeline record all fields are empty / null.
 *
 * @task T943
 */
export interface TaskViewLifecycleProgress {
  /** Stage names whose DB status is `completed`. */
  stagesCompleted: string[];
  /** Stage names whose DB status is `skipped`. */
  stagesSkipped: string[];
  /**
   * The pipeline's `currentStageId` resolved to a stage name, or `null` when
   * the task has no pipeline or the current stage has not been set.
   */
  currentStage: string | null;
}

/**
 * Verification gate status derived from `tasks.verification.gates`.
 *
 * Required gates (`implemented`, `testsPassed`, `qaPassed`) are always
 * present. Optional gates (`documented`) are `undefined` when not recorded.
 *
 * @task T943
 */
export interface TaskViewGatesStatus {
  /** Whether the `implemented` gate has passed. */
  implemented: boolean;
  /** Whether the `testsPassed` gate has passed. */
  testsPassed: boolean;
  /** Whether the `qaPassed` gate has passed. */
  qaPassed: boolean;
  /** Whether the `documented` gate has passed, or `undefined` if absent. */
  documented?: boolean;
}

/**
 * Direct-child rollup counts for the task.
 *
 * Archived children are excluded from all counts so progress bars reflect
 * in-flight scope only.
 *
 * @task T943
 */
export interface TaskViewChildRollup {
  /** Total non-archived direct children. */
  total: number;
  /** Non-archived children with `status = 'done'`. */
  done: number;
  /** Non-archived children with `status = 'blocked'`. */
  blocked: number;
  /** Non-archived children with `status = 'active'`. */
  active: number;
}

/**
 * Canonical task view — the unified projection consumed by SDK, CLI, and REST.
 *
 * Produced exclusively by `computeTaskView`. All surfaces that previously
 * derived their own view of a task now go through this type so they cannot
 * disagree.
 *
 * @task T943
 */
export interface TaskView {
  /** Task identifier (e.g. `T123`). */
  id: string;
  /** Task title. */
  title: string;
  /**
   * Canonical execution status.
   *
   * Mirrors `tasks.status` verbatim. Typed as `TaskStatus` (from contracts)
   * rather than a new union so callers do not need an adapter.
   */
  status: TaskStatus;
  /**
   * RCASD-IVTR+C pipeline stage this task is parked on.
   *
   * Reads `tasks.pipelineStage` directly (Option B cached projection per T943
   * decision). When the column is null the task has not been assigned a stage
   * yet; `'research'` is the conventional default for new epics.
   */
  pipelineStage: string | null;
  /**
   * Lifecycle progress derived from `lifecycle_pipelines` / `lifecycle_stages`.
   *
   * Empty default when the task has no pipeline record (non-epic tasks and
   * epics that have not yet been initialized with `cleo lifecycle`).
   */
  lifecycleProgress: TaskViewLifecycleProgress;
  /** Aggregated counts of non-archived direct children. */
  childRollup: TaskViewChildRollup;
  /**
   * Verification gate status derived from `tasks.verification`.
   *
   * Defaults to all `false` when the task has no verification record.
   */
  gatesStatus: TaskViewGatesStatus;
  /**
   * Whether the task is ready to be marked complete.
   *
   * True when: required gates all green AND no unresolved blocking deps AND
   * status is not already a terminal value (`done`, `cancelled`, `archived`).
   */
  readyToComplete: boolean;
  /**
   * Suggested next action for an agent working this task.
   *
   * Derived via a priority ladder:
   *   1. `already-complete`   — status is `done`/`cancelled`/`archived`
   *   2. `blocked-on-deps`    — has unresolved `depends` entries
   *   3. `awaiting-children`  — has non-archived, non-done children
   *   4. `verify`             — some required gate is false
   *   5. `advance-lifecycle`  — gates green but lifecycle stage not advanced
   *   6. `spawn-worker`       — ready to dispatch a worker agent
   *   7. `no-action`          — fallback
   */
  nextAction: TaskViewNextAction;
}

// =============================================================================
// INTERNAL HELPERS
// =============================================================================

/** Terminal task statuses — no further work needed. */
const TERMINAL_STATUSES: ReadonlySet<TaskStatus> = new Set(['done', 'cancelled', 'archived']);

/**
 * Fetch non-archived direct-child aggregates for a list of parent IDs.
 *
 * Uses the native `node:sqlite` handle for a single aggregation query rather
 * than loading every child object through the accessor — same pattern as
 * `lifecycle/rollup.ts`.
 */
function fetchChildAggregates(
  taskIds: string[],
): Map<string, { total: number; done: number; blocked: number; active: number }> {
  type AggRow = {
    parent_id: string | null;
    children_total: number | bigint | null;
    children_done: number | bigint | null;
    children_blocked: number | bigint | null;
    children_active: number | bigint | null;
  };

  const empty = new Map<string, { total: number; done: number; blocked: number; active: number }>();
  if (taskIds.length === 0) return empty;

  const native = getNativeTasksDb();
  if (!native) return empty;

  const placeholders = taskIds.map(() => '?').join(', ');
  const sqlText = `
    SELECT
      parent_id                                                       AS parent_id,
      COUNT(*)                                                        AS children_total,
      SUM(CASE WHEN status = 'done'    THEN 1 ELSE 0 END)            AS children_done,
      SUM(CASE WHEN status = 'blocked' THEN 1 ELSE 0 END)            AS children_blocked,
      SUM(CASE WHEN status = 'active'  THEN 1 ELSE 0 END)            AS children_active
    FROM tasks
    WHERE parent_id IN (${placeholders})
      AND status != 'archived'
    GROUP BY parent_id
  `;

  const rows = native.prepare(sqlText).all(...taskIds) as AggRow[];
  const map = new Map<string, { total: number; done: number; blocked: number; active: number }>();

  for (const row of rows) {
    if (row.parent_id === null) continue;
    map.set(row.parent_id, {
      total: Number(row.children_total ?? 0),
      done: Number(row.children_done ?? 0),
      blocked: Number(row.children_blocked ?? 0),
      active: Number(row.children_active ?? 0),
    });
  }
  return map;
}

/**
 * Fetch lifecycle progress for a list of task IDs.
 *
 * Queries `lifecycle_pipelines` and `lifecycle_stages` in two separate
 * statements (pipeline lookup + stage list). Gracefully degrades to an empty
 * progress record when the tables do not exist (freshly migrated DBs) or when
 * no pipeline record has been created for the task.
 */
function fetchLifecycleProgress(taskIds: string[]): Map<string, TaskViewLifecycleProgress> {
  type PipelineRow = {
    task_id: string | null;
    current_stage_id: string | null;
    pipeline_id: string | null;
  };
  type StageRow = {
    pipeline_id: string | null;
    stage_name: string | null;
    status: string | null;
  };

  const empty = new Map<string, TaskViewLifecycleProgress>();
  if (taskIds.length === 0) return empty;

  const native = getNativeTasksDb();
  if (!native) return empty;

  // Default empty progress for tasks that have no pipeline record.
  const emptyProgress = (): TaskViewLifecycleProgress => ({
    stagesCompleted: [],
    stagesSkipped: [],
    currentStage: null,
  });

  let pipelineRows: PipelineRow[];
  try {
    const placeholders = taskIds.map(() => '?').join(', ');
    pipelineRows = native
      .prepare(
        `SELECT task_id, current_stage_id, id AS pipeline_id
         FROM lifecycle_pipelines
         WHERE task_id IN (${placeholders})`,
      )
      .all(...taskIds) as PipelineRow[];
  } catch {
    // Table may not exist on old schemas.
    for (const id of taskIds) empty.set(id, emptyProgress());
    return empty;
  }

  // Build pipeline_id → task_id map and set initial empty progress for each.
  const pipelineIdToTaskId = new Map<string, string>();
  // track current_stage_id per task
  const currentStageIdByTaskId = new Map<string, string | null>();

  for (const row of pipelineRows) {
    if (row.task_id === null || row.pipeline_id === null) continue;
    pipelineIdToTaskId.set(row.pipeline_id, row.task_id);
    currentStageIdByTaskId.set(row.task_id, row.current_stage_id ?? null);
    empty.set(row.task_id, emptyProgress());
  }

  // Tasks with no pipeline row get the empty default.
  for (const id of taskIds) {
    if (!empty.has(id)) empty.set(id, emptyProgress());
  }

  if (pipelineIdToTaskId.size === 0) return empty;

  // Fetch all stage rows for found pipelines in one query.
  let stageRows: StageRow[];
  try {
    const pipelineIds = Array.from(pipelineIdToTaskId.keys());
    const stagePlaceholders = pipelineIds.map(() => '?').join(', ');
    stageRows = native
      .prepare(
        `SELECT pipeline_id, stage_name, status, id AS stage_id
         FROM lifecycle_stages
         WHERE pipeline_id IN (${stagePlaceholders})`,
      )
      .all(...pipelineIds) as StageRow[];
  } catch {
    // lifecycle_stages may not exist.
    return empty;
  }

  // Also need stage IDs to resolve current_stage_id → stage_name.
  type StageWithId = StageRow & { stage_id: string | null };
  const stageRowsWithId = stageRows as StageWithId[];

  // Build stageId → stageName map for resolving current_stage_id.
  const stageIdToName = new Map<string, string>();
  for (const row of stageRowsWithId) {
    if (row.stage_id !== null && row.stage_name !== null) {
      stageIdToName.set(row.stage_id, row.stage_name);
    }
  }

  // Populate progress per task.
  for (const row of stageRows) {
    if (row.pipeline_id === null || row.stage_name === null || row.status === null) continue;
    const taskId = pipelineIdToTaskId.get(row.pipeline_id);
    if (taskId === undefined) continue;
    const progress = empty.get(taskId);
    if (progress === undefined) continue;

    if (row.status === 'completed') progress.stagesCompleted.push(row.stage_name);
    if (row.status === 'skipped') progress.stagesSkipped.push(row.stage_name);
  }

  // Resolve current_stage_id to stage_name.
  for (const [taskId, currentStageId] of currentStageIdByTaskId) {
    const progress = empty.get(taskId);
    if (progress === undefined) continue;
    if (currentStageId !== null) {
      progress.currentStage = stageIdToName.get(currentStageId) ?? null;
    }
  }

  return empty;
}

/**
 * Derive `gatesStatus` from a raw `tasks.verification` object.
 *
 * The `verification` column stores a JSON blob whose `gates` key maps
 * `VerificationGate` names to `boolean | null`. We normalize everything
 * to `boolean` (null → false) for the view output.
 */
function deriveGatesStatus(task: Task): TaskViewGatesStatus {
  const gates = task.verification?.gates ?? {};
  return {
    implemented: gates['implemented'] === true,
    testsPassed: gates['testsPassed'] === true,
    qaPassed: gates['qaPassed'] === true,
    // Optional gate: only include when explicitly recorded.
    ...(gates['documented'] !== undefined && { documented: gates['documented'] === true }),
  };
}

/**
 * Determine whether the task is ready to be completed.
 *
 * Conditions (all must hold):
 *   1. Status is not already terminal.
 *   2. Required gates `implemented`, `testsPassed`, `qaPassed` are all `true`.
 *   3. No unresolved `depends` entries (all deps are `done` or `cancelled`).
 */
function deriveReadyToComplete(
  task: Task,
  gatesStatus: TaskViewGatesStatus,
  resolvedDeps: Set<string>,
): boolean {
  if (TERMINAL_STATUSES.has(task.status)) return false;
  if (!gatesStatus.implemented || !gatesStatus.testsPassed || !gatesStatus.qaPassed) return false;

  // Check for any unresolved dependencies.
  const unresolvedDeps = (task.depends ?? []).filter((id) => !resolvedDeps.has(id));
  if (unresolvedDeps.length > 0) return false;

  return true;
}

/**
 * Derive the `nextAction` token via the priority ladder.
 *
 * Ladder (first match wins):
 *   1. already-complete   — terminal status
 *   2. blocked-on-deps    — unresolved dependencies exist
 *   3. awaiting-children  — non-done non-archived children exist
 *   4. verify             — a required gate is not green
 *   5. advance-lifecycle  — gates green but lifecycle stage not at contribution
 *   6. spawn-worker       — ready to dispatch a child worker
 *   7. no-action          — fallback
 */
function deriveNextAction(
  task: Task,
  gatesStatus: TaskViewGatesStatus,
  childRollup: TaskViewChildRollup,
  lifecycleProgress: TaskViewLifecycleProgress,
  resolvedDeps: Set<string>,
): TaskViewNextAction {
  // 1. Terminal status — nothing to do.
  if (TERMINAL_STATUSES.has(task.status)) return 'already-complete';

  // 2. Blocked on dependencies.
  const unresolvedDeps = (task.depends ?? []).filter((id) => !resolvedDeps.has(id));
  if (unresolvedDeps.length > 0) return 'blocked-on-deps';

  // 3. Awaiting children (epic-level task with active/pending children).
  const pendingChildren = childRollup.total - childRollup.done;
  if (pendingChildren > 0) return 'awaiting-children';

  // 4. Verification gates not all green.
  if (!gatesStatus.implemented || !gatesStatus.testsPassed || !gatesStatus.qaPassed) {
    return 'verify';
  }

  // 5. Gates green — check whether lifecycle has been advanced to contribution.
  const atContribution =
    lifecycleProgress.stagesCompleted.includes('contribution') ||
    lifecycleProgress.currentStage === 'contribution';
  if (!atContribution && task.type === 'epic') return 'advance-lifecycle';

  // 6. All gates green, no children blocking, lifecycle advanced.
  if (task.status === 'pending' || task.status === 'active') return 'spawn-worker';

  // 7. Fallback.
  return 'no-action';
}

// =============================================================================
// PUBLIC API
// =============================================================================

/**
 * Compute the canonical {@link TaskView} for a single task.
 *
 * All reads happen in three phases:
 *   1. Task row — via `accessor.loadSingleTask`.
 *   2. Child aggregates + lifecycle progress — two native SQL queries.
 *   3. Dependency resolution — via `accessor.loadTasks` for `task.depends`.
 *
 * Returns `null` when the task does not exist.
 *
 * @param taskId  - Identifier of the task to project (e.g. `T123`).
 * @param accessor - Storage accessor for the target project's tasks.db.
 * @returns The projected view, or `null` if the task is missing.
 *
 * @example
 * ```ts
 * const view = await computeTaskView('T123', accessor);
 * if (view) {
 *   console.log(view.nextAction); // 'verify' | 'spawn-worker' | …
 * }
 * ```
 *
 * @task T943
 */
export async function computeTaskView(
  taskId: string,
  accessor: DataAccessor,
): Promise<TaskView | null> {
  const task = await accessor.loadSingleTask(taskId);
  if (task === null) return null;

  return buildViewFromTask(task, accessor);
}

/**
 * Compute canonical {@link TaskView}s for many tasks in a single batch.
 *
 * Issues exactly one task load, one child-aggregate query, and one lifecycle
 * query regardless of batch size. Results preserve input order; missing IDs
 * are omitted from the return array.
 *
 * @param taskIds  - Ordered list of task identifiers.
 * @param accessor - Storage accessor for the target project's tasks.db.
 * @returns Views in input order, minus any missing IDs.
 *
 * @task T943
 */
export async function computeTaskViews(
  taskIds: string[],
  accessor: DataAccessor,
): Promise<TaskView[]> {
  if (taskIds.length === 0) return [];

  const loaded = await accessor.loadTasks(taskIds);
  const byId = new Map<string, Task>();
  for (const task of loaded) byId.set(task.id, task);

  const presentIds = taskIds.filter((id) => byId.has(id));
  const childMap = fetchChildAggregates(presentIds);
  const lifecycleMap = fetchLifecycleProgress(presentIds);

  // Collect all dependency IDs across all tasks for a single batch resolution.
  const allDepIds = new Set<string>();
  for (const task of loaded) {
    for (const depId of task.depends ?? []) allDepIds.add(depId);
  }
  const depTasks = allDepIds.size > 0 ? await accessor.loadTasks(Array.from(allDepIds)) : [];
  const resolvedDepIds = new Set(
    depTasks.filter((t) => t.status === 'done' || t.status === 'cancelled').map((t) => t.id),
  );

  const views: TaskView[] = [];
  for (const id of taskIds) {
    const task = byId.get(id);
    if (task === undefined) continue;

    const childRollup: TaskViewChildRollup = childMap.get(id) ?? {
      total: 0,
      done: 0,
      blocked: 0,
      active: 0,
    };
    const lifecycleProgress: TaskViewLifecycleProgress = lifecycleMap.get(id) ?? {
      stagesCompleted: [],
      stagesSkipped: [],
      currentStage: null,
    };
    const gatesStatus = deriveGatesStatus(task);
    const readyToComplete = deriveReadyToComplete(task, gatesStatus, resolvedDepIds);
    const nextAction = deriveNextAction(
      task,
      gatesStatus,
      childRollup,
      lifecycleProgress,
      resolvedDepIds,
    );

    views.push({
      id: task.id,
      title: task.title,
      status: task.status,
      pipelineStage: task.pipelineStage ?? null,
      lifecycleProgress,
      childRollup,
      gatesStatus,
      readyToComplete,
      nextAction,
    });
  }
  return views;
}

// ---------------------------------------------------------------------------
// Internal single-task builder (shared by computeTaskView and computeTaskViews)
// ---------------------------------------------------------------------------

async function buildViewFromTask(task: Task, accessor: DataAccessor): Promise<TaskView> {
  const childMap = fetchChildAggregates([task.id]);
  const lifecycleMap = fetchLifecycleProgress([task.id]);

  // Resolve dependency statuses.
  const depTasks =
    (task.depends ?? []).length > 0 ? await accessor.loadTasks(task.depends ?? []) : [];
  const resolvedDepIds = new Set(
    depTasks.filter((t) => t.status === 'done' || t.status === 'cancelled').map((t) => t.id),
  );

  const childRollup: TaskViewChildRollup = childMap.get(task.id) ?? {
    total: 0,
    done: 0,
    blocked: 0,
    active: 0,
  };
  const lifecycleProgress: TaskViewLifecycleProgress = lifecycleMap.get(task.id) ?? {
    stagesCompleted: [],
    stagesSkipped: [],
    currentStage: null,
  };
  const gatesStatus = deriveGatesStatus(task);
  const readyToComplete = deriveReadyToComplete(task, gatesStatus, resolvedDepIds);
  const nextAction = deriveNextAction(
    task,
    gatesStatus,
    childRollup,
    lifecycleProgress,
    resolvedDepIds,
  );

  return {
    id: task.id,
    title: task.title,
    status: task.status,
    pipelineStage: task.pipelineStage ?? null,
    lifecycleProgress,
    childRollup,
    gatesStatus,
    readyToComplete,
    nextAction,
  };
}
