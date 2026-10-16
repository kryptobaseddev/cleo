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
import { cliOutput } from '../renderers/index.js';

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
    brief: {
      type: 'boolean',
      description:
        'One line per folder of exported names (nexus graph, else git-tracked walk), within --budget characters (T13666)',
    },
    budget: {
      type: 'string',
      description: 'Character budget for --brief (default 2000)',
    },
  },
  async run({ args }) {
    if (args.brief) {
      const { buildBriefMap, BRIEF_MAP_DEFAULT_BUDGET } = await import(
        '@cleocode/core/nexus/brief-map.js'
      );
      const { getProjectRoot } = await import('@cleocode/core/project-scope');
      const budget = Number.parseInt(String(args.budget ?? ''), 10);
      const report = await buildBriefMap(
        getProjectRoot(),
        Number.isFinite(budget) && budget > 0 ? budget : BRIEF_MAP_DEFAULT_BUDGET,
      );
      cliOutput(report, { command: 'map', operation: 'map.brief' });
      return;
    }
    const gateway = args.store ? 'mutate' : 'query';
    const params: Record<string, unknown> = {};
    if (args.focus) params.focus = args.focus;
    await dispatchFromCli(gateway, 'admin', 'map', params, { command: 'map' });
  },
});
