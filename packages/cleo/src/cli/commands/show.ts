/**
 * CLI show command.
 * @task T4460
 * @task T864
 * @epic T4454
 */

import { defineCommand } from 'citty';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';
import { getOperationParams, paramsToCittyArgs } from '../lib/registry-args.js';

/**
 * Native citty command for `cleo show` — retrieves full task details by ID,
 * including metadata, verification, and lifecycle information.
 *
 * Args are derived from the registry via `paramsToCittyArgs` so that the
 * CLI surface stays in sync with `tasks.show` params[] (T864 SSoT).
 *
 * @task T4460
 * @task T4666
 * @task T787
 * @task T864
 * @epic T487
 */
export const showCommand = defineCommand({
  meta: {
    name: 'show',
    description:
      'Show full task details by ID (returns complete task record with metadata, verification, lifecycle)',
  },
  args: paramsToCittyArgs(getOperationParams('query', 'tasks', 'show')),
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'tasks',
      'show',
      {
        taskId: args['taskId'] as string,
        history: args['history'] === true,
        ivtrHistory: args['ivtr-history'] === true,
      },
      { command: 'show' },
    );
  },
});
