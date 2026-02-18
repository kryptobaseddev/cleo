/**
 * CLI delete command.
 * @task T4461
 * @epic T4454
 */

import { Command } from 'commander';
import { getAccessor } from '../../store/data-accessor.js';
import { deleteTask } from '../../core/tasks/delete.js';
import { formatSuccess, formatError } from '../../core/output.js';
import { CleoError } from '../../core/errors.js';

/**
 * Register the delete command.
 * @task T4461
 */
export function registerDeleteCommand(program: Command): void {
  program
    .command('delete <taskId>')
    .alias('rm')
    .description('Delete a task (soft delete to archive)')
    .option('--force', 'Force delete even with dependents or children')
    .option('--cascade', 'Delete children recursively')
    .action(async (taskId: string, opts: Record<string, unknown>) => {
      try {
        const accessor = await getAccessor();
        const result = await deleteTask({
          taskId,
          force: opts['force'] as boolean | undefined,
          cascade: opts['cascade'] as boolean | undefined,
        }, undefined, accessor);

        const data: Record<string, unknown> = { deletedTask: result.deletedTask };
        if (result.cascadeDeleted?.length) {
          data['cascadeDeleted'] = result.cascadeDeleted;
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
