/**
 * CLI command group: `cleo sentient` — Tier-1 and Tier-2 autonomous loop management.
 *
 * Subcommands:
 *   cleo sentient start          — spawn detached daemon background process
 *   cleo sentient stop           — flip killSwitch + send SIGTERM
 *   cleo sentient status         — print pid / stats / killSwitch state
 *   cleo sentient resume         — clear killSwitch (does NOT restart the process)
 *   cleo sentient tick           — run a single tick in-process (for testing / owner verify)
 *   cleo sentient propose list   — list all Tier-2 proposals (status='proposed')
 *   cleo sentient propose accept — accept a proposal (proposed → pending)
 *   cleo sentient propose reject — reject a proposal (proposed → cancelled)
 *   cleo sentient propose diff   — show what a proposal would change (Tier-3 stub)
 *   cleo sentient propose run    — manually trigger a propose tick in-process
 *   cleo sentient propose enable — enable Tier-2 proposal generation
 *   cleo sentient propose disable— disable Tier-2 proposal generation
 *
 * All subcommands emit LAFS-compliant envelopes when `--json` is set.
 *
 * Scoped OUT:
 *   - `cleo sentient sandbox` (Tier-3 auto-merge — blocked on T992+T993+T995)
 *
 * @see packages/cleo/src/sentient/daemon.ts
 * @see docs/sentient-loop.md
 * @task T946
 * @task T1008
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
import { safeRunProposeTick } from '../../sentient/propose-tick.js';
import { patchSentientState, readSentientState } from '../../sentient/state.js';
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
// propose subcommands (Tier-2 — T1008)
// ---------------------------------------------------------------------------

const proposeListSub = defineCommand({
  meta: {
    name: 'list',
    description: 'List all Tier-2 proposals (status=proposed)',
  },
  args: {
    ...projectArgs,
    limit: { type: 'string' as const, description: 'Maximum proposals to return (default 50)' },
  },
  async run({ args }) {
    const projectRoot = resolveProjectRoot(args.project as string | undefined);
    const jsonMode = args.json === true;
    const limit = args.limit ? Number.parseInt(args.limit as string, 10) : 50;

    try {
      const { Cleo } = await import('@cleocode/core/sdk');
      const cleo = await Cleo.init(projectRoot);
      const result = await (
        cleo as unknown as {
          dispatch: (d: string, g: string, o: string, p: unknown) => Promise<unknown>;
        }
      ).dispatch?.('sentient', 'query', 'propose.list', { limit });

      const data = (result as { data?: unknown })?.data ?? result;
      emitSuccess(data, jsonMode, JSON.stringify(data, null, 2));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      emitFailure('E_SENTIENT_PROPOSE_LIST', message, jsonMode);
    }
  },
});

const proposeAcceptSub = defineCommand({
  meta: {
    name: 'accept',
    description: 'Accept a proposal — transition proposed → pending',
  },
  args: {
    ...projectArgs,
    id: { type: 'positional' as const, description: 'Proposal task ID', required: true },
  },
  async run({ args }) {
    const projectRoot = resolveProjectRoot(args.project as string | undefined);
    const jsonMode = args.json === true;
    const id = args.id as string;

    try {
      const { getDb } = await import('@cleocode/core/internal');
      const { tasks } = await import('@cleocode/core/store/tasks-schema');
      const { and, eq, like } = await import('drizzle-orm');

      const db = await getDb(projectRoot);
      const now = new Date().toISOString();

      const existing = await db
        .select()
        .from(tasks)
        .where(
          and(
            eq(tasks.id, id),
            eq(tasks.status, 'proposed'),
            like(tasks.labelsJson, '%sentient-tier2%'),
          ),
        )
        .get();

      if (!existing) {
        emitFailure('E_NOT_FOUND', `Task ${id} is not a pending Tier-2 proposal`, jsonMode);
        return;
      }

      await db
        .update(tasks)
        .set({ status: 'pending', updatedAt: now })
        .where(eq(tasks.id, id))
        .run();

      // Update stats
      const statePath = join(projectRoot, SENTIENT_STATE_FILE);
      const state = await readSentientState(statePath);
      await patchSentientState(statePath, {
        tier2Stats: {
          ...state.tier2Stats,
          proposalsAccepted: state.tier2Stats.proposalsAccepted + 1,
        },
      });

      emitSuccess(
        { id, status: 'pending', acceptedAt: now },
        jsonMode,
        `Proposal ${id} accepted → pending`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      emitFailure('E_SENTIENT_PROPOSE_ACCEPT', message, jsonMode);
    }
  },
});

const proposeRejectSub = defineCommand({
  meta: {
    name: 'reject',
    description: 'Reject a proposal — transition proposed → cancelled',
  },
  args: {
    ...projectArgs,
    id: { type: 'positional' as const, description: 'Proposal task ID', required: true },
    reason: { type: 'string' as const, description: 'Rejection reason' },
  },
  async run({ args }) {
    const projectRoot = resolveProjectRoot(args.project as string | undefined);
    const jsonMode = args.json === true;
    const id = args.id as string;
    const reason = (args.reason as string | undefined) ?? 'rejected by owner';

    try {
      const { getDb } = await import('@cleocode/core/internal');
      const { tasks } = await import('@cleocode/core/store/tasks-schema');
      const { and, eq, like } = await import('drizzle-orm');

      const db = await getDb(projectRoot);
      const now = new Date().toISOString();

      const existing = await db
        .select()
        .from(tasks)
        .where(
          and(
            eq(tasks.id, id),
            eq(tasks.status, 'proposed'),
            like(tasks.labelsJson, '%sentient-tier2%'),
          ),
        )
        .get();

      if (!existing) {
        emitFailure('E_NOT_FOUND', `Task ${id} is not a pending Tier-2 proposal`, jsonMode);
        return;
      }

      await db
        .update(tasks)
        .set({ status: 'cancelled', cancellationReason: reason, cancelledAt: now, updatedAt: now })
        .where(eq(tasks.id, id))
        .run();

      // Update stats
      const statePath = join(projectRoot, SENTIENT_STATE_FILE);
      const state = await readSentientState(statePath);
      await patchSentientState(statePath, {
        tier2Stats: {
          ...state.tier2Stats,
          proposalsRejected: state.tier2Stats.proposalsRejected + 1,
        },
      });

      emitSuccess(
        { id, status: 'cancelled', rejectedAt: now, reason },
        jsonMode,
        `Proposal ${id} rejected → cancelled`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      emitFailure('E_SENTIENT_PROPOSE_REJECT', message, jsonMode);
    }
  },
});

const proposeDiffSub = defineCommand({
  meta: {
    name: 'diff',
    description: 'Show what a proposal would change (Tier-3 stub)',
  },
  args: {
    ...projectArgs,
    id: { type: 'positional' as const, description: 'Proposal task ID', required: true },
  },
  async run({ args }) {
    const jsonMode = args.json === true;
    const id = args.id as string;
    const msg =
      `Content diff is a Tier-3 feature (blocked on T992+T993+T995). ` +
      `Proposal ${id} is a task-creation suggestion; no diff is available.`;
    emitSuccess({ id, diff: null, message: msg }, jsonMode, msg);
  },
});

const proposeRunSub = defineCommand({
  meta: {
    name: 'run',
    description: 'Manually trigger a single propose tick in-process',
  },
  args: projectArgs,
  async run({ args }) {
    const projectRoot = resolveProjectRoot(args.project as string | undefined);
    const jsonMode = args.json === true;

    try {
      const statePath = join(projectRoot, SENTIENT_STATE_FILE);
      const outcome = await safeRunProposeTick({ projectRoot, statePath });
      emitSuccess(
        { outcome },
        jsonMode,
        `Propose tick: ${outcome.kind} (written=${outcome.written}, count=${outcome.count}) ${outcome.detail}`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      emitFailure('E_SENTIENT_PROPOSE_RUN', message, jsonMode);
    }
  },
});

const proposeEnableSub = defineCommand({
  meta: { name: 'enable', description: 'Enable Tier-2 proposal generation' },
  args: projectArgs,
  async run({ args }) {
    const projectRoot = resolveProjectRoot(args.project as string | undefined);
    const jsonMode = args.json === true;
    try {
      const statePath = join(projectRoot, SENTIENT_STATE_FILE);
      const updated = await patchSentientState(statePath, { tier2Enabled: true });
      emitSuccess({ tier2Enabled: updated.tier2Enabled }, jsonMode, 'Tier-2 proposals enabled');
    } catch (err) {
      emitFailure(
        'E_SENTIENT_PROPOSE_ENABLE',
        err instanceof Error ? err.message : String(err),
        jsonMode,
      );
    }
  },
});

const proposeDisableSub = defineCommand({
  meta: { name: 'disable', description: 'Disable Tier-2 proposal generation' },
  args: projectArgs,
  async run({ args }) {
    const projectRoot = resolveProjectRoot(args.project as string | undefined);
    const jsonMode = args.json === true;
    try {
      const statePath = join(projectRoot, SENTIENT_STATE_FILE);
      const updated = await patchSentientState(statePath, { tier2Enabled: false });
      emitSuccess({ tier2Enabled: updated.tier2Enabled }, jsonMode, 'Tier-2 proposals disabled');
    } catch (err) {
      emitFailure(
        'E_SENTIENT_PROPOSE_DISABLE',
        err instanceof Error ? err.message : String(err),
        jsonMode,
      );
    }
  },
});

/**
 * `cleo sentient propose` — Tier-2 proposal queue management.
 *
 * @task T1008
 */
const proposeSub = defineCommand({
  meta: {
    name: 'propose',
    description: 'Tier-2 proposal queue management (list/accept/reject/diff/run)',
  },
  args: projectArgs,
  subCommands: {
    list: proposeListSub,
    accept: proposeAcceptSub,
    reject: proposeRejectSub,
    diff: proposeDiffSub,
    run: proposeRunSub,
    enable: proposeEnableSub,
    disable: proposeDisableSub,
  },
  async run({ args }) {
    const projectRoot = resolveProjectRoot(args.project as string | undefined);
    const jsonMode = args.json === true;
    try {
      const statePath = join(projectRoot, SENTIENT_STATE_FILE);
      const state = await readSentientState(statePath);
      emitSuccess(
        {
          tier2Enabled: state.tier2Enabled,
          tier2Stats: state.tier2Stats,
        },
        jsonMode,
        `Tier-2 proposals: ${state.tier2Enabled ? 'enabled' : 'disabled'} | ` +
          `generated=${state.tier2Stats.proposalsGenerated} ` +
          `accepted=${state.tier2Stats.proposalsAccepted} ` +
          `rejected=${state.tier2Stats.proposalsRejected}`,
      );
    } catch (err) {
      emitFailure('E_SENTIENT_PROPOSE', err instanceof Error ? err.message : String(err), jsonMode);
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
    description: 'Manage the Tier-1 sentient autonomous loop daemon and Tier-2 proposals',
  },
  args: projectArgs,
  subCommands: {
    start: startSub,
    stop: stopSub,
    status: statusSub,
    resume: resumeSub,
    tick: tickSub,
    propose: proposeSub,
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
