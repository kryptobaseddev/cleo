/**
 * CLI roadmap command - roadmap generation from pending epics and changelog.
 * @task T4538
 * @epic T4454
 */

import { Command } from 'commander';
import {
  getRoadmap,
} from '../../core/roadmap/index.js';
import { formatSuccess, formatError } from '../../core/output.js';
import { CleoError } from '../../core/errors.js';

/**
 * Register the roadmap command.
 * @task T4538
 */
export function registerRoadmapCommand(program: Command): void {
  program
    .command('roadmap')
    .description('Generate roadmap from pending epics and CHANGELOG history')
    .option('--include-history', 'Include release history from CHANGELOG')
    .option('--upcoming-only', 'Only show upcoming/planned releases')
    .action(async (opts: Record<string, unknown>) => {
      try {
        const result = await getRoadmap({
          includeHistory: opts['includeHistory'] as boolean | undefined,
          upcomingOnly: opts['upcomingOnly'] as boolean | undefined,
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
