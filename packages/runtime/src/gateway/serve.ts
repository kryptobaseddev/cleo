/**
 * Daemon-side gateway server bootstrap — the call-site `cleo daemon serve`
 * drives (T11919).
 *
 * The HTTP gateway adapter (`./http/listen.ts`, T11254) and the supervised
 * `defineGatewaySubsystem` unit (`./daemon-subsystem.ts`, T11451) both already
 * exist, but nothing started them: the daemon had no `serve` call-site. This
 * module is that thin bootstrap — it assembles a {@link SubsystemRegistry} with
 * one scoped gateway subsystem hosting the HTTP transport (loopback by default)
 * over an INJECTED {@link GatewayHandler}, starts it, and returns a live handle
 * with the bound port + an idempotent `close()`.
 *
 * It carries NO `@cleocode/cleo` dependency and NO drizzle (the runtime
 * invariant): the caller (`cleo daemon serve`) injects the assembled CLI gateway
 * handler and the resolved bind coordinates. Secrets never touch the wire —
 * sealed-handle resolution happens server-side inside the dispatched handler,
 * exactly as it does for an in-process CLI call. The HTTP listener binds
 * `127.0.0.1` by default (loopback only); exposing it on a public interface is
 * an explicit caller decision.
 *
 * The streaming transports (SSE — T11921, WS — T11922) extend the SAME
 * subsystem: when their listeners land they bind alongside the unary HTTP server
 * here, so this bootstrap deliberately owns only transport assembly + lifecycle,
 * leaving the per-route seam to the adapter (`parseHttpRoute`).
 *
 * @packageDocumentation
 * @module @cleocode/runtime/gateway
 *
 * @task T11919
 * @epic T11769
 * @saga T10400
 */

import { defineGatewaySubsystem, type GatewayScope } from './daemon-subsystem.js';
import type { GatewayHandler } from './index.js';

/** Default loopback host for the HTTP gateway — local-process-facing only. */
const DEFAULT_HOST = '127.0.0.1';

/**
 * Options for {@link serveGateway}.
 *
 * The caller injects the assembled {@link GatewayHandler} and resolves the bind
 * coordinates so the runtime stays free of `@cleocode/paths`/`@cleocode/cleo`.
 */
export interface ServeGatewayOptions {
  /** The transport-neutral gateway handler every hosted transport routes through. */
  handler: GatewayHandler;
  /** TCP port to bind. `0` selects an ephemeral port (readable from the handle). */
  port: number;
  /** Host/interface to bind. Defaults to `127.0.0.1` (loopback only). */
  host?: string;
  /** The scope this gateway process serves. Defaults to `'global'`. */
  scope?: GatewayScope;
}

/**
 * A live gateway server handle returned by {@link serveGateway}.
 *
 * Exposes the actually-bound `port`/`host` (resolved even when `0` was
 * requested) and an idempotent {@link close} for deterministic teardown
 * (daemon shutdown, tests). Mirrors the lower-level
 * {@link import('./http/listen.js').HttpServerHandle} so a test can boot, probe,
 * and tear down on an ephemeral port.
 */
export interface ServeGatewayHandle {
  /** The actually-bound HTTP port (resolved when `0` was requested). */
  port: number;
  /** Host/interface the HTTP listener is bound to. */
  host: string;
  /** The scope the gateway process serves. */
  scope: GatewayScope;
  /** Stop every bound listener (best-effort, idempotent); resolves once closed. */
  close(): Promise<void>;
}

/**
 * Boot the HTTP gateway as a supervised subsystem and return a live handle.
 *
 * Declares one scoped gateway subsystem hosting the HTTP transport (loopback
 * default) over the injected handler via {@link defineGatewaySubsystem}, starts
 * it, and reads the actually-bound port from the start context (so the caller —
 * and tests — learn the ephemeral port when `0` was requested). The returned
 * `close()` drives the subsystem's `shutdown(context)` so teardown is the same
 * lifecycle the daemon registry uses for every other supervised concern.
 *
 * Using `defineGatewaySubsystem` directly (rather than a full
 * `SubsystemRegistry`) keeps the bound HTTP handle in reach for the port
 * resolution while still routing through the canonical start→shutdown contract.
 *
 * @param opts - The injected handler + resolved bind coordinates.
 * @returns A promise resolving to the live {@link ServeGatewayHandle}.
 *
 * @example
 * ```ts
 * const handle = await serveGateway({
 *   handler: createCliGatewayHandler(),
 *   port: 0, // ephemeral
 * });
 * // POST http://127.0.0.1:${handle.port}/v1/tasks/show
 * await handle.close();
 * ```
 */
export async function serveGateway(opts: ServeGatewayOptions): Promise<ServeGatewayHandle> {
  const host = opts.host ?? DEFAULT_HOST;
  const scope: GatewayScope = opts.scope ?? 'global';

  const subsystem = defineGatewaySubsystem({
    scope,
    handler: opts.handler,
    http: { port: opts.port, host },
  });

  const context = await subsystem.start();
  // The HTTP transport is configured, so `start()` always binds it.
  const boundPort = context.http?.port ?? opts.port;

  let closed = false;
  return {
    port: boundPort,
    host,
    scope,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await subsystem.shutdown(context);
    },
  };
}
