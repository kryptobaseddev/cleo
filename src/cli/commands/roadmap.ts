/**
 * CLI roadmap command - roadmap generation from pending epics and changelog.
 * @task T4538
 * @epic T4454
 */

import { Command } from 'commander';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

export function registerRoadmapCommand(program: Command): void {
  program
    .command('roadmap')
    .description('Generate roadmap from pending epics and CHANGELOG history')
    .option('--include-history', 'Include release history from CHANGELOG')
    .option('--upcoming-only', 'Only show upcoming/planned releases')
    .action(async (opts: Record<string, unknown>) => {
      await dispatchFromCli('query', 'admin', 'dash', {
        type: 'roadmap',
        includeHistory: opts['includeHistory'],
        upcomingOnly: opts['upcomingOnly'],
      }, { command: 'roadmap' });
    });
}
