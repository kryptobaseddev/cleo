/**
 * CLI consensus command - consensus protocol validation.
 * Routes through dispatch layer to check.protocol.consensus.
 * @task T4537
 * @epic T4454
 */

import type { Command } from 'commander';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

/**
 * Register the consensus command group.
 * @task T4537
 */
export function registerConsensusCommand(program: Command): void {
  const consensus = program
    .command('consensus')
    .description('Validate consensus protocol compliance for multi-agent decision tasks');

  consensus
    .command('validate <taskId>')
    .description('Validate consensus protocol compliance for task')
    .option('--strict', 'Exit with error code on violations')
    .option('--voting-matrix <file>', 'Path to voting matrix JSON file')
    .action(async (taskId: string, opts: Record<string, unknown>) => {
      await dispatchFromCli(
        'query',
        'check',
        'protocol',
        {
          protocolType: 'consensus',
          mode: 'task',
          taskId,
          strict: opts['strict'] as boolean | undefined,
          votingMatrixFile: opts['votingMatrix'] as string | undefined,
        },
        { command: 'consensus' },
      );
    });

  consensus
    .command('check <manifestFile>')
    .description('Validate manifest entry directly')
    .option('--strict', 'Exit with error code on violations')
    .option('--voting-matrix <file>', 'Path to voting matrix JSON file')
    .action(async (manifestFile: string, opts: Record<string, unknown>) => {
      await dispatchFromCli(
        'query',
        'check',
        'protocol',
        {
          protocolType: 'consensus',
          mode: 'manifest',
          manifestFile,
          strict: opts['strict'] as boolean | undefined,
          votingMatrixFile: opts['votingMatrix'] as string | undefined,
        },
        { command: 'consensus' },
      );
    });
}
