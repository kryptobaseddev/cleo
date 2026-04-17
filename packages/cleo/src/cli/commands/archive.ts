/**
 * CLI command: cleo archive
 *
 * Archives completed (and optionally cancelled) tasks, either by date range
 * or by explicit task ID list.
 *
 * Usage:
 *   cleo archive                        -- archive all completed tasks
 *   cleo archive --before 2026-01-01    -- archive tasks completed before date
 *   cleo archive --tasks T001,T002      -- archive specific tasks
 *   cleo archive --no-cancelled         -- exclude cancelled tasks
 *   cleo archive --dry-run              -- preview without modifying
 *
 * @task T4461
 * @epic T4454
 */

import { defineCommand } from 'citty';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

/**
 * Native citty command for `cleo archive`.
 *
 * Dispatches to `tasks.archive` via dispatchFromCli.
 */
export const archiveCommand = defineCommand({
  meta: { name: 'archive', description: 'Archive completed tasks' },
  args: {
    before: {
      type: 'string',
      description: 'Archive tasks completed before date (ISO format)',
    },
    tasks: {
      type: 'string',
      description: 'Specific task IDs to archive (comma-separated)',
    },
    cancelled: {
      type: 'boolean',
      description: 'Include cancelled tasks (use --no-cancelled to exclude)',
      default: true,
    },
    'dry-run': {
      type: 'boolean',
      description: 'Show what would be archived without making changes',
      default: false,
    },
  },
  async run({ args }) {
    const params: Record<string, unknown> = {};

    if (args.before !== undefined) params['before'] = args.before;
    if (args.tasks) params['taskIds'] = args.tasks.split(',').map((s) => s.trim());
    if (args.cancelled === false) params['includeCancelled'] = false;
    if (args['dry-run']) params['dryRun'] = args['dry-run'];

    await dispatchFromCli('mutate', 'tasks', 'archive', params, { command: 'archive' });
  },
});
