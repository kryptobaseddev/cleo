/**
 * CLI archive command.
 * @task T4461
 * @epic T4454
 */

import { Command } from 'commander';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

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
      const params: Record<string, unknown> = {};

      if (opts['before'] !== undefined) params['before'] = opts['before'];
      if (opts['tasks']) params['taskIds'] = (opts['tasks'] as string).split(',').map(s => s.trim());
      if (opts['cancelled'] === false) params['includeCancelled'] = false;
      if (opts['dryRun']) params['dryRun'] = opts['dryRun'];

      await dispatchFromCli('mutate', 'tasks', 'archive', params, { command: 'archive' });
    });
}
