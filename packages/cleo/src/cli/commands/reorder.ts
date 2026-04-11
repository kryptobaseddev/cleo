/**
 * CLI reorder command - change task position within sibling group.
 * @task T4454
 */

import { dispatchFromCli } from '../../dispatch/adapters/cli.js';
import type { ShimCommand as Command } from '../commander-shim.js';

/** Sentinel value for --bottom: moves task to end of sibling list. */
const BOTTOM_POSITION = 999999;

/**
 * Register the reorder command with convenience flags.
 *
 * @remarks
 * Supports `--top` (position 0), `--bottom` (position 999999), or
 * explicit `--position <n>` for precise placement.
 *
 * @param program - The root CLI shim command
 * @task T4454
 */
export function registerReorderCommand(program: Command): void {
  program
    .command('reorder <task-id>')
    .description('Change task position within sibling group')
    .option('--position <n>', 'Move to specific zero-based position among siblings', parseInt)
    .option('--top', 'Move to the top (position 0)')
    .option('--bottom', 'Move to the bottom')
    .action(async (taskId: string, opts: Record<string, unknown>) => {
      let position = opts['position'] as number | undefined;

      if (opts['top']) {
        position = 0;
      } else if (opts['bottom']) {
        position = BOTTOM_POSITION;
      }

      if (position === undefined) {
        console.error('Error: Must specify --position <n>, --top, or --bottom.');
        process.exitCode = 2;
        return;
      }

      await dispatchFromCli(
        'mutate',
        'tasks',
        'reorder',
        { taskId, position },
        { command: 'reorder' },
      );
    });
}
