/**
 * CLI command: cleo observe <text>
 * Saves an observation to brain.db via the dispatch layer.
 *
 * Convenience alias for `cleo memory observe <text>`. Both route through
 * the `mutate memory observe` dispatch operation.
 *
 * @task T338 — migrated from custom envelope to canonical CliEnvelope (ADR-039).
 * @task CLI-audit — migrated from direct observeBrain() call to dispatchFromCli.
 */

import { dispatchFromCli } from '../../dispatch/adapters/cli.js';
import type { ShimCommand as Command } from '../commander-shim.js';

export function registerObserveCommand(program: Command): void {
  program
    .command('observe <text>')
    .description('Save an observation to brain.db')
    .option('-t, --title <title>', 'Optional title (defaults to first 120 chars of text)')
    .option(
      '--type <type>',
      'Observation type (discovery, decision, bugfix, refactor, feature, change, pattern, session_summary)',
    )
    .action(async (text: string, opts: { title?: string; type?: string }) => {
      await dispatchFromCli(
        'mutate',
        'memory',
        'observe',
        {
          text,
          title: opts.title,
          ...(opts.type !== undefined && { type: opts.type }),
          sourceType: 'manual',
        },
        { command: 'observe', operation: 'memory.observe' },
      );
    });
}
