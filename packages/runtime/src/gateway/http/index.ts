/**
 * `@cleocode/runtime/gateway/http` — the HTTP transport adapter.
 *
 * The fourth and final gateway transport adapter (after CLI, MCP, RPC). Serves
 * the unified gateway over HTTP in two modes:
 *
 *   - UNARY: a `POST <op>` with a JSON body → `source: 'http'` gateway request
 *     routed through an injected {@link GatewayHandler} (built with
 *     `createGatewayHandler`) → JSON LAFS envelope ({@link routeUnary}).
 *   - SSE: a `GET` streaming endpoint that emits {@link GatewayStreamEvent}
 *     frames (the streaming type in `@cleocode/contracts/gateway`) over a
 *     `text/event-stream` body, built with the abort-safe {@link createSseStream}
 *     primitive.
 *
 * Mirrors the `@cleocode/runtime/gateway/{mcp,rpc}` adapters structurally
 * (server + wire helpers + types + barrel) but is framework-agnostic: it owns NO
 * port binding and NO `Request`/`Response` lifecycle, so the embedder (a
 * SvelteKit route, the daemon HTTP server, a test harness) supplies the resolved
 * operation coordinates and serializes the result. It carries NO
 * `@cleocode/cleo` dependency, NO SvelteKit dependency, and NO drizzle-orm.
 *
 * @packageDocumentation
 * @module @cleocode/runtime/gateway/http
 *
 * @task T11450
 * @epic T11254
 * @saga T11243
 */

export { routeUnary, statusForResponse } from './server.js';
export {
  createSseStream,
  encodeSseFrame,
  encodeStreamEvent,
  SSE_HEADERS,
  type SseEmitter,
  type SseFrame,
  type SseSource,
} from './sse.js';
export type { HttpUnaryRequest, HttpUnaryResult } from './types.js';
