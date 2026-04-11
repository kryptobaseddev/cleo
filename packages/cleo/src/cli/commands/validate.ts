/**
 * CLI validate command - check file integrity, schema compliance, checksum.
 * Delegates to dispatch layer: check.schema.
 * @task T4454
 * @task T4659
 * @task T4795
 * @epic T4654
 * @task T4904
 */

import { dispatchFromCli } from '../../dispatch/adapters/cli.js';
import type { ShimCommand as Command } from '../commander-shim.js';

export function registerValidateCommand(program: Command): void {
  program
    .command('validate')
    .description(
      'DEPRECATED: Use `cleo check schema todo` instead. Validate task data against schema and business rules',
    )
    .option('--strict', 'Treat warnings as errors')
    .action(async (opts: Record<string, unknown>) => {
      console.error('[DEPRECATED] cleo validate is deprecated. Use: cleo check schema todo');
      await dispatchFromCli(
        'query',
        'check',
        'schema',
        {
          type: 'todo',
          strict: opts['strict'],
        },
        { command: 'validate', operation: 'check.schema' },
      );
    });
}
