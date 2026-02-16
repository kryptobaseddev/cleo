/**
 * CLI stats command - project statistics.
 * @task T4535
 * @epic T4454
 */

import { Command } from 'commander';
import {
  getProjectStats,
} from '../../core/stats/index.js';
import { formatSuccess, formatError } from '../../core/output.js';
import { CleoError } from '../../core/errors.js';

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
    .option('-q, --quiet', 'Suppress decorative output')
    .action(async (opts: Record<string, unknown>) => {
      try {
        const result = await getProjectStats({
          period: opts['period'] as string | undefined,
          verbose: opts['verbose'] as boolean | undefined,
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
