/**
 * `supervisor-ipc` v1.0 — FROZEN message contract (Zod schemas).
 *
 * This is the byte-for-byte TypeScript mirror of the Rust serde types in
 * `crates/cleo-supervisor/src/ipc.rs`. The wire format is newline-delimited
 * JSON (NDJSON): one {@link SupervisorIpcEnvelope} per line. The supervisor
 * (Rust) is the server; CLEO/Studio (TypeScript) are clients that send
 * {@link SupervisorIpcRequest}s and receive {@link SupervisorIpcResponse}s and
 * unsolicited {@link LifecycleEvent}s.
 *
 * Wire-shape contract (snake_case keys — matches serde defaults):
 *
 * ```jsonc
 * // request
 * { "protocol_version": "1.0.0", "id": "abc", "direction": "request",
 *   "request": { "kind": "spawn", "child_id": "w1", "program": "/bin/node",
 *                "args": [], "env": [] } }
 * // response
 * { "protocol_version": "1.0.0", "id": "abc", "direction": "response",
 *   "response": { "kind": "spawned", "child_id": "w1", "pid": 4242 } }
 * ```
 *
 * FROZEN v1.0: R2 (T11253) consumes this exact set. Do not add/rename/remove
 * fields in place — see {@link SUPERVISOR_IPC_PROTOCOL_VERSION}.
 *
 * @task T11339
 * @packageDocumentation
 */

import { z } from 'zod';

// ─── Shared value types ───────────────────────────────────────────────────────

/**
 * A single environment key/value override applied to a spawned child, layered
 * on top of the supervisor's own environment. Mirrors `EnvPair` in Rust.
 */
export const EnvPairSchema = z
  .object({
    /** Environment variable name. */
    key: z.string().min(1),
    /** Environment variable value. */
    value: z.string(),
  })
  .strict();

/** A single environment key/value override (inferred from {@link EnvPairSchema}). */
export type EnvPair = z.infer<typeof EnvPairSchema>;

/**
 * Liveness state of a supervised child. Mirrors `ChildState` in Rust.
 *
 * - `running`    — the child process is alive.
 * - `restarting` — the child exited and a backoff-delayed restart is pending.
 * - `stopped`    — the child exited and will not be restarted.
 */
export const ChildStateSchema = z.enum(['running', 'restarting', 'stopped']);

/** Liveness state of a supervised child (inferred). */
export type ChildState = z.infer<typeof ChildStateSchema>;

/**
 * A single child's status row in a monitor snapshot. Mirrors `ChildStatus`.
 */
export const ChildStatusSchema = z
  .object({
    /** Logical id of the child (stable across restarts). */
    child_id: z.string().min(1),
    /** Current OS pid (0 when not currently running). */
    pid: z.number().int().nonnegative(),
    /** Current liveness state. */
    state: ChildStateSchema,
    /** Total restarts observed for this child. */
    restart_count: z.number().int().nonnegative(),
  })
  .strict();

/** A single child's status row (inferred from {@link ChildStatusSchema}). */
export type ChildStatus = z.infer<typeof ChildStatusSchema>;

// ─── Requests (client → supervisor) ───────────────────────────────────────────

/**
 * Ask the supervisor to spawn a new child worker. Mirrors `SpawnRequest`.
 */
export const SpawnRequestSchema = z
  .object({
    /** Tag discriminating this request variant. */
    kind: z.literal('spawn'),
    /** Caller-chosen logical id for the child (stable across restarts). */
    child_id: z.string().min(1),
    /** Absolute path to the program to execute. */
    program: z.string().min(1),
    /** Arguments passed to the program. */
    args: z.array(z.string()).default([]),
    /** Environment overrides applied on top of the supervisor's environment. */
    env: z.array(EnvPairSchema).default([]),
    /** Optional working directory for the child. */
    cwd: z.string().optional(),
  })
  .strict();

/** Spawn request payload (inferred from {@link SpawnRequestSchema}). */
export type SpawnRequest = z.infer<typeof SpawnRequestSchema>;

/**
 * Ask the supervisor to restart an existing child by id. Mirrors `RestartRequest`.
 */
export const RestartRequestSchema = z
  .object({
    /** Tag discriminating this request variant. */
    kind: z.literal('restart'),
    /** Logical id of the child to restart. */
    child_id: z.string().min(1),
  })
  .strict();

/** Restart request payload (inferred from {@link RestartRequestSchema}). */
export type RestartRequest = z.infer<typeof RestartRequestSchema>;

/**
 * Ask the supervisor for the status of one or all children. Mirrors `MonitorRequest`.
 */
export const MonitorRequestSchema = z
  .object({
    /** Tag discriminating this request variant. */
    kind: z.literal('monitor'),
    /** Specific child id to monitor; omit to request all children. */
    child_id: z.string().optional(),
  })
  .strict();

/** Monitor request payload (inferred from {@link MonitorRequestSchema}). */
export type MonitorRequest = z.infer<typeof MonitorRequestSchema>;

/**
 * Ask the supervisor for its own health. Mirrors `HealthRequest` (no fields
 * beyond the discriminator).
 */
export const HealthRequestSchema = z
  .object({
    /** Tag discriminating this request variant. */
    kind: z.literal('health'),
  })
  .strict();

/** Health request payload (inferred from {@link HealthRequestSchema}). */
export type HealthRequest = z.infer<typeof HealthRequestSchema>;

/**
 * The discriminated union of all client → supervisor requests. The `kind`
 * field selects the variant, matching the serde `#[serde(tag = "kind")]`
 * tagging on the Rust `IpcRequest` enum.
 */
export const SupervisorIpcRequestSchema = z.discriminatedUnion('kind', [
  SpawnRequestSchema,
  RestartRequestSchema,
  MonitorRequestSchema,
  HealthRequestSchema,
]);

/** Any supervisor IPC request (inferred from {@link SupervisorIpcRequestSchema}). */
export type SupervisorIpcRequest = z.infer<typeof SupervisorIpcRequestSchema>;

// ─── Responses (supervisor → client) ──────────────────────────────────────────

/**
 * Result of a {@link SpawnRequest}. Mirrors `SpawnResult` carried by the
 * `spawned` response variant.
 */
export const SpawnedResponseSchema = z
  .object({
    /** Tag discriminating this response variant. */
    kind: z.literal('spawned'),
    /** Logical id of the spawned child. */
    child_id: z.string().min(1),
    /** OS pid assigned to the spawned child. */
    pid: z.number().int().nonnegative(),
  })
  .strict();

/** Spawned response payload (inferred from {@link SpawnedResponseSchema}). */
export type SpawnedResponse = z.infer<typeof SpawnedResponseSchema>;

/**
 * Result of a {@link RestartRequest}. Mirrors `RestartResult`.
 */
export const RestartedResponseSchema = z
  .object({
    /** Tag discriminating this response variant. */
    kind: z.literal('restarted'),
    /** Logical id of the restarted child. */
    child_id: z.string().min(1),
    /** New OS pid after the restart. */
    pid: z.number().int().nonnegative(),
    /** Number of times this child has been restarted in total. */
    restart_count: z.number().int().nonnegative(),
  })
  .strict();

/** Restarted response payload (inferred from {@link RestartedResponseSchema}). */
export type RestartedResponse = z.infer<typeof RestartedResponseSchema>;

/**
 * A monitor snapshot for one or more children. Mirrors `MonitorResult`.
 */
export const MonitorResponseSchema = z
  .object({
    /** Tag discriminating this response variant. */
    kind: z.literal('monitor'),
    /** One row per monitored child. */
    children: z.array(ChildStatusSchema),
  })
  .strict();

/** Monitor response payload (inferred from {@link MonitorResponseSchema}). */
export type MonitorResponse = z.infer<typeof MonitorResponseSchema>;

/**
 * A health snapshot for the supervisor itself. Mirrors `HealthResult`.
 */
export const HealthResponseSchema = z
  .object({
    /** Tag discriminating this response variant. */
    kind: z.literal('health'),
    /** Supervisor process pid. */
    pid: z.number().int().nonnegative(),
    /** Number of children currently tracked. */
    child_count: z.number().int().nonnegative(),
    /** Seconds the supervisor has been running. */
    uptime_secs: z.number().int().nonnegative(),
    /** Frozen protocol version the supervisor speaks. */
    protocol_version: z.string(),
  })
  .strict();

/** Health response payload (inferred from {@link HealthResponseSchema}). */
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

/**
 * Lifecycle event kind. Mirrors `LifecycleEventKind`.
 *
 * - `child_exited`    — a child process exited.
 * - `child_restarted` — a child was restarted after a crash.
 */
export const LifecycleEventKindSchema = z.enum(['child_exited', 'child_restarted']);

/** Lifecycle event kind (inferred from {@link LifecycleEventKindSchema}). */
export type LifecycleEventKind = z.infer<typeof LifecycleEventKindSchema>;

/**
 * An unsolicited lifecycle event broadcast to all connected clients. Mirrors
 * the `event` response variant wrapping `LifecycleEvent`.
 */
export const LifecycleEventResponseSchema = z
  .object({
    /** Tag discriminating this response variant. */
    kind: z.literal('event'),
    /** What happened. */
    event: LifecycleEventKindSchema,
    /** Logical id of the affected child. */
    child_id: z.string().min(1),
    /** Exit code, when the OS reported one. */
    exit_code: z.number().int().optional(),
    /** Terminating signal name, when the child was signalled (Unix). */
    signal: z.string().optional(),
    /** Backoff delay (ms) before the pending restart, when applicable. */
    restart_delay_ms: z.number().int().nonnegative().optional(),
  })
  .strict();

/** Lifecycle event response payload (inferred from {@link LifecycleEventResponseSchema}). */
export type LifecycleEventResponse = z.infer<typeof LifecycleEventResponseSchema>;

/**
 * An error response correlated to a request. Mirrors `ErrorResult`.
 */
export const ErrorResponseSchema = z
  .object({
    /** Tag discriminating this response variant. */
    kind: z.literal('error'),
    /** Machine-readable error code (e.g. `E_UNKNOWN_CHILD`). */
    code: z.string().min(1),
    /** Human-readable error message. */
    message: z.string(),
  })
  .strict();

/** Error response payload (inferred from {@link ErrorResponseSchema}). */
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

/**
 * The discriminated union of all supervisor → client responses and events. The
 * `kind` field selects the variant, matching the serde `#[serde(tag = "kind")]`
 * tagging on the Rust `IpcResponse` enum.
 */
export const SupervisorIpcResponseSchema = z.discriminatedUnion('kind', [
  SpawnedResponseSchema,
  RestartedResponseSchema,
  MonitorResponseSchema,
  HealthResponseSchema,
  LifecycleEventResponseSchema,
  ErrorResponseSchema,
]);

/** Any supervisor IPC response (inferred from {@link SupervisorIpcResponseSchema}). */
export type SupervisorIpcResponse = z.infer<typeof SupervisorIpcResponseSchema>;

// ─── Envelope ──────────────────────────────────────────────────────────────────

/**
 * A client → supervisor request envelope.
 *
 * The `direction` discriminator + flattened `request` payload mirror the serde
 * `#[serde(tag = "direction")]` `IpcPayload::Request { request }` variant.
 */
export const SupervisorIpcRequestEnvelopeSchema = z
  .object({
    /** Frozen protocol version. */
    protocol_version: z.string(),
    /** Correlation id echoed back on the matching response. */
    id: z.string().min(1),
    /** Direction discriminator. */
    direction: z.literal('request'),
    /** The request body. */
    request: SupervisorIpcRequestSchema,
  })
  .strict();

/** Request envelope (inferred from {@link SupervisorIpcRequestEnvelopeSchema}). */
export type SupervisorIpcRequestEnvelope = z.infer<typeof SupervisorIpcRequestEnvelopeSchema>;

/**
 * A supervisor → client response/event envelope.
 *
 * The `direction` discriminator + flattened `response` payload mirror the serde
 * `IpcPayload::Response { response }` variant.
 */
export const SupervisorIpcResponseEnvelopeSchema = z
  .object({
    /** Frozen protocol version. */
    protocol_version: z.string(),
    /** Correlation id echoed from the originating request (or a fresh id for events). */
    id: z.string().min(1),
    /** Direction discriminator. */
    direction: z.literal('response'),
    /** The response body. */
    response: SupervisorIpcResponseSchema,
  })
  .strict();

/** Response envelope (inferred from {@link SupervisorIpcResponseEnvelopeSchema}). */
export type SupervisorIpcResponseEnvelope = z.infer<typeof SupervisorIpcResponseEnvelopeSchema>;

/**
 * The top-level IPC envelope: a versioned, correlated wrapper that is either a
 * request or a response, discriminated by `direction`. One envelope per NDJSON
 * line. Mirrors the Rust `IpcEnvelope`.
 */
export const SupervisorIpcEnvelopeSchema = z.discriminatedUnion('direction', [
  SupervisorIpcRequestEnvelopeSchema,
  SupervisorIpcResponseEnvelopeSchema,
]);

/** Any supervisor IPC envelope (inferred from {@link SupervisorIpcEnvelopeSchema}). */
export type SupervisorIpcEnvelope = z.infer<typeof SupervisorIpcEnvelopeSchema>;

// ─── Frozen message-set guard ──────────────────────────────────────────────────

/**
 * The FROZEN v1.0 request `kind` values. The schema-drift guard test pins this
 * tuple; any addition/removal is a contract-breaking change.
 */
export const SUPERVISOR_IPC_REQUEST_KINDS = ['spawn', 'restart', 'monitor', 'health'] as const;

/**
 * The FROZEN v1.0 response `kind` values. The schema-drift guard test pins this
 * tuple; any addition/removal is a contract-breaking change.
 */
export const SUPERVISOR_IPC_RESPONSE_KINDS = [
  'spawned',
  'restarted',
  'monitor',
  'health',
  'event',
  'error',
] as const;

/**
 * The complete FROZEN v1.0 message kind set (requests + responses), used by the
 * drift guard on both the TS and Rust sides.
 */
export const SUPERVISOR_IPC_MESSAGE_KINDS = [
  ...SUPERVISOR_IPC_REQUEST_KINDS,
  ...SUPERVISOR_IPC_RESPONSE_KINDS,
] as const;
