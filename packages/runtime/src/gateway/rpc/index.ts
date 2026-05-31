/**
 * `@cleocode/runtime/gateway/rpc` — the CLI-RPC transport adapter.
 *
 * A thin unix-socket RPC adapter over the unified gateway. It serves
 * newline-delimited JSON (NDJSON) {@link GatewayRpcFrame}s over a long-lived
 * unix-domain socket and maps every `request` frame onto a `source: 'rpc'`
 * gateway request routed through an injected {@link GatewayHandler} (built with
 * `createGatewayHandler`).
 *
 * Mirrors the `@cleocode/runtime/gateway/mcp` adapter structurally (server +
 * codec + types + barrel) and reuses the FROZEN `supervisor-ipc` NDJSON framing
 * discipline — versioned, correlated, one frame per line — without editing that
 * frozen module. It carries NO `@cleocode/cleo` dependency and NO drizzle-orm.
 *
 * @packageDocumentation
 * @module @cleocode/runtime/gateway/rpc
 *
 * @task T11449
 * @epic T11254
 * @saga T11243
 */

export {
  buildErrorFrame,
  type DecodeResult,
  decodeLine,
  encodeFrame,
  LineBuffer,
} from './codec.js';
export { routeFrame, startRpcServer } from './server.js';
export type { RpcServerHandle, RpcServerOptions } from './types.js';
