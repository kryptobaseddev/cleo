/**
 * CLI cancel command — soft-cancel a task (reversible via tasks.restore).
 *
 * Dispatches to `tasks.cancel` (mutate). The cancelled state is a soft
 * terminal state — tasks can be un-cancelled via `cleo restore task <id>`.
 *
 * @task T473
 * @epic T443
 */

import { defineCommand } from 'citty';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

/**
 * cleo cancel <taskId> — cancel a task (soft terminal state; reversible via restore).
 *
 * Dispatches to the `tasks.cancel` registry operation.
 */
export const cancelCommand = defineCommand({
  meta: {
    name: 'cancel',
    description: 'Cancel a task (soft terminal state; reversible via restore)',
  },
  args: {
    taskId: {
      type: 'positional',
      description: 'Task ID to cancel',
      required: true,
    },
    reason: {
      type: 'string',
      description: 'Reason for cancellation',
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'mutate',
      'tasks',
      'cancel',
      {
        taskId: args.taskId,
        reason: args.reason as string | undefined,
      },
      { command: 'cancel', operation: 'tasks.cancel' },
    );
  },
});
