/**
 * Daemon subsystem + lifecycle-hook contracts.
 *
 * A **subsystem** is one supervised unit of long-running work inside a CLEO
 * daemon process — Studio supervision, the GC cron, the web server, the
 * docs-viewer, the runtime poller. Each declares a uniform lifecycle
 * (`start → healthProbe → shutdown`) so the `@cleocode/runtime/daemon`
 * registry can drive them identically and the Rust `cleo-supervisor` can
 * aggregate their health over the FROZEN `supervisor-ipc` v1.0 contract.
 *
 * These are **pure type contracts** (no runtime/IO). The implementation —
 * `defineSubsystem()`, the registry, the NDJSON client — lives in
 * `@cleocode/runtime/daemon` (R2 child T11367) and imports these types rather
 * than redeclaring them (Contracts Fan-Out gate, T10074).
 *
 * @packageDocumentation
 * @module @cleocode/contracts/daemon
 *
 * @epic T11253 R2 — `@cleocode/runtime/daemon` submodule
 * @task T11366 — daemon lifecycle + subsystem contracts
 * @saga T11243 SG-RUNTIME-UNIFICATION
 */

import type { SubsystemHealth } from './health.js';

/**
 * Lifecycle hooks fired by the subsystem registry around a subsystem's
 * `start`/`shutdown` transitions.
 *
 * All hooks are optional and may be async. They are observational — a hook
 * MUST NOT mutate registry state. `onError` is the single failure sink: a
 * throwing `start` or `shutdown`, or a rejected `healthProbe`, surfaces here.
 *
 * Hooks fire in a defined order relative to the underlying transition:
 * - `onStart`    — after the subsystem's `start()` resolves.
 * - `onShutdown` — after the subsystem's `shutdown()` resolves.
 * - `onError`    — when any lifecycle step throws/rejects (start, probe, or
 *   shutdown), with the offending `error` and the `phase` it occurred in.
 */
export interface DaemonLifecycleHooks {
  /**
   * Fired after the subsystem has successfully started.
   *
   * @param name - The logical subsystem name.
   */
  onStart?: (name: string) => void | Promise<void>;
  /**
   * Fired after the subsystem has successfully shut down.
   *
   * @param name - The logical subsystem name.
   */
  onShutdown?: (name: string) => void | Promise<void>;
  /**
   * Fired when a lifecycle step throws or rejects. The single failure sink.
   *
   * @param name  - The logical subsystem name.
   * @param error - The thrown value, normalized to an `Error`.
   * @param phase - Which lifecycle step failed.
   */
  onError?: (name: string, error: Error, phase: SubsystemLifecyclePhase) => void | Promise<void>;
}

/**
 * The lifecycle phase a subsystem transition is in, used to tag
 * {@link DaemonLifecycleHooks.onError} and registry diagnostics.
 */
export type SubsystemLifecyclePhase = 'start' | 'healthProbe' | 'shutdown';

/**
 * The frozen, ordered set of lifecycle phases. Pinned by the daemon test suite
 * so a phase cannot be silently added or removed.
 */
export const SUBSYSTEM_LIFECYCLE_PHASES = ['start', 'healthProbe', 'shutdown'] as const;

/**
 * A subsystem descriptor — the declarative unit `defineSubsystem()` produces
 * and the registry drives.
 *
 * The three lifecycle methods are intentionally minimal and uniform so that
 * every long-running concern (supervised child process, cron job, HTTP server)
 * can be expressed identically:
 *
 * - `start`       — bring the subsystem up. May be async. Idempotent callers
 *   should guard re-entry.
 * - `healthProbe` — report current liveness as a {@link SubsystemHealth} row.
 *   Maps onto a supervised `ChildStatus` the Rust supervisor aggregates.
 * - `shutdown`    — bring the subsystem down gracefully. May be async.
 *
 * @typeParam TContext - Optional opaque context the registry threads through
 *   `start`/`shutdown` (e.g. a resolved config or handle). Defaults to `void`.
 */
export interface Subsystem<TContext = void> {
  /** Logical, stable subsystem name (matches the supervised `child_id`). */
  readonly name: string;
  /**
   * Bring the subsystem up. The resolved value is threaded back into
   * `shutdown` as its context argument.
   *
   * @returns The subsystem context (or `void`).
   */
  start: () => TContext | Promise<TContext>;
  /**
   * Report the subsystem's current health as a single
   * {@link SubsystemHealth} row.
   *
   * @returns The current health row.
   */
  healthProbe: () => SubsystemHealth | Promise<SubsystemHealth>;
  /**
   * Bring the subsystem down gracefully.
   *
   * @param context - The value returned by `start`.
   */
  shutdown: (context: TContext) => void | Promise<void>;
}

/**
 * The descriptor passed to `defineSubsystem()` — the same surface as
 * {@link Subsystem} (a 1:1 mapping; `defineSubsystem` validates + freezes it).
 *
 * Exposed as a distinct name so call-sites can annotate the literal they pass
 * without importing the post-construction {@link Subsystem} type.
 *
 * @typeParam TContext - See {@link Subsystem}.
 */
export type SubsystemDefinition<TContext = void> = Subsystem<TContext>;
