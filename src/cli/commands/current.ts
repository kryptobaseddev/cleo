/**
 * CLI current command - show the current task being worked on.
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
 * Register the current command.
 * @task T4756
 * @task T4666
 */
export function registerCurrentCommand(program: Command): void {
  program
    .command('current')
    .description('Show the current task being worked on')
    .action(async () => {
      try {
        const accessor = await getAccessor();
        const result = await taskWork.currentTask(undefined, accessor);
        cliOutput(result, { command: 'current', operation: 'tasks.current' });
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });
}
