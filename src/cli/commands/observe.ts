/**
 * CLI command: cleo observe <text>
 * Saves an observation to brain.db via the memory system.
 *
 * Provides CLI parity for the MCP `mutate memory observe` operation.
 */

import { getProjectRoot } from '@cleocode/core';
import type { Command } from 'commander';

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
      const { observeBrain } = await import('../../core/memory/brain-retrieval.js');

      try {
        const result = await observeBrain(projectDir, {
          text,
          title: opts.title,
          type: opts.type as Parameters<typeof observeBrain>[1]['type'],
          sourceType: 'manual',
        });

        process.stdout.write(
          JSON.stringify({
            success: true,
            result: {
              id: result.id,
              type: result.type,
              createdAt: result.createdAt,
            },
          }) + '\n',
        );
      } catch (err) {
        process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exitCode = 1;
      }
    });
}
