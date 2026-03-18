/**
 * CLI snapshot command - Export/import task state for multi-contributor sharing.
 * Thin dispatch wrapper routing to admin.snapshot.export and admin.snapshot.import.
 *
 * @task T4882, T5323, T5328
 */

import type { Command } from 'commander';
import { dispatchFromCli, dispatchRaw, handleRawError } from '../../dispatch/adapters/cli.js';

export function registerSnapshotCommand(program: Command): void {
  const snapshot = program
    .command('snapshot')
    .description('Export/import task state snapshots for multi-contributor sharing');

  snapshot
    .command('export')
    .description('Export current task state to a portable JSON snapshot')
    .option(
      '-o, --output <file>',
      'Output file path (default: .cleo/snapshots/snapshot-<timestamp>.json)',
    )
    .option('--stdout', 'Write snapshot to stdout instead of file')
    .action(async (opts: Record<string, unknown>) => {
      if (opts['stdout']) {
        // Write snapshot JSON to stdout for piping
        const response = await dispatchRaw('query', 'admin', 'export', { scope: 'snapshot' });
        handleRawError(response, { command: 'snapshot', operation: 'admin.export' });
        const data = response.data as
          | { taskCount?: number; outputPath?: string; checksum?: string }
          | undefined;
        // Re-read the snapshot from the output path to write to stdout
        if (data?.outputPath) {
          const { readFile } = await import('node:fs/promises');
          const content = await readFile(data.outputPath, 'utf-8');
          process.stdout.write(content);
          if (!content.endsWith('\n')) process.stdout.write('\n');
        }
        return;
      }

      await dispatchFromCli(
        'query',
        'admin',
        'export',
        {
          scope: 'snapshot',
          output: opts['output'],
        },
        { command: 'snapshot' },
      );
    });

  snapshot
    .command('import <file>')
    .description('Import a task state snapshot into the local database')
    .option('--dry-run', 'Preview import without making changes')
    .action(async (file: string, opts: Record<string, unknown>) => {
      await dispatchFromCli(
        'mutate',
        'admin',
        'import',
        {
          scope: 'snapshot',
          file,
          dryRun: opts['dryRun'],
        },
        { command: 'snapshot' },
      );
    });
}
