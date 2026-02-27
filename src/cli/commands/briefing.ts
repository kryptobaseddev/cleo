/**
 * CLI briefing command - show composite session-start context.
 *
 * Aggregates session-start context from multiple sources:
 * - Last session handoff
 * - Current focus
 * - Top-N next tasks
 * - Open bugs
 * - Blocked tasks
 * - Active epics
 * - Pipeline stage
 *
 * @task T4916
 * @epic T4914
 */

import { Command } from 'commander';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

/**
 * Register the briefing command.
 * @task T4916
 */
export function registerBriefingCommand(program: Command): void {
  program
    .command('briefing')
    .description('Show composite session-start context (handoff, focus, next tasks, bugs, blockers, epics)')
    .option('-s, --scope <scope>', 'Scope filter (global or epic:T###)')
    .option('--max-next <n>', 'Maximum next tasks to show', '5')
    .option('--max-bugs <n>', 'Maximum bugs to show', '10')
    .option('--max-blocked <n>', 'Maximum blocked tasks to show', '10')
    .option('--max-epics <n>', 'Maximum active epics to show', '5')
    .action(async (opts: Record<string, unknown>) => {
      const scope = opts['scope'] as string | undefined;
      const maxNextTasks = parseInt(opts['maxNext'] as string, 10);
      const maxBugs = parseInt(opts['maxBugs'] as string, 10);
      const maxBlocked = parseInt(opts['maxBlocked'] as string, 10);
      const maxEpics = parseInt(opts['maxEpics'] as string, 10);

      await dispatchFromCli(
        'query',
        'session',
        'briefing.show',
        {
          scope,
          maxNextTasks,
          maxBugs,
          maxBlocked,
          maxEpics,
        },
        { command: 'briefing' },
      );
    });
}
