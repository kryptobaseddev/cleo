/**
 * Sentient Domain Operations (10 operations)
 *
 * Query operations: 2 (propose.list, allowlist.list)
 * Mutate operations: 5 (propose.accept, propose.reject, propose.run, propose.enable, propose.disable)
 * Allowlist mutations: 2 (allowlist.add, allowlist.remove)
 *
 * Operations for autonomous Tier-2 proposal management and owner allowlist control.
 * All operations emit LAFS-compliant envelopes.
 *
 * @task T1008 — Sentient Tier 2 Proposals
 * @task T1421 — Sentient domain typed narrowing (Wave D · T975 follow-on)
 */

// ---------------------------------------------------------------------------
// Query Operations
// ---------------------------------------------------------------------------

/** Parameters for `propose.list` — list all pending proposals. */
export interface ProposeListParams {
  /** Maximum number of proposals to return (default: 50). */
  limit?: number;
}

/** Minimal proposal for wire format. */
export interface Proposal {
  /** Task ID of the proposal. */
  id: string;
  /** Task title. */
  title: string;
  /** Task description. */
  description: string;
  /** Task status (always 'proposed' when returned). */
  status: string;
  /** Task priority. */
  priority?: string;
  /** Labels attached to the task. */
  labels: string[];
  /** ISO timestamp when the proposal was created. */
  createdAt: string;
  /** Proposal metadata (weight, reasoning, etc). */
  meta?: Record<string, unknown> | null;
}

/** Result of `propose.list`. */
export interface ProposeListResult {
  /** Array of proposals, sorted by weight descending. */
  proposals: Proposal[];
  /** Total count of proposals returned. */
  total: number;
}

// propose.diff
/** Parameters for `propose.diff` — show what a proposal would change. */
export interface ProposeDiffParams {
  /** Proposal task ID. */
  id: string;
}

/** Result of `propose.diff` — Tier-3 stub. */
export interface ProposeDiffResult {
  /** Proposal ID. */
  id: string;
  /** Content diff (null in Tier-2; Tier-3 feature). */
  diff: null;
  /** Explanation message. */
  message: string;
}

// allowlist.list
/** Parameters for `allowlist.list` — no params required. */
export type AllowlistListParams = Record<string, never>;

/** Result of `allowlist.list`. */
export interface AllowlistListResult {
  /** Array of base64-encoded owner public keys. */
  ownerPubkeys: string[];
  /** Total count of pubkeys in the allowlist. */
  count: number;
}

// ---------------------------------------------------------------------------
// Mutate Operations
// ---------------------------------------------------------------------------

// propose.accept
/** Parameters for `propose.accept` — accept a proposal. */
export interface ProposeAcceptParams {
  /** Proposal task ID to accept. */
  id: string;
}

/** Result of `propose.accept`. */
export interface ProposeAcceptResult {
  /** Task ID that was accepted. */
  id: string;
  /** New task status ('pending'). */
  status: string;
  /** ISO timestamp when accepted. */
  acceptedAt: string;
}

// propose.reject
/** Parameters for `propose.reject` — reject a proposal. */
export interface ProposeRejectParams {
  /** Proposal task ID to reject. */
  id: string;
  /** Reason for rejection. */
  reason?: string;
}

/** Result of `propose.reject`. */
export interface ProposeRejectResult {
  /** Task ID that was rejected. */
  id: string;
  /** New task status ('cancelled'). */
  status: string;
  /** ISO timestamp when rejected. */
  rejectedAt: string;
  /** Rejection reason. */
  reason: string;
}

// propose.run
/** Parameters for `propose.run` — manually trigger a propose tick. */
export type ProposeRunParams = Record<string, never>;

/** Result of `propose.run`. */
export interface ProposeRunResult {
  /** Outcome from the propose tick. */
  outcome: unknown;
}

// propose.enable
/** Parameters for `propose.enable` — enable Tier-2 proposals. */
export type ProposeEnableParams = Record<string, never>;

/** Result of `propose.enable`. */
export interface ProposeEnableResult {
  /** Whether Tier-2 is now enabled. */
  tier2Enabled: boolean;
  /** Confirmation message. */
  message: string;
}

// propose.disable
/** Parameters for `propose.disable` — disable Tier-2 proposals. */
export type ProposeDisableParams = Record<string, never>;

/** Result of `propose.disable`. */
export interface ProposeDisableResult {
  /** Whether Tier-2 is now enabled (false after disable). */
  tier2Enabled: boolean;
  /** Confirmation message. */
  message: string;
}

// allowlist.add
/** Parameters for `allowlist.add` — add a pubkey to the allowlist. */
export interface AllowlistAddParams {
  /** Base64-encoded public key to add. */
  pubkey: string;
}

/** Result of `allowlist.add`. */
export interface AllowlistAddResult {
  /** The pubkey that was added. */
  added: string;
}

// allowlist.remove
/** Parameters for `allowlist.remove` — remove a pubkey from the allowlist. */
export interface AllowlistRemoveParams {
  /** Base64-encoded public key to remove. */
  pubkey: string;
}

/** Result of `allowlist.remove`. */
export interface AllowlistRemoveResult {
  /** The pubkey that was removed. */
  removed: string;
}

// ---------------------------------------------------------------------------
// Typed operation record (Wave D adapter — T975 follow-on)
// ---------------------------------------------------------------------------

/**
 * Typed operation record for the sentient domain.
 *
 * Maps each operation name (as dispatched by the registry — no domain prefix)
 * to its `[Params, Result]` tuple. Used by `TypedDomainHandler<SentientOps>`
 * in the dispatch layer to provide compile-time narrowing of params.
 *
 * @task T1421 — Sentient domain typed narrowing (Wave D follow-on)
 */
export type SentientOps = {
  readonly 'propose.list': readonly [ProposeListParams, ProposeListResult];
  readonly 'propose.diff': readonly [ProposeDiffParams, ProposeDiffResult];
  readonly 'propose.accept': readonly [ProposeAcceptParams, ProposeAcceptResult];
  readonly 'propose.reject': readonly [ProposeRejectParams, ProposeRejectResult];
  readonly 'propose.run': readonly [ProposeRunParams, ProposeRunResult];
  readonly 'propose.enable': readonly [ProposeEnableParams, ProposeEnableResult];
  readonly 'propose.disable': readonly [ProposeDisableParams, ProposeDisableResult];
  readonly 'allowlist.list': readonly [AllowlistListParams, AllowlistListResult];
  readonly 'allowlist.add': readonly [AllowlistAddParams, AllowlistAddResult];
  readonly 'allowlist.remove': readonly [AllowlistRemoveParams, AllowlistRemoveResult];
};
