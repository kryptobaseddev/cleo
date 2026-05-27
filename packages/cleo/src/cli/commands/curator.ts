/**
 * CLI curator command group — opt-in skills curator surface.
 *
 *   cleo curator run [--dry-run]   — execute one curator tick
 *   cleo curator status            — read curator config + last-run stats
 *
 * Both verbs call the CORE curator module directly (no domain dispatch) so
 * the implementation stays narrow and skill-focused. The curator is opt-in
 * — when `daemon.curator.enabled=false` (the default), `run` still works
 * because the operator may want to invoke it on demand; `status` reports
 * the disabled flag so the operator knows the daemon won't schedule ticks.
 *
 * @task T9685, T9686, T9562
 * @epic T9562
 * @saga T9560
 */

import { join } from 'node:path';
import { getCleoHome } from '@cleocode/paths';
import { defineCommand } from 'citty';
import { isSubCommandDispatch } from '../lib/subcommand-guard.js';
import { cliError, cliOutput } from '../renderers/index.js';

/**
 * Lazy-load the curator core helpers so this file does not pull the sentient
 * subsystem into every `cleo --help` invocation.
 */
async function loadCurator(): Promise<typeof import('@cleocode/core/sentient/curator.js')> {
  return import('@cleocode/core/sentient/curator.js');
}

/**
 * Lazy-load the daemon helpers (config reader).
 */
async function loadDaemon(): Promise<typeof import('@cleocode/core/sentient/daemon.js')> {
  return import('@cleocode/core/sentient/daemon.js');
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

/**
 * `cleo curator run` — execute one curator tick.
 *
 * @remarks
 * Honours `--dry-run` per the T9685 contract: no disk moves, no db writes,
 * but the visit log is identical so operators can preview every transition.
 *
 * Reads cutoffs (`staleAfterDays`, `archiveAfterDays`) from
 * `daemon.curator.*` in `~/.cleo/config.json` and falls back to the
 * curator-module defaults when absent. `enabled=false` does NOT block this
 * verb — operator-invoked runs are always allowed, mirroring Hermes'
 * `hermes curator run` behaviour.
 */
const runCommand = defineCommand({
  meta: {
    name: 'run',
    description: 'Execute one curator tick (use --dry-run for a preview)',
  },
  args: {
    'dry-run': {
      type: 'boolean',
      description: 'Compute transitions without applying them — no disk writes',
    },
  },
  async run({ args }) {
    try {
      const { runCuratorTick } = await loadCurator();
      const { readCuratorConfig } = await loadDaemon();
      const configPath = join(getCleoHome(), 'config.json');
      const cfg = await readCuratorConfig(configPath);

      const result = await runCuratorTick({
        dryRun: args['dry-run'] === true,
        staleAfterDays: cfg.staleAfterDays,
        archiveAfterDays: cfg.archiveAfterDays,
      });

      cliOutput(
        {
          success: true,
          dryRun: result.summary.dryRun,
          checked: result.summary.checked,
          markedStale: result.summary.markedStale,
          reactivated: result.summary.reactivated,
          archived: result.summary.archived,
          skipped: result.summary.skipped,
          startedAt: result.summary.startedAt,
          completedAt: result.summary.completedAt,
          transitions: result.transitions,
        },
        {
          command: 'curator run',
          operation: 'curator.run',
          message: result.summary.dryRun
            ? `dry-run: ${result.transitions.length} transition(s) planned`
            : `applied ${result.summary.archived} archive(s), ${result.summary.markedStale} stale, ${result.summary.reactivated} reactivated`,
        },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      cliError(message, 'E_INTERNAL_ERROR', undefined, { operation: 'curator.run' });
      process.exit(1);
    }
  },
});

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

/**
 * `cleo curator status` — read curator config + recent state (pure read).
 *
 * @remarks
 * Pure read — does not invoke `runCuratorTick`. Surfaces:
 *   - `daemon.curator.*` config (enabled, runEveryHours, cutoffs)
 *   - Resolved cron expression that the daemon would (or does) use
 *
 * Useful as a sanity check after editing `~/.cleo/config.json` — the cron
 * expression makes it obvious whether the operator's interval matches their
 * mental model.
 */
const statusCommand = defineCommand({
  meta: {
    name: 'status',
    description: 'Show curator configuration and last-run summary (pure read)',
  },
  async run() {
    try {
      const { readCuratorConfig, curatorCronExpression } = await loadDaemon();
      const configPath = join(getCleoHome(), 'config.json');
      const cfg = await readCuratorConfig(configPath);

      cliOutput(
        {
          enabled: cfg.enabled,
          runEveryHours: cfg.runEveryHours,
          staleAfterDays: cfg.staleAfterDays,
          archiveAfterDays: cfg.archiveAfterDays,
          cronExpression: curatorCronExpression(cfg.runEveryHours),
          configPath,
        },
        {
          command: 'curator status',
          operation: 'curator.status',
          message: cfg.enabled
            ? `curator enabled (interval=${cfg.runEveryHours}h)`
            : 'curator disabled — set daemon.curator.enabled=true in ~/.cleo/config.json to schedule ticks',
        },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      cliError(message, 'E_INTERNAL_ERROR', undefined, { operation: 'curator.status' });
      process.exit(1);
    }
  },
});

// ---------------------------------------------------------------------------
// Root group
// ---------------------------------------------------------------------------

/**
 * Root `curator` command group.
 *
 * @remarks
 * Default action (no subcommand) prints status — read-only, no risk.
 */
export const curatorCommand = defineCommand({
  meta: {
    name: 'curator',
    description: 'Skill curator: lifecycle transitions for agent-created skills',
  },
  subCommands: {
    run: runCommand,
    status: statusCommand,
  },
  async run({ cmd, rawArgs }) {
    if (isSubCommandDispatch(rawArgs, cmd.subCommands)) return;
    // Default subcommand — pure status read.
    await statusCommand.run?.({
      args: {} as never,
      cmd: statusCommand,
      rawArgs: [],
      data: undefined,
    });
  },
});
