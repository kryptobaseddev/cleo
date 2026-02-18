/**
 * CLI archive command.
 * @task T4461
 * @epic T4454
 */

import { Command } from 'commander';
import { getAccessor } from '../../store/data-accessor.js';
import { archiveTasks } from '../../core/tasks/archive.js';
import { formatSuccess, formatError } from '../../core/output.js';
import { CleoError } from '../../core/errors.js';

/**
 * Register the archive command.
 * @task T4461
 */
export function registerArchiveCommand(program: Command): void {
  program
    .command('archive')
    .description('Archive completed tasks')
    .option('--before <date>', 'Archive tasks completed before date (ISO format)')
    .option('--tasks <ids>', 'Specific task IDs to archive (comma-separated)')
    .option('--no-cancelled', 'Exclude cancelled tasks')
    .option('--dry-run', 'Show what would be archived without making changes')
    .action(async (opts: Record<string, unknown>) => {
      try {
        const accessor = await getAccessor();
        const result = await archiveTasks({
          before: opts['before'] as string | undefined,
          taskIds: opts['tasks'] ? (opts['tasks'] as string).split(',').map(s => s.trim()) : undefined,
          includeCancelled: opts['cancelled'] !== false,
          dryRun: opts['dryRun'] as boolean | undefined,
        }, undefined, accessor);

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
