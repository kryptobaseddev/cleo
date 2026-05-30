/**
 * Dispatch-local metadata factory (thin re-export shim).
 *
 * `createDispatchMeta` was relocated to `@cleocode/runtime/gateway`
 * (R3-T3 · T11447 · SG-RUNTIME-UNIFICATION). This shim re-exports it so
 * in-package consumers importing from `'../lib/meta.js'` compile unchanged.
 *
 * @task T4772
 * @task T11447
 */

export { createDispatchMeta } from '@cleocode/runtime/gateway';
