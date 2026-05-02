/**
 * Shared task-domain result shapes for the operations layer.
 *
 * Defines types that are:
 *  - produced by core functions in `packages/core/src/tasks/`
 *  - consumed by the dispatch layer
 *  - exposed as `Result` types in `operations/tasks.ts`
 *
 * These types are the single source of truth for the wire-format shapes.
 * Core functions import them here (via `@cleocode/contracts`) rather than
 * defining inline interfaces.
 *
 * @module tasks
 * @task T1703 — Fill 20 Result=unknown stubs in operations/tasks.ts
 * @epic T1688
 */

import type { TaskPriority, TaskStatus } from './task.js';

// ---------------------------------------------------------------------------
// TaskView types (canonical task projection consumed by SDK, CLI, and REST)
// ---------------------------------------------------------------------------

/**
 * RCASD-IVTR+C pipeline stage values valid for `TaskView.pipelineStage`.
 *
 * Mirrors `TaskViewPipelineStage` from `packages/core/src/tasks/compute-task-view.ts`.
 *
 * @task T1703
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
 * Consumers pattern-match on these to drive agent guidance without
 * duplicating the priority-ladder logic in core.
 *
 * @task T1703
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
 * All fields are empty / null when the task has no pipeline record.
 *
 * @task T1703
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
 * Required gates are always present; `documented` is `undefined` when not recorded.
 *
 * @task T1703
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
 * Direct-child rollup counts for the task (archived children excluded).
 *
 * @task T1703
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
 * Produced exclusively by `computeTaskView` in core. All surfaces that
 * previously derived their own view of a task now go through this type so
 * they cannot disagree.
 *
 * @task T1703
 */
export interface TaskView {
  /** Task identifier (e.g. `T123`). */
  id: string;
  /** Task title. */
  title: string;
  /** Canonical execution status. Mirrors `tasks.status`. */
  status: TaskStatus;
  /**
   * RCASD-IVTR+C pipeline stage this task is parked on.
   * Reads `tasks.pipelineStage` directly. `null` when not yet assigned.
   */
  pipelineStage: string | null;
  /**
   * Lifecycle progress derived from `lifecycle_pipelines` / `lifecycle_stages`.
   * Empty default when the task has no pipeline record.
   */
  lifecycleProgress: TaskViewLifecycleProgress;
  /** Aggregated counts of non-archived direct children. */
  childRollup: TaskViewChildRollup;
  /**
   * Verification gate status derived from `tasks.verification`.
   * Defaults to all `false` when the task has no verification record.
   */
  gatesStatus: TaskViewGatesStatus;
  /**
   * Whether the task is ready to be marked complete.
   * True when: required gates all green AND no unresolved blocking deps AND
   * status is not already a terminal value.
   */
  readyToComplete: boolean;
  /**
   * Suggested next action for an agent working this task.
   * Derived via a priority ladder in `computeTaskView`.
   */
  nextAction: TaskViewNextAction;
}

// ---------------------------------------------------------------------------
// Task tree node (used by tasks.tree operation)
// ---------------------------------------------------------------------------

/**
 * A single node in the flat task hierarchy tree returned by `tasks.tree`.
 *
 * Mirrors `FlatTreeNode` from `packages/core/src/tasks/task-ops.ts`.
 *
 * @task T1703
 */
export interface TaskTreeNode {
  /** Unique task identifier (e.g. "T001"). */
  id: string;
  /** Human-readable task title. */
  title: string;
  /** Current task status. */
  status: string;
  /** Task type classification. @defaultValue "task" */
  type?: string;
  /** Child nodes in the hierarchy tree. */
  children: TaskTreeNode[];
  /** Task priority level. @defaultValue "medium" */
  priority: TaskPriority;
  /** Direct dependency IDs for this task. */
  depends: string[];
  /** Open (unresolved) dependency IDs that are currently blocking this task. */
  blockedBy: string[];
  /**
   * Whether this task is immediately actionable.
   * True when `blockedBy` is empty AND status is `"pending"` or `"active"`.
   */
  ready: boolean;
  /**
   * Full transitive blocker chain. Only populated when `withBlockers` is
   * requested at tree-build time.
   * @defaultValue undefined
   */
  blockerChain?: string[];
  /**
   * Leaf-level blockers — the root-cause tasks that must be resolved first.
   * Only populated when `withBlockers` is requested at tree-build time.
   * @defaultValue undefined
   */
  leafBlockers?: string[];
}

// ---------------------------------------------------------------------------
// Task plan types (used by tasks.plan operation)
// ---------------------------------------------------------------------------

/**
 * An in-progress epic returned by the plan operation.
 *
 * Mirrors `InProgressEpic` from `packages/core/src/tasks/plan.ts`.
 *
 * @task T1703
 */
export interface TaskPlanInProgressEpic {
  /** Epic task ID. */
  epicId: string;
  /** Epic title. */
  epicTitle: string;
  /** Number of active child tasks. */
  activeTasks: number;
  /** Completion percentage (0–100). */
  completionPercent: number;
}

/**
 * A ready task entry with leverage analysis returned by the plan operation.
 *
 * Mirrors `ReadyTask` from `packages/core/src/tasks/plan.ts`.
 *
 * @task T1703
 */
export interface TaskPlanReadyTask {
  /** Task identifier. */
  id: string;
  /** Task title. */
  title: string;
  /** Task priority. */
  priority: TaskPriority;
  /** Parent epic ID. */
  epicId: string;
  /** Leverage score (higher = more impactful). */
  leverage: number;
  /** Overall planning score. */
  score: number;
  /** Human-readable reasons this task is recommended. */
  reasons: string[];
}

/**
 * A blocked task entry returned by the plan operation.
 *
 * Mirrors `BlockedTask` from `packages/core/src/tasks/plan.ts`.
 *
 * @task T1703
 */
export interface TaskPlanBlockedTask {
  /** Task identifier. */
  id: string;
  /** Task title. */
  title: string;
  /** IDs of tasks blocking this task. */
  blockedBy: string[];
  /** Number of tasks this task is blocking. */
  blocksCount: number;
}

/**
 * An open bug entry returned by the plan operation.
 *
 * Mirrors `OpenBug` from `packages/core/src/tasks/plan.ts`.
 *
 * @task T1703
 */
export interface TaskPlanOpenBug {
  /** Task identifier. */
  id: string;
  /** Task title. */
  title: string;
  /** Task priority. */
  priority: TaskPriority;
  /** Parent epic ID. */
  epicId: string;
}

/**
 * Planning metrics summary.
 *
 * Mirrors `PlanMetrics` from `packages/core/src/tasks/plan.ts`.
 *
 * @task T1703
 */
export interface TaskPlanMetrics {
  /** Total number of epics. */
  totalEpics: number;
  /** Number of currently active epics. */
  activeEpics: number;
  /** Total number of tasks across all epics. */
  totalTasks: number;
  /** Number of tasks that are ready to work on. */
  actionable: number;
  /** Number of tasks that are blocked. */
  blocked: number;
  /** Number of open bug tasks. */
  openBugs: number;
  /** Average leverage score across actionable tasks. */
  avgLeverage: number;
}

/**
 * Composite planning view result returned by `tasks.plan`.
 *
 * Mirrors `PlanResult` from `packages/core/src/tasks/plan.ts`.
 *
 * @task T1703
 */
export interface TaskPlanResult {
  /** Epics currently being worked on. */
  inProgress: TaskPlanInProgressEpic[];
  /** Tasks ready to be started. */
  ready: TaskPlanReadyTask[];
  /** Tasks blocked by dependencies. */
  blocked: TaskPlanBlockedTask[];
  /** Open bug tasks. */
  openBugs: TaskPlanOpenBug[];
  /** Aggregate planning metrics. */
  metrics: TaskPlanMetrics;
}

// ---------------------------------------------------------------------------
// Label info (used by tasks.label.list operation)
// ---------------------------------------------------------------------------

/**
 * Label entry with task counts and status breakdown.
 *
 * Mirrors the private `LabelInfo` from `packages/core/src/tasks/labels.ts`.
 *
 * @task T1703
 */
export interface TaskLabelInfo {
  /** Label text. */
  label: string;
  /** Total number of tasks with this label. */
  count: number;
  /** Breakdown of task counts by status. */
  statuses: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Complexity factor (used by tasks.complexity.estimate operation)
// ---------------------------------------------------------------------------

/**
 * A single factor contributing to a task's complexity score.
 *
 * Mirrors `ComplexityFactor` from `packages/core/src/tasks/task-ops.ts`.
 *
 * @task T1703
 */
export interface TaskComplexityFactor {
  /** Factor name (e.g. "descriptionLength", "dependencyDepth"). */
  name: string;
  /** Numeric score contribution from this factor. */
  value: number;
  /** Human-readable explanation of the score. */
  detail: string;
}

// ---------------------------------------------------------------------------
// Depends result shape (used by tasks.depends operation)
// ---------------------------------------------------------------------------

/**
 * A compact task reference in dependency results.
 * Alias kept here for operations layer use.
 */
export interface TaskDependsRef {
  /** Task identifier. */
  id: string;
  /** Task title. */
  title: string;
  /** Current task status string. */
  status: string;
}

/**
 * Full result shape returned by `tasks.depends`.
 *
 * Mirrors the return of `coreTaskDepends` from `packages/core/src/tasks/task-ops.ts`.
 *
 * @task T1703
 */
export interface TaskDependsResult {
  /** The task ID whose dependencies were analyzed. */
  taskId: string;
  /** Direction of analysis: upstream | downstream | both. */
  direction: string;
  /** Tasks that this task depends on (upstream dependencies). */
  upstream: TaskDependsRef[];
  /** Tasks that depend on this task (downstream dependents). */
  downstream: TaskDependsRef[];
  /** Count of transitive unresolved dependencies. */
  unresolvedChain: number;
  /** Leaf-level blockers — root-cause tasks that must be resolved first. */
  leafBlockers: TaskDependsRef[];
  /** Whether all declared dependencies are in a terminal status. */
  allDepsReady: boolean;
  /** Optional hint for the next CLI command to run. @defaultValue undefined */
  hint?: string;
  /** Optional upstream dependency tree (only when `tree: true` was requested). @defaultValue undefined */
  upstreamTree?: TaskTreeNode[];
}
