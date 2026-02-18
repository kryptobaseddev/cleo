/**
 * CLI show command.
 * @task T4460
 * @epic T4454
 */

import { Command } from 'commander';
import { getAccessor } from '../../store/data-accessor.js';
import { showTask } from '../../core/tasks/show.js';
import { formatSuccess, formatError } from '../../core/output.js';
import { CleoError } from '../../core/errors.js';

/**
 * Register the show command.
 * @task T4460
 */
export function registerShowCommand(program: Command): void {
  program
    .command('show <taskId>')
    .description('Show full task details by ID')
    .action(async (taskId: string) => {
      try {
        const accessor = await getAccessor();
        const detail = await showTask(taskId, undefined, accessor);
        console.log(formatSuccess({ task: detail }));
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });
}
