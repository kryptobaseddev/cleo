/**
 * CLI command group: `cleo sentient` — Tier-1 autonomous loop management.
 *
 * Subcommands:
 *   cleo sentient start  — spawn detached daemon background process
 *   cleo sentient stop   — flip killSwitch + send SIGTERM
 *   cleo sentient status — print pid / stats / killSwitch state
 *   cleo sentient resume — clear killSwitch (does NOT restart the process)
 *   cleo sentient tick   — run a single tick in-process (for testing / owner verify)
 *
 * All subcommands emit LAFS-compliant envelopes when `--json` is set.
 *
 * Scoped OUT of Tier 1 (future work):
 *   - `cleo sentient propose` (Tier-2 proposal queue)
 *   - `cleo sentient sandbox` (Tier-3 auto-merge)
 *
 * @see packages/cleo/src/sentient/daemon.ts
 * @see docs/sentient-loop.md
 * @task T946
 */

import { join } from 'node:path';
import { cwd as processCwd } from 'node:process';
import { defineCommand } from 'citty';
import {
  getSentientDaemonStatus,
  resumeSentientDaemon,
  SENTIENT_STATE_FILE,
  spawnSentientDaemon,
  stopSentientDaemon,
} from '../../sentient/daemon.js';
import { safeRunTick } from '../../sentient/tick.js';

// ---------------------------------------------------------------------------
// Shared arg spec
// ---------------------------------------------------------------------------

const projectArgs = {
  project: {
    type: 'string' as const,
    description: 'Project root (defaults to process cwd)',
  },
  json: {
    type: 'boolean' as const,
    description: 'Emit LAFS JSON envelope',
  },
};

/** Resolve the project root from the provided arg or fall back to cwd. */
function resolveProjectRoot(arg: string | undefined): string {
  return arg && arg.length > 0 ? arg : processCwd();
}

/** Emit a LAFS-shaped success envelope as JSON or human text. */
function emitSuccess(payload: unknown, jsonMode: boolean, humanLine: string): void {
  if (jsonMode) {
    process.stdout.write(`${JSON.stringify({ success: true, data: payload })}\n`);
  } else {
    process.stdout.write(`${humanLine}\n`);
  }
}

/** Emit a LAFS-shaped failure envelope. */
function emitFailure(code: string, message: string, jsonMode: boolean): void {
  if (jsonMode) {
    process.stdout.write(`${JSON.stringify({ success: false, error: { code, message } })}\n`);
  } else {
    process.stderr.write(`Error: ${message}\n`);
  }
  process.exit(1);
}

// ---------------------------------------------------------------------------
// start
// ---------------------------------------------------------------------------

const startSub = defineCommand({
  meta: {
    name: 'start',
    description: 'Spawn the sentient daemon as a detached background process',
  },
  args: {
    ...projectArgs,
    'dry-run': {
      type: 'boolean' as const,
      description: 'Run a single in-process tick without spawning the daemon',
    },
  },
  async run({ args }) {
    const projectRoot = resolveProjectRoot(args.project as string | undefined);
    const jsonMode = args.json === true;
    const dryRun = args['dry-run'] === true;

    try {
      // Short-circuit if already running.
      const existing = await getSentientDaemonStatus(projectRoot);
      if (existing.running && existing.pid) {
        emitSuccess(
          { running: true, pid: existing.pid, message: 'daemon already running' },
          jsonMode,
          `Sentient daemon already running (pid ${existing.pid})`,
        );
        return;
      }

      if (dryRun) {
        const statePath = join(projectRoot, SENTIENT_STATE_FILE);
        const outcome = await safeRunTick({ projectRoot, statePath, dryRun: true });
        emitSuccess(
          { dryRun: true, outcome },
          jsonMode,
          `Dry-run tick: ${outcome.kind} (task=${outcome.taskId ?? 'n/a'}) ${outcome.detail}`,
        );
        return;
      }

      const { pid, statePath, logPath } = await spawnSentientDaemon(projectRoot);
      emitSuccess(
        { pid, statePath, logPath, message: 'sentient daemon started' },
        jsonMode,
        `Sentient daemon started (pid ${pid})\nState: ${statePath}\nLogs:  ${logPath}`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      emitFailure('E_SENTIENT_START', message, jsonMode);
    }
  },
});

// ---------------------------------------------------------------------------
// stop
// ---------------------------------------------------------------------------

const stopSub = defineCommand({
  meta: {
    name: 'stop',
    description: 'Flip killSwitch=true and send SIGTERM to the daemon',
  },
  args: {
    ...projectArgs,
    reason: {
      type: 'string' as const,
      description: 'Reason stored on sentient-state.json for diagnostics',
    },
  },
  async run({ args }) {
    const projectRoot = resolveProjectRoot(args.project as string | undefined);
    const jsonMode = args.json === true;
    const reason = (args.reason as string | undefined) ?? 'cleo sentient stop';

    try {
      const result = await stopSentientDaemon(projectRoot, reason);
      emitSuccess(result, jsonMode, `Sentient stop: ${result.reason}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      emitFailure('E_SENTIENT_STOP', message, jsonMode);
    }
  },
});

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

const statusSub = defineCommand({
  meta: {
    name: 'status',
    description: 'Show daemon pid, stats, kill-switch state',
  },
  args: projectArgs,
  async run({ args }) {
    const projectRoot = resolveProjectRoot(args.project as string | undefined);
    const jsonMode = args.json === true;

    try {
      const status = await getSentientDaemonStatus(projectRoot);
      if (jsonMode) {
        process.stdout.write(`${JSON.stringify({ success: true, data: status })}\n`);
        return;
      }

      process.stdout.write(
        `Daemon:       ${status.running ? `running (pid ${status.pid})` : 'stopped'}\n`,
      );
      process.stdout.write(`Started at:   ${status.startedAt ?? 'never'}\n`);
      process.stdout.write(`Last tick:    ${status.lastTickAt ?? 'never'}\n`);
      process.stdout.write(`Kill switch:  ${status.killSwitch ? 'ACTIVE' : 'inactive'}`);
      if (status.killSwitchReason) {
        process.stdout.write(` (${status.killSwitchReason})`);
      }
      process.stdout.write('\n');
      process.stdout.write(`Active task:  ${status.activeTaskId ?? 'none'}\n`);
      process.stdout.write(`Stuck tasks:  ${status.stuckCount}\n`);
      process.stdout.write(
        `Stats:        picked=${status.stats.tasksPicked} ` +
          `completed=${status.stats.tasksCompleted} ` +
          `failed=${status.stats.tasksFailed} ` +
          `ticks=${status.stats.ticksExecuted} ` +
          `killed-ticks=${status.stats.ticksKilled}\n`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      emitFailure('E_SENTIENT_STATUS', message, jsonMode);
    }
  },
});

// ---------------------------------------------------------------------------
// resume
// ---------------------------------------------------------------------------

const resumeSub = defineCommand({
  meta: {
    name: 'resume',
    description: 'Clear killSwitch so the cron schedule resumes execution',
  },
  args: projectArgs,
  async run({ args }) {
    const projectRoot = resolveProjectRoot(args.project as string | undefined);
    const jsonMode = args.json === true;

    try {
      const state = await resumeSentientDaemon(projectRoot);
      emitSuccess(
        {
          killSwitch: state.killSwitch,
          killSwitchReason: state.killSwitchReason,
          message: 'killSwitch cleared',
        },
        jsonMode,
        'Sentient kill-switch cleared. Daemon will resume ticks on next cron cadence.',
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      emitFailure('E_SENTIENT_RESUME', message, jsonMode);
    }
  },
});

// ---------------------------------------------------------------------------
// tick
// ---------------------------------------------------------------------------

const tickSub = defineCommand({
  meta: {
    name: 'tick',
    description: 'Run a single tick in-process (diagnostic / owner verify)',
  },
  args: {
    ...projectArgs,
    'dry-run': {
      type: 'boolean' as const,
      description: 'Skip the actual worker spawn',
    },
  },
  async run({ args }) {
    const projectRoot = resolveProjectRoot(args.project as string | undefined);
    const jsonMode = args.json === true;
    const dryRun = args['dry-run'] === true;

    try {
      const statePath = join(projectRoot, SENTIENT_STATE_FILE);
      const outcome = await safeRunTick({ projectRoot, statePath, dryRun });
      emitSuccess(
        { outcome, dryRun },
        jsonMode,
        `Tick outcome: ${outcome.kind} (task=${outcome.taskId ?? 'n/a'}) ${outcome.detail}`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      emitFailure('E_SENTIENT_TICK', message, jsonMode);
    }
  },
});

// ---------------------------------------------------------------------------
// Root command
// ---------------------------------------------------------------------------

/**
 * Root `cleo sentient` command. Running it without a subcommand prints the
 * status snapshot (same as `cleo sentient status`).
 */
export const sentientCommand = defineCommand({
  meta: {
    name: 'sentient',
    description: 'Manage the Tier-1 sentient autonomous loop daemon',
  },
  args: projectArgs,
  subCommands: {
    start: startSub,
    stop: stopSub,
    status: statusSub,
    resume: resumeSub,
    tick: tickSub,
  },
  async run({ args }) {
    const projectRoot = resolveProjectRoot(args.project as string | undefined);
    const jsonMode = args.json === true;

    try {
      const status = await getSentientDaemonStatus(projectRoot);
      if (jsonMode) {
        process.stdout.write(`${JSON.stringify({ success: true, data: status })}\n`);
      } else {
        process.stdout.write(
          `Daemon: ${status.running ? `running (pid ${status.pid})` : 'stopped'} ` +
            `| killSwitch=${status.killSwitch ? 'ACTIVE' : 'inactive'} ` +
            `| picked=${status.stats.tasksPicked} ` +
            `completed=${status.stats.tasksCompleted} ` +
            `failed=${status.stats.tasksFailed}\n`,
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      emitFailure('E_SENTIENT_STATUS', message, jsonMode);
    }
  },
});
