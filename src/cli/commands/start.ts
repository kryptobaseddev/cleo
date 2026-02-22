/**
 * CLI start command - start working on a task.
 * @task T4756
 * @epic T4732
 */

import { Command } from 'commander';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

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
      await dispatchFromCli('mutate', 'tasks', 'start', { taskId }, { command: 'start' });
    });
}
