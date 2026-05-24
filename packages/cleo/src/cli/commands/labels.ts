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
 * Behaviour matrix:
 *   - `cleo labels`             → list all labels with counts (label.list)
 *   - `cleo labels <name>`      → list tasks carrying that label (tasks.list)
 *   - `cleo labels list`        → explicit alias for label.list
 *   - `cleo labels show <name>` → explicit alias for the positional form
 *   - `cleo labels stats`       → label statistics
 *
 * The positional `name` arg closes GH#393 (T9904) — `cleo labels <name>`
 * used to be rejected because the root command had no positional arg.
 * `cleo find --label <name>` is the parallel alternative wired in the
 * same task.
 *
 * The `tags` alias is registered separately in index.ts.
 *
 * @task T9904 — GH#393 cleo labels <name> rejected positional
 */
export const labelsCommand = defineCommand({
  meta: {
    name: 'labels',
    description: 'List all labels (no args), or show tasks for a label (cleo labels <name>)',
  },
  args: {
    // Optional positional — when present, dispatches to tasks.list with the
    // label filter; when absent, falls through to the legacy label.list path.
    // Required:false keeps the bare `cleo labels` invocation working.
    name: {
      type: 'positional',
      description: 'Label name to filter tasks by (omit to list all labels)',
      required: false,
    },
  },
  subCommands: {
    list: listCommand,
    show: showCommand,
    stats: statsCommand,
  },
  async run(ctx) {
    const rawArgs = ctx.rawArgs ?? [];
    // If a subcommand was invoked, citty will dispatch to it — bail out.
    if (rawArgs.some((a) => ['list', 'show', 'stats'].includes(a))) {
      return;
    }
    // T9904 — positional `name`: route to tasks.list with label filter.
    // citty surfaces the positional under `args.name`. When absent the
    // user wants the original "list all labels" behaviour.
    const name = (ctx.args as { name?: string }).name;
    if (typeof name === 'string' && name.length > 0) {
      await dispatchFromCli('query', 'tasks', 'list', { label: name }, { command: 'labels' });
      return;
    }
    // Default: invoke list when no subcommand AND no positional was given
    await dispatchFromCli('query', 'tasks', 'label.list', {}, { command: 'labels' });
  },
});
