/**
 * CLI complete command.
 * @task T4461
 * @epic T4454
 */

import { Command } from 'commander';
import { dispatchRaw, handleRawError } from '../../dispatch/adapters/cli.js';
import { cliOutput } from '../renderers/index.js';

/**
 * Register the complete command.
 * @task T4461
 */
export function registerCompleteCommand(program: Command): void {
  program
    .command('complete <taskId>')
    .alias('done')
    .description('Mark a task as completed')
    .option('--notes <note>', 'Completion notes')
    .option('--changeset <changeset>', 'Changeset reference')
    .action(async (taskId: string, opts: Record<string, unknown>) => {
      const response = await dispatchRaw('mutate', 'tasks', 'complete', {
        taskId,
        notes: opts['notes'] as string | undefined,
        changeset: opts['changeset'] as string | undefined,
      });

      if (!response.success) {
        handleRawError(response, { command: 'complete', operation: 'tasks.complete' });
      }

      const data = response.data as Record<string, unknown>;
      // Engine may return {task: {...}} or the task record directly
      const task = data?.task ?? data;
      const output: Record<string, unknown> = { task };
      if ((data?.autoCompleted as unknown[] | undefined)?.length) {
        output['autoCompleted'] = data['autoCompleted'];
      }

      cliOutput(output, { command: 'complete', operation: 'tasks.complete' });
    });
}
