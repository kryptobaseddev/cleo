/**
 * `@cleocode/runtime/gateway/dispatch` — the dispatch core alone (T13126).
 *
 * `@cleocode/runtime/gateway` also exports the HTTP, MCP and RPC transports and
 * the engine re-exports of `@cleocode/core/internal`, so importing it loads all
 * of CORE. A CLI command needs only the pieces below: the {@link Dispatcher},
 * its middleware composer, the operation registry and response metadata. Every
 * module behind this entry imports narrow CORE and contracts modules, never a
 * barrel, so a read command can dispatch without loading CORE wholesale.
 *
 * @task T13126
 */

export type { DispatcherConfig } from './dispatcher.js';
export { Dispatcher } from './dispatcher.js';
export { createGatewayHandler, type GatewayHandler } from './gateway-handler.js';
export { createDispatchMeta } from './meta.js';
export { BRAIN_DB_FILENAME, CLEO_DIR_NAME, WORKFLOWS_SUBDIR } from './paths.js';
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
