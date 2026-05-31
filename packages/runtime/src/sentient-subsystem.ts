/**
 * Sentient daemon subsystem adapter — R4 (T11255).
 *
 * Expresses the full sentient daemon lifecycle (Studio supervision, Tier-1
 * tick cron, Tier-2 proposal cron, skill curator cron, nightly hygiene loop)
 * as a single {@link Subsystem} via `defineSubsystem` from
 * `@cleocode/runtime/daemon`.
 *
 * ### Package placement
 * This file lives in `@cleocode/runtime` (NOT `@cleocode/core`) to respect the
 * dependency direction: `@cleocode/runtime` → `@cleocode/core` (runtime
 * consumes core; core must not import runtime to avoid a circular dep).
 *
 * ### Standalone-daemon path (daemon-entry.ts)
 * The legacy `bootstrapDaemon` in `@cleocode/core/sentient` continues to
 * function as the entry point for the standalone `cleo daemon start --foreground`
 * path. `createSentientSubsystem` is the adapter for hosts that want to embed
 * the sentient daemon inside a `SubsystemRegistry`-driven process.
 *
 * @packageDocumentation
 * @module @cleocode/runtime
 *
 * @epic T11255 R4 — migrate sentient/daemon.ts → daemon subsystem
 * @saga T11243 SG-RUNTIME-UNIFICATION
 */

import type { FSWatcher } from 'node:fs';
import { watch } from 'node:fs';
import { join } from 'node:path';
import type { Subsystem, SubsystemHealth } from '@cleocode/contracts';
import {
  acquireLock,
  type BootstrapDaemonOptions,
  curatorCronExpression,
  patchSentientState,
  readCuratorConfig,
  readSentientState,
  readSuperviseStudioConfig,
  releaseLock,
  reVerifyWorkerReport,
  SENTIENT_CRON_EXPR,
  SENTIENT_HYGIENE_CRON_EXPR,
  SENTIENT_LOCK_FILE,
  SENTIENT_PROPOSE_CRON_EXPR,
  SENTIENT_STATE_FILE,
  StudioSupervisor,
  safeRunCrossProjectHygiene,
  safeRunProposeTick,
  safeRunTick,
  warmupWorktreeBackend,
} from '@cleocode/core/sentient';
import cron from 'node-cron';
import { createSubsystemLogger, defineSubsystem, SubsystemRegistry } from './daemon/index.js';

// Internal logger for the subsystem.
const log = createSubsystemLogger('sentient');

/**
 * Runtime context threaded from `start()` into `shutdown()`.
 *
 * Holds every handle the shutdown path needs to tear down cleanly.
 * Kept internal to this module — callers interact via `SubsystemRegistry`.
 */
interface SentientContext {
  readonly lockPath: string;
  readonly statePath: string;
  readonly studioSupervisor: StudioSupervisor | null;
  readonly watcher: FSWatcher | null;
  readonly lock: Awaited<ReturnType<typeof acquireLock>>;
}

/**
 * Declare the sentient daemon as a supervised daemon {@link Subsystem}.
 *
 * The returned subsystem (frozen by `defineSubsystem`) is registered with a
 * `SubsystemRegistry` in a host process. It carries the full lifecycle
 * that the legacy `bootstrapDaemon` ran inline:
 *
 * 1. `start()` — acquires the advisory lock, persists pid/startedAt,
 *    optionally starts Studio supervision, watches the state file, and
 *    schedules all four cron jobs (Tier-1, Tier-2, curator, hygiene). Runs
 *    one boot tick before returning.
 * 2. `healthProbe()` — returns a `SubsystemHealth` row based on the pid
 *    recorded in state.json.
 * 3. `shutdown()` — cascades Studio SIGTERM → watcher.close() → state patch
 *    → lock release.
 *
 * @param projectRoot - Absolute path to the project (contains `.cleo/`).
 * @param opts - Optional overrides for Studio supervision and config path.
 * @returns A frozen {@link Subsystem} for `SubsystemRegistry.register()`.
 */
export function createSentientSubsystem(
  projectRoot: string,
  opts: BootstrapDaemonOptions = {},
): Subsystem<SentientContext> {
  const statePath = join(projectRoot, SENTIENT_STATE_FILE);
  const lockPath = join(projectRoot, SENTIENT_LOCK_FILE);

  return defineSubsystem<SentientContext>({
    name: 'sentient',

    async start(): Promise<SentientContext> {
      // 1. Advisory lock.
      const lock = await acquireLock(lockPath);
      if (!lock) {
        log.error({}, 'lock acquisition failed — another daemon is running');
        process.exit(2);
      }

      // 2. Persist pid + startedAt.
      await patchSentientState(statePath, {
        pid: process.pid,
        startedAt: new Date().toISOString(),
      });

      // 3. Studio supervision.
      let studioSupervisor: StudioSupervisor | null = null;
      let shouldSuperviseStudio: boolean;
      if (typeof opts.superviseStudio === 'boolean') {
        shouldSuperviseStudio = opts.superviseStudio;
      } else {
        const { getCleoHome } = await import('@cleocode/core');
        const defaultConfigPath = join(getCleoHome(), 'config.json');
        const configPath = opts.globalConfigPath ?? defaultConfigPath;
        shouldSuperviseStudio = await readSuperviseStudioConfig(configPath);
      }

      if (shouldSuperviseStudio) {
        studioSupervisor = new StudioSupervisor(opts.studioOptions ?? {});
        try {
          studioSupervisor.start();
          log.info({}, 'Studio supervision enabled');
        } catch (err) {
          log.error({ err }, 'Studio supervision start failed (non-fatal; ticks continue)');
          studioSupervisor = null;
        }
      } else {
        log.info({}, 'Studio supervision disabled (daemon.superviseStudio=false)');
      }

      // 4. State file watcher.
      let watcher: FSWatcher | null = null;
      try {
        watcher = watch(statePath, { persistent: false }, () => {
          // Next tick will re-read state and honour kill-switch.
        });
      } catch {
        watcher = null;
      }

      // 5. Warm up worktree backend.
      await warmupWorktreeBackend();

      // 6. Boot tick (Tier-1 immediate run).
      // Wire reVerify (AC2/T11497) so the T1589 re-verify gate re-runs gates
      // on worker exit=0 instead of trusting the self-report.
      // Wire scope filter (AC1/T11497) for headless / walk-away autopilot.
      const tickOptions = {
        projectRoot,
        statePath,
        reVerify: reVerifyWorkerReport,
        scopeSagaId: opts.scopeSagaId,
        scopeEpicId: opts.scopeEpicId,
      };
      await patchSentientState(statePath, { lastCronFiredAt: new Date().toISOString() });
      const outcome = await safeRunTick(tickOptions);
      log.info(
        { kind: outcome.kind, taskId: outcome.taskId ?? null },
        `boot tick: ${outcome.kind} (task=${outcome.taskId ?? 'n/a'}) ${outcome.detail}`,
      );

      // 7. Schedule cron jobs.

      // Tier-1: every 5 minutes.
      cron.schedule(
        SENTIENT_CRON_EXPR,
        async () => {
          try {
            await patchSentientState(statePath, { lastCronFiredAt: new Date().toISOString() });
          } catch (err) {
            log.warn({ err }, 'heartbeat write failed');
          }
          try {
            const result = await safeRunTick(tickOptions);
            log.info(
              { kind: result.kind, taskId: result.taskId ?? null },
              `tick: ${result.kind} (task=${result.taskId ?? 'n/a'}) ${result.detail}`,
            );
          } catch (err) {
            log.error({ err }, 'tick error (caught at cron boundary)');
          }
        },
        { timezone: 'UTC', noOverlap: true, name: 'cleo-sentient' },
      );

      // Tier-2: every 2 hours.
      const proposeOptions = { projectRoot, statePath };
      cron.schedule(
        SENTIENT_PROPOSE_CRON_EXPR,
        async () => {
          try {
            const state = await readSentientState(statePath);
            if (!state.tier2Enabled) return;
            const result = await safeRunProposeTick(proposeOptions);
            log.info(
              { written: result.written, count: result.count },
              `propose: ${result.kind} ${result.detail}`,
            );
          } catch (err) {
            log.error({ err }, 'propose error (caught at cron boundary)');
          }
        },
        { timezone: 'UTC', noOverlap: true, name: 'cleo-sentient-propose' },
      );

      // Skill curator: opt-in, default off.
      {
        const { getCleoHome } = await import('@cleocode/core');
        const curatorConfigPath = opts.globalConfigPath ?? join(getCleoHome(), 'config.json');
        const curatorCfg = await readCuratorConfig(curatorConfigPath);
        if (curatorCfg.enabled) {
          const expr = curatorCronExpression(curatorCfg.runEveryHours);
          log.info({ interval: curatorCfg.runEveryHours, expr }, `curator enabled`);
          cron.schedule(
            expr,
            async () => {
              try {
                const curatorState = await readSentientState(statePath);
                if (curatorState.killSwitch) return;
                const { runCuratorTick } = await import('@cleocode/core/sentient');
                const result = await runCuratorTick({
                  staleAfterDays: curatorCfg.staleAfterDays,
                  archiveAfterDays: curatorCfg.archiveAfterDays,
                });
                log.info(
                  { checked: result.summary.checked, stale: result.summary.markedStale },
                  'curator tick complete',
                );
              } catch (err) {
                log.error({ err }, 'curator error (caught at cron boundary)');
              }
            },
            { timezone: 'UTC', noOverlap: true, name: 'cleo-sentient-curator' },
          );
        } else {
          log.info({}, 'curator disabled (daemon.curator.enabled=false)');
        }
      }

      // Nightly hygiene: 02:00 UTC (or CLEO_HYGIENE_CRON override).
      cron.schedule(
        SENTIENT_HYGIENE_CRON_EXPR,
        async () => {
          try {
            const hygieneState = await readSentientState(statePath);
            if (hygieneState.killSwitch) return;
            log.info({}, 'nightly cross-project hygiene loop starting');
            const digest = await safeRunCrossProjectHygiene();
            await patchSentientState(statePath, {
              hygieneLastRunAt: digest.completedAt,
              hygieneSummary: digest.summary,
              hygieneStats: {
                projectsChecked: digest.nexusIntegrity.total,
                projectsHealthy: digest.nexusIntegrity.healthy,
                tempGcCandidates: digest.tempGc.candidates.length,
                duplicateEpicGroups: digest.duplicateEpics.groups.length,
                worktreesPruned: digest.worktreePrune.totalPruned,
              },
            });
            log.info({}, `hygiene complete: ${digest.summary}`);
          } catch (err) {
            log.error({ err }, 'hygiene error (caught at cron boundary)');
          }
        },
        { noOverlap: true, name: 'cleo-sentient-hygiene' },
      );

      return { lockPath, statePath, studioSupervisor, watcher, lock };
    },

    async healthProbe(): Promise<SubsystemHealth> {
      try {
        const state = await readSentientState(statePath);
        const running = state.pid
          ? (() => {
              try {
                process.kill(state.pid, 0);
                return true;
              } catch {
                return false;
              }
            })()
          : false;
        return {
          child_id: 'sentient',
          pid: running ? (state.pid ?? 0) : 0,
          state: running ? 'running' : 'stopped',
          restart_count: 0,
          detail: `killSwitch=${state.killSwitch} lastTickAt=${state.lastTickAt ?? 'never'}`,
        };
      } catch {
        return { child_id: 'sentient', pid: 0, state: 'stopped', restart_count: 0 };
      }
    },

    async shutdown(context: SentientContext): Promise<void> {
      // 1. Stop Studio.
      if (context.studioSupervisor !== null) {
        log.info({}, 'forwarding shutdown to Studio (SIGTERM)');
        try {
          await context.studioSupervisor.stop();
        } catch {
          // ignore
        }
      }
      // 2. Close state file watcher.
      try {
        context.watcher?.close();
      } catch {
        // ignore
      }
      // 3. Patch state — clear pid.
      try {
        await patchSentientState(context.statePath, {
          pid: null,
          killSwitchReason: 'subsystem shutdown',
        });
      } catch {
        // ignore
      }
      // 4. Release advisory lock.
      try {
        if (context.lock) await releaseLock(context.lock);
      } catch {
        // ignore
      }
      log.info({}, 'sentient subsystem stopped');
    },
  });
}

/**
 * Bootstrap the sentient daemon via a SubsystemRegistry.
 *
 * Alternative to `bootstrapDaemon` for host processes that want to drive the
 * sentient daemon through the uniform `start → healthProbe → shutdown`
 * lifecycle (e.g., a unified CLEO daemon host that also runs the GC subsystem
 * and the gateway subsystem). Installs SIGTERM/SIGINT handlers that call
 * `shutdownAll()` and keeps the process alive via node-cron.
 *
 * @param projectRoot - Absolute path to the project (contains `.cleo/`).
 * @param opts - Optional Studio supervision and config overrides.
 */
export async function bootstrapSentientRegistry(
  projectRoot: string,
  opts: BootstrapDaemonOptions = {},
): Promise<void> {
  const registry = new SubsystemRegistry({
    onStart: (name: string) => log.info({ name }, `subsystem started: ${name}`),
    onShutdown: (name: string) => log.info({ name }, `subsystem shutdown: ${name}`),
    onError: (name: string, err: Error, phase: string) =>
      log.error({ name, phase, err }, `subsystem lifecycle error [${phase}]`),
  });

  registry.register(createSentientSubsystem(projectRoot, opts));
  await registry.startAll();

  const shutdown = async (reason: string): Promise<void> => {
    log.info({ reason }, 'shutdown signal received');
    await registry.shutdownAll();
    process.exit(0);
  };

  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });
  // Process stays alive via node-cron scheduler.
}
