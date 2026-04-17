/**
 * CLI phases command group — deprecated wrapper around `cleo phase`.
 *
 * Subcommands dispatch to `pipeline.phase.*` registry operations.
 * The `list` subcommand is the default when no subcommand is given.
 *
 * @deprecated Use `cleo phase` instead.
 * @task T4538, T5326
 * @epic T4454, T5323
 */

import { defineCommand } from 'citty';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

/** cleo phases list — list all phases with progress bars (default) */
const listCommand = defineCommand({
  meta: { name: 'list', description: 'List all phases with progress (default)' },
  async run() {
    console.error('[DEPRECATED] cleo phases is deprecated. Use: cleo phase list');
    await dispatchFromCli('query', 'pipeline', 'phase.list', {}, { command: 'phases' });
  },
});

/** cleo phases show <phase> — show phase details and task counts */
const showCommand = defineCommand({
  meta: { name: 'show', description: 'Show phase details and task counts' },
  args: {
    phase: {
      type: 'positional',
      description: 'Phase ID to show',
      required: true,
    },
  },
  async run({ args }) {
    console.error('[DEPRECATED] cleo phases is deprecated. Use: cleo phase show');
    await dispatchFromCli(
      'query',
      'pipeline',
      'phase.show',
      { phaseId: args.phase },
      { command: 'phases' },
    );
  },
});

/** cleo phases stats — show detailed phase statistics */
const statsCommand = defineCommand({
  meta: { name: 'stats', description: 'Show detailed phase statistics' },
  async run() {
    console.error('[DEPRECATED] cleo phases is deprecated. Use: cleo phase list');
    await dispatchFromCli('query', 'pipeline', 'phase.list', {}, { command: 'phases' });
  },
});

/**
 * Root phases command group — deprecated; use `cleo phase` instead.
 *
 * Defaults to `list` when invoked with no subcommand.
 */
export const phasesCommand = defineCommand({
  meta: {
    name: 'phases',
    description:
      'DEPRECATED: Use `cleo phase` instead. List phases with progress bars and statistics',
  },
  subCommands: {
    list: listCommand,
    show: showCommand,
    stats: statsCommand,
  },
  async run(ctx) {
    await listCommand.run?.(ctx as Parameters<NonNullable<typeof listCommand.run>>[0]);
  },
});
