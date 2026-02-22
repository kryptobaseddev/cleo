/**
 * CLI current command - show the current task being worked on.
 * @task T4756
 * @epic T4732
 */

import { Command } from 'commander';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

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
      await dispatchFromCli('query', 'tasks', 'current', {}, { command: 'current' });
    });
}
