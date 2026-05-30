/**
 * Central Dispatcher (thin re-export shim).
 *
 * The Dispatcher core was relocated to `@cleocode/runtime/gateway`
 * (R3-T3 · T11447 · SG-RUNTIME-UNIFICATION) so the runtime layer owns the
 * transport-agnostic dispatch core. This shim re-exports it so in-package
 * consumers (the CLI adapter, `getCliDispatcher`) keep importing from
 * `'./dispatcher.js'` unchanged. New code SHOULD import from
 * `'@cleocode/runtime/gateway'` directly.
 *
 * @epic T4820
 * @task T11447
 */

export type { DispatcherConfig, GatewayHandler } from '@cleocode/runtime/gateway';
export { createGatewayHandler, Dispatcher } from '@cleocode/runtime/gateway';
