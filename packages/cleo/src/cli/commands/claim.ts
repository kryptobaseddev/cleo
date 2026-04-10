/**
 * CLI claim / unclaim commands — assign a task to an agent or session.
 * @task T473
 * @epic T443
 */

import { dispatchFromCli } from '../../dispatch/adapters/cli.js';
import type { ShimCommand as Command } from '../commander-shim.js';

/**
 * Register the claim command.
 *
 * @remarks
 * Dispatches to `tasks.claim` (mutate). Claims a task by assigning it to
 * the specified agent. Requires an active session (sessionRequired: true).
 *
 * @param program - Root CLI program instance.
 */
export function registerClaimCommand(program: Command): void {
  program
    .command('claim <taskId>')
    .description('Claim a task by assigning it to an agent')
    .option('--agent <agentId>', 'Agent ID to assign the task to (required)')
    .action(async (taskId: string, opts: Record<string, unknown>) => {
      await dispatchFromCli(
        'mutate',
        'tasks',
        'claim',
        {
          taskId,
          agentId: opts['agent'] as string | undefined,
        },
        { command: 'claim', operation: 'tasks.claim' },
      );
    });
}

/**
 * Register the unclaim command.
 *
 * @remarks
 * Dispatches to `tasks.unclaim` (mutate). Removes the current assignee from
 * a task, freeing it for other agents. Requires an active session.
 *
 * @param program - Root CLI program instance.
 */
export function registerUnclaimCommand(program: Command): void {
  program
    .command('unclaim <taskId>')
    .description('Unclaim a task by removing its current assignee')
    .action(async (taskId: string) => {
      await dispatchFromCli(
        'mutate',
        'tasks',
        'unclaim',
        { taskId },
        { command: 'unclaim', operation: 'tasks.unclaim' },
      );
    });
}
