/**
 * CLI map command - codebase analysis and mapping.
 *
 * Analyzes codebase structure and returns a structured mapping. Optionally
 * stores findings to brain.db when `--store` is given.
 *
 * @epic cognitive-cleo
 * @task T487
 */

import { defineCommand } from 'citty';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

/**
 * cleo map — analyze codebase structure and return structured mapping.
 *
 * Dispatches to `admin.map` via the query (or mutate when `--store`) gateway.
 */
export const mapCommand = defineCommand({
  meta: { name: 'map', description: 'Analyze codebase structure and return structured mapping' },
  args: {
    store: {
      type: 'boolean',
      description: 'Store findings to brain.db',
    },
    focus: {
      type: 'string',
      description:
        'Focus on one area: stack, architecture, structure, conventions, testing, integrations, concerns',
    },
  },
  async run({ args }) {
    const gateway = args.store ? 'mutate' : 'query';
    const params: Record<string, unknown> = {};
    if (args.focus) params.focus = args.focus;
    await dispatchFromCli(gateway, 'admin', 'map', params, { command: 'map' });
  },
});
