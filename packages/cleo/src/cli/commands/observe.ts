/**
 * CLI command: cleo observe <text>
 * Saves an observation to brain.db via the memory system.
 *
 * Provides CLI parity for the `mutate memory observe` dispatch operation.
 *
 * @task T338 — migrated from custom {success, result} envelope to canonical
 *   CliEnvelope via cliOutput() (ADR-039).
 */

import { getProjectRoot } from '@cleocode/core';
import type { ShimCommand as Command } from '../commander-shim.js';
import { cliError, cliOutput } from '../renderers/index.js';

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
      const projectDir = getProjectRoot();
      const { observeBrain } = await import('@cleocode/core');

      try {
        const result = await observeBrain(projectDir, {
          text,
          title: opts.title,
          type: opts.type as Parameters<typeof observeBrain>[1]['type'],
          sourceType: 'manual',
        });

        // Use cliOutput to emit the canonical CliEnvelope shape (ADR-039).
        // Replaces the previous custom {success, result} output.
        cliOutput(
          {
            id: result.id,
            type: result.type,
            createdAt: result.createdAt,
          },
          { command: 'observe', operation: 'memory.observe' },
        );
      } catch (err) {
        cliError(err instanceof Error ? err.message : String(err), 1);
        process.exitCode = 1;
      }
    });
}
