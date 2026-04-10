/**
 * CLI cancel command — soft-cancel a task (reversible via tasks.restore).
 * @task T473
 * @epic T443
 */

import { dispatchFromCli } from '../../dispatch/adapters/cli.js';
import type { ShimCommand as Command } from '../commander-shim.js';

/**
 * Register the cancel command.
 *
 * @remarks
 * Dispatches to `tasks.cancel` (mutate). The cancelled state is a soft
 * terminal state — tasks can be un-cancelled via `cleo restore task <id>`.
 *
 * @param program - Root CLI program instance.
 */
export function registerCancelCommand(program: Command): void {
  program
    .command('cancel <taskId>')
    .description('Cancel a task (soft terminal state; reversible via restore)')
    .option('--reason <reason>', 'Reason for cancellation')
    .action(async (taskId: string, opts: Record<string, unknown>) => {
      await dispatchFromCli(
        'mutate',
        'tasks',
        'cancel',
        {
          taskId,
          reason: opts['reason'] as string | undefined,
        },
        { command: 'cancel', operation: 'tasks.cancel' },
      );
    });
}
