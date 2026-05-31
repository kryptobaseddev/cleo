/**
 * Wire + lifecycle types for the `@cleocode/runtime/gateway/http` adapter.
 *
 * The HTTP transport carries the SAME gateway payloads as every other transport
 * — request/response shapes are owned by `@cleocode/contracts/gateway` (R3-T2 ·
 * T11446) and the streaming frame by `GatewayStreamEvent`. This module holds
 * only the runtime-adapter-local option/handle shapes (mirroring the MCP and RPC
 * adapters' `types.ts`), so the runtime stays framework-agnostic and free of any
 * `@cleocode/cleo` / SvelteKit / drizzle dependency.
 *
 * @task T11450
 * @epic T11254
 * @saga T11243
 */

import type { DispatchResponse, Gateway } from '@cleocode/contracts/gateway';

/**
 * Where on the wire the `(gateway, domain, operation)` triple of an HTTP unary
 * request is sourced from. The adapter is framework-agnostic, so the embedder
 * (SvelteKit route, daemon HTTP server, test harness) supplies the resolved
 * coordinates explicitly rather than the adapter parsing a URL itself.
 */
export interface HttpUnaryRequest {
  /** CQRS gateway — `'mutate'` (write) or `'query'` (read). */
  gateway: Gateway;
  /** Target canonical domain (e.g. `'tasks'`). */
  domain: string;
  /** Domain operation name (e.g. `'show'`). */
  operation: string;
  /** Decoded JSON request body → operation params. */
  params?: Record<string, unknown>;
  /**
   * Optional caller-supplied request id for tracing. When omitted the adapter
   * mints a fresh UUID.
   */
  requestId?: string;
  /** Bound session id, if any (forwarded into the dispatch request). */
  sessionId?: string;
}

/**
 * The result of routing one HTTP unary request through the gateway: the LAFS
 * {@link DispatchResponse} JSON body plus the HTTP status the embedder should
 * set (200 on success, 4xx/5xx mapped from the dispatch error).
 *
 * The adapter never writes the response itself (no framework coupling) — it
 * returns this so the embedder serializes it onto its own `Response`.
 */
export interface HttpUnaryResult {
  /** HTTP status code derived from the dispatch outcome. */
  status: number;
  /** The LAFS envelope to serialize as the JSON response body. */
  body: DispatchResponse;
}
