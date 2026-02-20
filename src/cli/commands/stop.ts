/**
 * CLI stop command - stop working on the current task.
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
 * Register the stop command.
 * @task T4756
 * @task T4666
 */
export function registerStopCommand(program: Command): void {
  program
    .command('stop')
    .description('Stop working on the current task')
    .action(async () => {
      try {
        const accessor = await getAccessor();
        const result = await taskWork.stopTask(undefined, accessor);
        cliOutput(result, { command: 'stop', operation: 'tasks.stop' });
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });
}
