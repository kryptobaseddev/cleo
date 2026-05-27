/**
 * CLI reparent command - move a task to a different parent.
 * Delegates to src/core/tasks/reparent.ts (canonical implementation).
 *
 * @task T4807
 * @epic T4454
 */

import { defineCommand } from 'citty';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

/**
 * Native citty command for `cleo reparent` — moves a task to a different parent
 * in the task hierarchy, or makes it root-level when `--to ""` is passed.
 *
 * @task T4807
 * @epic T487
 */
export const reparentCommand = defineCommand({
  meta: { name: 'reparent', description: 'Move task to a different parent in hierarchy' },
  args: {
    taskId: {
      type: 'positional',
      description: 'ID of the task to reparent',
      required: true,
    },
    to: {
      type: 'string',
      description: 'Target parent task ID (or "" to make root)',
      required: true,
    },
  },
  async run({ args }) {
    const newParentId = args.to || null;
    await dispatchFromCli(
      'mutate',
      'tasks',
      'reparent',
      { taskId: args.taskId, newParentId },
      { command: 'reparent' },
    );
  },
});
