/**
 * CLI stop command - stop working on the current task.
 * @task T4756
 * @epic T4732
 */

import { Command } from 'commander';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

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
      await dispatchFromCli('mutate', 'tasks', 'stop', {}, { command: 'stop' });
    });
}
