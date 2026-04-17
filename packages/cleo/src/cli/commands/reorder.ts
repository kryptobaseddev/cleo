/**
 * CLI command for changing task position within a sibling group.
 *
 * @task T4454
 */

import { defineCommand } from 'citty';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

/** Sentinel value for --bottom: moves task to end of sibling list. */
const BOTTOM_POSITION = 999999;

/**
 * cleo reorder — change task position within sibling group.
 *
 * Supports `--top` (position 0), `--bottom` (position 999999), or
 * explicit `--position <n>` for precise placement.
 */
export const reorderCommand = defineCommand({
  meta: { name: 'reorder', description: 'Change task position within sibling group' },
  args: {
    'task-id': {
      type: 'positional',
      description: 'Task ID to reorder',
      required: true,
    },
    position: {
      type: 'string',
      description: 'Move to specific zero-based position among siblings',
    },
    top: {
      type: 'boolean',
      description: 'Move to the top (position 0)',
    },
    bottom: {
      type: 'boolean',
      description: 'Move to the bottom',
    },
  },
  async run({ args }) {
    const taskId = args['task-id'];
    let position: number | undefined;

    if (args.top) {
      position = 0;
    } else if (args.bottom) {
      position = BOTTOM_POSITION;
    } else if (args.position !== undefined) {
      position = Number.parseInt(args.position, 10);
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
  },
});
