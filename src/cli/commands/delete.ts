/**
 * CLI delete command.
 * @task T4461
 * @epic T4454
 */

import { Command } from 'commander';
import { getStore } from '../../store/index.js';
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
        const store = await getStore();
        const result = await store.richDeleteTask({
          taskId,
          force: opts['force'] as boolean | undefined,
          cascade: opts['cascade'] as boolean | undefined,
        });

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
