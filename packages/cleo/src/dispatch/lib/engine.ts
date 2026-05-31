/**
 * Engine Re-exports for Dispatch Domain Handlers (thin re-export shim).
 *
 * The engine barrel was relocated to `@cleocode/runtime/gateway` (R3-K1 ·
 * T11455 · SG-RUNTIME-UNIFICATION) so the runtime can assemble the domain-handler
 * map without importing `@cleocode/cleo`. This shim re-exports the full surface
 * so any remaining in-package consumer importing from `'../lib/engine.js'`
 * compiles unchanged (zero behavior change). New code SHOULD import from
 * `'@cleocode/runtime/gateway'` directly.
 *
 * @epic T4820
 * @task T4815
 * @task T11455
 */

export * from '@cleocode/runtime/gateway';
