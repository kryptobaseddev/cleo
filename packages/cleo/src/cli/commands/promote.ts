/**
 * CLI promote command — remove parent from task, making it root-level.
 *
 * Routes to `tasks.reparent` with `newParentId: null` (the canonical way to
 * promote a task since T5615 rationalization removed `tasks.promote`).
 *
 * @task T4454
 */

import { defineCommand } from 'citty';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

/**
 * cleo promote <task-id> — remove parent from task, making it root-level.
 */
export const promoteCommand = defineCommand({
  meta: { name: 'promote', description: 'Remove parent from task, making it root-level' },
  args: {
    taskId: {
      type: 'positional',
      description: 'Task ID to promote to root level',
      required: true,
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'mutate',
      'tasks',
      'reparent',
      { taskId: args.taskId, newParentId: null },
      { command: 'promote' },
    );
  },
});
