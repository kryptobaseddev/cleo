/**
 * CLI command: cleo archive-stats
 *
 * Generates analytics and insights from archived tasks. Routes through the
 * dispatch layer to `check.archive.stats`.
 *
 * Usage:
 *   cleo archive-stats              -- overview statistics (default)
 *   cleo archive-stats --by-phase   -- breakdown by project phase
 *   cleo archive-stats --by-label   -- breakdown by label
 *   cleo archive-stats --by-priority -- breakdown by priority
 *   cleo archive-stats --cycle-times -- analyze task completion cycle times
 *   cleo archive-stats --trends     -- show archiving trends over time
 *   cleo archive-stats --since DATE -- only tasks archived since DATE
 *   cleo archive-stats --until DATE -- only tasks archived until DATE
 *
 * @task T4555
 * @epic T4545
 */

import type { ArchiveReportType } from '@cleocode/core/internal';
import { defineCommand } from 'citty';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

// Re-export analyzeArchive as getArchiveStats for backward compat with tests
export { analyzeArchive as getArchiveStats } from '@cleocode/core/internal';

/**
 * Native citty command for `cleo archive-stats`.
 *
 * Dispatches to `check.archive.stats` via dispatchFromCli.
 */
export const archiveStatsCommand = defineCommand({
  meta: {
    name: 'archive-stats',
    description: 'Generate analytics and insights from archived tasks',
  },
  args: {
    summary: {
      type: 'boolean',
      description: 'Overview statistics (default)',
      default: false,
    },
    'by-phase': {
      type: 'boolean',
      description: 'Breakdown by project phase',
      default: false,
    },
    'by-label': {
      type: 'boolean',
      description: 'Breakdown by label',
      default: false,
    },
    'by-priority': {
      type: 'boolean',
      description: 'Breakdown by priority',
      default: false,
    },
    'cycle-times': {
      type: 'boolean',
      description: 'Analyze task completion cycle times',
      default: false,
    },
    trends: {
      type: 'boolean',
      description: 'Show archiving trends over time',
      default: false,
    },
    since: {
      type: 'string',
      description: 'Only include tasks archived since DATE (YYYY-MM-DD)',
    },
    until: {
      type: 'string',
      description: 'Only include tasks archived until DATE (YYYY-MM-DD)',
    },
  },
  async run({ args }) {
    let report: ArchiveReportType = 'summary';
    if (args['by-phase']) report = 'by-phase';
    else if (args['by-label']) report = 'by-label';
    else if (args['by-priority']) report = 'by-priority';
    else if (args['cycle-times']) report = 'cycle-times';
    else if (args.trends) report = 'trends';

    await dispatchFromCli(
      'query',
      'check',
      'archive.stats',
      {
        report,
        since: args.since as string | undefined,
        until: args.until as string | undefined,
      },
      { command: 'archive-stats' },
    );
  },
});
