/**
 * CLI command for importing tasks from an export package.
 *
 * Dispatches to `admin.import` via dispatchFromCli.
 *
 * @task T4454, T5323, T5328
 */

import { defineCommand } from 'citty';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

/**
 * cleo import <file> — import tasks from an export package.
 *
 * Supports duplicate handling strategies, phase/parent assignment,
 * label injection, and dry-run preview mode.
 */
export const importCommand = defineCommand({
  meta: {
    name: 'import',
    description: 'Import tasks from export package',
  },
  args: {
    file: {
      type: 'positional',
      description: 'Path to export package file',
      required: true,
    },
    parent: {
      type: 'string',
      description: 'Assign imported tasks to a parent',
    },
    phase: {
      type: 'string',
      description: 'Assign phase to imported tasks',
    },
    'on-duplicate': {
      type: 'string',
      description: 'Handle duplicates: skip, overwrite, rename',
      default: 'skip',
    },
    'add-label': {
      type: 'string',
      description: 'Add label to all imported tasks',
    },
    'dry-run': {
      type: 'boolean',
      description: 'Preview import without changes',
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'mutate',
      'admin',
      'import',
      {
        file: args.file,
        parent: args.parent,
        phase: args.phase,
        onDuplicate: args['on-duplicate'],
        addLabel: args['add-label'],
        dryRun: args['dry-run'],
      },
      { command: 'import' },
    );
  },
});
