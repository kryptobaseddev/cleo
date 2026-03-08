/**
 * CLI import command - import tasks from export package.
 * Thin dispatch wrapper routing to admin.import.
 *
 * @task T4454, T5323, T5328
 */

import type { Command } from 'commander';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

export function registerImportCommand(program: Command): void {
  program
    .command('import <file>')
    .description('Import tasks from export package')
    .option('--parent <id>', 'Assign imported tasks to a parent')
    .option('--phase <phase>', 'Assign phase to imported tasks')
    .option('--on-duplicate <strategy>', 'Handle duplicates: skip, overwrite, rename', 'skip')
    .option('--add-label <label>', 'Add label to all imported tasks')
    .option('--dry-run', 'Preview import without changes')
    .action(async (file: string, opts: Record<string, unknown>) => {
      await dispatchFromCli(
        'mutate',
        'admin',
        'import',
        {
          file,
          parent: opts['parent'],
          phase: opts['phase'],
          onDuplicate: opts['onDuplicate'],
          addLabel: opts['addLabel'],
          dryRun: opts['dryRun'],
        },
        { command: 'import' },
      );
    });
}
