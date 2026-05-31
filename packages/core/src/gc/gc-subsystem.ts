/**
 * GC daemon expressed as a supervised daemon subsystem.
 *
 * Wraps the GC bootstrap logic (`bootstrapDaemon`, crash recovery, missed-run
 * recovery, and the node-cron schedule) in the uniform
 * `start → healthProbe → shutdown` lifecycle from `@cleocode/contracts/daemon`
 * so the `@cleocode/runtime` `SubsystemRegistry` can drive it identically to
 * every other long-running concern (Studio supervision, the web server, …).
 *
 * Design constraints
 * ------------------
 * `@cleocode/core` CANNOT depend on `@cleocode/runtime` (runtime already
 * depends on core). To remain dependency-cycle free this module imports only
 * the pure type contracts from `@cleocode/contracts` and returns a plain
 * frozen object that satisfies the `Subsystem<GcSubsystemContext>` interface
 * without calling `defineSubsystem()` (a runtime-layer factory). A caller that
 * holds a `SubsystemRegistry` (from `@cleocode/runtime/daemon`) simply calls
 * `registry.register(createGcSubsystem(cleoDir))` — the frozen shape is
 * identical to what `defineSubsystem` returns and the registry types accept it.
 *
 * Thread-through context
 * ----------------------
 * `start()` returns a {@link GcSubsystemContext} that is threaded into
 * `shutdown()` by the registry (same pattern as `GatewaySubsystemContext`
 * in `@cleocode/runtime/gateway`). This lets `shutdown()` cancel the exact
 * cron task that `start()` scheduled without requiring module-level mutable
 * state.
 *
 * @see packages/core/src/gc/daemon.ts — standalone bootstrap / spawn helpers
 * @see packages/runtime/src/daemon/define-subsystem.ts — `defineSubsystem` factory
 * @see packages/runtime/src/gateway/daemon-subsystem.ts — reference implementation
 *
 * @packageDocumentation
 * @module @cleocode/core/gc
 *
 * @task T11503 (R5-T1)
 * @task T11504 (R5-T2)
 * @epic T11256
 * @saga T11243 SG-RUNTIME-UNIFICATION
 */

import { join } from 'node:path';
import type { Subsystem, SubsystemHealth, SubsystemState } from '@cleocode/contracts';
import cron from 'node-cron';
import { runGC } from './runner.js';
import { patchGCState, readGCState } from './state.js';

// ---------------------------------------------------------------------------
// Constants (mirrors daemon.ts — single authority is retained in daemon.ts)
// ---------------------------------------------------------------------------

/** Cron expression: daily at 03:00 UTC. Kept in sync with daemon.ts. */
const GC_CRON_EXPR = '0 3 * * *';

/** Interval for missed-run recovery check (24 hours in ms). */
const GC_INTERVAL_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

/**
 * The live context `start()` returns and the registry threads into
 * `shutdown()`. Carries the scheduled cron task so `shutdown()` can destroy
 * exactly the task that `start()` created.
 */
export interface GcSubsystemContext {
  /** The OS pid of this daemon process (set at subsystem start). */
  readonly pid: number;
  /** The ISO-8601 timestamp when this subsystem started. */
  readonly startedAt: string;
  /**
   * The scheduled cron task. `ScheduledTask` is the node-cron return value.
   * Typed as the minimal destroy surface so callers do not need to import
   * node-cron types.
   */
  readonly cronTask: { destroy: () => void };
  /** Count of GC runs performed since subsystem start. */
  runs: number;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a GC cron-daemon expressed as a uniform daemon subsystem.
 *
 * The returned object is a frozen `Subsystem<GcSubsystemContext>` that any
 * `SubsystemRegistry` (from `@cleocode/runtime/daemon`) can `register()`.
 *
 * Lifecycle
 * ---------
 * - `start(cleoDir)` — reads gc-state.json, performs crash recovery
 *   (resumes `pendingPrune` if non-empty), performs missed-run recovery (runs
 *   GC immediately if elapsed > 24 h), then schedules the daily cron job.
 *   Returns a {@link GcSubsystemContext} for health-probe and shutdown.
 * - `healthProbe()` — reports a single {@link SubsystemHealth} row keyed on
 *   `child_id: 'gc'`; `running` while the cron task is active, with a `detail`
 *   summarising run count and last-run timestamp.
 * - `shutdown(context)` — destroys the cron task so the daemon process can
 *   exit cleanly.
 *
 * @param cleoDir - Absolute path to the `.cleo/` directory for this project.
 * @returns A frozen `Subsystem<GcSubsystemContext>`.
 *
 * @example
 * ```ts
 * // In the daemon process:
 * import { SubsystemRegistry } from '@cleocode/runtime/daemon';
 * import { createGcSubsystem } from '@cleocode/core/gc/gc-subsystem.js';
 *
 * const registry = new SubsystemRegistry();
 * registry.register(createGcSubsystem('/home/user/.local/share/cleo/project/abc/.cleo'));
 * await registry.startAll();
 * ```
 */
export function createGcSubsystem(cleoDir: string): Subsystem<GcSubsystemContext> {
  const statePath = join(cleoDir, 'gc-state.json');

  // Closure-held live context so `healthProbe()` (which receives no arguments
  // per the Subsystem contract) can read the current state.
  let live: GcSubsystemContext | undefined;

  const subsystem: Subsystem<GcSubsystemContext> = {
    name: 'gc',

    async start(): Promise<GcSubsystemContext> {
      // Register daemon PID in state file
      await patchGCState(statePath, {
        daemonPid: process.pid,
        daemonStartedAt: new Date().toISOString(),
      });

      const state = await readGCState(statePath);
      let runs = 0;

      // Step 1: Crash recovery — resume pending prune from prior run
      if (state.pendingPrune && state.pendingPrune.length > 0) {
        try {
          await runGC({ cleoDir, resumeFrom: state.pendingPrune });
          runs += 1;
        } catch {
          // Crash-recovery failure is non-fatal; continue with scheduled runs
        }
      }

      // Step 2: Missed-run recovery — if last run was > 24 h ago, run immediately
      const lastRunTs = state.lastRunAt ? new Date(state.lastRunAt).getTime() : 0;
      const elapsed = Date.now() - lastRunTs;
      if (elapsed > GC_INTERVAL_MS) {
        try {
          await runGC({ cleoDir });
          runs += 1;
        } catch {
          // Immediate GC failure is non-fatal; cron will retry next cycle
        }
      }

      // Step 3: Schedule future runs via node-cron
      // noOverlap: true prevents double-runs if a previous run exceeds 24 h
      const cronTask = cron.schedule(
        GC_CRON_EXPR,
        async () => {
          try {
            await runGC({ cleoDir });
            if (live !== undefined) {
              live.runs += 1;
            }
          } catch {
            // Log failures via stderr (redirected to gc.log by spawn)
            const currentState = await readGCState(statePath);
            await patchGCState(statePath, {
              consecutiveFailures: currentState.consecutiveFailures + 1,
              lastRunResult: 'failed',
              escalationNeeded: currentState.consecutiveFailures + 1 >= 3,
              escalationReason:
                currentState.consecutiveFailures + 1 >= 3
                  ? `GC daemon: ${currentState.consecutiveFailures + 1} consecutive failures. Check logs.`
                  : currentState.escalationReason,
            });
          }
        },
        {
          timezone: 'UTC',
          noOverlap: true,
          name: 'cleo-gc',
        },
      );

      const context: GcSubsystemContext = {
        pid: process.pid,
        startedAt: new Date().toISOString(),
        cronTask,
        runs,
      };
      live = context;
      return context;
    },

    healthProbe(): SubsystemHealth {
      if (live === undefined) {
        const stopped: SubsystemState = 'stopped';
        return {
          child_id: 'gc',
          pid: 0,
          state: stopped,
          restart_count: 0,
          detail: 'gc subsystem not started',
        };
      }
      const running: SubsystemState = 'running';
      return {
        child_id: 'gc',
        pid: live.pid,
        state: running,
        restart_count: live.runs,
        detail: `runs=${live.runs} startedAt=${live.startedAt}`,
      };
    },

    shutdown(context: GcSubsystemContext): void {
      context.cronTask.destroy();
      live = undefined;
    },
  };

  return Object.freeze(subsystem);
}
