/**
 * `gateway/rpc` v1.0 — FROZEN CLI-RPC NDJSON contract barrel.
 *
 * Re-exports the version constants and Zod frame schemas + inferred types for
 * the CLI-RPC transport (`@cleocode/runtime/gateway/rpc`): a long-lived
 * unix-socket RPC server that decodes NDJSON {@link GatewayRpcFrame}s into a
 * `source: 'rpc'` gateway request and routes them through the gateway handler.
 *
 * Mirrors the `supervisor-ipc` contract structure (version.ts + messages.ts +
 * this barrel + a freeze guard test) but carries gateway dispatch traffic, not
 * supervisor process-control messages. The request/response PAYLOADS are owned
 * by `@cleocode/contracts/gateway` (R3-T2 · T11446) and re-validated here at
 * the untrusted RPC boundary.
 *
 * @task T11449
 * @epic T11254
 * @saga T11243
 * @packageDocumentation
 */

export type {
  GatewayRpcDirection,
  GatewayRpcError,
  GatewayRpcErrorCode,
  GatewayRpcErrorFrame,
  GatewayRpcFrame,
  GatewayRpcRequestFrame,
  GatewayRpcResponseFrame,
} from './messages.js';
export {
  GATEWAY_RPC_DIRECTIONS,
  GATEWAY_RPC_ERROR_CODES,
  GatewayRpcErrorFrameSchema,
  GatewayRpcErrorSchema,
  GatewayRpcFrameSchema,
  GatewayRpcRequestFrameSchema,
  GatewayRpcResponseFrameSchema,
  isFrozenGatewayRpcVersion,
} from './messages.js';
export {
  GATEWAY_RPC_CHANNEL_BASENAME,
  GATEWAY_RPC_PROTOCOL_VERSION,
} from './version.js';
