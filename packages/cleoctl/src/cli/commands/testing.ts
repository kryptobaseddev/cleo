/**
 * CLI testing command - validate testing protocol compliance.
 * Ported from scripts/testing.sh
 * @task T4551
 * @epic T4545
 */

import type { Command } from 'commander';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

/**
 * Register the testing command.
 * @task T4551
 */
export function registerTestingCommand(program: Command): void {
  const testingCmd = program.command('testing').description('Validate testing protocol compliance');

  testingCmd
    .command('validate <taskId>')
    .description('Validate testing protocol compliance for a task')
    .option('--strict', 'Exit with error code on violations')
    .action(async (taskId: string, opts: Record<string, unknown>) => {
      await dispatchFromCli(
        'query',
        'check',
        'manifest',
        {
          taskId,
          strict: !!opts['strict'],
          type: 'testing',
        },
        { command: 'testing', operation: 'check.manifest' },
      );
    });

  testingCmd
    .command('check <manifestFile>')
    .description('Validate testing protocol from a manifest file')
    .option('--strict', 'Exit with error code on violations')
    .action(async (manifestFile: string, opts: Record<string, unknown>) => {
      await dispatchFromCli(
        'query',
        'check',
        'manifest',
        {
          file: manifestFile,
          strict: !!opts['strict'],
          type: 'testing',
        },
        { command: 'testing', operation: 'check.manifest' },
      );
    });

  testingCmd
    .command('status')
    .description('Show test suite status')
    .action(async () => {
      await dispatchFromCli(
        'query',
        'check',
        'test',
        { format: 'status' },
        {
          command: 'testing',
          operation: 'check.test',
        },
      );
    });

  testingCmd
    .command('coverage')
    .description('Show test coverage')
    .action(async () => {
      await dispatchFromCli(
        'query',
        'check',
        'test',
        { format: 'coverage' },
        {
          command: 'testing',
          operation: 'check.test',
        },
      );
    });

  testingCmd
    .command('run')
    .description('Run test suite')
    .option('--filter <pattern>', 'Filter tests by pattern')
    .action(async (opts: Record<string, unknown>) => {
      await dispatchFromCli(
        'mutate',
        'check',
        'test.run',
        {
          filter: opts['filter'],
        },
        { command: 'testing', operation: 'check.test.run' },
      );
    });
}
