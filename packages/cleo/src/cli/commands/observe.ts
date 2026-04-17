/**
 * CLI command: cleo observe <text>
 * Saves an observation to brain.db via the dispatch layer.
 *
 * Thin alias for `cleo memory observe <text>`. Both route through
 * the `mutate memory observe` dispatch operation and accept the same options.
 *
 * @task T338 — migrated from custom envelope to canonical CliEnvelope (ADR-039).
 * @task CLI-audit — migrated from direct observeBrain() call to dispatchFromCli.
 */

import { defineCommand } from 'citty';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

/**
 * Root observe command — save an observation to brain.db.
 *
 * Thin alias for `cleo memory observe`. Routes through `mutate memory observe`.
 */
export const observeCommand = defineCommand({
  meta: {
    name: 'observe',
    description:
      'Save an observation to brain.db — captures facts, decisions, and discoveries for cross-session memory',
  },
  args: {
    text: {
      type: 'positional',
      description: 'Observation text to save',
      required: true,
    },
    title: {
      type: 'string',
      alias: 't',
      description: 'Short title for the observation (defaults to first 120 chars of text)',
    },
    type: {
      type: 'string',
      description:
        'Category: discovery (found something new), decision (choice made), bugfix (bug found/fixed), refactor (code restructured), feature (feature added), change (general change), pattern (recurring pattern), session_summary (end-of-session recap)',
    },
    agent: {
      type: 'string',
      description:
        'Name of the agent producing this observation (enables per-agent memory retrieval)',
    },
    'source-type': {
      type: 'string',
      description:
        'How this observation was captured: manual (typed by human/agent), auto (lifecycle hook), transcript (extracted from session)',
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'mutate',
      'memory',
      'observe',
      {
        text: args.text,
        title: args.title as string | undefined,
        ...(args.type !== undefined && { type: args.type }),
        ...(args.agent !== undefined && { agent: args.agent }),
        sourceType: (args['source-type'] as string | undefined) ?? 'manual',
      },
      { command: 'observe', operation: 'memory.observe' },
    );
  },
});
