/**
 * CLI validate command - check file integrity, schema compliance, checksum.
 * Delegates to dispatch layer: check.schema.
 * @task T4454
 * @task T4659
 * @task T4795
 * @epic T4654
 * @task T4904
 */

import { Command } from 'commander';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

export function registerValidateCommand(program: Command): void {
  program
    .command('validate')
    .description('Validate tasks.json against schema and business rules')
    .option('--strict', 'Treat warnings as errors')
    .action(async (opts: Record<string, unknown>) => {
      await dispatchFromCli('query', 'check', 'schema', {
        type: 'tasks',
        strict: opts['strict'],
      }, { command: 'validate', operation: 'check.schema' });
    });
}
