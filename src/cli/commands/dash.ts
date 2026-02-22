/**
 * CLI dash command - project dashboard.
 * @task T4535
 * @epic T4454
 */

import { Command } from 'commander';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

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
    .action(async () => {
      await dispatchFromCli('query', 'admin', 'dash', {}, { command: 'dash' });
    });
}
