/**
 * `defineSubsystem()` — declare a supervised daemon subsystem.
 *
 * The single factory R4-R7 adapters call to express a long-running concern
 * (Studio supervision, GC cron, web server, docs-viewer, runtime poller) as a
 * uniform {@link Subsystem}. The returned descriptor is frozen so the registry
 * can drive `start → healthProbe → shutdown` without the definition mutating
 * underfoot.
 *
 * @packageDocumentation
 * @module @cleocode/runtime/daemon
 *
 * @epic T11253 R2 — `@cleocode/runtime/daemon` submodule
 * @task T11367 — defineSubsystem + lifecycle/health registry + IPC client
 * @saga T11243 SG-RUNTIME-UNIFICATION
 */

import type { Subsystem, SubsystemDefinition } from '@cleocode/contracts';

/**
 * Declare a daemon subsystem.
 *
 * Validates that the four required surfaces (`name`, `start`, `healthProbe`,
 * `shutdown`) are present and that `name` is a non-empty string, then returns a
 * frozen {@link Subsystem} ready to register with a `SubsystemRegistry`.
 *
 * @typeParam TContext - Opaque context threaded from `start` into `shutdown`
 *   (e.g. a child handle or resolved config). Defaults to `void`.
 * @param definition - The subsystem descriptor.
 * @returns A frozen, registrable {@link Subsystem}.
 * @throws {TypeError} When `name` is empty or a required method is missing.
 *
 * @example
 * ```ts
 * const studio = defineSubsystem({
 *   name: 'studio',
 *   start: () => supervisor.start(),
 *   healthProbe: () => ({ child_id: 'studio', pid: supervisor.pid ?? 0,
 *                         state: supervisor.status === 'running' ? 'running' : 'stopped',
 *                         restart_count: 0 }),
 *   shutdown: () => supervisor.stop(),
 * });
 * ```
 */
export function defineSubsystem<TContext = void>(
  definition: SubsystemDefinition<TContext>,
): Subsystem<TContext> {
  if (typeof definition.name !== 'string' || definition.name.length === 0) {
    throw new TypeError('defineSubsystem: `name` must be a non-empty string');
  }
  if (typeof definition.start !== 'function') {
    throw new TypeError(`defineSubsystem(${definition.name}): \`start\` must be a function`);
  }
  if (typeof definition.healthProbe !== 'function') {
    throw new TypeError(`defineSubsystem(${definition.name}): \`healthProbe\` must be a function`);
  }
  if (typeof definition.shutdown !== 'function') {
    throw new TypeError(`defineSubsystem(${definition.name}): \`shutdown\` must be a function`);
  }

  return Object.freeze({
    name: definition.name,
    start: definition.start,
    healthProbe: definition.healthProbe,
    shutdown: definition.shutdown,
  });
}
