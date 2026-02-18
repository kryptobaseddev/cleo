/**
 * CLI find command.
 * @task T4460
 * @epic T4454
 */

import { Command } from 'commander';
import { getAccessor } from '../../store/data-accessor.js';
import { findTasks } from '../../core/tasks/find.js';
import { formatSuccess, formatError } from '../../core/output.js';
import { CleoError } from '../../core/errors.js';
import { ExitCode } from '../../types/exit-codes.js';
import type { TaskStatus } from '../../types/task.js';

/**
 * Register the find command.
 * @task T4460
 */
export function registerFindCommand(program: Command): void {
  program
    .command('find [query]')
    .alias('search')
    .description('Fuzzy search tasks by title/description')
    .option('--id <id>', 'Search by ID prefix')
    .option('--exact', 'Exact title match')
    .option('--status <status>', 'Filter by status')
    .option('--field <field>', 'Field to search in')
    .option('--include-archive', 'Include archived tasks')
    .option('--limit <n>', 'Max results (default: 20)', parseInt)
    .option('--offset <n>', 'Skip first N results', parseInt)
    .action(async (query: string | undefined, opts: Record<string, unknown>) => {
      try {
        const accessor = await getAccessor();
        const result = await findTasks({
          query,
          id: opts['id'] as string | undefined,
          exact: opts['exact'] as boolean | undefined,
          status: opts['status'] as TaskStatus | undefined,
          field: opts['field'] as string | undefined,
          includeArchive: opts['includeArchive'] as boolean | undefined,
          limit: opts['limit'] as number | undefined,
          offset: opts['offset'] as number | undefined,
        }, undefined, accessor);

        if (result.results.length === 0) {
          console.log(formatSuccess(result, 'No matching tasks found'));
          process.exit(ExitCode.NO_DATA);
        }

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
