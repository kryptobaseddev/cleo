/**
 * CLI commands command - list and query available CLEO commands.
 * Delegates to admin.help via dispatch layer.
 * @task T4551, T5671
 * @epic T4545
 */

import type { Command } from 'commander';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

/**
 * Register the commands command.
 * @task T4551, T5671
 */
export function registerCommandsCommand(program: Command): void {
  program
    .command('commands [command]')
    .description('List and query available CLEO commands (delegates to admin help)')
    .option('-c, --category <category>', 'Filter by category')
    .option('-r, --relevance <level>', 'Filter by agent relevance')
    .option('--tier <n>', 'Help tier level (0=basic, 1=extended, 2=full)', parseInt)
    .action(async (commandName: string | undefined, opts: Record<string, unknown>) => {
      console.error(
        '[DEPRECATED] cleo commands now delegates to admin.help.\n' +
          'Use: query admin help (MCP) or cleo help (CLI)\n',
      );

      await dispatchFromCli(
        'query',
        'admin',
        'help',
        {
          tier: (opts['tier'] as number) ?? 0,
          domain: commandName,
          category: opts['category'],
          relevance: opts['relevance'],
        },
        { command: 'commands', operation: 'admin.help' },
      );
    });
}
