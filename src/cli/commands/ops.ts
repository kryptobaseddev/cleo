/**
 * CLI ops command -- progressive disclosure for operations.
 * @task T4362
 */

import { Command } from 'commander';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

/**
 * Register the ops command.
 */
export function registerOpsCommand(program: Command): void {
  program
    .command('ops')
    .description('Show available operations filtered to disclosure tier')
    .option('-t, --tier <n>', 'disclosure tier: 0=basic (default), 1=+memory/check, 2=all', '0')
    .action(async (options: { tier?: string }) => {
      const tier = parseInt(options.tier ?? '0', 10);
      await dispatchFromCli(
        'query',
        'admin',
        'help',
        { tier },
        { command: 'ops' },
      );
    });
}
