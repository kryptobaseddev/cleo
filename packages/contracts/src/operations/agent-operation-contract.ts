/**
 * Agent operation contract doctrine for CLEO PM Core V2.
 *
 * The types in this module define the canonical result envelope for agent-facing
 * mutate operations. They intentionally live in `@cleocode/contracts` so core
 * implementations, CLI renderers, and validators share one vocabulary for
 * success, partial success, dry-run previews, empty states, and session lineage.
 *
 * @task T10555 — E1.W0 Define agent operation contract doctrine.
 */

/**
 * Canonical mutation result status for agent operation outputs.
 *
 * `partial_success` is a terminal success state with one or more durable writes
 * and one or more rejected or skipped items. `empty` and `dry_run` are typed
 * non-mutating states rather than ad-hoc empty arrays or prose-only messages.
 */
export type AgentMutationStatus = 'success' | 'partial_success' | 'empty' | 'dry_run' | 'failed';

/**
 * Per-item mutation effect recorded by an agent operation.
 *
 * `planned` is reserved for dry-run previews. `skipped` is a deliberate no-op
 * such as an already-satisfied request or an empty-state guard. `failed` means
 * the item did not mutate and MUST be paired with an issue entry.
 */
export type AgentMutationEffect = 'applied' | 'planned' | 'skipped' | 'failed';

/**
 * Machine-readable issue severity for mutation diagnostics.
 */
export type AgentOperationIssueSeverity = 'info' | 'warning' | 'error';

/**
 * Session lineage attached to every agent operation result.
 */
export interface AgentOperationSessionLineage {
  /**
   * Session that executed this operation attempt.
   *
   * For delegated workers this is the worker/current runtime session. For a
   * resumed or handoff execution it changes to the session that actually ran
   * the command. It MUST NOT be used to infer who originally requested the work.
   */
  executionSessionId: string;
  /**
   * Session that originated the intent being carried by this operation.
   *
   * For direct calls it usually equals `executionSessionId`. For delegated,
   * resumed, or handoff work it remains the orchestrator/lead session that
   * created the intent so audit trails can stitch execution back to origin.
   */
  originSessionId: string;
}

/**
 * A typed empty-state explanation for operations that have no rows to return or
 * no candidate records to mutate.
 */
export interface AgentOperationEmptyState {
  /** Stable empty-state code, suitable for tests and renderers. */
  code: string;
  /** Human-readable reason the operation had no applicable records. */
  reason: string;
  /** Optional next action for callers that need to create prerequisite data. */
  nextAction?: string;
}

/**
 * Dry-run metadata for operations that preview mutations without writing.
 */
export interface AgentOperationDryRun {
  /** Always true when the operation is a dry-run preview. */
  enabled: true;
  /** Number of writes that would have been attempted outside dry-run mode. */
  plannedWrites: number;
  /** Number of durable writes performed during the dry run; MUST be zero. */
  appliedWrites: 0;
}

/**
 * Machine-readable operation issue attached to rejected, skipped, or failed
 * records and to whole-operation validation failures.
 */
export interface AgentOperationIssue {
  /** Stable diagnostic code such as `E_TASK_NOT_FOUND`. */
  code: string;
  /** Severity for rendering and gate decisions. */
  severity: AgentOperationIssueSeverity;
  /** Human-readable diagnostic message. */
  message: string;
  /** Optional record identifier or logical path associated with the issue. */
  target?: string;
}

/**
 * Per-item outcome for a mutation request.
 */
export interface AgentMutationItem<TItem> {
  /** Stable item identifier from the request or resulting domain row. */
  id: string;
  /** Effect observed for this item. */
  effect: AgentMutationEffect;
  /** Domain-specific item payload after applying, planning, or skipping. */
  item: TItem;
  /** Issues associated with this item, if any. */
  issues: AgentOperationIssue[];
}

/**
 * Counts that summarize a mutation operation without consumers inspecting every
 * item. Counts MUST match `items` and `issues` for contract-backed outputs.
 */
export interface AgentMutationSummary {
  /** Number of requested mutation targets. */
  requested: number;
  /** Number of durable item writes. */
  applied: number;
  /** Number of planned item writes in dry-run mode. */
  planned: number;
  /** Number of deliberate no-op items. */
  skipped: number;
  /** Number of item-level failures. */
  failed: number;
}

/**
 * Shared fields present on every agent-facing mutation result.
 */
export interface AgentMutationResultBase<TData, TItem> {
  /** Discriminating status for renderer and validator behavior. */
  status: AgentMutationStatus;
  /** True for `success`, `partial_success`, `empty`, and `dry_run`; false for `failed`. */
  ok: boolean;
  /** Domain-specific aggregate payload. */
  data: TData;
  /** Per-item mutation outcomes. */
  items: AgentMutationItem<TItem>[];
  /** Count summary derived from `items`. */
  summary: AgentMutationSummary;
  /** Whole-operation and item-level diagnostics. */
  issues: AgentOperationIssue[];
  /** Execution and origin session lineage for audit stitching. */
  session: AgentOperationSessionLineage;
}

/**
 * Successful mutation result where all requested mutations were durably applied.
 */
export interface AgentMutationSuccessResult<TData, TItem>
  extends AgentMutationResultBase<TData, TItem> {
  /** Discriminating status for all-applied success. */
  status: 'success';
  /** Success results are agent-safe. */
  ok: true;
}

/**
 * Partial-success mutation result.
 *
 * At least one item was durably applied and at least one item was skipped or
 * failed; callers MUST inspect `items` and `issues` before assuming the whole
 * request completed.
 */
export interface AgentMutationPartialSuccessResult<TData, TItem>
  extends AgentMutationResultBase<TData, TItem> {
  /** Discriminating status for durable writes plus rejected/skipped items. */
  status: 'partial_success';
  /** Partial success is still a successful operation attempt. */
  ok: true;
}

/**
 * Typed empty-state mutation result.
 *
 * No mutation candidates existed; `emptyState` is required so renderers and
 * agents do not infer meaning from an untyped empty array.
 */
export interface AgentMutationEmptyResult<TData, TItem>
  extends AgentMutationResultBase<TData, TItem> {
  /** Discriminating status for no candidate records. */
  status: 'empty';
  /** Empty is a handled non-error state. */
  ok: true;
  /** Required typed empty-state explanation. */
  emptyState: AgentOperationEmptyState;
}

/**
 * Dry-run mutation result.
 *
 * No durable writes occurred; `dryRun` is required and mutating items MUST use
 * the `planned` effect rather than `applied`.
 */
export interface AgentMutationDryRunResult<TData, TItem>
  extends AgentMutationResultBase<TData, TItem> {
  /** Discriminating status for preview-only execution. */
  status: 'dry_run';
  /** Dry-run is a successful preview operation. */
  ok: true;
  /** Required dry-run write accounting. */
  dryRun: AgentOperationDryRun;
}

/**
 * Failed mutation result where no requested mutation was durably applied.
 */
export interface AgentMutationFailedResult<TData, TItem>
  extends AgentMutationResultBase<TData, TItem> {
  /** Discriminating status for failed mutation attempts. */
  status: 'failed';
  /** Failed results are not agent-safe to treat as completion. */
  ok: false;
}

/**
 * Standardized result envelope for agent-facing mutate operations.
 */
export type AgentMutationResult<TData, TItem> =
  | AgentMutationSuccessResult<TData, TItem>
  | AgentMutationPartialSuccessResult<TData, TItem>
  | AgentMutationEmptyResult<TData, TItem>
  | AgentMutationDryRunResult<TData, TItem>
  | AgentMutationFailedResult<TData, TItem>;

/**
 * Doctrine constants used by tests, docs generators, and future validators to
 * describe the operation-result invariants without duplicating prose.
 */
export const AGENT_OPERATION_CONTRACT_DOCTRINE = {
  mutationStatuses: ['success', 'partial_success', 'empty', 'dry_run', 'failed'],
  partialSuccess: {
    status: 'partial_success',
    requiresAppliedMinimum: 1,
    requiresRejectedOrSkippedMinimum: 1,
    inspect: ['items', 'issues'],
  },
  sessionLineage: {
    executionSessionId: 'session that executed this operation attempt',
    originSessionId: 'session that originated the operation intent',
  },
  emptyState: {
    status: 'empty',
    requiredField: 'emptyState',
  },
  dryRun: {
    status: 'dry_run',
    requiredField: 'dryRun',
    appliedWrites: 0,
    plannedEffect: 'planned',
  },
} as const;
