/**
 * `createCleoClient` — the thin, typed wrapper over the generated gateway SDK.
 *
 * Every CLEO surface (CLI / TUI / Studio) shares ONE generated client. The raw
 * generated artifact ({@link ./generated}) is a flat set of ~412 hey-api SDK
 * functions plus a {@link GENERATED_NAMESPACES | domain→method map} derived from
 * the canonical OPERATIONS registry. This wrapper turns that into an ergonomic,
 * per-instance namespaced surface:
 *
 * ```ts
 * import { createCleoClient } from '@cleocode/core/gateway-client';
 *
 * const cleo = createCleoClient({ baseUrl: 'http://127.0.0.1:7421' });
 * const res  = await cleo.tasks.show({ body: { taskId: 'T1' } });
 * //    ^ res.data is the typed LAFS response envelope for tasks/show
 * const add  = await cleo.tasks.add({ body: { title: 'New task' } });
 * ```
 *
 * ## Why a wrapper (not the raw generated functions)
 *
 *  - **One client, one baseUrl.** Each call to {@link createCleoClient} owns its
 *    own underlying hey-api client instance (via `createClient`), so two clients
 *    pointed at different daemons never share mutable config. The generated flat
 *    functions otherwise default to a single module-level client.
 *  - **Namespaced surface (AC2).** `cleo.{tasks,session,memory,llm,nexus,docs,…}`
 *    is the contract the task asks for. The grouping + method names come straight
 *    from the registry projection, so the surface can never drift from the ops.
 *  - **Full type-safety, zero hand-maintained types.** The bound method signatures
 *    are INFERRED from the generated functions via {@link BoundMethod}, so each
 *    method keeps its exact per-operation request (`body`) and response types.
 *
 * ## Auth / secrets (AC5)
 *
 * The generated client carries NO embedded credentials. Authentication, if any,
 * is supplied by the caller at call time through `headers` (or a default header
 * map passed to {@link createCleoClient}). Nothing here reads the environment or
 * embeds a token.
 *
 * @packageDocumentation
 * @module @cleocode/core/gateway-client
 *
 * @task T11920 — M5/AC2: the single SDK client over core's gateway
 * @epic T11769 — E-API-STANDARD-FOUNDATION
 * @saga T10400
 */

import { createClient } from './generated/client/client.gen.js';
import type { Client, Config } from './generated/client/index.js';
import { GENERATED_NAMESPACES, type GeneratedNamespaces } from './generated/namespaces.gen.js';

/**
 * Options accepted by {@link createCleoClient}.
 */
export interface CleoClientOptions {
  /**
   * Base URL of the running `/v1` REST gateway (the daemon's `cleo daemon serve`
   * listener). Every operation routes through `POST <baseUrl>/v1/<domain>/<operation>`.
   *
   * @example 'http://127.0.0.1:7421'
   */
  baseUrl: string;
  /**
   * Default headers merged into every request (e.g. an `Authorization` bearer
   * token). Supplied by the caller — never sourced from the environment here.
   */
  headers?: Record<string, string>;
  /**
   * Escape hatch: a fully-formed underlying client config merged over the
   * defaults. Advanced callers (custom `fetch`, interceptors) use this; most
   * callers only need `baseUrl`.
   */
  config?: Config;
}

/**
 * The bound form of a single generated SDK function. The raw function is
 * `(options: Options<Data>) => RequestResult<…>`; the bound form drops the
 * `client` field (the wrapper injects the per-instance client) and makes the
 * whole options bag optional for no-input operations, while preserving the exact
 * `body`/response types.
 *
 * @typeParam F - A generated hey-api SDK function.
 */
export type BoundMethod<F> = F extends (options: infer O) => infer R
  ? (options?: Omit<O, 'client'>) => R
  : never;

/**
 * The bound form of one namespace — every generated function in it rebound to
 * the per-instance client via {@link BoundMethod}.
 *
 * @typeParam N - A namespace object from {@link GeneratedNamespaces}.
 */
export type BoundNamespace<N> = {
  readonly [M in keyof N]: BoundMethod<N[M]>;
};

/**
 * The full typed client surface: every registry domain as a namespace of bound
 * methods. This is the shape every CLI/TUI/Studio caller programs against.
 */
export type CleoClient = {
  readonly [D in keyof GeneratedNamespaces]: BoundNamespace<GeneratedNamespaces[D]>;
};

/**
 * Instantiate the shared CLEO gateway SDK client against a running `/v1` REST
 * facade.
 *
 * Returns a namespaced surface — `client.tasks.show(...)`,
 * `client.session.status(...)`, `client.memory.find(...)`, etc. — where every
 * method targets the configured `baseUrl` and carries the full per-operation
 * request/response types projected from the operations registry.
 *
 * @param options - {@link CleoClientOptions} (at minimum, the gateway `baseUrl`).
 * @returns A {@link CleoClient} bound to a fresh underlying client instance.
 *
 * @example
 * ```ts
 * const cleo = createCleoClient({ baseUrl: 'http://127.0.0.1:7421' });
 * const { data } = await cleo.tasks.show({ body: { taskId: 'T1' } });
 * ```
 *
 * @task T11920 — AC2/AC5
 */
export function createCleoClient(options: CleoClientOptions): CleoClient {
  const client: Client = createClient({
    baseUrl: options.baseUrl,
    ...(options.headers !== undefined ? { headers: options.headers } : {}),
    ...options.config,
  });

  const surface: Record<string, Record<string, unknown>> = {};

  for (const [domain, methods] of Object.entries(GENERATED_NAMESPACES)) {
    const ns: Record<string, unknown> = {};
    for (const [methodName, fn] of Object.entries(methods)) {
      // The generated function accepts an options bag; we inject the per-instance
      // client and forward everything else. Types are restored at the boundary by
      // the CleoClient mapped type — the runtime is a thin, uniform forward.
      const sdkFn = fn as (opts: Record<string, unknown>) => unknown;
      ns[methodName] = (opts?: Record<string, unknown>) => sdkFn({ ...opts, client });
    }
    surface[domain] = ns;
  }

  return surface as unknown as CleoClient;
}

/**
 * The canonical list of namespace (domain) names exposed by {@link CleoClient},
 * derived from the generated map. Useful for introspection / tests.
 */
export const CLEO_CLIENT_NAMESPACES: readonly string[] = Object.keys(GENERATED_NAMESPACES).sort();
