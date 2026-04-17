/**
 * CLI complete command — mark a task as completed.
 *
 * Dispatches to the `tasks.complete` registry operation.
 *
 * @task T4461
 * @epic T4454
 */

import { defineCommand } from 'citty';
import { dispatchRaw, handleRawError } from '../../dispatch/adapters/cli.js';
import { cliOutput } from '../renderers/index.js';

/**
 * Complete command — marks the given task as done.
 *
 * Root alias `done` is wired in index.ts.
 */
export const completeCommand = defineCommand({
  meta: {
    name: 'complete',
    description: 'Mark a task as completed (requires active session)',
  },
  args: {
    taskId: {
      type: 'positional',
      description: 'ID of the task to complete',
      required: true,
    },
    notes: {
      type: 'string',
      description: 'Completion notes',
    },
    changeset: {
      type: 'string',
      description: 'Changeset reference',
    },
    force: {
      type: 'boolean',
      description: 'Force completion even when children are not done or dependencies unresolved',
    },
    'verification-note': {
      type: 'string',
      description: 'Evidence that acceptance criteria were met',
    },
  },
  async run({ args }) {
    const response = await dispatchRaw('mutate', 'tasks', 'complete', {
      taskId: args.taskId,
      notes: args.notes as string | undefined,
      changeset: args.changeset as string | undefined,
      force: args.force as boolean | undefined,
      verificationNote: args['verification-note'] as string | undefined,
    });

    if (!response.success) {
      handleRawError(response, { command: 'complete', operation: 'tasks.complete' });
    }

    const data = response.data as Record<string, unknown> | undefined;
    // Engine may return {task: {...}} or the task record directly
    const task = data?.task ?? data;
    const output: Record<string, unknown> = { task };
    const autoCompleted = data?.autoCompleted;
    if (Array.isArray(autoCompleted) && autoCompleted.length > 0) {
      output['autoCompleted'] = autoCompleted;
    }
    const unblockedTasks = data?.unblockedTasks;
    if (Array.isArray(unblockedTasks) && unblockedTasks.length > 0) {
      output['unblockedTasks'] = unblockedTasks;
    }

    cliOutput(output, { command: 'complete', operation: 'tasks.complete' });
  },
});
