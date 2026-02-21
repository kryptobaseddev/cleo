/**
 * Unified CQRS Dispatch Layer -- Public API
 *
 * Single entry point for the dispatch layer. Both CLI and MCP adapters
 * import from here to create and use the dispatcher.
 *
 * @epic T4820
 */

export { Dispatcher, type DispatcherConfig } from './dispatcher.js';
export { createDomainHandlers } from './domains/index.js';
export { compose } from './middleware/pipeline.js';
export { createSanitizer } from './middleware/sanitizer.js';
export { createRateLimiter } from './middleware/rate-limiter.js';
export { createVerificationGates } from './middleware/verification-gates.js';
export { createProtocolEnforcement } from './middleware/protocol-enforcement.js';
export { createAudit } from './middleware/audit.js';
export { createDispatchMeta } from './lib/meta.js';
export {
  OPERATIONS, resolve, validateRequiredParams,
  getByDomain, getByGateway, getByTier, getActiveDomains,
  getCounts,
  type OperationDef, type Resolution,
} from './registry.js';
export type {
  Gateway, Source, Tier, CanonicalDomain,
  DispatchRequest, DispatchResponse, DispatchError, DomainHandler,
  Middleware, DispatchNext,
} from './types.js';
