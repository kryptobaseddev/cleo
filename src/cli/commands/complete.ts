/**
 * CLI complete command.
 * @task T4461
 * @epic T4454
 */

import { Command } from 'commander';
import { getAccessor } from '../../store/data-accessor.js';
import { completeTask } from '../../core/tasks/complete.js';
import { formatSuccess, formatError } from '../../core/output.js';
import { CleoError } from '../../core/errors.js';

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
      try {
        const accessor = await getAccessor();
        const result = await completeTask({
          taskId,
          notes: opts['notes'] as string | undefined,
          changeset: opts['changeset'] as string | undefined,
        }, undefined, accessor);

        const data: Record<string, unknown> = { task: result.task };
        if (result.autoCompleted?.length) {
          data['autoCompleted'] = result.autoCompleted;
        }

        console.log(formatSuccess(data));
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });
}
