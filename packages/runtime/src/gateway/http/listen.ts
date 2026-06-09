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

import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { DispatchResponse, Gateway, GatewayStreamEvent } from '@cleocode/contracts/gateway';
import { getLogger } from '@cleocode/core';
import type { GatewayHandler } from '../index.js';
import { inferGateway, resolveStreamRoute } from '../registry.js';
import { routeUnary } from './server.js';
import { createSseStream, encodeStreamEvent, SSE_HEADERS } from './sse.js';
import { resolveStreamSource, type StreamSourceContext } from './stream-sources.js';
import type { HttpUnaryRequest } from './types.js';
import { attachWsPtyEndpoint, type WsPtyOptions } from './ws-pty.js';

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
  /**
   * WebSocket terminal/PTY endpoint configuration (T11922 · M5 WS half). When
   * provided, a WS upgrade handler for {@link WS_PTY_PATH} (`/v1/terminal/pty`)
   * is attached to this server's `'upgrade'` event — gated at the edge (loopback
   * + optional token/origin) and bridging a PTY bidirectionally over WS frames.
   * When OMITTED, no upgrade handler is attached and the server stays a pure
   * unary+SSE HTTP listener (the capability is opt-in — the daemon enables it
   * explicitly). The optional `node-pty` backend is loaded dynamically; if it is
   * absent, the endpoint still upgrades and reports a clean "PTY backend
   * unavailable" close rather than crashing.
   */
  wsPty?: WsPtyOptions;
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
  | { ok: true; kind: 'stream'; gateway: Gateway; domain: string; operation: string }
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
 * Two GET routing vocabularies are accepted:
 *
 *   - `GET /v1/health` — the liveness probe.
 *   - `GET /v1/<domain>/<operation>` — the **SSE streaming** endpoint (T11921),
 *     recognized only when the `(domain, operation)` pair is registered AND
 *     flagged `streaming: true` in {@link OPERATIONS} (resolved via
 *     {@link resolveStreamRoute}). The SAME pair is dispatched UNARY over POST,
 *     so the streaming GET co-exists with the unary POST route. A GET to a
 *     unary-only op is a `405` (method-not-allowed), distinguishing "route
 *     exists, this method is unsupported" from "no such route" (`404`).
 *
 * A non-POST/GET method is rejected at the edge (`405`); a path that resolves to
 * neither vocabulary is a `404`. The injected {@link GatewayHandler} is never
 * invoked with a malformed request.
 *
 * @param method - The HTTP request method.
 * @param url - The HTTP request URL (path + query).
 * @returns The parsed route, or a typed rejection for the wire edge.
 */
export function parseHttpRoute(method: string | undefined, url: string | undefined): ParsedRoute {
  // Parse against a dummy origin so only the path is consumed (query ignored).
  const pathname = new URL(url ?? '/', 'http://localhost').pathname;
  const segments = pathname.split('/').filter((s) => s.length > 0);

  // GET routes: the liveness probe and the SSE streaming endpoint.
  if (method === 'GET') {
    if (segments.length === 2 && segments[0] === V1_PREFIX && segments[1] === 'health') {
      return { ok: true, kind: 'health' };
    }
    // GET /v1/<domain>/<operation> — SSE streaming endpoint (T11921). Only a
    // `(domain, operation)` pair registered AND flagged `streaming: true` opens
    // a `text/event-stream`; this co-exists with the unary POST routes (the
    // SAME pair is dispatched unary over POST). A GET to a unary-only op falls
    // through to a 405 so the caller can tell "route exists, method unsupported"
    // from "no such route" (404).
    if (segments.length === 3 && segments[0] === V1_PREFIX) {
      const [, domain, operation] = segments;
      const stream = resolveStreamRoute(domain, operation);
      if (stream !== undefined) {
        return { ok: true, kind: 'stream', gateway: stream.gateway, domain, operation };
      }
    }
    return {
      ok: false,
      status: 405,
      code: 'E_HTTP_METHOD_NOT_ALLOWED',
      message: `method GET not allowed for '${pathname}'; only GET /v1/health and registered streaming ops are served`,
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
 * Decode the query string of a streaming `GET` into a params object.
 *
 * Numeric-looking values (e.g. `?ticks=3`) are coerced to numbers so a declared
 * `number` param (`ticks`) arrives typed; everything else stays a string. This
 * mirrors how the unary path receives an already-decoded JSON body, but for the
 * GET-with-query-string streaming shape.
 *
 * @param url - The raw request URL (path + query).
 * @returns The decoded params object (empty when there is no query string).
 */
function parseStreamParams(url: string | undefined): Record<string, unknown> {
  const parsed = new URL(url ?? '/', 'http://localhost');
  const params: Record<string, unknown> = {};
  for (const [key, value] of parsed.searchParams.entries()) {
    const asNumber = Number(value);
    params[key] = value !== '' && Number.isFinite(asNumber) ? asNumber : value;
  }
  return params;
}

/**
 * Write a single terminal SSE `error` frame and close the response.
 *
 * Used when a streaming route is recognized but has no registered source — the
 * client gets one well-formed `data: {kind:'error',…}` frame on the
 * `text/event-stream` body (not a JSON error envelope, which a streaming client
 * is not parsing for), then a clean close.
 *
 * @param res - The server response.
 * @param domain - The streaming route domain (for the error message).
 * @param operation - The streaming route operation (for the error message).
 * @param requestId - The request id stamped on the frame.
 */
function writeStreamError(
  res: ServerResponse,
  domain: string,
  operation: string,
  requestId: string,
): void {
  const frame: GatewayStreamEvent = {
    kind: 'error',
    seq: 0,
    error: {
      code: 'E_HTTP_NO_STREAM_SOURCE',
      message: `no streaming source registered for '${domain}/${operation}'`,
    },
    requestId,
  };
  res.writeHead(200, { ...SSE_HEADERS });
  res.end(encodeStreamEvent(frame));
}

/**
 * Handle a `GET /v1/<domain>/<operation>` streaming request: resolve the
 * registered {@link GatewayStreamSource}, open a `text/event-stream`, and pipe
 * its {@link GatewayStreamEvent} frames through the abort-safe
 * {@link createSseStream} builder until the source completes or the client
 * disconnects.
 *
 * The request's `close` is bridged to an {@link AbortController} so a client
 * disconnect closes the stream leak-free (the source's teardown runs exactly
 * once). The web {@link ReadableStream} the builder produces is adapted onto the
 * `node:http` response via {@link Readable.fromWeb}. Secrets never touch the
 * wire — the source resolves any credential server-side before emitting.
 *
 * @param req - The inbound request.
 * @param res - The outbound response.
 * @param domain - The resolved streaming-route domain.
 * @param operation - The resolved streaming-route operation.
 * @param log - The adapter's pino logger.
 */
async function handleStreamRequest(
  req: IncomingMessage,
  res: ServerResponse,
  domain: string,
  operation: string,
  log: ReturnType<typeof getLogger>,
): Promise<void> {
  const requestId = randomUUID();
  const source = resolveStreamSource(domain, operation);
  if (source === undefined) {
    writeStreamError(res, domain, operation, requestId);
    log.warn({ domain, operation }, 'sse stream has no registered source');
    return;
  }

  // Bridge client disconnect → abort so createSseStream tears the source down.
  const controller = new AbortController();
  const onClose = (): void => controller.abort();
  req.once('close', onClose);

  const context: StreamSourceContext = {
    domain,
    operation,
    params: parseStreamParams(req.url),
    requestId,
  };

  res.writeHead(200, { ...SSE_HEADERS });

  const webStream = createSseStream((emitter) => source(emitter, context), controller.signal);

  // Drain the web ReadableStream's reader directly onto the node response. We do
  // NOT use `Readable.fromWeb` here: its DOM-typed `ReadableStream<any>` clashes
  // with the global web-streams `ReadableStream<Uint8Array>` over ArrayBuffer
  // variance under `tsup --dts`. Reading the reader manually keeps the types
  // exact and gives us a single place to honor backpressure + abort.
  const reader = webStream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (res.writableEnded) break;
      // Honor backpressure: if the kernel buffer is full, wait for `drain`.
      if (!res.write(value)) {
        await new Promise<void>((resolve) => res.once('drain', resolve));
      }
    }
  } catch (err) {
    log.warn({ err, domain, operation }, 'sse stream pipe failed');
  } finally {
    reader.releaseLock();
    req.removeListener('close', onClose);
    if (!controller.signal.aborted) controller.abort();
    if (!res.writableEnded) res.end();
    log.debug({ domain, operation, requestId }, 'sse stream closed');
  }
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
  if (route.kind === 'stream') {
    await handleStreamRequest(req, res, route.domain, route.operation, log);
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

  // Attach the WS terminal/PTY endpoint (T11922) to the SAME server's `'upgrade'`
  // event when configured — the WS capability lives on the existing listener
  // (AC1), gated at the edge (AC4) and torn down with the server (AC3).
  const wsPty = opts.wsPty !== undefined ? attachWsPtyEndpoint(server, opts.wsPty) : undefined;

  return new Promise<HttpServerHandle>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, host, () => {
      server.removeListener('error', reject);
      const address = server.address();
      const boundPort = typeof address === 'object' && address !== null ? address.port : opts.port;
      log.info(
        { host, port: boundPort, wsPty: wsPty !== undefined },
        'http gateway server listening',
      );

      let closed = false;
      const handle: HttpServerHandle = {
        server,
        port: boundPort,
        host,
        close(): Promise<void> {
          if (closed) return Promise.resolve();
          closed = true;
          // Tear down every live WS-PTY session + detach the upgrade listener
          // BEFORE closing the HTTP server, so a hung terminal cannot block
          // shutdown (deterministic teardown — AC3).
          wsPty?.close();
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
