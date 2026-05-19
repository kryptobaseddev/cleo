/**
 * CLI worktree command group — structured worktree enumeration + lifecycle
 * mutations (T9546, T9547).
 *
 * Thin CLI wrapper delegating to the worktree dispatch domain. Implements
 * the read-only listing (T9546) plus the lifecycle mutations (T9547) for
 * the T9515 worktree-lifecycle bug-fix epic.
 *
 * Commands:
 *   cleo worktree list [--status <category>] [--json] [--days <n>]
 *     — list every worktree attached to the current project with status
 *       classification.
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
 *   mutate({ domain: 'worktree', operation: 'prune', params: { dryRun?, paths?, actor? } })
 *   mutate({ domain: 'worktree', operation: 'forceUnlock', params: { taskId, actor? } })
 *
 * @task T9546
 * @task T9547
 * @epic T9515
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
      },
      { command: 'worktree-prune', operation: 'worktree.prune' },
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

/**
 * Root `cleo worktree` command group — read-only listing plus T9547
 * lifecycle mutations (prune + force-unlock).
 *
 * @task T9546
 * @task T9547
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
    prune: pruneCommand,
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
