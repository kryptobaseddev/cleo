/**
 * CLI validate command - check file integrity, schema compliance, checksum.
 * Delegates to core/validation/validate-ops.coreValidateReport.
 * @task T4454
 * @task T4659
 * @task T4795
 * @epic T4654
 */

import { Command } from 'commander';
import { formatError } from '../../core/output.js';
import { cliOutput } from '../renderers/index.js';
import { CleoError } from '../../core/errors.js';
import { ExitCode } from '../../types/exit-codes.js';
import { coreValidateReport, coreValidateAndFix } from '../../core/validation/validate-ops.js';
import { getProjectRoot } from '../../core/paths.js';

export function registerValidateCommand(program: Command): void {
  program
    .command('validate')
    .description('Validate tasks.json against schema and business rules')
    .option('--strict', 'Treat warnings as errors')
    .option('--fix', 'Auto-fix simple issues (missing sizes, completedAt, checksum)')
    .option('--dry-run', 'Preview fixes without applying (requires --fix)')
    .action(async (opts: Record<string, unknown>) => {
      try {
        const projectRoot = getProjectRoot();
        const fix = !!opts['fix'];
        const dryRun = !!opts['dryRun'];
        const strict = !!opts['strict'];

        if (fix) {
          const result = await coreValidateAndFix(projectRoot, { dryRun });

          cliOutput({
            valid: result.validation.valid,
            schemaVersion: result.validation.schemaVersion,
            errors: result.validation.errors,
            warnings: result.validation.warnings,
            details: result.validation.details,
            repairs: result.repairs,
            allFixed: result.allFixed,
            dryRun,
          }, { command: 'validate' });

          if (!result.allFixed || (strict && result.validation.warnings > 0)) {
            process.exit(ExitCode.VALIDATION_ERROR);
          }
        } else {
          const result = await coreValidateReport(projectRoot);

          cliOutput({
            valid: result.valid,
            schemaVersion: result.schemaVersion,
            errors: result.errors,
            warnings: result.warnings,
            details: result.details,
            dryRun: false,
          }, { command: 'validate' });

          if (!result.valid || (strict && result.warnings > 0)) {
            process.exit(ExitCode.VALIDATION_ERROR);
          }
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
