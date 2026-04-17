/**
 * CLI next command - suggest next task to work on.
 *
 * Delegates scoring algorithm to core/tasks/task-ops.coreTaskNext.
 *
 * @task T4454
 * @task T4795
 * @task T487
 */

import { defineCommand } from 'citty';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

/**
 * cleo next — suggest the next task to work on based on priority and dependencies.
 *
 * Dispatches to `tasks.next` via the query gateway.
 */
export const nextCommand = defineCommand({
  meta: {
    name: 'next',
    description: 'Suggest next task to work on based on priority and dependencies',
  },
  args: {
    explain: {
      type: 'boolean',
      description: 'Show detailed reasoning for suggestion',
    },
    count: {
      type: 'string',
      description: 'Show top N suggestions',
      alias: 'n',
      default: '1',
    },
  },
  async run({ args }) {
    const count = Number.parseInt(args.count, 10) || 1;
    const explain = !!args.explain;
    await dispatchFromCli('query', 'tasks', 'next', { count, explain }, { command: 'next' });
  },
});
