/**
 * CLI worktree command group — structured worktree enumeration + lifecycle
 * mutations (T9546, T9547, T9804).
 *
 * Thin CLI wrapper delegating to the worktree dispatch domain. Implements
 * the read-only listing (T9546) plus the lifecycle mutations (T9547) for
 * the T9515 worktree-lifecycle bug-fix epic, and the Claude Code Agent
 * isolation:worktree bridge (T9804 / Saga T9800).
 *
 * Commands:
 *   cleo worktree list [--status <category>] [--json] [--days <n>]
 *     — list every worktree attached to the current project with status
 *       classification. Includes adopted sentinel-index entries (T9804).
 *
 *   cleo worktree adopt <path> [--source <source>] [--task-id <id>] [--json]
 *     — register an externally-created worktree (e.g. Claude Code Agent
 *       `isolation:worktree`) in the CLEO SSoT so it surfaces in
 *       `cleo worktree list`. Writes to `.cleo/worktrees.json` (sentinel
 *       index, council D009) and appends an audit-log entry. (T9804)
 *
 *   cleo worktree prune --orphaned [--yes] [--dry-run] [--json]
 *     — detect orphan/merged worktrees + remove them. Per-orphan TTY Y/N
 *       prompt unless `--yes`; non-TTY without `--yes` errors out.
 *
 *   cleo worktree force-unlock <taskId> [--json]
 *     — remove `.git/index.lock` + `git worktree unlock` for a wedged
 *       worktree owned by the given task ID.
 *
 * Dispatch equivalents:
 *   query({ domain: 'worktree', operation: 'list', params: { statusFilter?, staleDays? } })
 *   mutate({ domain: 'worktree', operation: 'adopt', params: { worktreePath, source?, taskId?, actor? } })
 *   mutate({ domain: 'worktree', operation: 'prune', params: { dryRun?, paths?, actor? } })
 *   mutate({ domain: 'worktree', operation: 'forceUnlock', params: { taskId, actor? } })
 *
 * @task T9546
 * @task T9547
 * @task T9804
 * @epic T9515
 * @saga T9800
 */

import readline from 'node:readline';
import type { WorktreeInfo } from '@cleocode/contracts';
import { getProjectRoot, listWorktrees } from '@cleocode/core/internal';
import { defineCommand, showUsage } from 'citty';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';
import { cliError, cliOutput } from '../renderers/index.js';

/** Recognised `--status` filter values. */
const VALID_STATUS_VALUES = ['active', 'stale', 'merged', 'orphan', 'locked'] as const;

/**
 * `cleo worktree list` — emit a structured listing of every worktree.
 *
 * Output:
 *  - `--json` (or `--format json` from the global flag): LAFS envelope with
 *    `data.worktrees: WorktreeInfo[]`.
 *  - default (human): a compact table rendered by the generic renderer.
 *
 * Filter `--status` accepts a single category or a comma-separated list
 * (e.g. `--status stale,orphan`). Unknown categories are silently dropped
 * by the dispatch layer to keep the surface forward-compatible.
 *
 * @example
 * ```sh
 * cleo worktree list
 * cleo worktree list --status stale,orphan
 * cleo worktree list --json
 * cleo worktree list --days 14 --status stale
 * ```
 */
const listCommand = defineCommand({
  meta: {
    name: 'list',
    description:
      'List worktrees attached to this project with status classification ' +
      '(active|stale|merged|orphan|locked).',
  },
  args: {
    status: {
      type: 'string',
      description:
        'Filter by status category (single value or comma-separated list of ' +
        `${VALID_STATUS_VALUES.join('|')}).`,
    },
    days: {
      type: 'string',
      description: 'Staleness threshold in days for the isStale classifier (default: 7).',
    },
  },
  async run({ args }) {
    const statusFilter =
      typeof args['status'] === 'string' && args['status'].length > 0 ? args['status'] : undefined;
    const staleDaysRaw = typeof args['days'] === 'string' ? args['days'] : undefined;
    const staleDays = staleDaysRaw !== undefined ? Number.parseInt(staleDaysRaw, 10) : undefined;

    await dispatchFromCli(
      'query',
      'worktree',
      'list',
      {
        ...(statusFilter !== undefined ? { statusFilter } : {}),
        ...(staleDays !== undefined && !Number.isNaN(staleDays) ? { staleDays } : {}),
      },
      { command: 'worktree-list', operation: 'worktree.list' },
    );
  },
});

/**
 * Prompt the user with a Y/N question. Resolves to `true` when the answer
 * starts with `y` or `Y`; everything else (including empty input) maps to
 * `false`. Caller must guarantee stdin is a TTY before calling.
 *
 * @internal
 */
async function promptYesNo(question: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`${question} [y/N]: `, (answer: string) => {
      rl.close();
      const trimmed = answer.trim().toLowerCase();
      resolve(trimmed === 'y' || trimmed === 'yes');
    });
  });
}

/**
 * Render the "this worktree is an orphan candidate" preamble used by the
 * interactive prune prompt. Kept in a single place so the format matches the
 * T9547 spec (path / branch / status / last activity).
 *
 * @internal
 */
function renderOrphanPreamble(wt: WorktreeInfo): string {
  return [
    'Orphaned worktree found:',
    `  Path: ${wt.path}`,
    `  Branch: ${wt.branch}${wt.isMerged ? ' (merged to main)' : ''}`,
    `  Task status: ${wt.owningTaskStatus ?? '(missing)'}`,
    `  Last activity: ${wt.lastActivity}`,
    '',
  ].join('\n');
}

/**
 * `cleo worktree prune --orphaned` — detect + remove orphan/merged worktrees.
 *
 * Behaviour:
 *  - `--orphaned` (required today, future-proofs the surface for stale-only
 *    pruning) filters to the orphan + merged categories.
 *  - `--idle-days <N>` (T9805 AC2) additionally prunes worktrees whose last
 *    commit is older than N days and have no open PR associated.
 *  - When stdin is a TTY and `--yes` is NOT set, the command prints a
 *    preamble per orphan and reads a Y/N answer from the user. Only the
 *    confirmed subset is sent to dispatch.
 *  - When stdin is NOT a TTY (CI / pipe), the command requires either
 *    `--yes` or `--dry-run`; otherwise it errors out cleanly.
 *  - `--dry-run` prints the candidate set without acting and is always
 *    safe to run anywhere.
 *
 * Output: LAFS envelope from the dispatch layer, augmented with the
 * skipped count when the user said N to one or more orphans (the SDK
 * sees only the confirmed paths, so the CLI tallies skips itself).
 *
 * @example
 * ```sh
 * cleo worktree prune --orphaned --dry-run
 * cleo worktree prune --orphaned --yes
 * cleo worktree prune --orphaned
 * cleo worktree prune --orphaned --idle-days 7 --yes
 * ```
 */
const pruneCommand = defineCommand({
  meta: {
    name: 'prune',
    description: 'Remove orphan/merged worktrees with per-orphan Y/N confirmation.',
  },
  args: {
    orphaned: {
      type: 'boolean',
      description: 'Prune worktrees classified as orphan or merged (required).',
      default: false,
    },
    yes: {
      type: 'boolean',
      description: 'Skip per-orphan confirmation. Required on non-TTY (CI / pipe) input.',
      default: false,
    },
    'dry-run': {
      type: 'boolean',
      description: 'Show what would be pruned without acting. No audit-log entries written.',
      default: false,
    },
    days: {
      type: 'string',
      description: 'Override staleness threshold passed through to the listing (default: 7).',
    },
    'idle-days': {
      type: 'string',
      description:
        'Abandonment-timeout threshold in days (T9805 AC2). Worktrees whose last commit ' +
        'is older than this value AND have no open PR are also pruned.',
    },
  },
  async run({ args }) {
    if (args['orphaned'] !== true) {
      cliError(
        'cleo worktree prune requires --orphaned (other categories are reserved for future flags).',
        2,
      );
      process.exit(2);
      return;
    }

    const dryRun = args['dry-run'] === true;
    const yes = args['yes'] === true;
    const staleDaysRaw = typeof args['days'] === 'string' ? args['days'] : undefined;
    const staleDays = staleDaysRaw !== undefined ? Number.parseInt(staleDaysRaw, 10) : undefined;
    const idleDaysRaw = typeof args['idle-days'] === 'string' ? args['idle-days'] : undefined;
    const idleDays = idleDaysRaw !== undefined ? Number.parseInt(idleDaysRaw, 10) : undefined;

    // Enumerate candidates locally so we can render the per-orphan prompt.
    // Dispatch is invoked AFTER confirmation with the user-confirmed subset.
    const projectRoot = getProjectRoot();
    const listResult = await listWorktrees({
      projectRoot,
      ...(staleDays !== undefined && !Number.isNaN(staleDays) ? { staleDays } : {}),
    });
    if (!listResult.success) {
      cliError(`Failed to enumerate worktrees: ${listResult.error.message}`, 1);
      process.exit(1);
      return;
    }

    const candidates = listResult.data.worktrees.filter(
      (w) => w.statusCategory === 'orphan' || w.statusCategory === 'merged',
    );

    if (candidates.length === 0) {
      cliOutput(
        {
          prunedCount: 0,
          skippedCount: 0,
          outcomes: [],
          errors: [],
          dryRun,
          message: 'No orphan or merged worktrees found.',
        },
        { command: 'worktree-prune', operation: 'worktree.prune' },
      );
      return;
    }

    // Non-TTY gate: must have --yes or --dry-run to proceed unattended.
    const isTty = process.stdin.isTTY === true;
    if (!isTty && !yes && !dryRun) {
      cliError(
        'cleo worktree prune is interactive — re-run with --yes or --dry-run on non-TTY input.',
        2,
      );
      process.exit(2);
      return;
    }

    // Per-orphan confirmation loop. Skipped under --yes or --dry-run.
    let confirmedPaths: string[];
    let skippedByUser = 0;
    if (dryRun || yes) {
      confirmedPaths = candidates.map((w) => w.path);
    } else {
      confirmedPaths = [];
      for (const wt of candidates) {
        process.stdout.write(renderOrphanPreamble(wt));
        const accepted = await promptYesNo('Prune this worktree?');
        if (accepted) {
          confirmedPaths.push(wt.path);
        } else {
          skippedByUser += 1;
        }
      }
    }

    if (confirmedPaths.length === 0) {
      cliOutput(
        {
          prunedCount: 0,
          skippedCount: skippedByUser,
          outcomes: [],
          errors: [],
          dryRun,
          message:
            skippedByUser > 0 ? `Skipped ${skippedByUser} orphan(s) on user request.` : 'No-op.',
        },
        { command: 'worktree-prune', operation: 'worktree.prune' },
      );
      return;
    }

    await dispatchFromCli(
      'mutate',
      'worktree',
      'prune',
      {
        dryRun,
        paths: confirmedPaths,
        ...(staleDays !== undefined && !Number.isNaN(staleDays) ? { staleDays } : {}),
        ...(idleDays !== undefined && !Number.isNaN(idleDays) ? { idleDays } : {}),
      },
      { command: 'worktree-prune', operation: 'worktree.prune' },
    );
  },
});

/**
 * `cleo worktree destroy <taskId>` — explicitly destroy a single agent worktree.
 *
 * Tears down the XDG worktree for `task/<taskId>`, writes an audit-log entry,
 * and removes the entry from the sentinel index at `.cleo/worktrees.json`.
 *
 * Designed for use by the worktree-cleanup GitHub Actions workflow (T9805 AC1):
 *   cleo worktree destroy T9805 --reason pr-merged --json
 *
 * Also available for manual cleanup after task completion.
 *
 * @example
 * ```sh
 * cleo worktree destroy T9805
 * cleo worktree destroy T9805 --reason pr-merged --json
 * cleo worktree destroy T9805 --force
 * ```
 *
 * @task T9805
 */
const destroyCommand = defineCommand({
  meta: {
    name: 'destroy',
    description:
      'Destroy the XDG worktree for a task, update audit log and sentinel index (T9805).',
  },
  args: {
    taskId: {
      type: 'positional',
      description: 'The task ID whose worktree to destroy (e.g. T9805).',
      required: true,
    },
    force: {
      type: 'boolean',
      description: 'Force removal even when the worktree has uncommitted changes.',
      default: false,
    },
    reason: {
      type: 'string',
      description:
        'Reason string recorded in the audit log (e.g. pr-merged, manual, idle-timeout).',
    },
    'keep-branch': {
      type: 'boolean',
      description: 'Do not delete the task branch after removing the worktree.',
      default: false,
    },
  },
  async run({ args }) {
    const rawTaskId = typeof args['taskId'] === 'string' ? args['taskId'] : '';
    if (rawTaskId.length === 0) {
      cliError('Missing required positional: <taskId>.', 2);
      process.exit(2);
      return;
    }

    const reason =
      typeof args['reason'] === 'string' && args['reason'].length > 0 ? args['reason'] : 'manual';

    await dispatchFromCli(
      'mutate',
      'worktree',
      'destroy',
      {
        taskId: rawTaskId,
        force: args['force'] === true,
        deleteBranch: args['keep-branch'] !== true,
        reason,
      },
      { command: 'worktree-destroy', operation: 'worktree.destroy' },
    );
  },
});

/**
 * `cleo worktree force-unlock <taskId>` — clear wedged worktree locks.
 *
 * Resolves the worktree owned by `task/T<taskId>`, removes any stale
 * `.git/index.lock`, then runs `git worktree unlock` if porcelain reports
 * the worktree as locked. Uncommitted changes are detected and warned about
 * but NEVER deleted.
 *
 * Audit-logged to `.cleo/audit/worktree-lifecycle.jsonl`.
 *
 * @example
 * ```sh
 * cleo worktree force-unlock T9547
 * cleo worktree force-unlock T9547 --json
 * ```
 */
const forceUnlockCommand = defineCommand({
  meta: {
    name: 'force-unlock',
    description: 'Clear wedged lock state (.git/index.lock + git worktree unlock) for a task.',
  },
  args: {
    taskId: {
      type: 'positional',
      description: 'The task ID whose worktree should be force-unlocked (e.g. T9547).',
      required: true,
    },
  },
  async run({ args }) {
    const rawTaskId = typeof args['taskId'] === 'string' ? args['taskId'] : '';
    if (rawTaskId.length === 0) {
      cliError('Missing required positional: <taskId>.', 2);
      process.exit(2);
      return;
    }

    await dispatchFromCli(
      'mutate',
      'worktree',
      'forceUnlock',
      { taskId: rawTaskId },
      { command: 'worktree-force-unlock', operation: 'worktree.forceUnlock' },
    );
  },
});

/** Recognised `--source` values for the adopt subcommand. */
const VALID_ADOPT_SOURCES = ['claude-agent', 'manual', 'adopted'] as const;

/**
 * `cleo worktree adopt <path>` — register an externally-created worktree in
 * the CLEO SSoT (T9804 — Claude Code Agent isolation:worktree bridge).
 *
 * This command is the CLI surface for Option B (Adopt) — the only feasible
 * approach since CLEO cannot modify the Claude Code Agent harness directly.
 * After adoption the worktree surfaces in `cleo worktree list` tagged with
 * `source: claude-agent` and inherits the same auto-cleanup lifecycle as
 * canonical CLEO-spawned worktrees.
 *
 * @example
 * ```sh
 * cleo worktree adopt .claude/worktrees/session-abc
 *   cleo worktree adopt .claude/worktrees/session-abc --source claude-agent
 *   cleo worktree adopt /tmp/my-manual-worktree --source manual --task-id T9804
 *   cleo worktree adopt .claude/worktrees/session-abc --recover
 *   cleo worktree adopt .claude/worktrees/session-abc --json
 * ```
 *
 * @task T9804
 * @saga T9800
 */
const adoptCommand = defineCommand({
  meta: {
    name: 'adopt',
    description:
      'Register an externally-created worktree (e.g. Claude Code Agent isolation:worktree) ' +
      'in the CLEO SSoT so it surfaces in `cleo worktree list`.',
  },
  args: {
    path: {
      type: 'positional',
      description:
        'Absolute or relative path to the worktree directory to adopt. ' +
        'For Claude Code Agent worktrees this is typically `.claude/worktrees/<sessionId>/`.',
      required: true,
    },
    source: {
      type: 'string',
      description:
        `Source classification for this worktree (${VALID_ADOPT_SOURCES.join('|')}). ` +
        'Defaults to `claude-agent` for paths under `.claude/worktrees/`, else `manual`.',
    },
    'task-id': {
      type: 'string',
      description:
        'Optional task ID to associate with this worktree. ' +
        'When omitted the command attempts to extract it from the branch name.',
    },
    actor: {
      type: 'string',
      description: 'Override actor name written to the audit log.',
    },
    recover: {
      type: 'boolean',
      description:
        'After adopting, recover a partial ETIMEDOUT worktree by running pnpm install and clearing stale git locks.',
      default: false,
    },
  },
  async run({ args }) {
    const rawPath = typeof args['path'] === 'string' ? args['path'] : '';
    if (rawPath.length === 0) {
      cliError('Missing required positional: <path>.', 2);
      process.exit(2);
      return;
    }

    const rawSource = typeof args['source'] === 'string' ? args['source'] : undefined;
    const source =
      rawSource !== undefined && (VALID_ADOPT_SOURCES as readonly string[]).includes(rawSource)
        ? (rawSource as (typeof VALID_ADOPT_SOURCES)[number])
        : undefined;

    const rawTaskId = typeof args['task-id'] === 'string' ? args['task-id'] : undefined;
    const rawActor = typeof args['actor'] === 'string' ? args['actor'] : undefined;

    await dispatchFromCli(
      'mutate',
      'worktree',
      'adopt',
      {
        worktreePath: rawPath,
        ...(source !== undefined ? { source } : {}),
        ...(rawTaskId !== undefined ? { taskId: rawTaskId } : {}),
        ...(rawActor !== undefined ? { actor: rawActor } : {}),
        recover: args['recover'] === true,
      },
      { command: 'worktree-adopt', operation: 'worktree.adopt' },
    );
  },
});

/**
 * Root `cleo worktree` command group — read-only listing plus T9547
 * lifecycle mutations (prune + force-unlock) and T9804 adopt.
 *
 * @task T9546
 * @task T9547
 * @task T9804
 */
export const worktreeCommand = defineCommand({
  meta: {
    name: 'worktree',
    description:
      'Inspect and manage CLEO-attached git worktrees. ' +
      'See `cleo worktree <subcommand> --help` for details.',
  },
  subCommands: {
    list: listCommand,
    adopt: adoptCommand,
    prune: pruneCommand,
    destroy: destroyCommand,
    'force-unlock': forceUnlockCommand,
  },
  // Early-return when a subcommand was matched; citty still invokes the
  // parent run() after the subcommand finishes which would otherwise
  // append the help text to the subcommand's JSON envelope output
  // (T9686-A bug A4).
  async run({ cmd, rawArgs }) {
    const firstArg = rawArgs?.find((a) => !a.startsWith('-'));
    if (firstArg && cmd.subCommands && firstArg in cmd.subCommands) return;
    await showUsage(cmd as Parameters<typeof showUsage>[0]);
  },
});
