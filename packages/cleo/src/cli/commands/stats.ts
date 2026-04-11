/**
 * CLI stats command - project statistics.
 * @task T4535
 * @epic T4454
 */

import { dispatchFromCli } from '../../dispatch/adapters/cli.js';
import type { ShimCommand as Command } from '../commander-shim.js';

/**
 * Register the stats command.
 * @task T4535
 */
export function registerStatsCommand(program: Command): void {
  const stats = program
    .command('stats')
    .description('Project statistics (counts, completion rates, velocity)')
    .option('-p, --period <period>', 'Analysis period: today/week/month/quarter/year or days', '30')
    .option('-v, --verbose', 'Show detailed breakdowns per category')
    .action(async (opts: Record<string, unknown>) => {
      await dispatchFromCli(
        'query',
        'admin',
        'stats',
        {
          period: opts['period'] ?? 30,
        },
        { command: 'stats', operation: 'admin.stats' },
      );
    });

  // T065: Workflow compliance subcommand — `cleo stats compliance`
  stats
    .command('compliance')
    .description('Agent workflow compliance dashboard (WF-001 through WF-005)')
    .option('--since <date>', 'Filter to tasks/events from this date (ISO 8601)')
    .option('--json', 'Output raw JSON instead of formatted dashboard')
    .action(async (opts: Record<string, unknown>) => {
      await dispatchFromCli(
        'query',
        'check',
        'workflow.compliance',
        {
          since: opts['since'],
          json: opts['json'],
        },
        { command: 'stats compliance', operation: 'check.workflow.compliance' },
      );
    });
}
