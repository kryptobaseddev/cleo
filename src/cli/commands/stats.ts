/**
 * CLI stats command - project statistics.
 * @task T4535
 * @epic T4454
 */

import { Command } from 'commander';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

/**
 * Register the stats command.
 * @task T4535
 */
export function registerStatsCommand(program: Command): void {
  program
    .command('stats')
    .description('Project statistics (counts, completion rates, velocity)')
    .option('-p, --period <period>', 'Analysis period: today/week/month/quarter/year or days', '30')
    .option('-v, --verbose', 'Show detailed breakdowns per category')
    .action(async (opts: Record<string, unknown>) => {
      await dispatchFromCli('query', 'admin', 'stats', {
        period: opts['period'] ? Number(opts['period']) : 30,
      }, { command: 'stats', operation: 'admin.stats' });
    });
}
