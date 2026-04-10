/**
 * CLI roadmap command — roadmap generation from pending epics and changelog.
 *
 * Dispatches to `admin.roadmap` in the system engine, which calls
 * `getRoadmap()` from core. Not wired via registry at CLI layer because
 * roadmap is a pure query with no session dependency — calling core
 * through the dispatch layer (admin.roadmap) is the correct pattern.
 *
 * @task T4538
 * @epic T4454
 */

import { dispatchFromCli } from '../../dispatch/adapters/cli.js';
import type { ShimCommand as Command } from '../commander-shim.js';

export function registerRoadmapCommand(program: Command): void {
  program
    .command('roadmap')
    .description(
      'Generate project roadmap from task provenance — epics grouped by status with progress',
    )
    .option('--include-history', 'Include release history from CHANGELOG.md')
    .option('--upcoming-only', 'Only show pending/upcoming epics (exclude completed)')
    .action(async (opts: Record<string, unknown>) => {
      await dispatchFromCli(
        'query',
        'admin',
        'roadmap',
        {
          includeHistory: opts['includeHistory'] as boolean | undefined,
          upcomingOnly: opts['upcomingOnly'] as boolean | undefined,
        },
        { command: 'roadmap', operation: 'admin.roadmap' },
      );
    });
}
