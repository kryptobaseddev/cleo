/**
 * CLI reason command group — reasoning and intelligence operations.
 *
 * Surfaces BRAIN memory reasoning and task dependency intelligence as
 * first-class CLI commands, providing parity with MCP-only operations.
 *
 * Commands:
 *   cleo reason why <taskId>            — causal trace through dependency chains
 *   cleo reason similar <taskId>        — find semantically similar BRAIN entries
 *   cleo reason impact --change <text>  — predict impact of a free-text change (T043)
 *   cleo reason impact <taskId>         — downstream dependency impact for a known task
 *   cleo reason timeline <taskId>       — task history and audit trail
 *
 * @task T043
 * @task T044
 * @epic T038
 */

import { dispatchFromCli } from '../../dispatch/adapters/cli.js';
import type { ShimCommand as Command } from '../commander-shim.js';

/**
 * Register the `cleo reason` command group and its subcommands.
 *
 * @remarks
 * Adds `why`, `similar`, `impact`, and `timeline` subcommands that
 * dispatch to the intelligence and tasks domains.
 *
 * @param program - Root CLI program instance (commander shim).
 *
 * @example
 * ```ts
 * registerReasonCommand(rootCommand);
 * // Adds: cleo reason why|similar|impact|timeline
 * ```
 */
export function registerReasonCommand(program: Command): void {
  const reason = program
    .command('reason')
    .description('Reasoning and intelligence operations (why, similar, impact, timeline)');

  // -- why --
  reason
    .command('why <taskId>')
    .description('Explain why a task exists via causal trace through dependency chains')
    .option('--json', 'Output raw JSON envelope')
    .action(async (taskId: string) => {
      await dispatchFromCli(
        'query',
        'memory',
        'reason.why',
        { taskId },
        { command: 'reason', operation: 'memory.reason.why' },
      );
    });

  // -- similar --
  reason
    .command('similar <taskId>')
    .description('Find BRAIN entries semantically similar to a task or observation ID')
    .option('--limit <n>', 'Maximum number of results to return', parseInt)
    .option('--json', 'Output raw JSON envelope')
    .action(async (taskId: string, opts: Record<string, unknown>) => {
      await dispatchFromCli(
        'query',
        'memory',
        'reason.similar',
        {
          entryId: taskId,
          limit: opts['limit'] as number | undefined,
        },
        { command: 'reason', operation: 'memory.reason.similar' },
      );
    });

  // -- impact --
  // Two modes:
  //   cleo reason impact --change "Modify X"   → free-text prediction (T043)
  //   cleo reason impact <taskId>              → dependency graph impact for known task
  reason
    .command('impact [taskId]')
    .description(
      'Predict impact of a change. Use --change for free-text prediction, or pass a taskId for graph-based analysis.',
    )
    .option('--change <description>', 'Free-text description of the proposed change (T043)')
    .option('--limit <n>', 'Maximum seed tasks to match when using --change (default: 5)', '5')
    .option('--depth <n>', 'Maximum traversal depth when using taskId (default: 10)', '10')
    .option('--json', 'Output raw JSON envelope')
    .action(async (taskId: string | undefined, opts: Record<string, unknown>) => {
      const change = opts['change'] as string | undefined;

      if (change) {
        // Free-text impact prediction (T043): tasks.impact
        await dispatchFromCli(
          'query',
          'tasks',
          'impact',
          {
            change,
            matchLimit: parseInt(opts['limit'] as string, 10),
          },
          { command: 'reason', operation: 'tasks.impact' },
        );
      } else if (taskId) {
        // Graph-based impact for a specific known task: tasks.depends
        await dispatchFromCli(
          'query',
          'tasks',
          'depends',
          {
            taskId,
            action: 'impact',
            depth: parseInt(opts['depth'] as string, 10),
          },
          { command: 'reason', operation: 'tasks.depends' },
        );
      } else {
        process.stderr.write(
          'Error: reason impact requires either --change <description> or a <taskId>\n',
        );
        process.exit(1);
      }
    });

  // -- timeline --
  reason
    .command('timeline <taskId>')
    .description('Show history and audit trail for a task')
    .option('--limit <n>', 'Maximum number of history entries', parseInt)
    .option('--json', 'Output raw JSON envelope')
    .action(async (taskId: string, opts: Record<string, unknown>) => {
      await dispatchFromCli(
        'query',
        'tasks',
        'history',
        {
          taskId,
          limit: opts['limit'] as number | undefined,
        },
        { command: 'reason', operation: 'tasks.history' },
      );
    });
}
