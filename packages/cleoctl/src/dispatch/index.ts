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
export { createDispatchMeta } from './lib/meta.js';
export { createAudit } from './middleware/audit.js';
export { compose } from './middleware/pipeline.js';
export { createProtocolEnforcement } from './middleware/protocol-enforcement.js';
export { createRateLimiter } from './middleware/rate-limiter.js';
export { createSanitizer } from './middleware/sanitizer.js';
export { createVerificationGates } from './middleware/verification-gates.js';
export {
  getActiveDomains,
  getByDomain,
  getByGateway,
  getByTier,
  getCounts,
  OPERATIONS,
  type OperationDef,
  type Resolution,
  resolve,
  validateRequiredParams,
} from './registry.js';
export type {
  CanonicalDomain,
  DispatchError,
  DispatchNext,
  DispatchRequest,
  DispatchResponse,
  DomainHandler,
  Gateway,
  Middleware,
  Source,
  Tier,
} from './types.js';
