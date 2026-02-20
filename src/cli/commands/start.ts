/**
 * CLI start command - start working on a task.
 * @task T4756
 * @epic T4732
 */

import { Command } from 'commander';
import { getAccessor } from '../../store/data-accessor.js';
import * as taskWork from '../../core/task-work/index.js';
import { formatError } from '../../core/output.js';
import { CleoError } from '../../core/errors.js';
import { cliOutput } from '../renderers/index.js';

/**
 * Register the start command.
 * @task T4756
 * @task T4666
 */
export function registerStartCommand(program: Command): void {
  program
    .command('start <taskId>')
    .description('Start working on a task')
    .action(async (taskId: string) => {
      try {
        const accessor = await getAccessor();
        const result = await taskWork.startTask(taskId, undefined, accessor);
        cliOutput(result, { command: 'start', operation: 'tasks.start' });
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });
}
