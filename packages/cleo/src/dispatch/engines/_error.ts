/**
 * Centralized engine error helper (thin re-export shim).
 *
 * The engine error helpers were relocated to `@cleocode/runtime/gateway`
 * (R3-K1 · T11455 · SG-RUNTIME-UNIFICATION) so the runtime owns the shared
 * handler dependencies and can assemble the handler map without importing
 * `@cleocode/cleo`. This shim re-exports the full surface so the in-package
 * import sites that reference `'../engines/_error.js'` (or
 * `'../../engines/_error.js'`) compile unchanged. New code SHOULD import from
 * `'@cleocode/runtime/gateway'`.
 *
 * @task T11455
 */

export {
  cleoErrorToEngineError,
  type EngineResult,
  type ErrorMeta,
  engineError,
  engineSuccess,
  STRING_TO_EXIT,
} from '@cleocode/runtime/gateway';
