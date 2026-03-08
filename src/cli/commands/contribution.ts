/**
 * CLI contribution command - contribution protocol validation.
 * Routes through dispatch layer to check.protocol.contribution.
 * @task T4537
 * @epic T4454
 */

import type { Command } from 'commander';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

/**
 * Register the contribution command group.
 * @task T4537
 */
export function registerContributionCommand(program: Command): void {
  const contribution = program
    .command('contribution')
    .description('Validate contribution protocol compliance for shared codebase work');

  contribution
    .command('validate <taskId>')
    .description('Validate contribution protocol compliance for task')
    .option('--strict', 'Exit with error code on violations')
    .action(async (taskId: string, opts: Record<string, unknown>) => {
      await dispatchFromCli(
        'query',
        'check',
        'protocol',
        {
          protocolType: 'contribution',
          mode: 'task',
          taskId,
          strict: opts['strict'] as boolean | undefined,
        },
        { command: 'contribution' },
      );
    });

  contribution
    .command('check <manifestFile>')
    .description('Validate manifest entry directly')
    .option('--strict', 'Exit with error code on violations')
    .action(async (manifestFile: string, opts: Record<string, unknown>) => {
      await dispatchFromCli(
        'query',
        'check',
        'protocol',
        {
          protocolType: 'contribution',
          mode: 'manifest',
          manifestFile,
          strict: opts['strict'] as boolean | undefined,
        },
        { command: 'contribution' },
      );
    });
}
