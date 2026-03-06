/**
 * CLI import-tasks command - import tasks from export package with ID remapping.
 * Thin dispatch wrapper routing to admin.import.tasks.
 *
 * @task T4551, T5323, T5328
 * @epic T4545
 */

import { Command } from 'commander';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

export function registerImportTasksCommand(program: Command): void {
  program
    .command('import-tasks <file>')
    .description('Import tasks from .cleo-export.json package with ID remapping')
    .option('--dry-run', 'Preview import without writing to task data')
    .option('--parent <id>', 'Attach all imported tasks under existing parent')
    .option('--phase <phase>', 'Override phase for all imported tasks')
    .option('--add-label <label>', 'Add label to all imported tasks')
    .option('--no-provenance', 'Skip adding provenance notes')
    .option('--reset-status <status>', 'Reset all task statuses (pending|active|blocked)')
    .option('--on-conflict <mode>', 'Handle duplicate titles: duplicate|rename|skip|fail', 'fail')
    .option('--on-missing-dep <mode>', 'Handle missing deps: strip|placeholder|fail', 'strip')
    .option('--force', 'Skip conflict detection')
    .action(async (file: string, opts: Record<string, unknown>) => {
      await dispatchFromCli('mutate', 'admin', 'import.tasks', {
        file,
        dryRun: opts['dryRun'],
        parent: opts['parent'],
        phase: opts['phase'],
        addLabel: opts['addLabel'],
        provenance: opts['provenance'],
        resetStatus: opts['resetStatus'],
        onConflict: opts['onConflict'],
        onMissingDep: opts['onMissingDep'],
        force: opts['force'],
      }, { command: 'import-tasks' });
    });
}
