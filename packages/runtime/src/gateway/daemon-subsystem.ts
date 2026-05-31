/**
 * The gateway as a supervised **daemon subsystem**.
 *
 * R3-T7 (this task) closes the loop between the two R-track halves: the R3
 * gateway (dispatcher + the four transport adapters) and the R2 daemon
 * (`defineSubsystem` + the `SubsystemRegistry`). It expresses the
 * external-facing gateway as a uniform {@link Subsystem} so the R2 daemon
 * registry drives its `start → healthProbe → shutdown` lifecycle exactly like
 * every other long-running concern (Studio supervision, the GC cron, …). One
 * gateway subsystem is registered per scope (project / global) → one
 * external-facing gateway process per scope.
 *
 * Which transports the daemon hosts:
 *  - the **RPC unix socket** (`@cleocode/runtime/gateway/rpc`) — the canonical
 *    local-client wire: the `cleo` CLI, Studio's server process, and test
 *    harnesses open it to dispatch without paying a cold `cleo` spawn.
 *  - the **HTTP server** (`@cleocode/runtime/gateway/http` via the daemon-local
 *    `startHttpServer` embedder) — for external clients that speak HTTP rather
 *    than the unix-socket NDJSON wire.
 *
 * The CLI and MCP adapters are intentionally NOT hosted by the daemon: the CLI
 * adapter is in-process to the `cleo` binary, and the MCP adapter is a stdio
 * server an MCP client spawns and owns — neither is a long-lived,
 * daemon-supervised listener. The two external-facing listeners (RPC + HTTP)
 * are the ones the daemon owns.
 *
 * This subsystem adds NO behavior to the adapters themselves — it only wires
 * their existing `start*Server` / `close()` lifecycle (and their already-merged
 * routing) into the daemon registry's uniform lifecycle. It carries NO
 * `@cleocode/cleo` dependency and NO drizzle-orm (the runtime invariant): the
 * caller injects the assembled {@link GatewayHandler} and the resolved bind
 * coordinates; this module only orchestrates listeners.
 *
 * @packageDocumentation
 * @module @cleocode/runtime/gateway
 *
 * @task T11451 (R3-T7)
 * @epic T11254
 * @saga T11243 SG-RUNTIME-UNIFICATION
 */

import type { Subsystem, SubsystemHealth, SubsystemState } from '@cleocode/contracts';
import { getLogger } from '@cleocode/core';
import { defineSubsystem } from '../daemon/index.js';
import { type HttpServerHandle, type HttpServerOptions, startHttpServer } from './http/listen.js';
import type { GatewayHandler } from './index.js';
import { type RpcServerHandle, type RpcServerOptions, startRpcServer } from './rpc/index.js';

/** The scope a single gateway process serves — one external-facing process per scope. */
export type GatewayScope = 'project' | 'global';

/**
 * Configuration for one scoped gateway subsystem.
 *
 * The caller injects the assembled, transport-neutral {@link GatewayHandler}
 * (built with `createGatewayHandler` from its domain handlers + middleware) and
 * the resolved bind coordinates for each hosted transport. The runtime never
 * resolves paths/ports itself — that keeps it free of `@cleocode/paths` and of
 * any policy decision about where a scope's socket/port lives.
 */
export interface GatewaySubsystemOptions {
  /** The scope this gateway process serves (`project` | `global`). */
  scope: GatewayScope;
  /** The transport-neutral gateway handler every hosted transport routes through. */
  handler: GatewayHandler;
  /**
   * RPC unix-socket transport options. When omitted, the RPC transport is not
   * hosted (a deployment that only wants HTTP). At least one transport MUST be
   * configured.
   */
  rpc?: RpcServerOptions;
  /**
   * HTTP transport options. When omitted, the HTTP transport is not hosted (a
   * deployment that only wants the local RPC socket). At least one transport
   * MUST be configured.
   */
  http?: HttpServerOptions;
}

/**
 * The live context a started gateway subsystem threads from `start` into
 * `healthProbe`/`shutdown`: the bound transport handles plus the owning pid.
 *
 * `void`-typed contexts are common for subsystems, but the gateway needs to
 * carry its bound handles so `shutdown` can close exactly what `start` opened
 * (and `healthProbe` can report the bound coordinates).
 */
export interface GatewaySubsystemContext {
  /** The OS pid hosting the listeners (this daemon process). */
  readonly pid: number;
  /** The bound RPC server handle, when the RPC transport is hosted. */
  readonly rpc?: RpcServerHandle;
  /** The bound HTTP server handle, when the HTTP transport is hosted. */
  readonly http?: HttpServerHandle;
}

/**
 * The stable subsystem name (and supervised `child_id`) of a scoped gateway.
 *
 * Suffixed with the scope so a single daemon process supervising both scopes
 * (project + global) registers two distinct, non-colliding subsystems. The
 * `child_id` matches the id the Rust supervisor tracks the listener under.
 *
 * @param scope - The gateway scope.
 * @returns The subsystem name, e.g. `gateway-project`.
 */
export function gatewaySubsystemName(scope: GatewayScope): string {
  return `gateway-${scope}`;
}

/**
 * Declare the external-facing gateway as a supervised daemon {@link Subsystem}.
 *
 * The returned subsystem (frozen by {@link defineSubsystem}) is registered with
 * a `SubsystemRegistry`, which then drives its lifecycle uniformly:
 *
 *  - `start()`       — binds the configured transports (RPC unix socket and/or
 *    HTTP server) over the injected handler, in a fixed order (RPC then HTTP).
 *    If the second listener fails to bind, the first is rolled back so a failed
 *    start leaves no half-open listener — then the error is re-thrown for the
 *    registry's `onError` sink.
 *  - `healthProbe()` — reports a single {@link SubsystemHealth} row keyed on the
 *    scoped `child_id`, `running` while the configured listeners are live, with
 *    a `detail` summarizing the bound coordinates. Projects losslessly onto the
 *    supervisor's `ChildStatus`.
 *  - `shutdown()`    — closes every bound listener (best-effort, idempotent) in
 *    reverse bind order (HTTP then RPC).
 *
 * One subsystem instance is declared per scope, so registering the project and
 * global gateways yields two supervised listeners → one external-facing gateway
 * process surface per scope (AC1).
 *
 * @param opts - The scoped gateway configuration (handler + per-transport bind
 *   coordinates).
 * @returns A frozen {@link Subsystem} ready to `register()` with a
 *   `SubsystemRegistry`.
 * @throws {TypeError} When neither the RPC nor the HTTP transport is configured
 *   (a gateway with no hosted transport serves nothing).
 *
 * @example
 * ```ts
 * const registry = new SubsystemRegistry();
 * registry.register(
 *   defineGatewaySubsystem({
 *     scope: 'project',
 *     handler: createGatewayHandler(dispatcherConfig),
 *     rpc: { socketPath: '/run/cleo/cleo-gateway-rpc-project.sock' },
 *     http: { port: 7777 },
 *   }),
 * );
 * await registry.startAll();        // binds the RPC socket + HTTP server
 * const health = await registry.aggregateHealth();
 * await registry.shutdownAll();     // closes both listeners
 * ```
 */
export function defineGatewaySubsystem(
  opts: GatewaySubsystemOptions,
): Subsystem<GatewaySubsystemContext> {
  if (opts.rpc === undefined && opts.http === undefined) {
    throw new TypeError(
      'defineGatewaySubsystem: at least one transport (rpc and/or http) must be configured',
    );
  }

  const name = gatewaySubsystemName(opts.scope);
  const log = getLogger(name);

  // The `Subsystem.healthProbe` contract takes NO arguments — the registry only
  // threads the start→shutdown context, not into the probe. We therefore hold
  // the live context in a closure so `healthProbe()` can read the bound handles
  // (and report `stopped` before `start()`/after `shutdown()`).
  let live: GatewaySubsystemContext | undefined;

  return defineSubsystem<GatewaySubsystemContext>({
    name,

    async start(): Promise<GatewaySubsystemContext> {
      // Bind RPC first, then HTTP, so the unix socket is available before the
      // HTTP listener (the canonical local wire comes up first). On an HTTP
      // bind failure, roll back the RPC socket so start() never leaves a
      // half-open listener for the registry's onError to clean up after.
      let rpc: RpcServerHandle | undefined;
      try {
        if (opts.rpc !== undefined) {
          rpc = await startRpcServer(opts.handler, opts.rpc);
        }
        let http: HttpServerHandle | undefined;
        if (opts.http !== undefined) {
          http = await startHttpServer(opts.handler, opts.http);
        }
        const context: GatewaySubsystemContext = { pid: process.pid, rpc, http };
        live = context;
        log.info(
          { scope: opts.scope, rpc: rpc?.socketPath, httpPort: http?.port },
          'gateway subsystem started',
        );
        return context;
      } catch (cause) {
        // Roll back any listener already bound before re-throwing.
        if (rpc !== undefined) {
          await rpc.close().catch(() => undefined);
        }
        live = undefined;
        throw cause;
      }
    },

    healthProbe(): SubsystemHealth {
      // Not started (or already shut down) → report a stopped row so the
      // aggregate `allHealthy` cannot be falsely true.
      if (live === undefined) {
        const stopped: SubsystemState = 'stopped';
        return {
          child_id: name,
          pid: 0,
          state: stopped,
          restart_count: 0,
          detail: `scope=${opts.scope} not started`,
        };
      }
      const transports: string[] = [];
      if (live.rpc !== undefined) transports.push(`rpc=${live.rpc.socketPath}`);
      if (live.http !== undefined) {
        transports.push(`http=${live.http.host}:${live.http.port}`);
      }
      const running: SubsystemState = 'running';
      return {
        child_id: name,
        pid: live.pid,
        state: running,
        restart_count: 0,
        detail: `scope=${opts.scope} ${transports.join(' ')}`.trim(),
      };
    },

    async shutdown(context: GatewaySubsystemContext): Promise<void> {
      // Reverse bind order: close HTTP before the RPC socket. Both close()
      // calls are idempotent and best-effort — one failure must not block the
      // other listener's teardown.
      if (context.http !== undefined) {
        await context.http.close().catch((err: unknown) => {
          log.warn({ err }, 'gateway http close failed');
        });
      }
      if (context.rpc !== undefined) {
        await context.rpc.close().catch((err: unknown) => {
          log.warn({ err }, 'gateway rpc close failed');
        });
      }
      live = undefined;
      log.info({ scope: opts.scope }, 'gateway subsystem stopped');
    },
  });
}
