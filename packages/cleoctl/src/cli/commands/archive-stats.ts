/**
 * CLI archive-stats command — thin wrapper over core archive analytics.
 *
 * Parses Commander.js args, calls core analyzeArchive, and routes output
 * through the dispatch layer.
 *
 * @task T4555
 * @epic T4545
 */

import type { Command } from 'commander';
import type { ArchiveReportType } from '@cleocode/core';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

// Re-export analyzeArchive as getArchiveStats for backward compat with tests
export { analyzeArchive as getArchiveStats } from '@cleocode/core';

/**
 * Register the archive-stats command.
 * Routes through dispatch layer to admin.archive.stats.
 * @task T4555
 */
export function registerArchiveStatsCommand(program: Command): void {
  program
    .command('archive-stats')
    .description('Generate analytics and insights from archived tasks')
    .option('--summary', 'Overview statistics (default)')
    .option('--by-phase', 'Breakdown by project phase')
    .option('--by-label', 'Breakdown by label')
    .option('--by-priority', 'Breakdown by priority')
    .option('--cycle-times', 'Analyze task completion cycle times')
    .option('--trends', 'Show archiving trends over time')
    .option('--since <date>', 'Only include tasks archived since DATE (YYYY-MM-DD)')
    .option('--until <date>', 'Only include tasks archived until DATE (YYYY-MM-DD)')
    .action(async (opts: Record<string, unknown>) => {
      let report: ArchiveReportType = 'summary';
      if (opts['byPhase']) report = 'by-phase';
      else if (opts['byLabel']) report = 'by-label';
      else if (opts['byPriority']) report = 'by-priority';
      else if (opts['cycleTimes']) report = 'cycle-times';
      else if (opts['trends']) report = 'trends';

      await dispatchFromCli(
        'query',
        'check',
        'archive.stats',
        {
          report,
          since: opts['since'] as string | undefined,
          until: opts['until'] as string | undefined,
        },
        { command: 'archive-stats' },
      );
    });
}
