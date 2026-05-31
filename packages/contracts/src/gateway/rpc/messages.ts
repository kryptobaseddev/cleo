/**
 * `gateway/rpc` v1.0 — FROZEN NDJSON message contract (Zod schemas).
 *
 * The CLI-RPC transport carries gateway dispatch traffic over a long-lived
 * unix-domain socket. The wire format is newline-delimited JSON (NDJSON): one
 * {@link GatewayRpcFrame} per line — exactly the framing discipline used by the
 * FROZEN `supervisor-ipc` v1.0 contract, REUSED here (not edited): a versioned,
 * correlation-id'd envelope discriminated by `direction`.
 *
 * The difference from supervisor-ipc is the PAYLOAD: this contract wraps the
 * frozen gateway shapes ({@link dispatchRequestSchema} /
 * {@link dispatchResponseSchema} from `@cleocode/contracts/gateway`) rather
 * than supervisor process-control messages. So:
 *
 * ```jsonc
 * // request frame (client → server)
 * { "protocol_version": "1.0.0", "id": "abc", "direction": "request",
 *   "request": { "gateway": "query", "domain": "tasks", "operation": "show",
 *                "params": { "id": "T1" }, "source": "rpc",
 *                "requestId": "abc" } }
 * // response frame (server → client)
 * { "protocol_version": "1.0.0", "id": "abc", "direction": "response",
 *   "response": { "success": true, "data": {…}, "meta": {…} } }
 * // error frame (server → client) — protocol-level (bad version / parse / unknown)
 * { "protocol_version": "1.0.0", "id": "abc", "direction": "error",
 *   "error": { "code": "E_RPC_BAD_VERSION", "message": "…" } }
 * ```
 *
 * FROZEN v1.0: the {@link GATEWAY_RPC_DIRECTIONS} set is pinned by the drift
 * guard (`__tests__/freeze.test.ts`). Do not add/rename/remove directions in
 * place — bump to a new versioned directory instead. The request/response
 * PAYLOADS are owned by the gateway contract (R3-T2 · T11446) and re-validated
 * here so an untrusted RPC boundary cannot inject a malformed dispatch request.
 *
 * @task T11449
 * @epic T11254
 * @saga T11243
 * @packageDocumentation
 */

import { z } from 'zod';
import { dispatchRequestSchema, dispatchResponseSchema } from '../../gateway.js';
import { GATEWAY_RPC_PROTOCOL_VERSION } from './version.js';

// ─── Protocol-level error payload ──────────────────────────────────────────────

/**
 * A protocol-level (transport) error returned when a frame cannot even reach
 * the gateway: malformed JSON, a wrong `protocol_version`, or a frame the
 * server cannot route. Distinct from a {@link dispatchResponseSchema} `error`
 * field, which is a DOMAIN error produced by the handler itself.
 */
export const GatewayRpcErrorSchema = z
  .object({
    /** Machine-readable transport error code (e.g. `E_RPC_BAD_VERSION`). */
    code: z.string().min(1),
    /** Human-readable error message. */
    message: z.string(),
  })
  .strict();

/** Protocol-level RPC error payload (inferred from {@link GatewayRpcErrorSchema}). */
export type GatewayRpcError = z.infer<typeof GatewayRpcErrorSchema>;

// ─── Request frame (client → server) ───────────────────────────────────────────

/**
 * A client → server request frame: a versioned, correlated wrapper around a
 * single frozen {@link dispatchRequestSchema}. The `direction` discriminator +
 * flattened `request` payload mirror the supervisor-ipc envelope shape.
 */
export const GatewayRpcRequestFrameSchema = z
  .object({
    /** Frozen protocol version; rejected if it differs from the server's. */
    protocol_version: z.string(),
    /** Correlation id echoed back on the matching response/error frame. */
    id: z.string().min(1),
    /** Direction discriminator. */
    direction: z.literal('request'),
    /** The gateway dispatch request (re-validated at the untrusted boundary). */
    request: dispatchRequestSchema,
  })
  .strict();

/** Request frame (inferred from {@link GatewayRpcRequestFrameSchema}). */
export type GatewayRpcRequestFrame = z.infer<typeof GatewayRpcRequestFrameSchema>;

// ─── Response frame (server → client) ──────────────────────────────────────────

/**
 * A server → client response frame: a versioned, correlated wrapper around a
 * single frozen {@link dispatchResponseSchema} (the LAFS envelope the handler
 * produced).
 */
export const GatewayRpcResponseFrameSchema = z
  .object({
    /** Frozen protocol version. */
    protocol_version: z.string(),
    /** Correlation id echoed from the originating request. */
    id: z.string().min(1),
    /** Direction discriminator. */
    direction: z.literal('response'),
    /** The gateway dispatch response (LAFS envelope). */
    response: dispatchResponseSchema,
  })
  .strict();

/** Response frame (inferred from {@link GatewayRpcResponseFrameSchema}). */
export type GatewayRpcResponseFrame = z.infer<typeof GatewayRpcResponseFrameSchema>;

// ─── Error frame (server → client) ─────────────────────────────────────────────

/**
 * A server → client protocol-level error frame, emitted when a request frame
 * cannot be decoded or routed. Correlation `id` is best-effort (`'0'` when the
 * frame was so malformed the id could not be recovered).
 */
export const GatewayRpcErrorFrameSchema = z
  .object({
    /** Frozen protocol version. */
    protocol_version: z.string(),
    /** Correlation id (best-effort; `'0'` when unrecoverable). */
    id: z.string().min(1),
    /** Direction discriminator. */
    direction: z.literal('error'),
    /** The protocol-level error. */
    error: GatewayRpcErrorSchema,
  })
  .strict();

/** Error frame (inferred from {@link GatewayRpcErrorFrameSchema}). */
export type GatewayRpcErrorFrame = z.infer<typeof GatewayRpcErrorFrameSchema>;

// ─── Top-level frame union ─────────────────────────────────────────────────────

/**
 * The top-level RPC frame: a versioned, correlated wrapper that is a request,
 * a response, or a protocol-level error, discriminated by `direction`. One
 * frame per NDJSON line.
 */
export const GatewayRpcFrameSchema = z.discriminatedUnion('direction', [
  GatewayRpcRequestFrameSchema,
  GatewayRpcResponseFrameSchema,
  GatewayRpcErrorFrameSchema,
]);

/** Any RPC frame (inferred from {@link GatewayRpcFrameSchema}). */
export type GatewayRpcFrame = z.infer<typeof GatewayRpcFrameSchema>;

// ─── Frozen direction-set guard ────────────────────────────────────────────────

/**
 * The FROZEN v1.0 `direction` discriminator values. The drift guard
 * (`__tests__/freeze.test.ts`) pins this tuple; any addition/removal is a
 * contract-breaking change requiring a new versioned directory.
 */
export const GATEWAY_RPC_DIRECTIONS = ['request', 'response', 'error'] as const;

/** A single frozen RPC frame direction. */
export type GatewayRpcDirection = (typeof GATEWAY_RPC_DIRECTIONS)[number];

/**
 * The FROZEN v1.0 protocol-level transport error codes the adapter emits in an
 * {@link GatewayRpcErrorFrameSchema}. Pinned by the drift guard.
 */
export const GATEWAY_RPC_ERROR_CODES = [
  'E_RPC_PARSE',
  'E_RPC_BAD_VERSION',
  'E_RPC_BAD_FRAME',
  'E_RPC_INTERNAL',
] as const;

/** A single frozen RPC protocol-level error code. */
export type GatewayRpcErrorCode = (typeof GATEWAY_RPC_ERROR_CODES)[number];

/**
 * Type guard: is `v` the frozen RPC protocol version this contract pins?
 *
 * Used by the adapter's version-negotiation step to reject mismatched frames
 * with an `E_RPC_BAD_VERSION` error frame before any gateway routing.
 *
 * @param v - The candidate `protocol_version` string from an inbound frame.
 * @returns `true` iff `v` equals {@link GATEWAY_RPC_PROTOCOL_VERSION}.
 */
export function isFrozenGatewayRpcVersion(v: string): v is typeof GATEWAY_RPC_PROTOCOL_VERSION {
  return v === GATEWAY_RPC_PROTOCOL_VERSION;
}
