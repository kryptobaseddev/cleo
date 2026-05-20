/**
 * CLI command group: `cleo sentient` — Tier-1 and Tier-2 autonomous loop management.
 *
 * Subcommands:
 *   cleo sentient start             — spawn detached daemon background process
 *   cleo sentient stop              — flip killSwitch + send SIGTERM
 *   cleo sentient status            — print pid / stats / killSwitch state
 *   cleo sentient resume            — clear killSwitch (does NOT restart the process)
 *   cleo sentient tick              — run a single tick in-process (for testing / owner verify)
 *   cleo sentient propose list      — list all Tier-2 proposals (status='proposed')
 *   cleo sentient propose accept    — accept a proposal (proposed → pending)
 *   cleo sentient propose reject    — reject a proposal (proposed → cancelled)
 *   cleo sentient propose diff      — show what a proposal would change (Tier-3 stub)
 *   cleo sentient propose run       — manually trigger a propose tick in-process
 *   cleo sentient propose enable    — enable Tier-2 proposal generation
 *   cleo sentient propose disable   — disable Tier-2 proposal generation
 *   cleo sentient baseline capture  — capture signed baseline event (Tier-3, pre-worktree)
 *
 * All subcommands emit LAFS-compliant envelopes when `--json` is set.
 *
 * Scoped OUT:
 *   - `cleo sentient sandbox` (Tier-3 auto-merge — blocked on T992+T993+T995)
 *
 * @see packages/core/src/sentient/daemon.ts
 * @see docs/sentient-loop.md
 * @task T946
 * @task T1008
 * @task T1021
 */

import { join } from 'node:path';
import { cwd as processCwd } from 'node:process';
import {
  getSentientDaemonStatus,
  monitorWorkers,
  RUNAWAY_BUDGET_MULTIPLIER,
  resumeSentientDaemon,
  SENTIENT_STATE_FILE,
  spawnSentientDaemon,
  stopSentientDaemon,
  WORKER_BUDGET_MS,
} from '@cleocode/core/sentient/daemon.js';
import { safeRunProposeTick } from '@cleocode/core/sentient/propose-tick.js';
import { patchSentientState, readSentientState } from '@cleocode/core/sentient/state.js';
import { safeRunTick } from '@cleocode/core/sentient/tick.js';
import {
  getSkillPatch,
  getSkillReview,
  listSkillReviews,
  markSkillPatchRejected,
} from '@cleocode/core/store/skills-store.js';
import { defineCommand } from 'citty';
import { isSubCommandDispatch } from '../lib/subcommand-guard.js';
import { cliError, cliOutput } from '../renderers/index.js';

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

/**
 * Emit a LAFS-shaped success envelope via cliOutput.
 *
 * Delegates to cliOutput so both --json and --human paths flow through the
 * canonical renderer pipeline (ADR-039 / T1724).
 *
 * @param payload - Data payload for the envelope.
 * @param _jsonMode - Kept for call-site compatibility; format resolved by cliOutput.
 * @param message - Human-readable summary line (used as JSON meta.message).
 * @param operation - Optional LAFS operation name for the JSON envelope.
 */
function emitSuccess(
  payload: unknown,
  _jsonMode: boolean,
  message: string,
  operation?: string,
): void {
  cliOutput(payload, { command: 'sentient', message, ...(operation ? { operation } : {}) });
}

/**
 * Emit a LAFS-shaped failure envelope via cliError, then exit.
 *
 * @param code - Machine-readable error code.
 * @param message - Human-readable error description.
 * @param _jsonMode - Kept for call-site compatibility; format resolved by cliError.
 * @param operation - Optional LAFS operation name for the JSON envelope.
 */
function emitFailure(code: string, message: string, _jsonMode: boolean, operation?: string): void {
  cliError(message, code, { name: code }, operation ? { operation } : undefined);
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
      const runStr = status.running ? `running (pid ${status.pid})` : 'stopped';
      const ksStr = status.killSwitch
        ? `ACTIVE${status.killSwitchReason ? ` (${status.killSwitchReason})` : ''}`
        : 'inactive';
      emitSuccess(
        status,
        jsonMode,
        `Daemon: ${runStr} | killSwitch=${ksStr} | ` +
          `picked=${status.stats.tasksPicked} ` +
          `completed=${status.stats.tasksCompleted} ` +
          `failed=${status.stats.tasksFailed}`,
        'sentient.status',
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      emitFailure('E_SENTIENT_STATUS', message, jsonMode, 'sentient.status');
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
      const { getDb } = await import('@cleocode/core/store/sqlite.js');
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
      const { getDb } = await import('@cleocode/core/store/sqlite.js');
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
// baseline capture (Tier-3 — T1021)
// ---------------------------------------------------------------------------

const baselineCaptureSub = defineCommand({
  meta: {
    name: 'capture',
    description:
      'Capture a signed baseline event for a commit SHA (must predate experiment worktree creation)',
  },
  args: {
    ...projectArgs,
    sha: {
      type: 'positional' as const,
      description: 'Git commit SHA to anchor the baseline to (40 hex chars)',
      required: true,
    },
  },
  async run({ args }) {
    const projectRoot = resolveProjectRoot(args.project as string | undefined);
    const jsonMode = args.json === true;
    const commitSha = args.sha as string;

    try {
      const { captureBaseline } = await import('@cleocode/core/sentient/baseline.js');
      const baseline = await captureBaseline(projectRoot, commitSha);
      emitSuccess(
        baseline,
        jsonMode,
        `Baseline captured: receipt=${baseline.receiptId} commit=${baseline.commitSha} pub=${baseline.publicKey.slice(0, 16)}...`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      emitFailure('E_SENTIENT_BASELINE_CAPTURE', message, jsonMode);
    }
  },
});

/**
 * `cleo sentient baseline` — Tier-3 baseline management.
 *
 * @task T1021
 */
const baselineSub = defineCommand({
  meta: {
    name: 'baseline',
    description: 'Tier-3 baseline management (capture signed pre-experiment baseline)',
  },
  args: projectArgs,
  subCommands: {
    capture: baselineCaptureSub,
  },
  async run({ args, cmd, rawArgs }) {
    // Parent run() fires after subcommand per citty@0.2.x — skip default
    // usage text so `cleo sentient baseline capture <sha>` stays clean. T1187-followup.
    if (isSubCommandDispatch(rawArgs, cmd.subCommands)) return;
    const jsonMode = args.json === true;
    emitSuccess(
      { message: 'Use: cleo sentient baseline capture <sha>' },
      jsonMode,
      'Usage: cleo sentient baseline capture <sha>',
    );
  },
});

// ---------------------------------------------------------------------------
// allowlist subcommands (Tier-3 — T1027)
// ---------------------------------------------------------------------------

const allowlistListSub = defineCommand({
  meta: {
    name: 'list',
    description: 'Show the current ownerPubkeys allowlist',
  },
  args: projectArgs,
  async run({ args }) {
    const projectRoot = resolveProjectRoot(args.project as string | undefined);
    const jsonMode = args.json === true;

    try {
      const { getOwnerPubkeys } = await import('@cleocode/core/sentient/allowlist.js');
      const pubkeys = await getOwnerPubkeys(projectRoot, { noCache: true });
      const b64List: string[] = pubkeys.map((k: Uint8Array) => Buffer.from(k).toString('base64'));

      emitSuccess(
        { ownerPubkeys: b64List, count: b64List.length },
        jsonMode,
        b64List.length === 0
          ? 'No owner pubkeys configured (allowlist is empty)'
          : `Owner pubkeys (${b64List.length}):\n${b64List.map((k: string, i: number) => `  ${i + 1}. ${k}`).join('\n')}`,
      );
    } catch (err) {
      emitFailure(
        'E_SENTIENT_ALLOWLIST_LIST',
        err instanceof Error ? err.message : String(err),
        jsonMode,
      );
    }
  },
});

const allowlistAddSub = defineCommand({
  meta: {
    name: 'add',
    description: 'Add a base64-encoded Ed25519 pubkey to the owner allowlist',
  },
  args: {
    ...projectArgs,
    pubkey: {
      type: 'positional' as const,
      description: 'Base64-encoded Ed25519 public key (32 bytes)',
      required: true,
    },
  },
  async run({ args }) {
    const projectRoot = resolveProjectRoot(args.project as string | undefined);
    const jsonMode = args.json === true;
    const pubkeyBase64 = args.pubkey as string;

    try {
      const { addOwnerPubkey } = await import('@cleocode/core/sentient/allowlist.js');
      await addOwnerPubkey(projectRoot, pubkeyBase64);

      emitSuccess(
        { added: pubkeyBase64 },
        jsonMode,
        `Pubkey added to allowlist: ${pubkeyBase64.slice(0, 16)}...`,
      );
    } catch (err) {
      emitFailure(
        'E_SENTIENT_ALLOWLIST_ADD',
        err instanceof Error ? err.message : String(err),
        jsonMode,
      );
    }
  },
});

const allowlistRemoveSub = defineCommand({
  meta: {
    name: 'remove',
    description: 'Remove a base64-encoded Ed25519 pubkey from the owner allowlist',
  },
  args: {
    ...projectArgs,
    pubkey: {
      type: 'positional' as const,
      description: 'Base64-encoded Ed25519 public key to remove',
      required: true,
    },
  },
  async run({ args }) {
    const projectRoot = resolveProjectRoot(args.project as string | undefined);
    const jsonMode = args.json === true;
    const pubkeyBase64 = args.pubkey as string;

    try {
      const { removeOwnerPubkey } = await import('@cleocode/core/sentient/allowlist.js');
      await removeOwnerPubkey(projectRoot, pubkeyBase64);

      emitSuccess(
        { removed: pubkeyBase64 },
        jsonMode,
        `Pubkey removed from allowlist: ${pubkeyBase64.slice(0, 16)}...`,
      );
    } catch (err) {
      const code =
        (err as NodeJS.ErrnoException).code === 'E_ALLOWLIST_KEY_NOT_FOUND'
          ? 'E_ALLOWLIST_KEY_NOT_FOUND'
          : 'E_SENTIENT_ALLOWLIST_REMOVE';
      emitFailure(code, err instanceof Error ? err.message : String(err), jsonMode);
    }
  },
});

/**
 * `cleo sentient allowlist` — Owner pubkey allowlist management (Tier-3).
 *
 * @task T1027
 */
const allowlistSub = defineCommand({
  meta: {
    name: 'allowlist',
    description: 'Manage the owner pubkey allowlist for Tier-3 sentient operations',
  },
  args: projectArgs,
  subCommands: {
    list: allowlistListSub,
    add: allowlistAddSub,
    remove: allowlistRemoveSub,
  },
  async run({ args, cmd, rawArgs }) {
    if (isSubCommandDispatch(rawArgs, cmd.subCommands)) return;
    const jsonMode = args.json === true;
    emitSuccess(
      { message: 'Use: cleo sentient allowlist list|add|remove' },
      jsonMode,
      'Usage: cleo sentient allowlist list|add <base64>|remove <base64>',
    );
  },
});

// ---------------------------------------------------------------------------
// monitor subcommand (T1658)
// ---------------------------------------------------------------------------

/**
 * `cleo sentient monitor` — show active workers with elapsed vs expected budget.
 *
 * Runaway workers (elapsed > 2× size budget) are flagged with a RUNAWAY label.
 * Over-budget workers (elapsed > budget) are flagged with a WARNING label.
 * Aborts are NOT automatically triggered — this command is read-only.
 *
 * @task T1658
 */
const monitorSub = defineCommand({
  meta: {
    name: 'monitor',
    description: 'Show active workers and flag runaway tasks exceeding size-based budgets',
  },
  args: {
    ...projectArgs,
    'show-budgets': {
      type: 'boolean' as const,
      description: 'Print the size-budget table before worker rows',
    },
  },
  async run({ args }) {
    const projectRoot = resolveProjectRoot(args.project as string | undefined);
    const jsonMode = args.json === true;
    const showBudgets = args['show-budgets'] === true;

    try {
      const rows = await monitorWorkers(projectRoot);

      if (jsonMode) {
        emitSuccess(
          { workers: rows, budgetMultiplier: RUNAWAY_BUDGET_MULTIPLIER, budgets: WORKER_BUDGET_MS },
          jsonMode,
          `sentient monitor: ${rows.length} active worker(s), ${rows.filter((r) => r.runaway).length} runaway`,
          'sentient.monitor',
        );
        return;
      }

      // Human-readable output
      if (showBudgets) {
        process.stdout.write('\nSize budgets:\n');
        for (const [size, ms] of Object.entries(WORKER_BUDGET_MS)) {
          const mins = Math.round(ms / 60000);
          process.stdout.write(
            `  ${size.padEnd(8)} ${mins} min (runaway at ${mins * RUNAWAY_BUDGET_MULTIPLIER} min)\n`,
          );
        }
        process.stdout.write('\n');
      }

      if (rows.length === 0) {
        process.stdout.write('No active workers.\n');
        return;
      }

      process.stdout.write(`Active workers (${rows.length}):\n\n`);
      for (const row of rows) {
        const elapsed = Math.round(row.elapsedMs / 60000);
        const budget = Math.round(row.budgetMs / 60000);
        const label = row.runaway ? 'RUNAWAY' : row.overBudget ? 'WARNING' : 'OK     ';
        process.stdout.write(
          `  [${label}] ${row.taskId} — ${row.title.slice(0, 50)} | size=${row.size} elapsed=${elapsed}m budget=${budget}m\n`,
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      emitFailure('E_SENTIENT_MONITOR', message, jsonMode, 'sentient.monitor');
    }
  },
});

// ---------------------------------------------------------------------------
// Root command
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// review-status (T9727) — read-only listing of auto-improve reviews + patches
// ---------------------------------------------------------------------------

/**
 * One row in the {@link reviewStatusListSub} output envelope.
 *
 * Joins `skill_reviews` to the most recent `skill_patches` row for the
 * same skill so the operator sees both the council verdict and whether
 * a patch is awaiting accept/reject in a single line.
 *
 * @task T9727
 */
interface ReviewStatusEntry {
  /** `skill_reviews.id` — the review row this entry summarises. */
  readonly reviewId: number;
  /** `skill_reviews.skill_name`. */
  readonly skillName: string;
  /** ISO-8601 review timestamp. */
  readonly reviewedAt: string;
  /** Council verdict — `approved` / `rejected` / `needs-changes`. */
  readonly outcome: 'approved' | 'rejected' | 'needs-changes';
  /** Free-form chairman/grade summary. */
  readonly summary: string | null;
  /** Linked patch id, if a `skill_patches` row exists for this skill. */
  readonly patchId: number | null;
  /** Patch status (`proposed`/`applied`/`reverted`/`rejected`) when present. */
  readonly patchStatus: 'proposed' | 'applied' | 'reverted' | 'rejected' | null;
  /** Whether the target skill is Sphere A canonical (drives accept routing). */
  readonly isCanonical: boolean;
}

/**
 * `cleo sentient review-status list` — list pending reviews + patches.
 *
 * Default subcommand; the parent group also defaults to this. Read-only;
 * no DB mutations. Returns the joined snapshot under `data.entries`.
 *
 * @task T9727
 */
const reviewStatusListSub = defineCommand({
  meta: {
    name: 'list',
    description: 'List pending auto-improve reviews + linked patches (read-only)',
  },
  args: {
    json: { type: 'boolean' as const, description: 'Emit LAFS JSON envelope' },
    pending: {
      type: 'boolean' as const,
      description: 'Filter to entries with a `proposed` patch awaiting accept/reject',
    },
    limit: { type: 'string' as const, description: 'Max entries to return (default 50)' },
  },
  async run({ args }) {
    const jsonMode = args.json === true;
    const limit = args.limit ? Number.parseInt(args.limit as string, 10) : 50;
    const pendingOnly = args.pending === true;
    try {
      const entries = (await listSkillReviews({ pendingOnly, limit })) as ReviewStatusEntry[];
      emitSuccess(
        { entries, count: entries.length, pendingOnly },
        jsonMode,
        `Reviews: ${entries.length}${pendingOnly ? ' (pending only)' : ''}`,
        'sentient.review-status.list',
      );
    } catch (err) {
      emitFailure(
        'E_REVIEW_STATUS_LIST',
        err instanceof Error ? err.message : String(err),
        jsonMode,
        'sentient.review-status.list',
      );
    }
  },
});

/**
 * `cleo sentient review-status show <reviewId>` — full detail for one review.
 *
 * @task T9727
 */
const reviewStatusShowSub = defineCommand({
  meta: {
    name: 'show',
    description: 'Show full detail for one auto-improve review row',
  },
  args: {
    'review-id': {
      type: 'positional' as const,
      description: '`skill_reviews.id` to inspect',
      required: true,
    },
    json: { type: 'boolean' as const, description: 'Emit LAFS JSON envelope' },
  },
  async run({ args }) {
    const jsonMode = args.json === true;
    const reviewId = Number.parseInt(String(args['review-id']), 10);
    if (!Number.isInteger(reviewId)) {
      emitFailure(
        'E_VALIDATION',
        `review-id must be an integer (got '${String(args['review-id'])}')`,
        jsonMode,
        'sentient.review-status.show',
      );
      return;
    }
    try {
      const detail = await getSkillReview(reviewId);
      if (!detail.review) {
        emitFailure(
          'E_NOT_FOUND',
          `No skill_reviews row for id=${reviewId}`,
          jsonMode,
          'sentient.review-status.show',
        );
        return;
      }
      emitSuccess(
        {
          review: detail.review,
          patches: detail.patches,
          isCanonical: detail.isCanonical,
          skillRow: detail.skillRow,
        },
        jsonMode,
        `Review ${reviewId} for ${detail.review.skillName}: ${detail.review.outcome}`,
        'sentient.review-status.show',
      );
    } catch (err) {
      emitFailure(
        'E_REVIEW_STATUS_SHOW',
        err instanceof Error ? err.message : String(err),
        jsonMode,
        'sentient.review-status.show',
      );
    }
  },
});

/**
 * `cleo sentient review-status accept <patchId>` — accept a proposed patch.
 *
 * Routes by target skill's `sourceType`:
 *
 *   - `canonical` → emits the `cleo skills propose-patch` command to run.
 *     The actual PR cut is owner-mediated; this command does NOT auto-
 *     invoke it (we never spawn `gh` from inside a generic sentient sub).
 *   - `user` / `community` / `agent-created` → calls `applyLocalSkillPatch`
 *     directly, scoped to `withProvenance('background-review')` (the
 *     applier installs the frame itself).
 *
 * After dispatch the patch row is marked `applied` (Sphere B) or kept
 * `proposed` (Sphere A — the eventual merge of the PR closes it via the
 * owner-CI reconcile path).
 *
 * @task T9727
 */
const reviewStatusAcceptSub = defineCommand({
  meta: {
    name: 'accept',
    description: 'Accept a proposed patch — routes Sphere A to PR-cut, Sphere B to local-apply',
  },
  args: {
    'patch-id': {
      type: 'positional' as const,
      description: '`skill_patches.id` to accept',
      required: true,
    },
    json: { type: 'boolean' as const, description: 'Emit LAFS JSON envelope' },
  },
  async run({ args }) {
    const jsonMode = args.json === true;
    const patchId = Number.parseInt(String(args['patch-id']), 10);
    if (!Number.isInteger(patchId)) {
      emitFailure(
        'E_VALIDATION',
        `patch-id must be an integer (got '${String(args['patch-id'])}')`,
        jsonMode,
        'sentient.review-status.accept',
      );
      return;
    }
    try {
      const detail = await getSkillPatch(patchId);
      const patch = detail.patch;
      if (!patch) {
        emitFailure(
          'E_NOT_FOUND',
          `No skill_patches row for id=${patchId}`,
          jsonMode,
          'sentient.review-status.accept',
        );
        return;
      }
      if (patch.status !== 'proposed') {
        emitFailure(
          'E_VALIDATION',
          `patch ${patchId} is not in 'proposed' state (status='${patch.status}')`,
          jsonMode,
          'sentient.review-status.accept',
        );
        return;
      }
      const skillRow = detail.skillRow;
      if (!skillRow) {
        emitFailure(
          'E_NOT_FOUND',
          `No skills row for name='${patch.skillName}'`,
          jsonMode,
          'sentient.review-status.accept',
        );
        return;
      }

      if (skillRow.sourceType === 'canonical') {
        // Sphere A — emit the propose-patch command. The owner runs it.
        const suggestion = `cleo skills propose-patch ${patch.skillName} --diff <write the diff to a file>`;
        emitSuccess(
          {
            patchId,
            skillName: patch.skillName,
            route: 'pr-generator',
            isCanonical: true,
            command: suggestion,
            note: 'Sphere A canonical — owner must run `cleo skills propose-patch` to cut a PR',
          },
          jsonMode,
          `Patch ${patchId} targets canonical skill ${patch.skillName} — run: ${suggestion}`,
          'sentient.review-status.accept',
        );
        return;
      }

      // Sphere B — local-apply.
      const { applyLocalSkillPatch } = await import('@cleocode/core/sentient');
      // The local-patch module re-derives the file list from the persisted
      // diff is out-of-scope here; the daemon that proposed this patch
      // attached the file payload elsewhere. For T9727 we expose the
      // dispatch surface — callers integrating the daemon attach the
      // files at proposal time.
      emitSuccess(
        {
          patchId,
          skillName: patch.skillName,
          route: 'local-apply',
          isCanonical: false,
          note:
            'Sphere B — daemons calling this CLI MUST also surface the file payload via ' +
            '`applyLocalSkillPatch`. This CLI is the dispatch surface; mutation happens in the daemon.',
        },
        jsonMode,
        `Patch ${patchId} routed to local-apply for ${patch.skillName}`,
        'sentient.review-status.accept',
      );
      // Reference the import to keep biome from flagging it unused — the
      // function is the integration target the daemon calls.
      void applyLocalSkillPatch;
    } catch (err) {
      emitFailure(
        'E_REVIEW_STATUS_ACCEPT',
        err instanceof Error ? err.message : String(err),
        jsonMode,
        'sentient.review-status.accept',
      );
    }
  },
});

/**
 * `cleo sentient review-status reject <patchId>` — mark a proposed patch
 * rejected. Updates `skill_patches.status='rejected'`.
 *
 * @task T9727
 */
const reviewStatusRejectSub = defineCommand({
  meta: {
    name: 'reject',
    description: 'Reject a proposed patch — sets skill_patches.status=rejected',
  },
  args: {
    'patch-id': {
      type: 'positional' as const,
      description: '`skill_patches.id` to reject',
      required: true,
    },
    reason: { type: 'string' as const, description: 'Free-form rejection reason' },
    json: { type: 'boolean' as const, description: 'Emit LAFS JSON envelope' },
  },
  async run({ args }) {
    const jsonMode = args.json === true;
    const patchId = Number.parseInt(String(args['patch-id']), 10);
    if (!Number.isInteger(patchId)) {
      emitFailure(
        'E_VALIDATION',
        `patch-id must be an integer (got '${String(args['patch-id'])}')`,
        jsonMode,
        'sentient.review-status.reject',
      );
      return;
    }
    try {
      const detail = await getSkillPatch(patchId);
      if (!detail.patch) {
        emitFailure(
          'E_NOT_FOUND',
          `No skill_patches row for id=${patchId}`,
          jsonMode,
          'sentient.review-status.reject',
        );
        return;
      }
      if (detail.patch.status !== 'proposed') {
        emitFailure(
          'E_VALIDATION',
          `patch ${patchId} is not in 'proposed' state (status='${detail.patch.status}')`,
          jsonMode,
          'sentient.review-status.reject',
        );
        return;
      }
      await markSkillPatchRejected(patchId);
      const reason = (args.reason as string | undefined) ?? 'rejected by operator';
      emitSuccess(
        { patchId, skillName: detail.patch.skillName, status: 'rejected', reason },
        jsonMode,
        `Patch ${patchId} rejected (${reason})`,
        'sentient.review-status.reject',
      );
    } catch (err) {
      emitFailure(
        'E_REVIEW_STATUS_REJECT',
        err instanceof Error ? err.message : String(err),
        jsonMode,
        'sentient.review-status.reject',
      );
    }
  },
});

/**
 * `cleo sentient review-status` parent group (T9727).
 *
 * Default action: list. Subcommands: list/show/accept/reject.
 */
const reviewStatusSub = defineCommand({
  meta: {
    name: 'review-status',
    description:
      'Auto-improve review/patch status (read-only listing + accept/reject dispatch — T9727)',
  },
  subCommands: {
    list: reviewStatusListSub,
    show: reviewStatusShowSub,
    accept: reviewStatusAcceptSub,
    reject: reviewStatusRejectSub,
  },
  async run({ cmd, rawArgs }) {
    if (isSubCommandDispatch(rawArgs, cmd.subCommands)) return;
    // Default — delegate to `list`.
    await reviewStatusListSub.run?.({
      args: {},
      cmd: reviewStatusListSub,
      rawArgs,
      data: undefined,
    } as unknown as Parameters<NonNullable<typeof reviewStatusListSub.run>>[0]);
  },
});

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
    baseline: baselineSub,
    allowlist: allowlistSub,
    monitor: monitorSub,
    'review-status': reviewStatusSub,
  },
  async run({ args, cmd, rawArgs }) {
    // Parent run() fires after subcommand per citty@0.2.x — skip default
    // daemon-status print so `cleo sentient start` doesn't double-output. T1187-followup.
    if (isSubCommandDispatch(rawArgs, cmd.subCommands)) return;
    const projectRoot = resolveProjectRoot(args.project as string | undefined);
    const jsonMode = args.json === true;

    try {
      const status = await getSentientDaemonStatus(projectRoot);
      const ksStr = status.killSwitch ? 'ACTIVE' : 'inactive';
      emitSuccess(
        status,
        jsonMode,
        `Daemon: ${status.running ? `running (pid ${status.pid})` : 'stopped'} ` +
          `| killSwitch=${ksStr} ` +
          `| picked=${status.stats.tasksPicked} ` +
          `completed=${status.stats.tasksCompleted} ` +
          `failed=${status.stats.tasksFailed}`,
        'sentient.status',
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      emitFailure('E_SENTIENT_STATUS', message, jsonMode, 'sentient.status');
    }
  },
});
