/**
 * `lease-ipc` v1.1 — PARALLEL message contract (Zod schemas) for the
 * DbWriterLease IPC surface (T11627 ST-1).
 *
 * This is the byte-for-byte TypeScript mirror of the Rust serde types in
 * `crates/cleo-supervisor/src/lease_ipc.rs`. The wire format is newline-delimited
 * JSON (NDJSON): one {@link LeaseIpcEnvelope} per line — identical framing to the
 * frozen `supervisor-ipc` v1.0 envelope, only the version string
 * ({@link LEASE_IPC_PROTOCOL_VERSION}) and the inner union differ.
 *
 * Wire-shape contract (snake_case keys — matches serde defaults):
 *
 * ```jsonc
 * // request
 * { "protocol_version": "1.1.0", "id": "abc", "direction": "request",
 *   "request": { "kind": "lease_acquire", "scope": "project", "lane": "tasks",
 *                "holder_id": "pid-42:tasks", "priority": 0, "ttl_ms": 30000,
 *                "reentrant": true } }
 * // response
 * { "protocol_version": "1.1.0", "id": "abc", "direction": "response",
 *   "response": { "kind": "lease_granted", "scope": "project", "lane": "tasks",
 *                 "holder_id": "pid-42:tasks", "epoch": 7, "ttl_ms": 30000,
 *                 "expires_at_ms": 1000030000 } }
 * ```
 *
 * Staged delivery: every kind is *declared* so the protocol freeze is stable,
 * but `rate_check` / `tool_grant` handlers are deferred (return
 * `E_LEASE_UNIMPLEMENTED`) until a follow-up task. This module (ST-1) ships the
 * protocol surface with **no consumer** — zero behavior change.
 *
 * @task T11627
 * @packageDocumentation
 */

import { z } from 'zod';

// ─── Shared value types ───────────────────────────────────────────────────────

/**
 * The cleo.db scope a lease is arbitrated within. Mirrors `DbScope` in Rust.
 *
 * Under the dual-cleo.db split, a `project` lease lives inside the project's
 * `cleo.db` and a `global` lease inside the global `cleo.db` — different files,
 * so they never serialize against each other (AC2).
 */
export const LeaseScopeSchema = z.enum(['project', 'global']);

/** The cleo.db scope a lease is arbitrated within (inferred). */
export type LeaseScope = z.infer<typeof LeaseScopeSchema>;

/**
 * The write lane a lease arbitrates within a single scope file. Mirrors
 * `LeaseLane` in Rust.
 *
 * - `tasks` — the primary task-chokepoint write lane.
 * - `brain` — the BRAIN memory write lane (gated separately — AC4).
 * - `bulk`  — the bulk / bypass-writer lane (conduit, telemetry, nexus graph).
 */
export const LeaseLaneSchema = z.enum(['tasks', 'brain', 'bulk']);

/** The write lane a lease arbitrates within a scope (inferred). */
export type LeaseLane = z.infer<typeof LeaseLaneSchema>;

// ─── Requests (client → arbiter) ──────────────────────────────────────────────

/**
 * Acquire (or re-enter) the writer lease for a (scope, lane). Mirrors
 * `LeaseAcquireReq`. `[v1 core]`
 */
export const LeaseAcquireRequestSchema = z
  .object({
    /** Tag discriminating this request variant. */
    kind: z.literal('lease_acquire'),
    /** The cleo.db scope being arbitrated. */
    scope: LeaseScopeSchema,
    /** The write lane within the scope. */
    lane: LeaseLaneSchema,
    /** Process+lane holder identity. */
    holder_id: z.string().min(1),
    /** Advisory priority — lower acquires sooner. `0` = highest. */
    priority: z.number().int().min(0).max(255),
    /** Lease time-to-live in milliseconds. */
    ttl_ms: z.number().int().nonnegative(),
    /** When true, a same-holder acquire re-enters (refcount++) rather than queuing. */
    reentrant: z.boolean(),
  })
  .strict();

/** Acquire request payload (inferred from {@link LeaseAcquireRequestSchema}). */
export type LeaseAcquireRequest = z.infer<typeof LeaseAcquireRequestSchema>;

/**
 * Release the held writer lease. Mirrors `LeaseReleaseReq`. `[v1 core]`
 */
export const LeaseReleaseRequestSchema = z
  .object({
    /** Tag discriminating this request variant. */
    kind: z.literal('lease_release'),
    /** The cleo.db scope being arbitrated. */
    scope: LeaseScopeSchema,
    /** The write lane within the scope. */
    lane: LeaseLaneSchema,
    /** Process+lane holder identity. */
    holder_id: z.string().min(1),
    /** The epoch fence the holder acquired — a stale epoch no-ops. */
    epoch: z.number().int().nonnegative(),
  })
  .strict();

/** Release request payload (inferred from {@link LeaseReleaseRequestSchema}). */
export type LeaseReleaseRequest = z.infer<typeof LeaseReleaseRequestSchema>;

/**
 * Heartbeat / renew the held lease's TTL. Mirrors `LeaseRenewReq`. `[v1 core]`
 */
export const LeaseRenewRequestSchema = z
  .object({
    /** Tag discriminating this request variant. */
    kind: z.literal('lease_renew'),
    /** The cleo.db scope being arbitrated. */
    scope: LeaseScopeSchema,
    /** The write lane within the scope. */
    lane: LeaseLaneSchema,
    /** Process+lane holder identity. */
    holder_id: z.string().min(1),
    /** The epoch fence the holder acquired (epoch-guarded renew). */
    epoch: z.number().int().nonnegative(),
  })
  .strict();

/** Renew request payload (inferred from {@link LeaseRenewRequestSchema}). */
export type LeaseRenewRequest = z.infer<typeof LeaseRenewRequestSchema>;

/**
 * Check the per-scope write rate budget. Mirrors `RateCheckReq`.
 * `[declared; handler deferred — returns E_LEASE_UNIMPLEMENTED]`
 */
export const RateCheckRequestSchema = z
  .object({
    /** Tag discriminating this request variant. */
    kind: z.literal('rate_check'),
    /** The cleo.db scope being checked. */
    scope: LeaseScopeSchema,
    /** The write lane within the scope. */
    lane: LeaseLaneSchema,
    /** Estimated bytes the caller intends to write. */
    est_bytes: z.number().int().nonnegative(),
  })
  .strict();

/** Rate-check request payload (inferred from {@link RateCheckRequestSchema}). */
export type RateCheckRequest = z.infer<typeof RateCheckRequestSchema>;

/**
 * Request a tool-use grant. Mirrors `ToolGrantReq`.
 * `[declared; handler deferred — returns E_LEASE_UNIMPLEMENTED]`
 */
export const ToolGrantRequestSchema = z
  .object({
    /** Tag discriminating this request variant. */
    kind: z.literal('tool_grant'),
    /** The tool name being requested. */
    tool: z.string().min(1),
    /** The requesting holder identity. */
    holder_id: z.string().min(1),
  })
  .strict();

/** Tool-grant request payload (inferred from {@link ToolGrantRequestSchema}). */
export type ToolGrantRequest = z.infer<typeof ToolGrantRequestSchema>;

/**
 * The discriminated union of all client → arbiter lease requests. The `kind`
 * field selects the variant, matching the serde `#[serde(tag = "kind")]`
 * tagging on the Rust `LeaseRequest` enum.
 */
export const LeaseIpcRequestSchema = z.discriminatedUnion('kind', [
  LeaseAcquireRequestSchema,
  LeaseReleaseRequestSchema,
  LeaseRenewRequestSchema,
  RateCheckRequestSchema,
  ToolGrantRequestSchema,
]);

/** Any lease IPC request (inferred from {@link LeaseIpcRequestSchema}). */
export type LeaseIpcRequest = z.infer<typeof LeaseIpcRequestSchema>;

// ─── Responses (arbiter → client) ─────────────────────────────────────────────

/**
 * The lease was granted to the caller. Mirrors `LeaseGranted`.
 */
export const LeaseGrantedResponseSchema = z
  .object({
    /** Tag discriminating this response variant. */
    kind: z.literal('lease_granted'),
    /** The granted cleo.db scope. */
    scope: LeaseScopeSchema,
    /** The granted write lane. */
    lane: LeaseLaneSchema,
    /** The holder the lease was granted to. */
    holder_id: z.string().min(1),
    /** The monotonic epoch fence assigned to this grant. */
    epoch: z.number().int().nonnegative(),
    /** The lease TTL in milliseconds. */
    ttl_ms: z.number().int().nonnegative(),
    /** Absolute expiry timestamp (epoch ms) for this grant. */
    expires_at_ms: z.number().int().nonnegative(),
  })
  .strict();

/** Lease-granted response payload (inferred from {@link LeaseGrantedResponseSchema}). */
export type LeaseGrantedResponse = z.infer<typeof LeaseGrantedResponseSchema>;

/**
 * The caller was placed in the per-scope FIFO+priority queue. Mirrors
 * `LeaseQueued`.
 */
export const LeaseQueuedResponseSchema = z
  .object({
    /** Tag discriminating this response variant. */
    kind: z.literal('lease_queued'),
    /** The queued cleo.db scope. */
    scope: LeaseScopeSchema,
    /** The queued write lane. */
    lane: LeaseLaneSchema,
    /** The monotonic ticket assigned for FIFO tiebreak. */
    ticket: z.number().int().nonnegative(),
    /** Number of waiters ahead of this one. */
    ahead: z.number().int().nonnegative(),
  })
  .strict();

/** Lease-queued response payload (inferred from {@link LeaseQueuedResponseSchema}). */
export type LeaseQueuedResponse = z.infer<typeof LeaseQueuedResponseSchema>;

/**
 * The acquire was denied. Mirrors `LeaseDenied`.
 */
export const LeaseDeniedResponseSchema = z
  .object({
    /** Tag discriminating this response variant. */
    kind: z.literal('lease_denied'),
    /** The denied cleo.db scope. */
    scope: LeaseScopeSchema,
    /** Machine-readable denial code (e.g. `E_LEASE_UNAVAILABLE`). */
    code: z.string().min(1),
    /** Human-readable denial message. */
    message: z.string(),
  })
  .strict();

/** Lease-denied response payload (inferred from {@link LeaseDeniedResponseSchema}). */
export type LeaseDeniedResponse = z.infer<typeof LeaseDeniedResponseSchema>;

/**
 * Reply to a deferred `rate_check`. Mirrors `RateResult`.
 */
export const RateResultResponseSchema = z
  .object({
    /** Tag discriminating this response variant. */
    kind: z.literal('rate_result'),
    /** The checked cleo.db scope. */
    scope: LeaseScopeSchema,
    /** Whether the write is within budget. */
    ok: z.boolean(),
    /** Suggested back-off in milliseconds when `ok` is false. */
    retry_after_ms: z.number().int().nonnegative(),
    /** Remaining token budget for the scope. */
    tokens_remaining: z.number().int().nonnegative(),
  })
  .strict();

/** Rate-result response payload (inferred from {@link RateResultResponseSchema}). */
export type RateResultResponse = z.infer<typeof RateResultResponseSchema>;

/**
 * Reply to a deferred `tool_grant`. Mirrors `ToolGranted`.
 */
export const ToolGrantedResponseSchema = z
  .object({
    /** Tag discriminating this response variant. */
    kind: z.literal('tool_granted'),
    /** The granted tool name. */
    tool: z.string().min(1),
    /** The holder the tool grant was issued to. */
    holder_id: z.string().min(1),
  })
  .strict();

/** Tool-granted response payload (inferred from {@link ToolGrantedResponseSchema}). */
export type ToolGrantedResponse = z.infer<typeof ToolGrantedResponseSchema>;

/**
 * Unsolicited event: a held lease was revoked. Mirrors `LeaseRevoked`.
 */
export const LeaseRevokedResponseSchema = z
  .object({
    /** Tag discriminating this response variant. */
    kind: z.literal('lease_revoked'),
    /** The revoked cleo.db scope. */
    scope: LeaseScopeSchema,
    /** The revoked write lane. */
    lane: LeaseLaneSchema,
    /** The holder whose lease was revoked. */
    holder_id: z.string().min(1),
    /** Human-readable reason for the revocation. */
    reason: z.string(),
  })
  .strict();

/** Lease-revoked event payload (inferred from {@link LeaseRevokedResponseSchema}). */
export type LeaseRevokedResponse = z.infer<typeof LeaseRevokedResponseSchema>;

/**
 * Unsolicited event: a lease holder was killed for being unresponsive. Mirrors
 * `ChildKilled` carried by the `child_killed_unresponsive` response variant.
 */
export const ChildKilledUnresponsiveResponseSchema = z
  .object({
    /** Tag discriminating this response variant. */
    kind: z.literal('child_killed_unresponsive'),
    /** Logical id of the killed child. */
    child_id: z.string().min(1),
    /** The holder identity the killed child held the lease as. */
    holder_id: z.string().min(1),
    /** The cleo.db scope the killed child held the lease in. */
    scope: LeaseScopeSchema,
    /** Human-readable reason for the kill. */
    reason: z.string(),
  })
  .strict();

/** Child-killed event payload (inferred from {@link ChildKilledUnresponsiveResponseSchema}). */
export type ChildKilledUnresponsiveResponse = z.infer<typeof ChildKilledUnresponsiveResponseSchema>;

/**
 * An error response correlated to a request. Mirrors the v1.0
 * `crate::ipc::ErrorResult` shape reused by the Rust `LeaseResponse::Error`
 * variant — error framing is shared across protocol versions.
 */
export const LeaseErrorResponseSchema = z
  .object({
    /** Tag discriminating this response variant. */
    kind: z.literal('error'),
    /** Machine-readable error code (e.g. `E_LEASE_BAD_VERSION`, `E_LEASE_UNIMPLEMENTED`). */
    code: z.string().min(1),
    /** Human-readable error message. */
    message: z.string(),
  })
  .strict();

/** Lease error response payload (inferred from {@link LeaseErrorResponseSchema}). */
export type LeaseErrorResponse = z.infer<typeof LeaseErrorResponseSchema>;

/**
 * The discriminated union of all arbiter → client lease responses and events.
 * The `kind` field selects the variant, matching the serde
 * `#[serde(tag = "kind")]` tagging on the Rust `LeaseResponse` enum.
 */
export const LeaseIpcResponseSchema = z.discriminatedUnion('kind', [
  LeaseGrantedResponseSchema,
  LeaseQueuedResponseSchema,
  LeaseDeniedResponseSchema,
  RateResultResponseSchema,
  ToolGrantedResponseSchema,
  LeaseRevokedResponseSchema,
  ChildKilledUnresponsiveResponseSchema,
  LeaseErrorResponseSchema,
]);

/** Any lease IPC response (inferred from {@link LeaseIpcResponseSchema}). */
export type LeaseIpcResponse = z.infer<typeof LeaseIpcResponseSchema>;

// ─── Envelope ──────────────────────────────────────────────────────────────────

/**
 * A client → arbiter lease request envelope.
 *
 * The `direction` discriminator + flattened `request` payload mirror the serde
 * `#[serde(tag = "direction")]` `LeasePayload::Request { request }` variant.
 */
export const LeaseIpcRequestEnvelopeSchema = z
  .object({
    /** Parallel protocol version. */
    protocol_version: z.string(),
    /** Correlation id echoed back on the matching response. */
    id: z.string().min(1),
    /** Direction discriminator. */
    direction: z.literal('request'),
    /** The request body. */
    request: LeaseIpcRequestSchema,
  })
  .strict();

/** Lease request envelope (inferred from {@link LeaseIpcRequestEnvelopeSchema}). */
export type LeaseIpcRequestEnvelope = z.infer<typeof LeaseIpcRequestEnvelopeSchema>;

/**
 * An arbiter → client lease response/event envelope.
 *
 * The `direction` discriminator + flattened `response` payload mirror the serde
 * `LeasePayload::Response { response }` variant.
 */
export const LeaseIpcResponseEnvelopeSchema = z
  .object({
    /** Parallel protocol version. */
    protocol_version: z.string(),
    /** Correlation id echoed from the originating request (or a fresh id for events). */
    id: z.string().min(1),
    /** Direction discriminator. */
    direction: z.literal('response'),
    /** The response body. */
    response: LeaseIpcResponseSchema,
  })
  .strict();

/** Lease response envelope (inferred from {@link LeaseIpcResponseEnvelopeSchema}). */
export type LeaseIpcResponseEnvelope = z.infer<typeof LeaseIpcResponseEnvelopeSchema>;

/**
 * The top-level lease IPC envelope: a versioned, correlated wrapper that is
 * either a request or a response, discriminated by `direction`. One envelope per
 * NDJSON line. Mirrors the Rust `LeaseEnvelope`.
 */
export const LeaseIpcEnvelopeSchema = z.discriminatedUnion('direction', [
  LeaseIpcRequestEnvelopeSchema,
  LeaseIpcResponseEnvelopeSchema,
]);

/** Any lease IPC envelope (inferred from {@link LeaseIpcEnvelopeSchema}). */
export type LeaseIpcEnvelope = z.infer<typeof LeaseIpcEnvelopeSchema>;

// ─── Frozen message-set guard ──────────────────────────────────────────────────

/**
 * The v1.1 request `kind` values, in declaration order. The schema-drift guard
 * test pins this tuple; any addition/removal is a contract-breaking change
 * requiring a coordinated dual (Rust + TS) edit.
 */
export const LEASE_IPC_REQUEST_KINDS = [
  'lease_acquire',
  'lease_release',
  'lease_renew',
  'rate_check',
  'tool_grant',
] as const;

/**
 * The v1.1 response `kind` values, in declaration order. The schema-drift guard
 * test pins this tuple.
 */
export const LEASE_IPC_RESPONSE_KINDS = [
  'lease_granted',
  'lease_queued',
  'lease_denied',
  'rate_result',
  'tool_granted',
  'lease_revoked',
  'child_killed_unresponsive',
  'error',
] as const;

/**
 * The complete v1.1 message kind set (requests + responses), used by the drift
 * guard on both the TS and Rust sides.
 */
export const LEASE_IPC_MESSAGE_KINDS = [
  ...LEASE_IPC_REQUEST_KINDS,
  ...LEASE_IPC_RESPONSE_KINDS,
] as const;
