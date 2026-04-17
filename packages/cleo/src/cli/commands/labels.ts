/**
 * CLI command group for label management.
 *
 * Routes through dispatch layer to tasks.label.list.
 *
 * Note: `tasks.label.show` was removed in T5615 rationalization.
 * Use `tasks.label.list` with a `{label}` filter param instead.
 *
 * The `tags` alias is wired in index.ts — this file exports only `labelsCommand`.
 *
 * @task T4538
 * @epic T4454
 */

import { defineCommand } from 'citty';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

/** cleo labels list — list all labels with task counts (default) */
const listCommand = defineCommand({
  meta: { name: 'list', description: 'List all labels with task counts (default)' },
  async run() {
    await dispatchFromCli('query', 'tasks', 'label.list', {}, { command: 'labels' });
  },
});

/** cleo labels show <label> — show tasks with a specific label */
const showCommand = defineCommand({
  meta: { name: 'show', description: 'Show tasks with specific label' },
  args: {
    label: { type: 'positional', description: 'Label name to filter by', required: true },
  },
  async run({ args }) {
    await dispatchFromCli('query', 'tasks', 'list', { label: args.label }, { command: 'labels' });
  },
});

/** cleo labels stats — show detailed label statistics */
const statsCommand = defineCommand({
  meta: { name: 'stats', description: 'Show detailed label statistics' },
  async run() {
    // stats is essentially label.list with additional computed fields
    // For now, route through label.list since it provides the same base data
    await dispatchFromCli('query', 'tasks', 'label.list', {}, { command: 'labels' });
  },
});

/**
 * Root labels command group — list and filter tasks by label.
 *
 * Defaults to `list` when no subcommand is given.
 * The `tags` alias is registered separately in index.ts.
 */
export const labelsCommand = defineCommand({
  meta: {
    name: 'labels',
    description: 'List all labels with counts or show tasks with specific label',
  },
  subCommands: {
    list: listCommand,
    show: showCommand,
    stats: statsCommand,
  },
  async run(ctx) {
    // Default: invoke list when no subcommand provided
    if (!ctx.rawArgs.some((a) => ['list', 'show', 'stats'].includes(a))) {
      await dispatchFromCli('query', 'tasks', 'label.list', {}, { command: 'labels' });
    }
  },
});
