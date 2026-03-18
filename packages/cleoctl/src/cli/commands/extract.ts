/**
 * CLI extract command - merge TodoWrite state back to CLEO.
 *
 * Thin CLI wrapper; all business logic lives in @cleocode/core
 * (src/core/task-work/todowrite-merge.ts).
 *
 * @task T4551
 * @epic T4545
 */

import { CleoError, formatError, mergeTodoWriteState } from '@cleocode/core';
import type { Command } from 'commander';
import { cliOutput } from '../renderers/index.js';

/**
 * Register the extract command.
 * @task T4551
 */
export function registerExtractCommand(program: Command): void {
  program
    .command('extract <file>')
    .description('Merge TodoWrite state back to CLEO (session end)')
    .option('--dry-run', 'Show changes without modifying files')
    .option('--default-phase <phase>', 'Override default phase for new tasks')
    .action(async (file: string, opts: Record<string, unknown>) => {
      try {
        const dryRun = (opts['dryRun'] as boolean) ?? false;
        const defaultPhase = opts['defaultPhase'] as string | undefined;

        const result = await mergeTodoWriteState({ file, dryRun, defaultPhase });

        const message =
          result.changes.applied === 0 && !dryRun
            ? 'No changes to apply'
            : dryRun
              ? 'Dry run complete'
              : `Applied ${result.changes.applied} changes`;

        cliOutput(result, { command: 'extract', message });
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });
}
