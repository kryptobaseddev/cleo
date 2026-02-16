/**
 * CLI specification command - specification protocol validation.
 * @task T4537
 * @epic T4454
 */

import { Command } from 'commander';
import {
  validateSpecificationTask,
  checkSpecificationManifest,
} from '../../core/validation/protocols/specification.js';
import { formatSuccess, formatError } from '../../core/output.js';
import { CleoError } from '../../core/errors.js';

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
      try {
        const result = await validateSpecificationTask(taskId, {
          strict: opts['strict'] as boolean | undefined,
          specFile: opts['specFile'] as string | undefined,
        });
        console.log(formatSuccess(result));
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });

  specification
    .command('check <manifestFile>')
    .description('Validate manifest entry directly')
    .option('--strict', 'Exit with error code on violations')
    .option('--spec-file <file>', 'Path to specification file')
    .action(async (manifestFile: string, opts: Record<string, unknown>) => {
      try {
        const result = await checkSpecificationManifest(manifestFile, {
          strict: opts['strict'] as boolean | undefined,
          specFile: opts['specFile'] as string | undefined,
        });
        console.log(formatSuccess(result));
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });
}
