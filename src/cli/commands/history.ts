/**
 * CLI history command - completion timeline and productivity analytics.
 * @task T4538
 * @epic T4454
 */

import { Command } from 'commander';
import {
  getCompletionHistory,
} from '../../core/stats/index.js';
import { formatError } from '../../core/output.js';
import { cliOutput } from '../renderers/index.js';
import { CleoError } from '../../core/errors.js';

/**
 * Register the history command.
 * @task T4538
 */
export function registerHistoryCommand(program: Command): void {
  program
    .command('history')
    .description('Completion timeline and productivity analytics')
    .option('--days <n>', 'Show last N days', '30')
    .option('--since <date>', 'Show completions since date (YYYY-MM-DD)')
    .option('--until <date>', 'Show completions until date (YYYY-MM-DD)')
    .option('--no-chart', 'Disable bar charts')
    .action(async (opts: Record<string, unknown>) => {
      try {
        const result = await getCompletionHistory({
          days: opts['days'] ? Number(opts['days']) : 30,
          since: opts['since'] as string | undefined,
          until: opts['until'] as string | undefined,
        });
        cliOutput(result, { command: 'history' });
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });
}
