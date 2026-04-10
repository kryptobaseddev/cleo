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
    .description('Save an observation to brain.db (alias for `cleo memory observe`)')
    .option('-t, --title <title>', 'Optional title (defaults to first 120 chars of text)')
    .option(
      '--type <type>',
      'Observation type (discovery, decision, bugfix, refactor, feature, change, pattern, session_summary)',
    )
    .option(
      '--agent <name>',
      'Tag this observation with the producing agent name (Wave 8 mental models)',
    )
    .option('--source-type <sourceType>', 'Source type override (default: manual)')
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
