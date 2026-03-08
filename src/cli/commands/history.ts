/**
 * CLI history command - completion timeline, audit log, and task work history.
 * @task T4538
 * @epic T4454
 * @task T5323
 */

import type { Command } from 'commander';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

export function registerHistoryCommand(program: Command): void {
  const history = program
    .command('history')
    .description('Completion timeline and productivity analytics')
    .option('--days <n>', 'Show last N days', '30')
    .option('--since <date>', 'Show completions since date (YYYY-MM-DD)')
    .option('--until <date>', 'Show completions until date (YYYY-MM-DD)')
    .option('--no-chart', 'Disable bar charts')
    .action(async (opts: Record<string, unknown>) => {
      await dispatchFromCli(
        'query',
        'admin',
        'log',
        {
          days: opts['days'] ? Number(opts['days']) : 30,
          since: opts['since'],
          until: opts['until'],
        },
        { command: 'history' },
      );
    });

  history
    .command('work')
    .description('Show task work history (time tracked per task)')
    .action(async () => {
      await dispatchFromCli('query', 'tasks', 'history', {}, { command: 'history' });
    });
}
