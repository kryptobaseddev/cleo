/**
 * CLI blockers command — show blocked tasks and analyze blocking chains.
 *
 * Dispatches to `tasks.blockers` (query) to display tasks that are blocked
 * and optionally produce a full blocking chain analysis.
 *
 * @task T4454
 */

import { defineCommand } from 'citty';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

/**
 * cleo blockers — show blocked tasks and analyze blocking chains.
 *
 * Dispatches to the `tasks.blockers` registry operation.
 */
export const blockersCommand = defineCommand({
  meta: {
    name: 'blockers',
    description: 'Show blocked tasks and analyze blocking chains',
  },
  args: {
    analyze: {
      type: 'boolean',
      description: 'Show full blocking chain analysis',
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'tasks',
      'blockers',
      { analyze: !!args.analyze },
      { command: 'blockers' },
    );
  },
});
