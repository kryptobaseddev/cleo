/**
 * CLI delete command — soft-delete a task to archive.
 *
 * Dispatches to the `tasks.delete` registry operation.
 *
 * @task T4461
 * @epic T4454
 */

import { defineCommand } from 'citty';
import { dispatchRaw, handleRawError } from '../../dispatch/adapters/cli.js';
import { cliOutput } from '../renderers/index.js';

/**
 * Delete command — soft-deletes the given task (archives it).
 *
 * Root alias `rm` is wired in index.ts.
 */
export const deleteCommand = defineCommand({
  meta: {
    name: 'delete',
    description: 'Delete a task (soft delete to archive)',
  },
  args: {
    taskId: {
      type: 'positional',
      description: 'ID of the task to delete',
      required: true,
    },
    force: {
      type: 'boolean',
      description: 'Force delete even with dependents or children',
    },
    cascade: {
      type: 'boolean',
      description: 'Delete children recursively',
    },
  },
  async run({ args }) {
    const response = await dispatchRaw('mutate', 'tasks', 'delete', {
      taskId: args.taskId,
      force: args.force as boolean | undefined,
      cascade: args.cascade as boolean | undefined,
    });

    if (!response.success) {
      handleRawError(response, { command: 'delete', operation: 'tasks.delete' });
    }

    const data = response.data as Record<string, unknown> | undefined;
    const output: Record<string, unknown> = { deletedTask: data?.deletedTask };
    const cascadeDeleted = data?.cascadeDeleted;
    if (Array.isArray(cascadeDeleted) && cascadeDeleted.length > 0) {
      output['cascadeDeleted'] = cascadeDeleted;
    }

    cliOutput(output, { command: 'delete', operation: 'tasks.delete' });
  },
});
