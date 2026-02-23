/**
 * CLI history command - completion timeline and productivity analytics.
 * @task T4538
 * @epic T4454
 */

import { Command } from 'commander';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

export function registerHistoryCommand(program: Command): void {
  program
    .command('history')
    .description('Completion timeline and productivity analytics')
    .option('--days <n>', 'Show last N days', '30')
    .option('--since <date>', 'Show completions since date (YYYY-MM-DD)')
    .option('--until <date>', 'Show completions until date (YYYY-MM-DD)')
    .option('--no-chart', 'Disable bar charts')
    .action(async (opts: Record<string, unknown>) => {
      await dispatchFromCli('query', 'admin', 'log', {
        days: opts['days'] ? Number(opts['days']) : 30,
        since: opts['since'],
        until: opts['until'],
      }, { command: 'history' });
    });
}
