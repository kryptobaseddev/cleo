/**
 * HTTP transport adapter — serves gateway unary + SSE over HTTP.
 *
 * The fourth and final gateway transport (after CLI, MCP, RPC). Unlike the
 * connection-oriented RPC/MCP adapters, the HTTP adapter is framework-agnostic
 * by design: it does NOT bind a port or own a `Request`/`Response` lifecycle.
 * Instead it exposes two pure routing primitives the embedder (a SvelteKit
 * route handler, the daemon's HTTP server, a test harness) calls directly:
 *
 *   - {@link routeUnary} — one POST → `source: 'http'` {@link DispatchRequest}
 *     → injected {@link GatewayHandler} → `{ status, body }` (LAFS envelope).
 *   - the SSE primitives in `./sse.js` (`createSseStream`) for streaming ops.
 *
 * This keeps the runtime free of any HTTP-server / SvelteKit / `@cleocode/cleo`
 * dependency: the embedder owns wire concerns (parsing the URL into a
 * `(gateway, domain, operation)` triple, setting headers, `process.exit`,
 * error-render at the edge), exactly mirroring how the CLI adapter wraps the
 * same handler. There is NO `process.exit` and NO error-render in the handlers
 * (R3 contract); the adapter never calls `process.exit` at all.
 *
 * The request `source` is forced to `'http'` regardless of what the embedder
 * passes, so a client cannot impersonate another transport.
 *
 * @packageDocumentation
 * @module @cleocode/runtime/gateway/http
 *
 * @task T11450
 * @epic T11254
 * @saga T11243
 */

import { randomUUID } from 'node:crypto';
import type { DispatchRequest, DispatchResponse } from '@cleocode/contracts/gateway';
import type { GatewayHandler } from '../index.js';
import type { HttpUnaryRequest, HttpUnaryResult } from './types.js';

/**
 * Map a LAFS dispatch error code to an HTTP status code.
 *
 * The canonical machine-readable error code (`E_NOT_FOUND`, `E_VALIDATION_…`,
 * `E_FORBIDDEN`, …) is the source of truth; the numeric LAFS exit code is a
 * secondary hint. Unknown error codes fall back to `500`. A successful envelope
 * is always `200`.
 *
 * @param response - The dispatch response.
 * @returns The HTTP status the embedder should set.
 */
export function statusForResponse(response: DispatchResponse): number {
  if (response.success) return 200;
  const code = response.error?.code ?? '';
  if (code === 'E_NOT_FOUND' || code.endsWith('_NOT_FOUND')) return 404;
  if (code === 'E_UNAUTHORIZED' || code === 'E_AUTH_REQUIRED') return 401;
  if (code === 'E_FORBIDDEN') return 403;
  if (code === 'E_RATE_LIMITED' || code === 'E_RATE_LIMIT_EXCEEDED') return 429;
  if (
    code === 'E_VALIDATION' ||
    code.startsWith('E_VALIDATION') ||
    code === 'E_INVALID_INPUT' ||
    code === 'E_BAD_REQUEST'
  ) {
    return 400;
  }
  if (code === 'E_NOT_IMPLEMENTED' || code === 'E_UNSUPPORTED') return 501;
  return 500;
}

/**
 * Route a single HTTP unary request through the gateway handler.
 *
 * Builds a `source: 'http'` {@link DispatchRequest} from the embedder-resolved
 * `(gateway, domain, operation, params)` triple and delegates to the injected
 * {@link GatewayHandler}. A thrown handler error is trapped and rendered as a
 * `500` LAFS error envelope — never propagated as an unhandled rejection or
 * `process.exit`. The `source` is always forced to `'http'`.
 *
 * @param handler - The injected transport-neutral gateway handler.
 * @param req - The embedder-resolved unary request coordinates + body params.
 * @returns The HTTP status + LAFS response body for the embedder to serialize.
 */
export async function routeUnary(
  handler: GatewayHandler,
  req: HttpUnaryRequest,
): Promise<HttpUnaryResult> {
  const requestId = req.requestId ?? randomUUID();
  const request: DispatchRequest = {
    gateway: req.gateway,
    domain: req.domain,
    operation: req.operation,
    params: req.params,
    // Force the transport of origin — a client cannot impersonate cli/mcp/rpc.
    source: 'http',
    requestId,
    sessionId: req.sessionId,
  };

  try {
    const body = await handler.handle(request);
    return { status: statusForResponse(body), body };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const body: DispatchResponse = {
      meta: {
        gateway: req.gateway,
        domain: req.domain,
        operation: req.operation,
        timestamp: new Date().toISOString(),
        duration_ms: 0,
        source: 'http',
        requestId,
      },
      success: false,
      error: { code: 'E_HTTP_INTERNAL', message },
    };
    return { status: 500, body };
  }
}
