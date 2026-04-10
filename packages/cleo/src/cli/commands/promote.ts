/**
 * CLI promote command - remove parent from task, making it root-level.
 *
 * Routes to `tasks.reparent` with `newParentId: null` (the canonical way to
 * promote a task since T5615 rationalization removed `tasks.promote`).
 *
 * @task T4454
 */

import { dispatchFromCli } from '../../dispatch/adapters/cli.js';
import type { ShimCommand as Command } from '../commander-shim.js';

export function registerPromoteCommand(program: Command): void {
  program
    .command('promote <task-id>')
    .description('Remove parent from task, making it root-level')
    .action(async (taskId: string) => {
      await dispatchFromCli(
        'mutate',
        'tasks',
        'reparent',
        { taskId, newParentId: null },
        { command: 'promote' },
      );
    });
}
