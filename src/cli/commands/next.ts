/**
 * CLI next command - suggest next task to work on.
 * Delegates scoring algorithm to core/tasks/task-ops.coreTaskNext.
 * @task T4454
 * @task T4795
 */

import { Command } from 'commander';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

export function registerNextCommand(program: Command): void {
  program
    .command('next')
    .description('Suggest next task to work on based on priority and dependencies')
    .option('--explain', 'Show detailed reasoning for suggestion')
    .option('-n, --count <n>', 'Show top N suggestions', '1')
    .action(async (opts: Record<string, unknown>) => {
      const count = parseInt(opts['count'] as string, 10) || 1;
      const explain = !!opts['explain'];
      await dispatchFromCli('query', 'tasks', 'next', { count, explain }, { command: 'next' });
    });
}
