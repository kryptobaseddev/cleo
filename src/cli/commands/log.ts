/**
 * CLI log command - view audit log entries.
 * @task T4538
 * @epic T4454
 */

import { Command } from 'commander';
import {
  getLogEntries,
} from '../../core/log/index.js';
import { formatSuccess, formatError } from '../../core/output.js';
import { CleoError } from '../../core/errors.js';

/**
 * Register the log command.
 * @task T4538
 */
export function registerLogCommand(program: Command): void {
  program
    .command('log')
    .description('View audit log entries (operations, timestamps, changes)')
    .option('--limit <n>', 'Maximum entries to show', '20')
    .option('--offset <n>', 'Skip N entries', '0')
    .option('--operation <op>', 'Filter by operation type')
    .option('--task <id>', 'Filter by task ID')
    .option('--since <date>', 'Filter entries since date')
    .option('-q, --quiet', 'Suppress decorative output')
    .action(async (opts: Record<string, unknown>) => {
      try {
        const result = await getLogEntries({
          limit: opts['limit'] ? Number(opts['limit']) : 20,
          offset: opts['offset'] ? Number(opts['offset']) : 0,
          operation: opts['operation'] as string | undefined,
          task: opts['task'] as string | undefined,
          since: opts['since'] as string | undefined,
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
