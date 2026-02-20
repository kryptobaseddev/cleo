/**
 * CLI dash command - project dashboard.
 * @task T4535
 * @epic T4454
 */

import { Command } from 'commander';
import {
  getDashboard,
} from '../../core/stats/index.js';
import { formatError } from '../../core/output.js';
import { cliOutput } from '../renderers/index.js';
import { CleoError } from '../../core/errors.js';

/**
 * Register the dash command.
 * @task T4535
 */
export function registerDashCommand(program: Command): void {
  program
    .command('dash')
    .description('Project dashboard with status summary, phase progress, recent activity')
    .option('-c, --compact', 'Condensed single-line view')
    .option('--period <days>', 'Stats period in days', '7')
    .option('--no-chart', 'Disable ASCII charts/progress bars')
    .option('--sections <list>', 'Comma-separated list of sections to show')
    .option('-v, --verbose', 'Show full task details')
    .action(async (opts: Record<string, unknown>) => {
      try {
        const result = await getDashboard({
          compact: opts['compact'] as boolean | undefined,
          period: opts['period'] ? Number(opts['period']) : 7,
          showCharts: opts['chart'] !== false,
          sections: opts['sections'] ? (opts['sections'] as string).split(',') : undefined,
          verbose: opts['verbose'] as boolean | undefined,
          quiet: opts['quiet'] as boolean | undefined,
        });
        cliOutput(result, { command: 'dash' });
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });
}
