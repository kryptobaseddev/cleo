/**
 * `node:http` server binding for the framework-agnostic HTTP gateway adapter.
 *
 * The HTTP adapter ({@link routeUnary} + the SSE primitives) is deliberately
 * framework-agnostic — it owns NO port binding and NO `Request`/`Response`
 * lifecycle, so an embedder (a SvelteKit route, a test harness) can drive it
 * directly. The **daemon**, however, is itself the embedder: it must expose the
 * gateway to external HTTP clients over a real listening socket. This module is
 * that thin embedder — a minimal `node:http` server that parses the request URL
 * into a `(gateway, domain, operation)` triple, reads the JSON body, and routes
 * it through {@link routeUnary}. It deliberately stays in the runtime (no
 * SvelteKit / no `@cleocode/cleo` / no drizzle dependency) so the daemon can
 * host the gateway without reaching across a package boundary.
 *
 * Routing contract (intentionally minimal — the wire vocabulary is the same as
 * every other transport, only the framing differs):
 *
 *   `POST /<gateway>/<domain>/<operation>`  with a JSON body → operation params
 *
 * where `<gateway>` is `query` | `mutate`. A non-POST method, an unparseable
 * path, or a body that is not a JSON object is rejected at the wire edge with a
 * LAFS-shaped error envelope — the injected {@link GatewayHandler} is never
 * invoked with a malformed request.
 *
 * @packageDocumentation
 * @module @cleocode/runtime/gateway/http
 *
 * @task T11451
 * @epic T11254
 * @saga T11243 SG-RUNTIME-UNIFICATION
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { DispatchResponse, Gateway } from '@cleocode/contracts/gateway';
import { getLogger } from '@cleocode/core';
import type { GatewayHandler } from '../index.js';
import { inferGateway } from '../registry.js';
import { routeUnary } from './server.js';
import type { HttpUnaryRequest } from './types.js';

/** The two CQRS gateways a path segment may name. */
const GATEWAYS: ReadonlySet<string> = new Set<Gateway>(['query', 'mutate']);

/** Maximum accepted request-body size (1 MiB) — a crude DoS guard at the edge. */
const MAX_BODY_BYTES = 1_048_576;

/**
 * The versioned REST facade prefix (T11919). `/v1/<domain>/<operation>` infers
 * the gateway from the registry; `/v1/health` is the liveness probe. The legacy
 * `/<gateway>/<domain>/<operation>` form is retained for backward compatibility.
 */
const V1_PREFIX = 'v1';

/**
 * Options for {@link startHttpServer}.
 *
 * Mirrors the connection-oriented {@link RpcServerOptions} shape: the caller
 * resolves the bind coordinates so the runtime stays free of any
 * `@cleocode/paths` dependency.
 */
export interface HttpServerOptions {
  /**
   * TCP port to bind. `0` selects an ephemeral port (the bound port is then
   * readable from {@link HttpServerHandle.port}).
   */
  port: number;
  /**
   * Host/interface to bind. Defaults to `127.0.0.1` (loopback only) — the
   * gateway is local-process-facing; exposing it on a public interface is an
   * explicit caller decision.
   */
  host?: string;
}

/**
 * A live HTTP server handle returned by {@link startHttpServer}.
 *
 * Exposes the bound {@link Server}, the actually-bound `port` (resolved even
 * when `0` was requested), and an idempotent {@link close}. The adapter never
 * calls `process.exit` — lifecycle stays with the caller (R3 contract).
 */
export interface HttpServerHandle {
  /** The bound `node:http` server. */
  server: Server;
  /** The actually-bound TCP port (resolved when `0` was requested). */
  port: number;
  /** Host/interface the server is bound to. */
  host: string;
  /** Close the server + all live connections; resolves once fully closed. */
  close(): Promise<void>;
}

/**
 * The result of parsing a request line into routing coordinates: a resolved
 * unary triple, a recognized health probe, or a rejection for the wire edge.
 */
type ParsedRoute =
  | { ok: true; kind: 'unary'; gateway: Gateway; domain: string; operation: string }
  | { ok: true; kind: 'health' }
  | { ok: false; status: number; code: string; message: string };

/**
 * Parse a gateway request line into a routing decision.
 *
 * Two POST routing vocabularies are accepted (the wire payload is identical to
 * every other transport — only the framing differs):
 *
 *   - `POST /v1/<domain>/<operation>` — the **versioned REST facade** (T11919).
 *     The gateway (`query` | `mutate`) is INFERRED from the registry, so the
 *     client need not name it. An unregistered `(domain, operation)` pair is a
 *     `404`.
 *   - `POST /<gateway>/<domain>/<operation>` — the **legacy** form, where the
 *     client names the gateway segment explicitly (validated against the two
 *     CQRS gateways so a client cannot smuggle an arbitrary value).
 *
 * `GET /v1/health` is recognized as a liveness probe (any other GET is a `405`).
 * A non-POST/GET method is rejected at the edge (`405`); a path that resolves to
 * neither vocabulary is a `404`. The injected {@link GatewayHandler} is never
 * invoked with a malformed request.
 *
 * The `/v1` listener is shaped so a future streaming route (SSE — T11921, WS —
 * T11922) slots in as an additional recognized `GET /v1/<domain>/<operation>`
 * branch without disturbing the unary path: this parser deliberately rejects
 * unknown GETs as `405` (not `404`) so the streaming seam can later distinguish
 * "method not yet supported on this route" from "no such route".
 *
 * @param method - The HTTP request method.
 * @param url - The HTTP request URL (path + query).
 * @returns The parsed route, or a typed rejection for the wire edge.
 */
export function parseHttpRoute(method: string | undefined, url: string | undefined): ParsedRoute {
  // Parse against a dummy origin so only the path is consumed (query ignored).
  const pathname = new URL(url ?? '/', 'http://localhost').pathname;
  const segments = pathname.split('/').filter((s) => s.length > 0);

  // GET /v1/health — liveness probe. The only non-POST route the gateway serves.
  if (method === 'GET') {
    if (segments.length === 2 && segments[0] === V1_PREFIX && segments[1] === 'health') {
      return { ok: true, kind: 'health' };
    }
    // Streaming seam (T11921/T11922): a future GET /v1/<domain>/<operation>
    // streaming branch lands here. Until then an unrecognized GET is a 405 so
    // the caller can tell "route exists, method unsupported" from "no route".
    return {
      ok: false,
      status: 405,
      code: 'E_HTTP_METHOD_NOT_ALLOWED',
      message: `method GET not allowed for '${pathname}'; only GET /v1/health is served`,
    };
  }

  if (method !== 'POST') {
    return {
      ok: false,
      status: 405,
      code: 'E_HTTP_METHOD_NOT_ALLOWED',
      message: `method ${method ?? '<none>'} not allowed; gateway accepts POST`,
    };
  }

  // POST /v1/<domain>/<operation> — versioned facade; gateway inferred.
  if (segments.length === 3 && segments[0] === V1_PREFIX) {
    const [, domain, operation] = segments;
    const gateway = inferGateway(domain, operation);
    if (gateway === undefined) {
      return {
        ok: false,
        status: 404,
        code: 'E_HTTP_NOT_FOUND',
        message: `unknown operation '${domain}/${operation}'; no registered query/mutate matches`,
      };
    }
    return { ok: true, kind: 'unary', gateway, domain, operation };
  }

  // POST /<gateway>/<domain>/<operation> — legacy explicit-gateway form.
  if (segments.length !== 3) {
    return {
      ok: false,
      status: 404,
      code: 'E_HTTP_NOT_FOUND',
      message: `expected POST /v1/<domain>/<operation> or /<gateway>/<domain>/<operation>, got '${pathname}'`,
    };
  }
  const [gateway, domain, operation] = segments;
  if (!GATEWAYS.has(gateway)) {
    return {
      ok: false,
      status: 404,
      code: 'E_HTTP_NOT_FOUND',
      message: `unknown gateway '${gateway}'; expected one of query, mutate`,
    };
  }
  return { ok: true, kind: 'unary', gateway: gateway as Gateway, domain, operation };
}

/**
 * Read the full request body as a string, enforcing {@link MAX_BODY_BYTES}.
 *
 * @param req - The inbound request stream.
 * @returns The decoded UTF-8 body.
 * @throws {Error} When the body exceeds the size cap (the connection is then
 *   destroyed by the caller).
 */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * Write a LAFS-shaped error envelope to the response at the wire edge.
 *
 * Used for rejections that never reach the {@link GatewayHandler} (bad method,
 * unroutable path, malformed body), so a client always sees a well-formed LAFS
 * envelope rather than a bare HTTP error.
 *
 * @param res - The server response.
 * @param status - The HTTP status to set.
 * @param code - The machine-readable LAFS error code.
 * @param message - A human-readable message.
 */
function writeEdgeError(res: ServerResponse, status: number, code: string, message: string): void {
  const body: DispatchResponse = {
    meta: {
      gateway: 'query',
      domain: '',
      operation: '',
      timestamp: new Date().toISOString(),
      duration_ms: 0,
      source: 'http',
      requestId: '',
    },
    success: false,
    error: { code, message },
  };
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

/**
 * Write a LAFS-shaped success envelope for the `GET /v1/health` liveness probe.
 *
 * The probe never touches the {@link GatewayHandler} (it is a pure wire-edge
 * liveness signal), so it returns a self-contained `200` envelope reporting the
 * server is up and the wire version it serves.
 *
 * @param res - The server response.
 */
function writeHealth(res: ServerResponse): void {
  const body: DispatchResponse = {
    meta: {
      gateway: 'query',
      domain: 'gateway',
      operation: 'health',
      timestamp: new Date().toISOString(),
      duration_ms: 0,
      source: 'http',
      requestId: '',
    },
    success: true,
    data: { status: 'ok', version: V1_PREFIX },
  };
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

/**
 * Handle a single inbound HTTP request: parse the route, read + JSON-parse the
 * body, route it through the gateway handler, and serialize the LAFS response.
 *
 * All failure modes are rendered as LAFS envelopes — a bad route or malformed
 * body is rejected at the edge (handler never invoked); a thrown handler error
 * is already trapped inside {@link routeUnary} as a `500`. The function never
 * throws and never calls `process.exit`.
 *
 * @param handler - The injected transport-neutral gateway handler.
 * @param req - The inbound request.
 * @param res - The outbound response.
 * @param log - The adapter's pino logger.
 */
async function handleHttpRequest(
  handler: GatewayHandler,
  req: IncomingMessage,
  res: ServerResponse,
  log: ReturnType<typeof getLogger>,
): Promise<void> {
  const route = parseHttpRoute(req.method, req.url);
  if (!route.ok) {
    writeEdgeError(res, route.status, route.code, route.message);
    return;
  }
  if (route.kind === 'health') {
    writeHealth(res);
    log.debug({ route: 'health' }, 'http health probe served');
    return;
  }

  let params: Record<string, unknown> | undefined;
  try {
    const raw = await readBody(req);
    if (raw.trim().length > 0) {
      const parsed: unknown = JSON.parse(raw);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        writeEdgeError(res, 400, 'E_HTTP_BAD_REQUEST', 'request body must be a JSON object');
        return;
      }
      params = parsed as Record<string, unknown>;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    writeEdgeError(res, 400, 'E_HTTP_BAD_REQUEST', `invalid request body: ${message}`);
    return;
  }

  const unary: HttpUnaryRequest = {
    gateway: route.gateway,
    domain: route.domain,
    operation: route.operation,
    params,
  };
  const result = await routeUnary(handler, unary);
  res.writeHead(result.status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(result.body));
  log.debug(
    {
      gateway: route.gateway,
      domain: route.domain,
      operation: route.operation,
      status: result.status,
    },
    'http request routed',
  );
}

/**
 * Start a `node:http` server that hosts the gateway over HTTP for external
 * clients.
 *
 * Binds {@link HttpServerOptions.port} on {@link HttpServerOptions.host}
 * (default loopback), routes every `POST /<gateway>/<domain>/<operation>`
 * through the injected {@link GatewayHandler} via {@link routeUnary}, and
 * resolves once listening. The returned {@link HttpServerHandle} exposes an
 * idempotent `close()` for deterministic teardown (daemon shutdown, tests). The
 * adapter never calls `process.exit`.
 *
 * The caller assembles the handler (via `createGatewayHandler` with its domain
 * handlers + middleware) and injects it here — this server never builds
 * handlers itself, keeping the runtime free of any `@cleocode/cleo` dependency.
 *
 * @param handler - The transport-neutral gateway handler to route through.
 * @param opts - Bind coordinates.
 * @returns A promise resolving to the live {@link HttpServerHandle}.
 */
export function startHttpServer(
  handler: GatewayHandler,
  opts: HttpServerOptions,
): Promise<HttpServerHandle> {
  const log = getLogger('gateway-http');
  const host = opts.host ?? '127.0.0.1';

  const server = createServer((req, res) => {
    handleHttpRequest(handler, req, res, log).catch((err: unknown) => {
      // handleHttpRequest traps its own failures; this guards the wire path.
      const message = err instanceof Error ? err.message : String(err);
      log.warn({ err }, 'http request handling failed');
      if (!res.headersSent) {
        writeEdgeError(res, 500, 'E_HTTP_INTERNAL', message);
      } else if (!res.writableEnded) {
        res.end();
      }
    });
  });

  return new Promise<HttpServerHandle>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, host, () => {
      server.removeListener('error', reject);
      const address = server.address();
      const boundPort = typeof address === 'object' && address !== null ? address.port : opts.port;
      log.info({ host, port: boundPort }, 'http gateway server listening');

      let closed = false;
      const handle: HttpServerHandle = {
        server,
        port: boundPort,
        host,
        close(): Promise<void> {
          if (closed) return Promise.resolve();
          closed = true;
          return new Promise<void>((res) => {
            server.close(() => res());
            // Drop keep-alive connections so close() resolves promptly.
            server.closeIdleConnections();
          });
        },
      };
      resolve(handle);
    });
  });
}
