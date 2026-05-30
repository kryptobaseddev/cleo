/**
 * `SubsystemRegistry` — drives the uniform daemon subsystem lifecycle.
 *
 * Aggregates {@link Subsystem}s declared via `defineSubsystem` and runs them
 * through a uniform `start → healthProbe → shutdown` lifecycle, firing the
 * typed {@link DaemonLifecycleHooks} in order. Health probes are aggregated
 * into a {@link HealthStatus} that projects onto the FROZEN `supervisor-ipc`
 * `MonitorResponse` the Rust supervisor consumes (AC4).
 *
 * Shutdown runs in reverse registration order (LIFO) so dependants stop before
 * their dependencies — the conventional supervised-process teardown ordering.
 *
 * @packageDocumentation
 * @module @cleocode/runtime/daemon
 *
 * @epic T11253 R2 — `@cleocode/runtime/daemon` submodule
 * @task T11367 — defineSubsystem + lifecycle/health registry + IPC client
 * @saga T11243 SG-RUNTIME-UNIFICATION
 */

import {
  type DaemonLifecycleHooks,
  type HealthStatus,
  type Subsystem,
  type SubsystemHealth,
  type SubsystemLifecyclePhase,
  summarizeHealth,
} from '@cleocode/contracts';

/**
 * A registered subsystem plus its runtime bookkeeping.
 *
 * The `context` is the value `start()` resolved to, threaded back into
 * `shutdown()`. It is type-erased to `unknown` inside the registry because the
 * registry holds subsystems of heterogeneous context types; each entry's
 * `subsystem.shutdown` is the only consumer and re-narrows it at the call site
 * via the subsystem's own typing — no `any`, and the erased value never escapes
 * the registry surface.
 */
interface RegisteredSubsystem {
  readonly subsystem: Subsystem<unknown>;
  started: boolean;
  context: unknown;
}

/** Normalize an unknown thrown value into an `Error`. */
function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/**
 * The registry that owns and drives the daemon's subsystems.
 *
 * Construct with optional {@link DaemonLifecycleHooks}; register subsystems,
 * then `startAll()` / `aggregateHealth()` / `shutdownAll()`.
 */
export class SubsystemRegistry {
  readonly #entries: RegisteredSubsystem[] = [];
  readonly #hooks: DaemonLifecycleHooks;

  /**
   * @param hooks - Optional lifecycle hooks fired around start/shutdown and on
   *   any lifecycle error.
   */
  constructor(hooks: DaemonLifecycleHooks = {}) {
    this.#hooks = hooks;
  }

  /**
   * Register a subsystem. Registration order defines start order; shutdown runs
   * in reverse.
   *
   * @typeParam TContext - The subsystem's start→shutdown context type.
   * @param subsystem - A subsystem produced by `defineSubsystem`.
   * @throws {Error} When a subsystem with the same `name` is already registered.
   */
  register<TContext>(subsystem: Subsystem<TContext>): void {
    if (this.#entries.some((entry) => entry.subsystem.name === subsystem.name)) {
      throw new Error(`SubsystemRegistry: duplicate subsystem name '${subsystem.name}'`);
    }
    // Widen the context type to `unknown` for heterogeneous storage. The
    // subsystem's own `start`/`shutdown` remain individually well-typed; only
    // the registry's internal handle is erased, and it never leaks out.
    this.#entries.push({
      subsystem: subsystem as Subsystem<unknown>,
      started: false,
      context: undefined,
    });
  }

  /** The names of all registered subsystems, in registration order. */
  get names(): readonly string[] {
    return this.#entries.map((entry) => entry.subsystem.name);
  }

  /**
   * Start every registered subsystem in registration order.
   *
   * For each subsystem: awaits `start()`, stores the resolved context, then
   * fires `onStart`. If `start()` throws, fires `onError` with phase `start`
   * and re-throws — a failed start is surfaced, never swallowed.
   *
   * @throws The first subsystem `start()` error (after firing `onError`).
   */
  async startAll(): Promise<void> {
    for (const entry of this.#entries) {
      try {
        entry.context = await entry.subsystem.start();
        entry.started = true;
        await this.#hooks.onStart?.(entry.subsystem.name);
      } catch (cause) {
        await this.#fireError(entry.subsystem.name, cause, 'start');
        throw toError(cause);
      }
    }
  }

  /**
   * Probe every registered subsystem and aggregate into a {@link HealthStatus}.
   *
   * A subsystem whose `healthProbe()` rejects does not abort the aggregate:
   * `onError` fires with phase `healthProbe` and the subsystem is reported as a
   * `stopped` row carrying the error in its `detail`, so the supervisor still
   * receives a complete snapshot.
   *
   * @returns The aggregate health snapshot (projects onto `MonitorResponse`).
   */
  async aggregateHealth(): Promise<HealthStatus> {
    const rows: SubsystemHealth[] = [];
    for (const entry of this.#entries) {
      try {
        rows.push(await entry.subsystem.healthProbe());
      } catch (cause) {
        await this.#fireError(entry.subsystem.name, cause, 'healthProbe');
        rows.push({
          child_id: entry.subsystem.name,
          pid: 0,
          state: 'stopped',
          restart_count: 0,
          detail: `healthProbe failed: ${toError(cause).message}`,
        });
      }
    }
    return summarizeHealth(rows);
  }

  /**
   * Shut down every started subsystem in reverse registration order (LIFO).
   *
   * Each subsystem's `shutdown(context)` is awaited and `onShutdown` fires. A
   * throwing `shutdown` fires `onError` with phase `shutdown` but does NOT
   * abort the teardown of the remaining subsystems — best-effort graceful
   * shutdown of the whole daemon.
   */
  async shutdownAll(): Promise<void> {
    for (let i = this.#entries.length - 1; i >= 0; i -= 1) {
      const entry = this.#entries[i];
      if (entry === undefined || !entry.started) continue;
      try {
        await entry.subsystem.shutdown(entry.context);
        entry.started = false;
        await this.#hooks.onShutdown?.(entry.subsystem.name);
      } catch (cause) {
        await this.#fireError(entry.subsystem.name, cause, 'shutdown');
        // Continue tearing down the rest — do not abort on one failure.
      }
    }
  }

  /** Fire the `onError` hook, swallowing any error the hook itself throws. */
  async #fireError(name: string, cause: unknown, phase: SubsystemLifecyclePhase): Promise<void> {
    try {
      await this.#hooks.onError?.(name, toError(cause), phase);
    } catch {
      // A throwing error-hook must not mask the original failure.
    }
  }
}
