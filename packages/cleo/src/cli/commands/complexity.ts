/**
 * CLI complexity command — estimate complexity of a task.
 * @task T473
 * @epic T443
 */

import { dispatchFromCli } from '../../dispatch/adapters/cli.js';
import type { ShimCommand as Command } from '../commander-shim.js';

/**
 * Register the complexity command group and its subcommands.
 *
 * @remarks
 * Exposes `tasks.complexity.estimate` as `cleo complexity estimate <taskId>`.
 * Returns a complexity estimate (small/medium/large) with reasoning.
 *
 * @param program - Root CLI program instance.
 */
export function registerComplexityCommand(program: Command): void {
  const complexity = program.command('complexity').description('Task complexity analysis');

  complexity
    .command('estimate <taskId>')
    .description('Estimate complexity of a task (small / medium / large)')
    .action(async (taskId: string) => {
      await dispatchFromCli(
        'query',
        'tasks',
        'complexity.estimate',
        { taskId },
        { command: 'complexity', operation: 'tasks.complexity.estimate' },
      );
    });
}
