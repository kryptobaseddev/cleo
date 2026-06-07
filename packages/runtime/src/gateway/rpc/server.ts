/**
 * CLI-RPC unix-socket transport adapter — routes NDJSON frames through the gateway.
 *
 * Serves the gateway over a long-lived unix-domain socket using newline-delimited
 * JSON (NDJSON): one zod-validated {@link GatewayRpcFrame} per line. Any local
 * client (the `cleo` CLI talking to a warm daemon, Studio's server process, a
 * test harness) can open the socket, write `request` frames, and read back
 * `response`/`error` frames — without paying the per-invocation cold-start of
 * spawning a fresh `cleo` process.
 *
 * This is the THIRD transport adapter, mirroring the just-merged MCP stdio
 * adapter (`packages/runtime/src/gateway/mcp/`):
 *
 *   RPC request frame { direction:'request', request:{…} }
 *     → decode + validate (`@cleocode/contracts/gateway/rpc`)
 *     → DispatchRequest { source: 'rpc', … }  (re-validated at the boundary)
 *     → injected {@link GatewayHandler}.handle()
 *     → DispatchResponse (LAFS envelope)  →  RPC response frame
 *
 * The adapter owns ONLY wire concerns: socket lifecycle, line framing, version
 * negotiation, error rendering, and per-connection cleanup. All domain logic
 * (resolution, validation, middleware, handler execution) lives behind the
 * {@link GatewayHandler} — exactly mirroring the CLI and MCP adapters. There is
 * NO `process.exit` and NO error-render inside the handlers (R3 contract); the
 * adapter never calls `process.exit` at all (lifecycle is the caller's).
 *
 * The request `source` is forced to `'rpc'` regardless of what the client sent,
 * so a client cannot impersonate another transport.
 *
 * @task T11449
 * @epic T11254
 * @saga T11243
 */

import { randomUUID } from 'node:crypto';
import { existsSync, unlinkSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import type { DispatchRequest } from '@cleocode/contracts/gateway';
import type {
  GatewayRpcRequestFrame,
  GatewayRpcResponseFrame,
} from '@cleocode/contracts/gateway/rpc';
import { GATEWAY_RPC_PROTOCOL_VERSION } from '@cleocode/contracts/gateway/rpc';
import { getLogger } from '@cleocode/core';
import {
  bindConnectionSession,
  runWithConnectionHandle,
  unbindConnectionSession,
} from '@cleocode/core/internal';
import type { GatewayHandler } from '../index.js';
import { buildErrorFrame, decodeLine, encodeFrame, LineBuffer } from './codec.js';
import type { RpcServerHandle, RpcServerOptions } from './types.js';

/**
 * Route a single decoded request frame through the gateway handler and build
 * the correlated response frame.
 *
 * The request's `source` is forced to `'rpc'`; the frame `id` is reused as the
 * response correlation id (and, when the client omitted a `requestId` shaped
 * for tracing, the frame id flows through as the dispatch `requestId`). Thrown
 * handler errors are caught and rendered as a protocol-level `E_RPC_INTERNAL`
 * error frame — never propagated as an unhandled rejection or `process.exit`.
 *
 * ## Connection-scoped session binding (T11640 · Epic T11638)
 *
 * The daemon serves many connections over one process, so it cannot rely on the
 * single-process session-context singleton for identity. Instead, a frame on a
 * connection that declares a `sessionId` binds it into the `{connId → sessionId}`
 * registry, and the whole dispatch runs inside {@link runWithConnectionHandle}
 * so `core`'s `resolveCurrentSession` resolves THIS connection's session (its
 * highest-precedence tier) rather than "whoever wrote the DB last". When a frame
 * carries no `sessionId`, no binding is performed and resolution transparently
 * falls through to the env / active tiers — preserving existing behavior for
 * anonymous frames.
 *
 * ### Intra-connection bleed safety
 *
 * Frames on one connection are dispatched CONCURRENTLY (each `routeFrame` is
 * fired without awaiting the prior one), and registry binding is last-write-wins.
 * To stop a still-in-flight Frame A from resolving a sibling Frame B's session,
 * the frame's OWN declared `sessionId` is snapshotted into the per-frame
 * connection handle ({@link runWithConnectionHandle}'s third arg) — that snapshot
 * is authoritative for the dispatch, so a later re-bind of the same `connId`
 * cannot retroactively change who Frame A is. The registry binding remains only
 * for the late-binding path used by frames that declare no session of their own.
 *
 * @param handler - The injected transport-neutral gateway handler.
 * @param frame - A validated, version-matched request frame.
 * @param connId - The opaque per-connection id (bound at accept-time). Omitted
 *   only by direct/test callers that route a single frame outside a socket; a
 *   fresh ephemeral id is minted so the call still runs in an isolated
 *   connection-handle scope.
 * @returns The response or error frame to write back on the same connection.
 */
export async function routeFrame(
  handler: GatewayHandler,
  frame: GatewayRpcRequestFrame,
  connId: string = randomUUID(),
): Promise<GatewayRpcResponseFrame | ReturnType<typeof buildErrorFrame>> {
  const request: DispatchRequest = {
    ...frame.request,
    // Force the transport of origin — a client cannot impersonate cli/mcp/http.
    source: 'rpc',
    requestId: frame.request.requestId,
  };

  // Bind this connection to the session the frame declared (empty/absent ids are
  // ignored by the registry). This feeds the late-binding path for any sibling
  // frame that declares no session of its own. The per-frame snapshot below — not
  // this mutable registry — is what THIS dispatch resolves against, so a
  // concurrent sibling frame's re-bind cannot bleed into it.
  if (request.sessionId) {
    bindConnectionSession(connId, request.sessionId);
  }

  try {
    // Snapshot the frame's own session into the per-frame handle so this dispatch
    // is immune to concurrent last-write-wins re-binds of the same connId.
    const response = await runWithConnectionHandle(
      connId,
      () => handler.handle(request),
      request.sessionId,
    );
    return {
      protocol_version: GATEWAY_RPC_PROTOCOL_VERSION,
      id: frame.id,
      direction: 'response',
      response,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return buildErrorFrame(frame.id, 'E_RPC_INTERNAL', message);
  }
}

/**
 * Handle a single client connection: buffer NDJSON lines, decode each, route
 * request frames through the gateway, and write back response/error frames.
 *
 * Each connection owns its own {@link LineBuffer}, so partial-line chunk
 * boundaries are reassembled per socket. Frames are processed concurrently;
 * each correlated response carries the originating frame `id`, so the client
 * can demultiplex out-of-order completions.
 *
 * ## Accept-time session binding (T11640)
 *
 * A fresh opaque `connId` is minted per accepted socket and threaded into every
 * {@link routeFrame} call so the connection's declared session is bound into the
 * `{connId → sessionId}` registry and made the authoritative identity for that
 * dispatch (see {@link routeFrame}). On socket `close` the binding is removed so
 * the registry never grows unbounded across a long-lived daemon process.
 *
 * @param handler - The injected gateway handler.
 * @param socket - The accepted `node:net` connection.
 * @param log - The adapter's pino logger.
 */
function handleConnection(
  handler: GatewayHandler,
  socket: Socket,
  log: ReturnType<typeof getLogger>,
): void {
  socket.setEncoding('utf8');
  const lines = new LineBuffer();
  const connId = randomUUID();

  socket.on('data', (chunk: string) => {
    for (const line of lines.push(chunk)) {
      const decoded = decodeLine(line);
      if (decoded.kind === 'error') {
        socket.write(encodeFrame(decoded.frame));
        continue;
      }
      routeFrame(handler, decoded.frame, connId)
        .then((out) => {
          if (!socket.destroyed) socket.write(encodeFrame(out));
        })
        .catch((err: unknown) => {
          // routeFrame already traps handler errors; this guards the framing path.
          const message = err instanceof Error ? err.message : String(err);
          log.warn({ err }, 'rpc frame routing failed');
          if (!socket.destroyed) {
            socket.write(encodeFrame(buildErrorFrame(decoded.frame.id, 'E_RPC_INTERNAL', message)));
          }
        });
    }
  });

  socket.on('error', (err) => {
    log.warn({ err }, 'rpc connection error');
  });

  // Release the connection→session binding when the socket goes away so the
  // in-memory registry stays bounded across the daemon's lifetime (T11640).
  socket.on('close', () => {
    unbindConnectionSession(connId);
  });
}

/**
 * Start the CLI-RPC unix-socket server over the gateway.
 *
 * Binds {@link RpcServerOptions.socketPath}, accepts connections, and routes
 * each inbound NDJSON `request` frame through the injected {@link GatewayHandler}.
 * The caller assembles the handler (via `createGatewayHandler` with its domain
 * handlers + middleware) and injects it here — this adapter never builds
 * handlers itself, keeping the runtime free of any `@cleocode/cleo` dependency.
 *
 * Returns once the socket is listening. The returned {@link RpcServerHandle}
 * exposes an idempotent `close()` for deterministic teardown (daemon shutdown,
 * tests). The adapter never calls `process.exit`.
 *
 * @param handler - The transport-neutral gateway handler to route through.
 * @param opts - Socket path + lifecycle options.
 * @returns A promise resolving to the live {@link RpcServerHandle}.
 */
export function startRpcServer(
  handler: GatewayHandler,
  opts: RpcServerOptions,
): Promise<RpcServerHandle> {
  const log = getLogger('gateway-rpc');
  const removeStale = opts.removeStaleSocket ?? true;

  if (removeStale && existsSync(opts.socketPath)) {
    try {
      unlinkSync(opts.socketPath);
    } catch (err) {
      log.warn({ err, socketPath: opts.socketPath }, 'failed to unlink stale rpc socket');
    }
  }

  const server = createServer((socket) => handleConnection(handler, socket, log));

  return new Promise<RpcServerHandle>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.socketPath, () => {
      server.removeListener('error', reject);
      log.info(
        { socketPath: opts.socketPath, version: GATEWAY_RPC_PROTOCOL_VERSION },
        'rpc server listening',
      );

      let closed = false;
      const handle: RpcServerHandle = {
        server,
        socketPath: opts.socketPath,
        close(): Promise<void> {
          if (closed) return Promise.resolve();
          closed = true;
          return new Promise<void>((res) => {
            server.close(() => {
              if (existsSync(opts.socketPath)) {
                try {
                  unlinkSync(opts.socketPath);
                } catch {
                  // best-effort cleanup; the OS reclaims the node on exit anyway.
                }
              }
              res();
            });
          });
        },
      };
      resolve(handle);
    });
  });
}
