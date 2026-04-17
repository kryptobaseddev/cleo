/**
 * CLI show command.
 * @task T4460
 * @epic T4454
 */

import { defineCommand } from 'citty';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

/**
 * Native citty command for `cleo show` — retrieves full task details by ID,
 * including metadata, verification, and lifecycle information.
 *
 * @task T4460
 * @task T4666
 * @task T787
 * @epic T487
 */
export const showCommand = defineCommand({
  meta: {
    name: 'show',
    description:
      'Show full task details by ID (returns complete task record with metadata, verification, lifecycle)',
  },
  args: {
    taskId: {
      type: 'positional',
      description: 'ID of the task to retrieve',
      required: true,
    },
    history: {
      type: 'boolean',
      description: 'Include lifecycle stage history in the response',
    },
    'ivtr-history': {
      type: 'boolean',
      description: 'Include IVTR phase chain history in the response',
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'tasks',
      'show',
      {
        taskId: args.taskId,
        history: args.history === true,
        ivtrHistory: args['ivtr-history'] === true,
      },
      { command: 'show' },
    );
  },
});
