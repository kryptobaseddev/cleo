/**
 * CLI reorder command - change task position within sibling group.
 * @task T4454
 */

import { Command } from 'commander';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

export function registerReorderCommand(program: Command): void {
  program
    .command('reorder <task-id>')
    .description('Change task position within sibling group')
    .option('--position <n>', 'Move to specific position', parseInt)
    .option('--before <id>', 'Move before specified task')
    .option('--after <id>', 'Move after specified task')
    .option('--top', 'Move to first position')
    .option('--bottom', 'Move to last position')
    .action(async (taskId: string, opts: Record<string, unknown>) => {
      const position = opts['position'] as number | undefined;
      await dispatchFromCli('mutate', 'tasks', 'reorder', { taskId, position }, { command: 'reorder' });
    });
}
