/**
 * CLI commands command — list and query available CLEO commands.
 *
 * DEPRECATED: Use `cleo ops` instead. This command delegates to
 * `admin.help` via the dispatch layer for backwards compatibility.
 *
 * @task T4551, T5671
 * @epic T4545
 */

import { defineCommand } from 'citty';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

/**
 * `cleo commands` — DEPRECATED alias that delegates to `admin.help`.
 *
 * Use `cleo ops` instead. Retained for backwards compatibility only.
 */
export const commandsCommand = defineCommand({
  meta: {
    name: 'commands',
    description: 'DEPRECATED: Use `cleo ops` instead. List and query available CLEO commands',
  },
  args: {
    command: {
      type: 'positional',
      description: 'Command name to look up (optional)',
      required: false,
    },
    category: {
      type: 'string',
      description: 'Filter by category',
      alias: 'c',
    },
    relevance: {
      type: 'string',
      description: 'Filter by agent relevance',
      alias: 'r',
    },
    tier: {
      type: 'string',
      description: 'Help tier level (0=basic, 1=extended, 2=full)',
    },
  },
  async run({ args }) {
    console.error(
      '[DEPRECATED] cleo commands now delegates to admin.help.\nUse: cleo help (CLI)\n',
    );

    await dispatchFromCli(
      'query',
      'admin',
      'help',
      {
        tier: args.tier !== undefined ? Number.parseInt(args.tier, 10) : 0,
        domain: args.command,
        category: args.category,
        relevance: args.relevance,
      },
      { command: 'commands', operation: 'admin.help' },
    );
  },
});
