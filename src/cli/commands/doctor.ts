/**
 * CLI doctor command - system diagnostics.
 * Delegates via dispatch to admin.health handler.
 * @task T4454
 * @task T4795
 * @task T4903
 */

import { Command } from 'commander';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

export function registerDoctorCommand(program: Command): void {
  program
    .command('doctor')
    .description('Run system diagnostics and health checks')
    .option('--detailed', 'Show detailed health check results')
    .action(async (opts: Record<string, unknown>) => {
      await dispatchFromCli('query', 'admin', 'health', {
        detailed: opts['detailed'] as boolean | undefined,
      }, { command: 'doctor', operation: 'admin.health' });
    });
}
