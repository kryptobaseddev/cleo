/**
 * Middleware Pipeline (thin re-export shim).
 *
 * `compose` was relocated to `@cleocode/runtime/gateway` (R3-T3 · T11447 ·
 * SG-RUNTIME-UNIFICATION). This shim re-exports it so in-package consumers
 * importing from `'./pipeline.js'` compile unchanged.
 *
 * @epic T4820
 * @task T11447
 */

export { compose } from '@cleocode/runtime/gateway';
