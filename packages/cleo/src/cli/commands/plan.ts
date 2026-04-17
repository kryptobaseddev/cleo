/**
 * CLI plan command - composite planning view.
 *
 * Renders a task prioritization view: in-progress epics, ready tasks, blocked
 * tasks, and open bugs with scoring. Use when deciding what to work on next.
 *
 * @task T4914
 * @epic T4454
 * @task T487
 */

import { defineCommand } from 'citty';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

/**
 * cleo plan — task prioritization view with scoring.
 *
 * Dispatches to `tasks.plan` via the query gateway.
 */
export const planCommand = defineCommand({
  meta: {
    name: 'plan',
    description:
      'Task prioritization view: in-progress epics, ready tasks, blocked tasks, open bugs with scoring. Use when deciding what to work on next.',
  },
  async run() {
    await dispatchFromCli(
      'query',
      'tasks',
      'plan',
      {},
      { command: 'plan', operation: 'tasks.plan' },
    );
  },
});
