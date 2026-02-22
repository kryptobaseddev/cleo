/**
 * CLI show command.
 * @task T4460
 * @epic T4454
 */

import { Command } from 'commander';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

/**
 * Register the show command.
 * @task T4460
 * @task T4666
 */
export function registerShowCommand(program: Command): void {
  program
    .command('show <taskId>')
    .description('Show full task details by ID')
    .action(async (taskId: string) => {
      await dispatchFromCli('query', 'tasks', 'show', { taskId }, { command: 'show' });
    });
}
