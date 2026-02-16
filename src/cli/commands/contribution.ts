/**
 * CLI contribution command - contribution protocol validation.
 * @task T4537
 * @epic T4454
 */

import { Command } from 'commander';
import {
  validateContributionTask,
  checkContributionManifest,
} from '../../core/validation/protocols/contribution.js';
import { formatSuccess, formatError } from '../../core/output.js';
import { CleoError } from '../../core/errors.js';

/**
 * Register the contribution command group.
 * @task T4537
 */
export function registerContributionCommand(program: Command): void {
  const contribution = program
    .command('contribution')
    .description('Validate contribution protocol compliance for shared codebase work');

  contribution
    .command('validate <taskId>')
    .description('Validate contribution protocol compliance for task')
    .option('--strict', 'Exit with error code on violations')
    .action(async (taskId: string, opts: Record<string, unknown>) => {
      try {
        const result = await validateContributionTask(taskId, {
          strict: opts['strict'] as boolean | undefined,
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

  contribution
    .command('check <manifestFile>')
    .description('Validate manifest entry directly')
    .option('--strict', 'Exit with error code on violations')
    .action(async (manifestFile: string, opts: Record<string, unknown>) => {
      try {
        const result = await checkContributionManifest(manifestFile, {
          strict: opts['strict'] as boolean | undefined,
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
