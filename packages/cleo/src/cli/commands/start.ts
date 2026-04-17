/**
 * CLI start command - start working on a task.
 * @task T4756
 * @epic T4732
 */

import { defineCommand } from 'citty';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

/**
 * Native citty command for `cleo start` — sets a task as the current active
 * task in the active session.
 *
 * @task T4756
 * @task T4666
 * @epic T487
 */
export const startCommand = defineCommand({
  meta: {
    name: 'start',
    description: 'Start working on a task (sets it as the current task in the active session)',
  },
  args: {
    taskId: {
      type: 'positional',
      description: 'ID of the task to start',
      required: true,
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'mutate',
      'tasks',
      'start',
      { taskId: args.taskId },
      { command: 'start' },
    );
  },
});
