/**
 * `@cleocode/contracts/daemon` — daemon lifecycle + subsystem type contracts.
 *
 * The shared, IO-free type vocabulary for the `@cleocode/runtime/daemon`
 * submodule (R2, T11253): the {@link Subsystem} descriptor, the typed
 * {@link DaemonLifecycleHooks}, and the {@link HealthStatus} aggregate that
 * composes the FROZEN `supervisor-ipc` v1.0 contract.
 *
 * The implementation (`defineSubsystem`, registry, NDJSON client) lives in
 * `@cleocode/runtime/daemon` and consumes these types — never redeclares them
 * (Contracts Fan-Out gate, T10074).
 *
 * @packageDocumentation
 * @module @cleocode/contracts/daemon
 *
 * @epic T11253 R2 — `@cleocode/runtime/daemon` submodule
 * @task T11366 — daemon lifecycle + subsystem contracts
 * @saga T11243 SG-RUNTIME-UNIFICATION
 */

export type { HealthStatus, SubsystemHealth, SubsystemState } from './health.js';
export {
  HealthStatusSchema,
  SubsystemHealthSchema,
  SubsystemStateSchema,
  summarizeHealth,
  toMonitorChildren,
} from './health.js';
export type {
  DaemonLifecycleHooks,
  Subsystem,
  SubsystemDefinition,
  SubsystemLifecyclePhase,
} from './subsystem.js';
export { SUBSYSTEM_LIFECYCLE_PHASES } from './subsystem.js';
