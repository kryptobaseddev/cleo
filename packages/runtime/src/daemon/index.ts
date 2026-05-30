/**
 * `@cleocode/runtime/daemon` — the daemon submodule.
 *
 * A single, uniform lifecycle surface for every long-running CLEO concern
 * (Studio supervision, the GC cron, the web server, the docs-viewer, the
 * runtime poller). Subsystems declared via `defineSubsystem` are driven by a
 * `SubsystemRegistry` through a uniform `start → healthProbe → shutdown`
 * lifecycle, and their health is surfaced in the shape the Rust
 * `cleo-supervisor` aggregates over the FROZEN `supervisor-ipc` v1.0 contract.
 *
 * This is a **subpath export of `@cleocode/runtime`** (D6 — NOT a separately
 * published package): `import { defineSubsystem } from '@cleocode/runtime/daemon'`.
 * It is intentionally distinct from the package root (`@cleocode/runtime`),
 * which exposes the legacy agent-poller/SSE/heartbeat services.
 *
 * All daemon lifecycle + subsystem TYPES live in `@cleocode/contracts/daemon`
 * (Contracts Fan-Out gate, T10074); this submodule consumes them and provides
 * the runtime implementation.
 *
 * @packageDocumentation
 * @module @cleocode/runtime/daemon
 *
 * @epic T11253 R2 — `@cleocode/runtime/daemon` submodule
 * @task T11365 — scaffold submodule + ./daemon subpath export
 * @saga T11243 SG-RUNTIME-UNIFICATION
 */

// Re-export the daemon type contracts so consumers (and R4-R7 adapters) can
// import both the API and its types from the single `@cleocode/runtime/daemon`
// entrypoint. The types are OWNED by @cleocode/contracts/daemon — this is a
// convenience re-export, not a redeclaration.
export type {
  DaemonLifecycleHooks,
  HealthStatus,
  Subsystem,
  SubsystemDefinition,
  SubsystemHealth,
  SubsystemLifecyclePhase,
  SubsystemState,
} from '@cleocode/contracts';

export { defineSubsystem } from './define-subsystem.js';
export { SubsystemRegistry } from './registry.js';
export type { SupervisorIpcClient } from './supervisor-client.js';
export { createSupervisorIpcClient, MalformedIpcFrameError } from './supervisor-client.js';
