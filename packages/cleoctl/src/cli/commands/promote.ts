/**
 * CLI promote command - remove parent from task, making it root-level.
 * @task T4454
 */

import type { ShimCommand as Command } from '../commander-shim.js';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

export function registerPromoteCommand(program: Command): void {
  program
    .command('promote <task-id>')
    .description('Remove parent from task, making it root-level')
    .option('--no-type-update', 'Skip auto-updating type from subtask to task')
    .action(async (taskId: string) => {
      await dispatchFromCli('mutate', 'tasks', 'promote', { taskId }, { command: 'promote' });
    });
}
