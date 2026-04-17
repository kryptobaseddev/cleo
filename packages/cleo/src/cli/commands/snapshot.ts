/**
 * CLI snapshot command — export/import task state for multi-contributor sharing.
 *
 * Thin dispatch wrapper routing to admin.snapshot.export and admin.snapshot.import.
 *
 *   cleo snapshot export  — export current task state to a portable JSON snapshot
 *   cleo snapshot import  — import a task state snapshot into the local database
 *
 * @task T4882, T5323, T5328
 */

import { defineCommand, showUsage } from 'citty';
import { dispatchFromCli, dispatchRaw, handleRawError } from '../../dispatch/adapters/cli.js';

/** cleo snapshot export — export current task state to a portable JSON snapshot */
const exportCommand = defineCommand({
  meta: { name: 'export', description: 'Export current task state to a portable JSON snapshot' },
  args: {
    output: {
      type: 'string',
      description: 'Output file path (default: .cleo/snapshots/snapshot-<timestamp>.json)',
      alias: 'o',
    },
    stdout: {
      type: 'boolean',
      description: 'Write snapshot to stdout instead of file',
    },
  },
  async run({ args }) {
    if (args.stdout) {
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
        output: args.output,
      },
      { command: 'snapshot' },
    );
  },
});

/** cleo snapshot import — import a task state snapshot into the local database */
const importCommand = defineCommand({
  meta: {
    name: 'import',
    description: 'Import a task state snapshot into the local database',
  },
  args: {
    file: {
      type: 'positional',
      description: 'Snapshot file to import',
      required: true,
    },
    'dry-run': {
      type: 'boolean',
      description: 'Preview import without making changes',
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'mutate',
      'admin',
      'import',
      {
        scope: 'snapshot',
        file: args.file,
        dryRun: args['dry-run'],
      },
      { command: 'snapshot' },
    );
  },
});

/**
 * Root snapshot command group — export/import task state snapshots.
 *
 * Dispatches to `admin.export` and `admin.import` registry operations.
 */
export const snapshotCommand = defineCommand({
  meta: {
    name: 'snapshot',
    description: 'Export/import task state snapshots for multi-contributor sharing',
  },
  subCommands: {
    export: exportCommand,
    import: importCommand,
  },
  async run({ cmd, rawArgs }) {
    const firstArg = rawArgs?.find((a) => !a.startsWith('-'));
    if (firstArg && cmd.subCommands && firstArg in cmd.subCommands) return;
    await showUsage(cmd);
  },
});
