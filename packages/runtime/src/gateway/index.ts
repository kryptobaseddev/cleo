/**
 * `@cleocode/runtime/gateway` — the transport-agnostic CQRS dispatch core.
 *
 * Relocated from `packages/cleo/src/dispatch` (R3-T3 · T11447 ·
 * SG-RUNTIME-UNIFICATION) so the dispatcher is owned by the runtime layer and
 * can be driven by ANY transport adapter — CLI, MCP, RPC, HTTP — not just the
 * CLI. Mirrors the `@cleocode/runtime/daemon` subpath (R2).
 *
 * The CLI adapter (`packages/cleo/src/dispatch/adapters/cli.ts`) and the
 * domain handlers + transport-specific middleware stay in `packages/cleo`; they
 * are INJECTED into the {@link Dispatcher} via {@link DispatcherConfig}. The
 * gateway contract itself lives in `@cleocode/contracts/gateway` (R3-T2).
 *
 * `packages/cleo/src/dispatch/{dispatcher,registry,lib/meta,middleware/pipeline}.ts`
 * remain as thin re-export shims pointing here, so the in-package import sites
 * (cli adapter, ~18 registry consumers, getCliDispatcher) compile unchanged.
 *
 * @epic T4820
 * @task T11447
 * @saga T11243
 */

import type { DispatchRequest, DispatchResponse } from '@cleocode/contracts/gateway';
import { Dispatcher, type DispatcherConfig } from './dispatcher.js';

export type { DispatcherConfig } from './dispatcher.js';
export { Dispatcher } from './dispatcher.js';
export { createDispatchMeta } from './meta.js';
export { compose } from './pipeline.js';
export type { OperationDef, Resolution } from './registry.js';
export {
  deriveGatewayMatrix,
  getActiveDomains,
  getByDomain,
  getByGateway,
  getByTier,
  getCounts,
  getGatewayDomains,
  OPERATIONS,
  resolve,
  validateRequiredParams,
} from './registry.js';

/**
 * Transport-agnostic gateway entrypoint. Wraps a configured {@link Dispatcher}
 * (`compose(middlewares) → DomainHandler`) behind a single `handle()` call that
 * every transport adapter (CLI/MCP/RPC/HTTP) invokes uniformly. The adapter
 * owns wire concerns (error-render, `process.exit`, serialization); the handler
 * only resolves, validates, runs middleware, and returns a {@link DispatchResponse}.
 */
export interface GatewayHandler {
  /** Route one gateway request through the dispatch pipeline. */
  handle(req: DispatchRequest): Promise<DispatchResponse>;
}

/**
 * Build a {@link GatewayHandler} from a {@link DispatcherConfig} (injected
 * domain handlers + middleware). The returned handler is transport-neutral.
 */
export function createGatewayHandler(config: DispatcherConfig): GatewayHandler {
  const dispatcher = new Dispatcher(config);
  return { handle: (req: DispatchRequest): Promise<DispatchResponse> => dispatcher.dispatch(req) };
}
