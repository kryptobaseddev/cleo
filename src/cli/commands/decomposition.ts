/**
 * CLI decomposition command - decomposition protocol validation.
 * @task T4537
 * @epic T4454
 */

import { Command } from 'commander';
import {
  validateDecompositionTask,
  checkDecompositionManifest,
} from '../../core/validation/protocols/decomposition.js';
import { formatSuccess, formatError } from '../../core/output.js';
import { CleoError } from '../../core/errors.js';

/**
 * Register the decomposition command group.
 * @task T4537
 */
export function registerDecompositionCommand(program: Command): void {
  const decomposition = program
    .command('decomposition')
    .description('Validate decomposition protocol compliance for epic breakdown tasks');

  decomposition
    .command('validate <taskId>')
    .description('Validate decomposition protocol compliance for task')
    .option('--strict', 'Exit with error code on violations')
    .option('--epic <id>', 'Specify parent epic ID')
    .action(async (taskId: string, opts: Record<string, unknown>) => {
      try {
        const result = await validateDecompositionTask(taskId, {
          strict: opts['strict'] as boolean | undefined,
          epicId: opts['epic'] as string | undefined,
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

  decomposition
    .command('check <manifestFile>')
    .description('Validate manifest entry directly')
    .option('--strict', 'Exit with error code on violations')
    .option('--epic <id>', 'Specify parent epic ID')
    .action(async (manifestFile: string, opts: Record<string, unknown>) => {
      try {
        const result = await checkDecompositionManifest(manifestFile, {
          strict: opts['strict'] as boolean | undefined,
          epicId: opts['epic'] as string | undefined,
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
