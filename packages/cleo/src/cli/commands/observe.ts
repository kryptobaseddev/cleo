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

import { dispatchFromCli } from '../../dispatch/adapters/cli.js';
import type { ShimCommand as Command } from '../commander-shim.js';

export function registerObserveCommand(program: Command): void {
  program
    .command('observe <text>')
    .description(
      'Save an observation to brain.db — captures facts, decisions, and discoveries for cross-session memory',
    )
    .option(
      '-t, --title <title>',
      'Short title for the observation (defaults to first 120 chars of text)',
    )
    .option(
      '--type <type>',
      'Category: discovery (found something new), decision (choice made), bugfix (bug found/fixed), refactor (code restructured), feature (feature added), change (general change), pattern (recurring pattern), session_summary (end-of-session recap)',
    )
    .option(
      '--agent <name>',
      'Name of the agent producing this observation (enables per-agent memory retrieval)',
    )
    .option(
      '--source-type <sourceType>',
      'How this observation was captured: manual (typed by human/agent), auto (lifecycle hook), transcript (extracted from session)',
    )
    .action(
      async (
        text: string,
        opts: { title?: string; type?: string; agent?: string; sourceType?: string },
      ) => {
        await dispatchFromCli(
          'mutate',
          'memory',
          'observe',
          {
            text,
            title: opts.title,
            ...(opts.type !== undefined && { type: opts.type }),
            ...(opts.agent !== undefined && { agent: opts.agent }),
            sourceType: opts.sourceType ?? 'manual',
          },
          { command: 'observe', operation: 'memory.observe' },
        );
      },
    );
}
