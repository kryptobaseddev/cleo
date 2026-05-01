/**
 * Tasks Domain Operations — wire-format contracts for the tasks dispatch domain.
 *
 * Contains only types that appear in the `TasksOps` discriminated union (the
 * authoritative wire-format spec) plus shared primitives (`TaskOp`,
 * `MinimalTask`, `TaskPriority`, `TaskStatus`) used cross-domain.
 *
 * Legacy pre-dispatch aliases (`TasksCreateParams`, `TasksUpdateParams`, etc.)
 * were removed in T1446 (T1435-W2). Use the dispatch-level types
 * (`TasksAddParams`, `TasksUpdateQueryParams`, etc.) that appear in `TasksOps`.
 *
 * SYNC: Canonical type definitions live in the CLI package at:
 *   src/types/task.ts (TaskStatus, TaskPriority, Task, etc.)
 * These operation types are the API contract (wire format).
 * Internal domain types must stay aligned with CLI definitions.
 *
 * @task T1446 — strip redundant Params/Result aliases (T1435-W2)
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
   * @task T963 / T944
   */
  role?: string;
}
export type TasksFindResult = MinimalTask[];

/**
 * Mutate Operations
 */

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

// tasks.relates.add — relatedId is canonical; targetId kept for backward compat (T5149)
export interface TasksRelatesAddParams {
  taskId: string;
  relatedId?: string;
  // SSoT-EXEMPT: targetId is a backward-compat alias for relatedId accepted since T5149; removal is a separate cleanup task
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
  /**
   * Reason for overriding the `E_EPIC_HAS_PENDING_CHILDREN` guard.
   *
   * When provided, `cleo complete <epicId>` is allowed even if the epic
   * still has pending or active children. The reason is appended to
   * `.cleo/audit/premature-close.jsonl` (ADR-051 pattern).
   *
   * @task T1632
   */
  overrideReason?: string;
  /** Reason for acknowledging CRITICAL nexus impact risk (bypasses nexusImpact gate). */
  acknowledgeRisk?: string;
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
