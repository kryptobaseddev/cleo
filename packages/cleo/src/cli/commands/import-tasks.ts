/**
 * CLI command for importing tasks from a .cleo-export.json package with ID remapping.
 *
 * Dispatches to `admin.import` with `scope: 'tasks'` via dispatchFromCli.
 *
 * @task T4551, T5323, T5328
 * @epic T4545
 */

import { defineCommand } from 'citty';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

/**
 * cleo import-tasks <file> — import tasks from .cleo-export.json with ID remapping.
 *
 * Supports conflict resolution, dependency handling, phase/parent/label overrides,
 * provenance control, status reset, and dry-run preview mode.
 */
export const importTasksCommand = defineCommand({
  meta: {
    name: 'import-tasks',
    description: 'Import tasks from .cleo-export.json package with ID remapping',
  },
  args: {
    file: {
      type: 'positional',
      description: 'Path to .cleo-export.json package',
      required: true,
    },
    'dry-run': {
      type: 'boolean',
      description: 'Preview import without writing to task data',
    },
    parent: {
      type: 'string',
      description: 'Attach all imported tasks under existing parent',
    },
    phase: {
      type: 'string',
      description: 'Override phase for all imported tasks',
    },
    'add-label': {
      type: 'string',
      description: 'Add label to all imported tasks',
    },
    'no-provenance': {
      type: 'boolean',
      description: 'Skip adding provenance notes',
    },
    'reset-status': {
      type: 'string',
      description: 'Reset all task statuses (pending|active|blocked)',
    },
    'on-conflict': {
      type: 'string',
      description: 'Handle duplicate titles: duplicate|rename|skip|fail',
      default: 'fail',
    },
    'on-missing-dep': {
      type: 'string',
      description: 'Handle missing deps: strip|placeholder|fail',
      default: 'strip',
    },
    force: {
      type: 'boolean',
      description: 'Skip conflict detection',
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'mutate',
      'admin',
      'import',
      {
        scope: 'tasks',
        file: args.file,
        dryRun: args['dry-run'],
        parent: args.parent,
        phase: args.phase,
        addLabel: args['add-label'],
        provenance: args['no-provenance'] ? false : undefined,
        resetStatus: args['reset-status'],
        onConflict: args['on-conflict'],
        onMissingDep: args['on-missing-dep'],
        force: args.force,
      },
      { command: 'import-tasks' },
    );
  },
});
