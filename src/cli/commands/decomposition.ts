/**
 * CLI decomposition command - decomposition protocol validation.
 * Routes through dispatch layer to check.protocol.decomposition.
 * @task T4537
 * @epic T4454
 */

import type { Command } from 'commander';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

/**
 * Register the decomposition command group.
 * @task T4537
 */
export function registerDecompositionCommand(program: Command): void {
  const decomposition = program
    .command('decomposition')
    .description('Validate decomposition protocol compliance for epic breakdown tasks');

  decomposition
    .command('validate <taskId>')
    .description('Validate decomposition protocol compliance for task')
    .option('--strict', 'Exit with error code on violations')
    .option('--epic <id>', 'Specify parent epic ID')
    .action(async (taskId: string, opts: Record<string, unknown>) => {
      await dispatchFromCli(
        'query',
        'check',
        'protocol',
        {
          protocolType: 'decomposition',
          mode: 'task',
          taskId,
          strict: opts['strict'] as boolean | undefined,
          epicId: opts['epic'] as string | undefined,
        },
        { command: 'decomposition' },
      );
    });

  decomposition
    .command('check <manifestFile>')
    .description('Validate manifest entry directly')
    .option('--strict', 'Exit with error code on violations')
    .option('--epic <id>', 'Specify parent epic ID')
    .action(async (manifestFile: string, opts: Record<string, unknown>) => {
      await dispatchFromCli(
        'query',
        'check',
        'protocol',
        {
          protocolType: 'decomposition',
          mode: 'manifest',
          manifestFile,
          strict: opts['strict'] as boolean | undefined,
          epicId: opts['epic'] as string | undefined,
        },
        { command: 'decomposition' },
      );
    });
}
