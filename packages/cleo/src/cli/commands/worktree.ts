/**
 * CLI worktree command group — structured worktree enumeration (T9546).
 *
 * Thin CLI wrapper delegating to the worktree dispatch domain. Implements the
 * 2-of-5 step of the T9515 worktree-lifecycle bug fix epic: every CLEO-managed
 * worktree is enumerated with a single mutually-exclusive `statusCategory`
 * (`active|stale|merged|orphan|locked`) plus orphan-detection heuristics.
 *
 * Commands:
 *   cleo worktree list [--status <category>] [--json] [--days <n>]
 *     — list every worktree attached to the current project with status
 *       classification.
 *
 * Dispatch equivalent:
 *   query({ domain: 'worktree', operation: 'list', params: { statusFilter?, staleDays? } })
 *
 * @task T9546
 * @epic T9515
 */

import { defineCommand, showUsage } from 'citty';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

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
 * Root `cleo worktree` command group.
 *
 * Today only the read-only `list` subcommand is wired — prune and force-unlock
 * mutations are tracked under T9547 (worktree-lifecycle 3/5).
 *
 * @task T9546
 */
export const worktreeCommand = defineCommand({
  meta: {
    name: 'worktree',
    description:
      'Inspect CLEO-managed git worktrees attached to this project. ' +
      'See `cleo worktree list --help` for status classification details.',
  },
  subCommands: {
    list: listCommand,
  },
  async run() {
    await showUsage(worktreeCommand as Parameters<typeof showUsage>[0]);
  },
});
