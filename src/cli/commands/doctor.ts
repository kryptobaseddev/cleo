/**
 * CLI doctor command - system diagnostics.
 * Delegates to core/system/health.coreDoctorReport.
 * @task T4454
 * @task T4795
 */

import { Command } from 'commander';
import { formatError } from '../../core/output.js';
import { CleoError } from '../../core/errors.js';
import { cliOutput } from '../renderers/index.js';
import { ExitCode } from '../../types/exit-codes.js';
import { coreDoctorReport } from '../../core/system/health.js';
import { getProjectRoot } from '../../core/paths.js';

export function registerDoctorCommand(program: Command): void {
  program
    .command('doctor')
    .description('Run system diagnostics and health checks')
    .action(async () => {
      try {
        const projectRoot = getProjectRoot();
        const report = await coreDoctorReport(projectRoot);

        cliOutput({
          healthy: report.healthy,
          errors: report.errors,
          warnings: report.warnings,
          checks: report.checks,
        }, { command: 'doctor', operation: 'system.health' });

        if (!report.healthy) {
          process.exit(ExitCode.VALIDATION_ERROR);
        }
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });
}
