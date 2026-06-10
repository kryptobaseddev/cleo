/**
 * Service-vault trust gate — **policy-before-decrypt** per-agent access control.
 *
 * EP-UNIVERSAL-SERVICE-VAULT (epic T11765 · saga SG-VAULT-CORE T10409 · M2 W1a ·
 * task T11937 · AC4). Ports onecli `connect.rs` selective-mode: an agent may use a
 * service connection ONLY when (a) a row exists in `agent_service_grants` linking
 * the agent to the connection, AND (b) the grant's `session_policy` evaluates to
 * an allow. This module evaluates that decision from already-loaded grant data —
 * it performs ZERO crypto. The store
 * ({@link import('./service-connections-accessor.js')}) calls `decryptGlobal`
 * ONLY after this gate returns `allowed: true`, so a denied/blocked agent NEVER
 * triggers a decrypt (the policy-before-decrypt invariant, proven by unit test).
 *
 * ## Why the gate is decrypt-free
 *
 * The gate takes the grant rows as INPUT and returns a pure decision. It cannot
 * decrypt even if it wanted to — it imports no crypto. The decryption chokepoint
 * lives one layer up (the accessor), guarded by this decision. That separation is
 * exactly what makes "a denied agent never decrypts" structurally true and
 * spy-assertable: the spy is placed on `decryptGlobal`, and a deny path returns
 * before the accessor reaches the decrypt call.
 *
 * ## Policy shape ({@link SessionPolicy})
 *
 * Mirrors onecli's `PolicyAction` (block / rate-limit / manual-approval) collapsed
 * to a per-grant JSON:
 *
 *   - `mode: 'allow' | 'block'` — `block` is a hard deny (no decrypt).
 *   - `rateLimit?` — advisory rate cap; the gate surfaces it but does not itself
 *     count requests (the caller enforces). Presence alone does not deny.
 *   - `manualApproval?: true` — the connection requires an out-of-band human
 *     approval that has not been granted for this session → deny (no decrypt)
 *     until the caller supplies `approved: true` in the evaluation context.
 *
 * A bare grant (`{"mode":"allow"}`, the column default) allows.
 *
 * @module store/service-trust-gate
 * @task T11937
 * @epic T11765
 * @saga T10409
 * @see ./service-connections-accessor.ts — the accessor that decrypts ONLY on allow
 * @see ../../../onecli — `apps/gateway/src/connect.rs` selective-mode (the ported model)
 */

/**
 * Advisory rate-limit clause on a {@link SessionPolicy}.
 *
 * The gate reports it on an allow decision; it does NOT itself maintain a counter
 * (the consumer enforces the cap). Presence never denies access — it shapes how
 * the caller throttles an already-permitted credential use.
 *
 * @task T11937
 */
export interface SessionRateLimit {
  /** Maximum requests permitted within `window`. */
  readonly maxRequests: number;
  /** Rolling window the cap applies over. */
  readonly window: 'minute' | 'hour' | 'day';
}

/**
 * Per-grant session policy evaluated by the trust gate BEFORE any decrypt.
 *
 * Serialized as the `agent_service_grants.session_policy` JSON column. The column
 * default `{"mode":"allow"}` makes a bare grant permissive.
 *
 * @task T11937
 */
export interface SessionPolicy {
  /** `block` is a hard deny (no decrypt); `allow` permits (subject to other clauses). */
  readonly mode: 'allow' | 'block';
  /** Advisory rate cap surfaced on an allow decision (never itself denies). */
  readonly rateLimit?: SessionRateLimit;
  /**
   * When `true`, the connection requires an out-of-band human approval. The gate
   * DENIES unless the evaluation context carries `approved: true` for this
   * session.
   */
  readonly manualApproval?: boolean;
}

/**
 * Minimal grant projection the gate evaluates — exactly the
 * `agent_service_grants` columns the decision needs, no token material.
 *
 * @task T11937
 */
export interface ServiceGrant {
  /** The granted agent. */
  readonly agentId: string;
  /** The connection this grant authorizes. */
  readonly serviceConnectionId: number;
  /** The parsed {@link SessionPolicy} (already JSON-decoded from the column). */
  readonly sessionPolicy: SessionPolicy;
}

/**
 * Context for a single access evaluation.
 *
 * @task T11937
 */
export interface TrustEvalContext {
  /** The agent requesting access. */
  readonly agentId: string;
  /** The connection the agent wants to use. */
  readonly serviceConnectionId: number;
  /**
   * Whether an out-of-band manual approval has been granted for this session.
   * Required to pass a `manualApproval: true` policy. Defaults to `false`.
   */
  readonly approved?: boolean;
}

/**
 * Reason an access evaluation was DENIED — stable codes for diagnostics/audit.
 *
 * @task T11937
 */
export type TrustDenyReason = 'no-grant' | 'policy-block' | 'manual-approval-required';

/**
 * The pure decision returned by {@link evaluateServiceAccess}.
 *
 * On `allowed: false` the accessor MUST NOT decrypt. On `allowed: true` the
 * accessor may decrypt and (optionally) honor `rateLimit`.
 *
 * @task T11937
 */
export type TrustDecision =
  | { readonly allowed: true; readonly rateLimit?: SessionRateLimit }
  | { readonly allowed: false; readonly reason: TrustDenyReason };

/**
 * Parse a raw `session_policy` JSON string into a {@link SessionPolicy}, failing
 * CLOSED (to `block`) on any malformed input.
 *
 * SECURITY: a corrupt/unparseable policy must NEVER silently widen access — it
 * resolves to `{ mode: 'block' }` so the gate denies and no decrypt occurs.
 *
 * @param raw - The `agent_service_grants.session_policy` column value.
 * @returns A well-formed {@link SessionPolicy}; `block` on parse failure.
 * @task T11937
 */
export function parseSessionPolicy(raw: string): SessionPolicy {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { mode: 'block' };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { mode: 'block' };
  }
  const obj = parsed as Record<string, unknown>;
  const mode = obj['mode'] === 'block' ? 'block' : obj['mode'] === 'allow' ? 'allow' : 'block';
  const policy: {
    mode: 'allow' | 'block';
    rateLimit?: SessionRateLimit;
    manualApproval?: boolean;
  } = { mode };
  if (obj['manualApproval'] === true) {
    policy.manualApproval = true;
  }
  const rl = obj['rateLimit'];
  if (typeof rl === 'object' && rl !== null) {
    const rlObj = rl as Record<string, unknown>;
    const maxRequests = rlObj['maxRequests'];
    const window = rlObj['window'];
    if (
      typeof maxRequests === 'number' &&
      maxRequests > 0 &&
      (window === 'minute' || window === 'hour' || window === 'day')
    ) {
      policy.rateLimit = { maxRequests, window };
    }
  }
  return policy;
}

/**
 * Evaluate whether an agent may access a service connection — the **policy-
 * before-decrypt** chokepoint.
 *
 * Pure: takes the agent's grants (already loaded) + the evaluation context and
 * returns a {@link TrustDecision} WITHOUT touching crypto. The store calls
 * `decryptGlobal` ONLY when the returned `allowed` is `true`. Deny order:
 *
 *  1. no matching grant → `no-grant` (denied).
 *  2. grant policy `mode: 'block'` → `policy-block` (denied).
 *  3. policy `manualApproval` set but context not `approved` →
 *     `manual-approval-required` (denied).
 *  4. otherwise → allowed (carrying any advisory `rateLimit`).
 *
 * @param grants - The agent's grant rows (the accessor loads these from
 *   `agent_service_grants`). Only grants for `ctx.agentId` /
 *   `ctx.serviceConnectionId` are considered.
 * @param ctx - The evaluation context (agent, connection, approval flag).
 * @returns The access decision. NEVER decrypts.
 * @task T11937
 */
export function evaluateServiceAccess(
  grants: readonly ServiceGrant[],
  ctx: TrustEvalContext,
): TrustDecision {
  const grant = grants.find(
    (g) => g.agentId === ctx.agentId && g.serviceConnectionId === ctx.serviceConnectionId,
  );
  if (grant === undefined) {
    return { allowed: false, reason: 'no-grant' };
  }
  const policy = grant.sessionPolicy;
  if (policy.mode === 'block') {
    return { allowed: false, reason: 'policy-block' };
  }
  if (policy.manualApproval === true && ctx.approved !== true) {
    return { allowed: false, reason: 'manual-approval-required' };
  }
  return policy.rateLimit !== undefined
    ? { allowed: true, rateLimit: policy.rateLimit }
    : { allowed: true };
}
