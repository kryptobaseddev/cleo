/**
 * CLI inject command - prepare tasks for external injection.
 * @task T4539
 * @epic T4454
 */

import { defineCommand } from 'citty';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

/**
 * Root inject command — prepare tasks for external system injection.
 *
 * Dispatches to `admin.inject.generate`.
 */
export const injectCommand = defineCommand({
  meta: { name: 'inject', description: 'Prepare tasks for external system injection' },
  args: {
    'max-tasks': {
      type: 'string',
      description: 'Maximum tasks to inject',
      default: '8',
    },
    'focused-only': {
      type: 'boolean',
      description: 'Only inject the focused task',
      default: false,
    },
    phase: {
      type: 'string',
      description: 'Filter tasks to specific phase',
    },
    output: {
      type: 'string',
      description: 'Write to file instead of stdout',
    },
    'save-state': {
      type: 'boolean',
      description: 'Save session state for extraction',
      default: true,
    },
    'dry-run': {
      type: 'boolean',
      description: 'Preview without writing',
      default: false,
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'mutate',
      'admin',
      'inject.generate',
      {
        maxTasks: Number.parseInt(args['max-tasks'], 10),
        focusedOnly: args['focused-only'],
        phase: args.phase as string | undefined,
        output: args.output as string | undefined,
        saveState: args['save-state'],
        dryRun: args['dry-run'],
      },
      { command: 'inject' },
    );
  },
});
