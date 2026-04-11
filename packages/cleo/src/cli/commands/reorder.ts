/**
 * CLI reorder command - change task position within sibling group.
 * @task T4454
 */

import { dispatchFromCli } from '../../dispatch/adapters/cli.js';
import type { ShimCommand as Command } from '../commander-shim.js';

export function registerReorderCommand(program: Command): void {
  program
    .command('reorder <task-id>')
    .description('Change task position within sibling group')
    .option('--position <n>', 'Move to specific zero-based position among siblings', parseInt)
    .action(async (taskId: string, opts: Record<string, unknown>) => {
      const position = opts['position'] as number | undefined;
      await dispatchFromCli(
        'mutate',
        'tasks',
        'reorder',
        { taskId, position },
        { command: 'reorder' },
      );
    });
}
