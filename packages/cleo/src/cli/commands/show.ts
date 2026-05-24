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
      'Show task details by ID. MVI-projected (id + title + status + key metadata) by default; pass --verbose / --full to receive the complete record with description, acceptance, verification, evidence, etc. (T9922)',
  },
  args: {
    ...paramsToCittyArgs(getOperationParams('query', 'tasks', 'show')),
    // T9922 — MVI record projection opt-out flags. The global parser in
    // cli/index.ts reads these too; the declarations here surface them in
    // `cleo show --help` and document the contract for agents.
    verbose: {
      type: 'boolean',
      description:
        'Return the full task record (description, acceptance, verification, evidence) instead of the MVI projection. T9922.',
    },
    full: {
      type: 'boolean',
      description: 'Alias for --verbose. T9922.',
    },
  },
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
