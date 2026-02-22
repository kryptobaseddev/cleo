/**
 * CLI log command - view audit log entries.
 * @task T4538
 * @epic T4454
 */

import { Command } from 'commander';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

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
    .action(async (opts: Record<string, unknown>) => {
      await dispatchFromCli('query', 'admin', 'log', {
        limit: opts['limit'] ? Number(opts['limit']) : 20,
        offset: opts['offset'] ? Number(opts['offset']) : 0,
        operation: opts['operation'] as string | undefined,
        taskId: opts['task'] as string | undefined,
        since: opts['since'] as string | undefined,
      }, { command: 'log', operation: 'admin.log' });
    });
}
