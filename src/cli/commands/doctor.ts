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
    .option('--comprehensive', 'Run comprehensive doctor report')
    .option('--fix', 'Auto-fix failed checks')
    .action(async (opts: Record<string, unknown>) => {
      if (opts['fix']) {
        await dispatchFromCli('mutate', 'admin', 'fix', {}, { command: 'doctor', operation: 'admin.fix' });
      } else if (opts['comprehensive']) {
        await dispatchFromCli('query', 'admin', 'doctor', {}, { command: 'doctor', operation: 'admin.doctor' });
      } else {
        await dispatchFromCli('query', 'admin', 'health', {
          detailed: opts['detailed'] as boolean | undefined,
        }, { command: 'doctor', operation: 'admin.health' });
      }
    });
}
