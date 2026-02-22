/**
 * CLI reparent command - move a task to a different parent.
 * Delegates to src/core/tasks/reparent.ts (canonical implementation).
 *
 * @task T4807
 * @epic T4454
 */

import { Command } from 'commander';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

export function registerReparentCommand(program: Command): void {
  program
    .command('reparent <task-id>')
    .description('Move task to a different parent in hierarchy')
    .requiredOption('--to <parent-id>', 'Target parent task ID (or "" to make root)')
    .action(async (taskId: string, opts: Record<string, unknown>) => {
      const newParentId = (opts['to'] as string) || null;
      await dispatchFromCli('mutate', 'tasks', 'reparent', { taskId, newParentId }, { command: 'reparent' });
    });
}
