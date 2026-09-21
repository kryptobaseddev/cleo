/**
 * CLI decompose command — turn a leaf task into a container.
 *
 * Dispatches to the `tasks.decompose` registry operation, which moves the
 * task's free-text acceptance criteria onto a new first child so PM-Core V2
 * design-point 3 ("a task is a leaf defined by its text ACs OR a container
 * defined by its children, never both") is satisfied without the caller having
 * to perform the move by hand.
 *
 * @task T12281
 */

import { dispatchRaw, handleRawError } from '../../dispatch/adapters/cli.js';
import { defineCommand } from '../lib/define-cli-command.js';
import { cliOutput } from '../renderers/index.js';

/**
 * Decompose command — lifts a task's text acceptance criteria onto a new child.
 */
export const decomposeCommand = defineCommand({
  meta: {
    name: 'decompose',
    description: "Move a task's text acceptance criteria onto a new child so it can hold subtasks",
  },
  args: {
    taskId: {
      type: 'positional',
      description: 'ID of the task to decompose',
      required: true,
    },
    'child-title': {
      type: 'string',
      description: "Title for the child that inherits the criteria (default: the parent's)",
    },
    'child-description': {
      type: 'string',
      description: "Description for the child (default: the parent's)",
    },
    'dry-run': {
      type: 'boolean',
      description: 'Preview the move without writing',
    },
  },
  async run({ args }) {
    const response = await dispatchRaw('mutate', 'tasks', 'decompose', {
      taskId: args.taskId,
      childTitle: args['child-title'] as string | undefined,
      childDescription: args['child-description'] as string | undefined,
      dryRun: args['dry-run'] as boolean | undefined,
    });

    if (!response.success) {
      handleRawError(response, { command: 'decompose', operation: 'tasks.decompose' });
    }

    cliOutput(response.data as Record<string, unknown>, {
      command: 'decompose',
      operation: 'tasks.decompose',
    });
  },
});
