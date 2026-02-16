/**
 * CLI implementation command - implementation protocol validation.
 * @task T4537
 * @epic T4454
 */

import { Command } from 'commander';
import {
  validateImplementationTask,
  checkImplementationManifest,
} from '../../core/validation/protocols/implementation.js';
import { formatSuccess, formatError } from '../../core/output.js';
import { CleoError } from '../../core/errors.js';

/**
 * Register the implementation command group.
 * @task T4537
 */
export function registerImplementationCommand(program: Command): void {
  const implementation = program
    .command('implementation')
    .description('Validate implementation protocol compliance for code tasks');

  implementation
    .command('validate <taskId>')
    .description('Validate implementation protocol compliance for task')
    .option('--strict', 'Exit with error code on violations')
    .action(async (taskId: string, opts: Record<string, unknown>) => {
      try {
        const result = await validateImplementationTask(taskId, {
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

  implementation
    .command('check <manifestFile>')
    .description('Validate manifest entry directly')
    .option('--strict', 'Exit with error code on violations')
    .action(async (manifestFile: string, opts: Record<string, unknown>) => {
      try {
        const result = await checkImplementationManifest(manifestFile, {
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
