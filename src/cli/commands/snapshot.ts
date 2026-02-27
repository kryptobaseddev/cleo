/**
 * CLI snapshot command - Export/import task state for multi-contributor sharing.
 *
 * @task T4882
 */

import { Command } from 'commander';
import { formatError } from '../../core/output.js';
import { cliOutput } from '../renderers/index.js';
import { CleoError } from '../../core/errors.js';
import {
  exportSnapshot,
  writeSnapshot,
  readSnapshot,
  importSnapshot,
  getDefaultSnapshotPath,
} from '../../core/snapshot/index.js';

/**
 * Register the snapshot command with export and import subcommands.
 * @task T4882
 */
export function registerSnapshotCommand(program: Command): void {
  const snapshot = program
    .command('snapshot')
    .description('Export/import task state snapshots for multi-contributor sharing');

  snapshot
    .command('export')
    .description('Export current task state to a portable JSON snapshot')
    .option('-o, --output <file>', 'Output file path (default: .cleo/snapshots/snapshot-<timestamp>.json)')
    .option('--stdout', 'Write snapshot to stdout instead of file')
    .action(async (opts: Record<string, unknown>) => {
      try {
        const snapshot = await exportSnapshot();

        if (opts['stdout']) {
          const output = JSON.stringify(snapshot, null, 2);
          process.stdout.write(output);
          if (!output.endsWith('\n')) process.stdout.write('\n');
          return;
        }

        const outputPath = (opts['output'] as string) ?? getDefaultSnapshotPath();
        await writeSnapshot(snapshot, outputPath);

        cliOutput({
          exported: true,
          taskCount: snapshot._meta.taskCount,
          outputPath,
          checksum: snapshot._meta.checksum,
        }, { command: 'snapshot', message: `Exported ${snapshot._meta.taskCount} task(s) to ${outputPath}` });
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });

  snapshot
    .command('import <file>')
    .description('Import a task state snapshot into the local database')
    .option('--dry-run', 'Preview import without making changes')
    .action(async (file: string, opts: Record<string, unknown>) => {
      try {
        const snapshotData = await readSnapshot(file);

        if (opts['dryRun']) {
          cliOutput({
            dryRun: true,
            source: snapshotData._meta.source,
            taskCount: snapshotData._meta.taskCount,
            createdAt: snapshotData._meta.createdAt,
          }, { command: 'snapshot', message: `Would import ${snapshotData._meta.taskCount} task(s) from ${file}` });
          return;
        }

        const result = await importSnapshot(snapshotData);

        cliOutput({
          imported: true,
          added: result.added,
          updated: result.updated,
          skipped: result.skipped,
          conflicts: result.conflicts.length > 0 ? result.conflicts : undefined,
        }, {
          command: 'snapshot',
          message: `Imported: ${result.added} added, ${result.updated} updated, ${result.skipped} skipped`
            + (result.conflicts.length > 0 ? `, ${result.conflicts.length} conflict(s)` : ''),
        });
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });
}
