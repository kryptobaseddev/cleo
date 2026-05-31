/**
 * Shared exit-code mapping utilities (thin re-export shim).
 *
 * `mapNumericExitCodeToString` was relocated to `@cleocode/runtime/gateway`
 * (R3-K1 · T11455 · SG-RUNTIME-UNIFICATION) alongside the engine error helpers
 * so the runtime owns the shared handler dependencies. This shim re-exports it
 * so any in-package consumer importing from `'../lib/exit-codes.js'` compiles
 * unchanged. New code SHOULD import from `'@cleocode/runtime/gateway'`.
 *
 * @task T374
 * @task T11455
 * @epic T335
 */

export { mapNumericExitCodeToString } from '@cleocode/runtime/gateway';
