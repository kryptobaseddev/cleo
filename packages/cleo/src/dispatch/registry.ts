/**
 * Operation Registry (thin re-export shim).
 *
 * The registry (OPERATIONS re-export + resolve/validate/derivation helpers) was
 * relocated to `@cleocode/runtime/gateway` (R3-T3 · T11447 ·
 * SG-RUNTIME-UNIFICATION). This shim re-exports the full surface so the ~18
 * in-package consumers that import from `'./registry.js'` (or `'../registry.js'`)
 * compile unchanged. New code SHOULD import from `'@cleocode/runtime/gateway'`.
 *
 * @epic T4820
 * @task T11447
 */

export type { OperationDef, Resolution } from '@cleocode/runtime/gateway';
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
} from '@cleocode/runtime/gateway';
