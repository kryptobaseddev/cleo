/**
 * CLI dash command - project dashboard.
 * @task T4535
 * @epic T4454
 */

import { dispatchFromCli } from '../../dispatch/adapters/cli.js';
import type { ShimCommand as Command } from '../commander-shim.js';

/**
 * Register the dash command.
 * @task T4535
 */
export function registerDashCommand(program: Command): void {
  program
    .command('dash')
    .description(
      'Project health dashboard: status summary, phase progress, recent activity, high priority tasks. Use for overall project status.',
    )
    .option('--blocked-limit <n>', 'Max blocked tasks to show', parseInt)
    .action(async (opts: Record<string, unknown>) => {
      await dispatchFromCli(
        'query',
        'admin',
        'dash',
        { blockedTasksLimit: opts['blockedLimit'] as number | undefined },
        { command: 'dash' },
      );
    });
}
