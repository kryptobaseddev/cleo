/**
 * CLI specification command - specification protocol validation.
 * Routes through dispatch layer to check.protocol.specification.
 * @task T4537
 * @epic T4454
 */

import type { Command } from 'commander';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

/**
 * Register the specification command group.
 * @task T4537
 */
export function registerSpecificationCommand(program: Command): void {
  const specification = program
    .command('specification')
    .description('Validate specification protocol compliance');

  specification
    .command('validate <taskId>')
    .description('Validate specification protocol compliance for task')
    .option('--strict', 'Exit with error code on violations')
    .option('--spec-file <file>', 'Path to specification file')
    .action(async (taskId: string, opts: Record<string, unknown>) => {
      await dispatchFromCli(
        'query',
        'check',
        'protocol.specification',
        {
          mode: 'task',
          taskId,
          strict: opts['strict'] as boolean | undefined,
          specFile: opts['specFile'] as string | undefined,
        },
        { command: 'specification' },
      );
    });

  specification
    .command('check <manifestFile>')
    .description('Validate manifest entry directly')
    .option('--strict', 'Exit with error code on violations')
    .option('--spec-file <file>', 'Path to specification file')
    .action(async (manifestFile: string, opts: Record<string, unknown>) => {
      await dispatchFromCli(
        'query',
        'check',
        'protocol.specification',
        {
          mode: 'manifest',
          manifestFile,
          strict: opts['strict'] as boolean | undefined,
          specFile: opts['specFile'] as string | undefined,
        },
        { command: 'specification' },
      );
    });
}
