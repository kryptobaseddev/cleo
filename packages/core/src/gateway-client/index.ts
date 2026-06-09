/**
 * `@cleocode/core/gateway-client` — the single, shared, typed SDK client over
 * the CLEO `/v1` REST gateway.
 *
 * North-Star ratified decision: `@cleocode/core` IS the SDK — there is no
 * separate `@cleocode/sdk` package. This subpath is the public surface of the
 * generated client. CLI, TUI, and Studio all import {@link createCleoClient}
 * from here so they share ONE client off ONE OpenAPI projection of the
 * operations registry.
 *
 * The bulk of this module (per-operation request/response types, the inlined
 * fetch client, the flat SDK functions) is generated under `./generated/` by
 * `pnpm --filter @cleocode/core run gen:sdk` from the OpenAPI 3.1 document that
 * {@link generateOpenApi} projects. Only {@link createCleoClient} (and its
 * types) is hand-written.
 *
 * @packageDocumentation
 * @module @cleocode/core/gateway-client
 *
 * @task T11920 — M5/AC2
 * @epic T11769 — E-API-STANDARD-FOUNDATION
 * @saga T10400
 */

export {
  type BoundMethod,
  type BoundNamespace,
  CLEO_CLIENT_NAMESPACES,
  type CleoClient,
  type CleoClientOptions,
  createCleoClient,
} from './client.js';
// Re-export the underlying client primitives consumers may need to type custom
// config (interceptors, custom fetch) or response handling.
export type {
  Client,
  ClientOptions,
  Config,
  Options,
  RequestResult,
} from './generated/client/index.js';
// Re-export the generated per-operation types so consumers can name request and
// response shapes (e.g. `QueryTasksShowData`, `MutateTasksAddResponses`).
export type * from './generated/types.gen.js';
