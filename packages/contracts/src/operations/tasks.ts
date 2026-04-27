/**
 * Tasks Domain Operations (22 operations)
 *
 * Query operations: 10
 * Mutate operations: 12
 *
 * SYNC: Canonical type definitions live in the CLI package at:
 *   src/types/task.ts (TaskStatus, TaskPriority, Task, etc.)
 * These operation types are the API contract (wire format).
 * Internal domain types must stay aligned with CLI definitions.
 */

/**
 * Common task types (API contract — matches CLI src/types/task.ts)
 */
import type { TaskStatus } from '../status-registry.js';

export type { TaskStatus };
export type TaskPriority = 'low' | 'medium' | 'high' | 'critical';

export interface TaskOp {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority?: TaskPriority;
  parent?: string;
  depends?: string[];
  labels?: string[];
  created: string;
  updated: string;
  completed?: string;
  notes?: string[];
}

export interface MinimalTask {
  id: string;
  title: string;
  status: TaskStatus;
  parent?: string;
}

/**
 * Query Operations
 */

// tasks.get
export interface TasksGetParams {
  taskId: string;
}
export type TasksGetResult = TaskOp;

// tasks.list
export interface TasksListParams {
  parent?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  type?: string;
  phase?: string;
  label?: string;
  children?: boolean;
  limit?: number;
  offset?: number;
  compact?: boolean;
}
export interface TasksListResult {
  tasks: TaskOp[];
  total: number;
  filtered: number;
}

// tasks.find
/**
 * Parameters for `tasks.find`.
 *
 * @remarks
 * Re-synced to match `taskFind(projectRoot, query, limit, options)` in the
 * dispatch layer. Legacy contract exposed only `{query, limit}` and hid
 * the 7 additional filter options agents actually need.
 *
 * @task T963 — contract↔impl drift reconciliation (T910 audit)
 */
export interface TasksFindParams {
  /** Free-text search query. @task T963 */
  query: string;
  /** Max results. @task T963 */
  limit?: number;
  /** Exact task ID lookup (bypasses search). @task T963 */
  id?: string;
  /** When true, require exact string match instead of fuzzy. @task T963 */
  exact?: boolean;
  /** Filter by status. @task T963 */
  status?: TaskStatus;
  /** When true, include archived tasks in the search. @task T963 */
  includeArchive?: boolean;
  /** Offset into the results (pagination). @task T963 */
  offset?: number;
  /**
   * Comma-separated field projection (e.g. `'id,title,status'`) to shrink
   * the wire payload.
   * @task T963
   */
  fields?: string;
  /** When true, emit verbose per-match diagnostic fields. @task T963 */
  verbose?: boolean;
  /**
   * Filter by role axis (T944 — orthogonal axes).
   * Accepts the same values as the `role` field on TasksCreateParams.
   * @task T963 / T944
   */
  role?: string;
}
export type TasksFindResult = MinimalTask[];

// tasks.exists
export interface TasksExistsParams {
  taskId: string;
}
export interface TasksExistsResult {
  exists: boolean;
  taskId: string;
}

// tasks.tree
export interface TasksTreeParams {
  rootId?: string;
  depth?: number;
}
export interface TaskTreeNode {
  task: TaskOp;
  children: TaskTreeNode[];
  depth: number;
}
export type TasksTreeResult = TaskTreeNode[];

// tasks.blockers
export interface TasksBlockersParams {
  taskId: string;
}
export interface Blocker {
  taskId: string;
  title: string;
  status: TaskStatus;
  blockType: 'dependency' | 'parent' | 'gate';
}
export type TasksBlockersResult = Blocker[];

// tasks.deps
export interface TasksDepsParams {
  taskId: string;
  direction?: 'upstream' | 'downstream' | 'both';
}
export interface TaskDependencyNode {
  taskId: string;
  title: string;
  status: TaskStatus;
  distance: number;
}
export interface TasksDepsResult {
  taskId: string;
  upstream: TaskDependencyNode[];
  downstream: TaskDependencyNode[];
}

// tasks.analyze
export interface TasksAnalyzeParams {
  epicId?: string;
}
export interface TriageRecommendation {
  taskId: string;
  title: string;
  priority: number;
  reason: string;
  readiness: 'ready' | 'blocked' | 'pending';
}
export type TasksAnalyzeResult = TriageRecommendation[];

// tasks.next
export interface TasksNextParams {
  epicId?: string;
  count?: number;
}
export interface SuggestedTask {
  taskId: string;
  title: string;
  score: number;
  rationale: string;
}
export type TasksNextResult = SuggestedTask[];

/**
 * Mutate Operations
 */

// tasks.create
/**
 * Parameters for `tasks.create` / `tasks.add`.
 *
 * @remarks
 * Re-synced to match `AddTaskOptions` in `packages/core/src/tasks/add.ts`
 * and the dispatch handler in `packages/cleo/src/dispatch/domains/tasks.ts`.
 * The legacy contract was missing 8 fields (`type`, `acceptance`, `phase`,
 * `size`, `notes`, `files`, `dryRun`, `parentSearch`) — agents following
 * the contract would omit them and fail CLEO's anti-hallucination + epic
 * creation enforcement.
 *
 * @task T963 — contract↔impl drift reconciliation (T910 audit)
 */
export interface TasksCreateParams {
  /** Task title (required, 1..200 chars). @task T963 */
  title: string;
  /**
   * Task description (required by anti-hallucination rule T5698 — must
   * differ from `title`). The legacy contract marked this required; kept
   * required here to preserve behavior.
   * @task T963
   */
  description: string;
  /** Parent task id (`T###`). Omit for root-level tasks (epics only). @task T963 */
  parent?: string;
  /** Task IDs this task depends on. @task T963 */
  depends?: string[];
  /** Priority (`critical`|`high`|`medium`|`low`). Defaults to `medium`. @task T963 */
  priority?: TaskPriority;
  /** Label tags (lowercase alphanumeric + hyphens/periods). @task T963 */
  labels?: string[];
  /**
   * Task type. When omitted, inferred from parent (epic-child → `task`,
   * task-child → `subtask`, rootless → `task`). @task T963
   */
  type?: 'epic' | 'task' | 'subtask';
  /**
   * Acceptance criteria (pipe-separated strings). Minimum 3 required by
   * enforcement layer; epics require minimum 5.
   * @task T963
   */
  acceptance?: string[];
  /** Phase slug (lowercase alphanumeric + hyphens). @task T963 */
  phase?: string;
  /** Task size (`small`|`medium`|`large`). Defaults to `medium`. @task T963 */
  size?: 'small' | 'medium' | 'large';
  /** Initial note text (timestamped at insertion). @task T963 */
  notes?: string;
  /** File paths associated with the task. @task T963 */
  files?: string[];
  /**
   * When true, validate + preview the task without allocating a task id or
   * writing to the DB. Preview returns an `id: 'T???'` placeholder.
   * @task T963
   */
  dryRun?: boolean;
  /**
   * CLI helper for parent resolution via search term — when set, dispatch
   * layer resolves the search to a parent id before calling core.
   * @task T963
   */
  parentSearch?: string;
}
export type TasksCreateResult = TaskOp;

// tasks.update
/**
 * Parameters for `tasks.update`.
 *
 * @remarks
 * Re-synced to match `UpdateTaskOptions` in
 * `packages/core/src/tasks/update.ts` and the dispatch handler in
 * `packages/cleo/src/dispatch/domains/tasks.ts`. The legacy contract was
 * missing `acceptance`, `pipelineStage` (T834 / ADR-051 Decision 4),
 * `files`, `blockedBy`, `phase`, `noAutoComplete`, the narrow typing of
 * `type`/`size`, and the `addDepends`/`removeDepends` array mutators.
 *
 * @task T963 — contract↔impl drift reconciliation (T910 audit)
 */
export interface TasksUpdateParams {
  /** Task ID to update (required). @task T963 */
  taskId: string;
  /** Replace title. @task T963 */
  title?: string;
  /** Replace description. @task T963 */
  description?: string;
  /** Target status — `done` transitions route through complete flow. @task T963 */
  status?: TaskStatus;
  /** Replace priority. @task T963 */
  priority?: TaskPriority;
  /** Append a timestamped note. @task T963 */
  notes?: string;
  /** Set parent ID, or null/"" to promote to root. @task T963 */
  parent?: string | null;
  /** Replace labels wholesale. @task T963 */
  labels?: string[];
  /** Additive label insert. @task T963 */
  addLabels?: string[];
  /** Label removal set. @task T963 */
  removeLabels?: string[];
  /** Replace dependency list. @task T963 */
  depends?: string[];
  /** Additive dependency insert. @task T963 */
  addDepends?: string[];
  /** Dependency removal set. @task T963 */
  removeDepends?: string[];
  /** Task type (`epic`|`task`|`subtask`). @task T963 */
  type?: 'epic' | 'task' | 'subtask';
  /** Task size (`small`|`medium`|`large`). @task T963 */
  size?: 'small' | 'medium' | 'large';
  /**
   * Replace acceptance criteria. Subject to AC enforcement — min 3 for
   * all tasks, min 5 for epics.
   * @task T963
   */
  acceptance?: string[];
  /** Replace files attached to the task. @task T963 */
  files?: string[];
  /** Phase slug (lowercase alphanumeric + hyphens). @task T963 */
  phase?: string;
  /** Blocking reason (set when status=`blocked`). @task T963 */
  blockedBy?: string;
  /**
   * When true, skip auto-complete cascading when all children complete.
   * @task T963
   */
  noAutoComplete?: boolean;
  /**
   * RCASD-IVTR+C pipeline stage transition target. Forward-only
   * (validated by `validatePipelineTransition`); epic advancements are
   * additionally gated by `validateEpicStageAdvancement`; non-epic tasks
   * are gated by `validateChildStageCeiling` against their ancestor epic.
   * @task T963 / T834 / ADR-051 Decision 4
   */
  pipelineStage?: string;
}
export type TasksUpdateResult = TaskOp;

// tasks.complete
export interface TasksCompleteParams {
  taskId: string;
  notes?: string;
  archive?: boolean;
}
export interface TasksCompleteResult {
  taskId: string;
  completed: string;
  archived: boolean;
}

// tasks.delete
export interface TasksDeleteParams {
  taskId: string;
  force?: boolean;
}
export interface TasksDeleteResult {
  taskId: string;
  deleted: true;
}

// tasks.archive
export interface TasksArchiveParams {
  taskId?: string;
  before?: string;
}
export interface TasksArchiveResult {
  archived: number;
  taskIds: string[];
}

// tasks.unarchive
export interface TasksUnarchiveParams {
  taskId: string;
}
export type TasksUnarchiveResult = TaskOp;

// tasks.reparent
export interface TasksReparentParams {
  taskId: string;
  newParent: string;
}
export type TasksReparentResult = TaskOp;

// tasks.promote
export interface TasksPromoteParams {
  taskId: string;
}
export type TasksPromoteResult = TaskOp;

// tasks.reorder
export interface TasksReorderParams {
  taskId: string;
  position: number;
}
export interface TasksReorderResult {
  taskId: string;
  newPosition: number;
}

// tasks.restore (completed tasks) — alias: reopen
export interface TasksReopenParams {
  taskId: string;
}
export type TasksReopenResult = TaskOp;

// tasks.start (begin working on a task)
export interface TasksStartParams {
  taskId: string;
}
export interface TasksStartResult {
  taskId: string;
  sessionId: string;
  timestamp: string;
}

// tasks.stop (stop working on current task)
export type TasksStopParams = Record<string, never>;
export interface TasksStopResult {
  stopped: true;
  previousTask?: string;
}

// tasks.current (get currently active task)
export type TasksCurrentParams = Record<string, never>;
export interface TasksCurrentResult {
  taskId: string | null;
  since?: string;
  sessionId?: string;
}

// tasks.show (with optional history/ivtrHistory flags)
export interface TasksShowParams {
  taskId: string;
  /** When true, include task change history. */
  history?: boolean;
  /** When true, include IVTR phase history. */
  ivtrHistory?: boolean;
}
export type TasksShowResult = unknown;

// tasks.tree dispatch params (with optional withBlockers flag — dispatch alias)
export interface TasksTreeDispatchParams {
  taskId?: string;
  withBlockers?: boolean;
}
export type TasksTreeDispatchResult = unknown;

// tasks.blockers dispatch params (with optional analyze/limit)
export interface TasksBlockersQueryParams {
  analyze?: boolean;
  limit?: number;
}
export type TasksBlockersQueryResult = unknown;

// tasks.depends (with action routing for overview/cycles)
export interface TasksDependsParams {
  taskId?: string;
  direction?: 'upstream' | 'downstream' | 'both';
  tree?: boolean;
  action?: 'overview' | 'cycles';
}
export type TasksDependsResult = unknown;

// tasks.analyze dispatch params (with optional taskId and tierLimit)
export interface TasksAnalyzeQueryParams {
  taskId?: string;
  tierLimit?: number;
}
export type TasksAnalyzeQueryResult = unknown;

// tasks.impact
export interface TasksImpactParams {
  change: string;
  matchLimit?: number;
}
export type TasksImpactResult = unknown;

// tasks.next dispatch params (with count and explain)
export interface TasksNextQueryParams {
  count?: number;
  explain?: boolean;
}
export type TasksNextQueryResult = unknown;

// tasks.plan
export type TasksPlanParams = Record<string, never>;
export type TasksPlanResult = unknown;

// tasks.relates (with mode routing for suggest/discover)
export interface TasksRelatesParams {
  taskId: string;
  mode?: 'suggest' | 'discover';
  threshold?: number;
}
export type TasksRelatesResult = unknown;

// tasks.complexity.estimate
export interface TasksComplexityEstimateParams {
  taskId: string;
}
export type TasksComplexityEstimateResult = unknown;

// tasks.history
export interface TasksHistoryParams {
  taskId?: string;
  limit?: number;
}
export type TasksHistoryResult = unknown;

// tasks.label.list
export type TasksLabelListParams = Record<string, never>;
export type TasksLabelListResult = unknown;

// tasks.sync.links
export interface TasksSyncLinksParams {
  providerId?: string;
  taskId?: string;
}
export type TasksSyncLinksResult = unknown;

// tasks.sync.reconcile
export interface TasksSyncReconcileParams {
  providerId: string;
  externalTasks: import('../task-sync.js').ExternalTask[];
  dryRun?: boolean;
  conflictPolicy?: string;
  defaultPhase?: string;
  defaultLabels?: string[];
}
export type TasksSyncReconcileResult = unknown;

// tasks.sync.links.remove
export interface TasksSyncLinksRemoveParams {
  providerId: string;
}
export type TasksSyncLinksRemoveResult = unknown;

// tasks.cancel
export interface TasksCancelParams {
  taskId: string;
  reason?: string;
}
export type TasksCancelResult = unknown;

// tasks.restore (with from routing: done → reopen, archived → unarchive)
export interface TasksRestoreParams {
  taskId: string;
  from?: 'done' | 'archived';
  status?: string;
  reason?: string;
  preserveStatus?: boolean;
  cascade?: boolean;
  notes?: string;
}
export type TasksRestoreResult = unknown;

// tasks.reparent (dispatch-level params include newParentId)
export interface TasksReparentQueryParams {
  taskId: string;
  /** New parent ID, or null/undefined to promote to root. */
  newParentId: string | null | undefined;
}
export type TasksReparentDispatchResult = unknown;

// tasks.reorder (dispatch-level params)
export interface TasksReorderQueryParams {
  taskId: string;
  position: number;
}
export type TasksReorderDispatchResult = unknown;

// tasks.relates.add (accepts both relatedId and targetId aliases)
export interface TasksRelatesAddParams {
  taskId: string;
  relatedId?: string;
  targetId?: string;
  type: string;
  reason?: string;
}
export type TasksRelatesAddResult = unknown;

// tasks.add (dispatch-level params — extends TasksCreateParams)
export interface TasksAddParams {
  title: string;
  description?: string;
  /** Canonical wire field for parent task ID. @see ADR-057 D2 */
  parent?: string;
  depends?: string[];
  priority?: string;
  labels?: string[];
  type?: string;
  acceptance?: string[];
  phase?: string;
  size?: string;
  notes?: string;
  files?: string[];
  dryRun?: boolean;
  parentSearch?: string;
  /** Canonical wire field for task role axis. @see ADR-057 D2 */
  role?: string;
  scope?: string;
  severity?: string;
}
export type TasksAddResult = unknown;

// tasks.update (dispatch-level params — extends TasksUpdateParams)
export interface TasksUpdateQueryParams {
  taskId: string;
  title?: string;
  description?: string;
  status?: string;
  priority?: string;
  notes?: string;
  note?: string;
  labels?: string[];
  addLabels?: string[];
  removeLabels?: string[];
  depends?: string[];
  addDepends?: string[];
  removeDepends?: string[];
  acceptance?: string[];
  /** Canonical wire field for parent task ID. @see ADR-057 D2 */
  parent?: string | null;
  type?: string;
  size?: string;
  files?: string[];
  pipelineStage?: string;
}
export type TasksUpdateQueryResult = unknown;

// tasks.complete (dispatch-level params)
export interface TasksCompleteQueryParams {
  taskId: string;
  notes?: string;
  force?: unknown;
}
export type TasksCompleteQueryResult = unknown;

// tasks.delete (dispatch-level params)
export interface TasksDeleteQueryParams {
  taskId: string;
  force?: boolean;
}
export type TasksDeleteQueryResult = unknown;

// tasks.archive (dispatch-level params)
export interface TasksArchiveQueryParams {
  taskId?: string;
  before?: string;
  taskIds?: string[];
  includeCancelled?: boolean;
  dryRun?: boolean;
}
export type TasksArchiveQueryResult = unknown;

// tasks.claim
export interface TasksClaimParams {
  taskId: string;
  agentId: string;
}
export type TasksClaimResult = unknown;

// tasks.unclaim
export interface TasksUnclaimParams {
  taskId: string;
}
export type TasksUnclaimResult = unknown;

// tasks.start (dispatch-level)
export interface TasksStartQueryParams {
  taskId: string;
}
export type TasksStartQueryResult = unknown;

// tasks.stop (dispatch-level)
export type TasksStopQueryParams = Record<string, never>;
export type TasksStopQueryResult = unknown;

// ---------------------------------------------------------------------------
// Typed operation record (Wave D adapter — T1425)
// ---------------------------------------------------------------------------

/**
 * Typed operation record for the tasks domain.
 *
 * Maps each operation name (as dispatched by the registry — no domain prefix)
 * to its `[Params, Result]` tuple. Used by `TypedDomainHandler<TasksOps>`
 * in the dispatch layer to provide compile-time narrowing of params.
 *
 * @task T1425 — tasks typed-dispatch migration
 */
export type TasksOps = {
  // Query ops
  readonly show: readonly [TasksShowParams, TasksShowResult];
  readonly list: readonly [TasksListParams, TasksListResult];
  readonly find: readonly [TasksFindParams, TasksFindResult];
  readonly tree: readonly [TasksTreeDispatchParams, TasksTreeDispatchResult];
  readonly blockers: readonly [TasksBlockersQueryParams, TasksBlockersQueryResult];
  readonly depends: readonly [TasksDependsParams, TasksDependsResult];
  readonly analyze: readonly [TasksAnalyzeQueryParams, TasksAnalyzeQueryResult];
  readonly impact: readonly [TasksImpactParams, TasksImpactResult];
  readonly next: readonly [TasksNextQueryParams, TasksNextQueryResult];
  readonly plan: readonly [TasksPlanParams, TasksPlanResult];
  readonly relates: readonly [TasksRelatesParams, TasksRelatesResult];
  readonly 'complexity.estimate': readonly [
    TasksComplexityEstimateParams,
    TasksComplexityEstimateResult,
  ];
  readonly history: readonly [TasksHistoryParams, TasksHistoryResult];
  readonly current: readonly [TasksCurrentParams, TasksCurrentResult];
  readonly 'label.list': readonly [TasksLabelListParams, TasksLabelListResult];
  readonly 'sync.links': readonly [TasksSyncLinksParams, TasksSyncLinksResult];
  // Mutate ops
  readonly add: readonly [TasksAddParams, TasksAddResult];
  readonly update: readonly [TasksUpdateQueryParams, TasksUpdateQueryResult];
  readonly complete: readonly [TasksCompleteQueryParams, TasksCompleteQueryResult];
  readonly cancel: readonly [TasksCancelParams, TasksCancelResult];
  readonly delete: readonly [TasksDeleteQueryParams, TasksDeleteQueryResult];
  readonly archive: readonly [TasksArchiveQueryParams, TasksArchiveQueryResult];
  readonly restore: readonly [TasksRestoreParams, TasksRestoreResult];
  readonly reparent: readonly [TasksReparentQueryParams, TasksReparentDispatchResult];
  readonly reorder: readonly [TasksReorderQueryParams, TasksReorderDispatchResult];
  readonly 'relates.add': readonly [TasksRelatesAddParams, TasksRelatesAddResult];
  readonly start: readonly [TasksStartQueryParams, TasksStartQueryResult];
  readonly stop: readonly [TasksStopQueryParams, TasksStopQueryResult];
  readonly 'sync.reconcile': readonly [TasksSyncReconcileParams, TasksSyncReconcileResult];
  readonly 'sync.links.remove': readonly [TasksSyncLinksRemoveParams, TasksSyncLinksRemoveResult];
  readonly claim: readonly [TasksClaimParams, TasksClaimResult];
  readonly unclaim: readonly [TasksUnclaimParams, TasksUnclaimResult];
};
