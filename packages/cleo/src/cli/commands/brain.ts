/**
 * CLI command group: cleo brain
 *
 * Subcommands:
 *   cleo brain maintenance   — run temporal decay + consolidation + embedding backfill
 *
 * @task T143
 * @epic T134
 * @why Provide a single CLI entry point for brain optimization operations
 * @what Parent command group with maintenance subcommand and progress reporting
 */

import { getProjectRoot, runBrainMaintenance } from '@cleocode/core/internal';
import type { ShimCommand as Command } from '../commander-shim.js';

/**
 * Register the `cleo brain` command group.
 *
 * Registers a `brain` parent command and a `maintenance` subcommand that
 * combines temporal decay, memory consolidation, and embedding backfill
 * into one idempotent pass.
 *
 * @param program - The root CLI command to attach to
 *
 * @example
 * ```ts
 * registerBrainCommand(rootCommand);
 * // Adds: cleo brain maintenance [--skip-decay] [--skip-consolidation] [--skip-embeddings] [--json]
 * ```
 */
export function registerBrainCommand(program: Command): void {
  const brain = program.command('brain').description('Brain memory optimization operations');

  brain
    .command('maintenance')
    .description('Run brain maintenance: temporal decay, consolidation, and embedding backfill')
    .option(
      '--skip-decay',
      'Skip the temporal decay step (confidence reduction on stale learnings)',
    )
    .option('--skip-consolidation', 'Skip the memory consolidation step (merging old observations)')
    .option(
      '--skip-embeddings',
      'Skip the embedding backfill step (vector generation for observations)',
    )
    .option('--json', 'Output results as JSON')
    .action(
      async (opts: {
        skipDecay?: boolean;
        skipConsolidation?: boolean;
        skipEmbeddings?: boolean;
        json?: boolean;
      }) => {
        const root = getProjectRoot();
        const isJson = !!opts.json;

        if (!isJson) {
          console.log('Running brain maintenance...');
        }

        try {
          const result = await runBrainMaintenance(root, {
            skipDecay: !!opts.skipDecay,
            skipConsolidation: !!opts.skipConsolidation,
            skipEmbeddings: !!opts.skipEmbeddings,
            onProgress: isJson
              ? undefined
              : (step, current, total) => {
                  if (step === 'embeddings' && total > 0) {
                    // Inline progress for embeddings (the only long-running step)
                    if (process.stdout.isTTY) {
                      process.stdout.clearLine(0);
                      process.stdout.cursorTo(0);
                      process.stdout.write(`  [embeddings] ${current}/${total}...`);
                    } else if (current === 1 || current === total) {
                      console.log(`  [embeddings] ${current}/${total}...`);
                    }
                  } else if (current === 0) {
                    console.log(`  [${step}] starting...`);
                  } else if (current === total && total > 0) {
                    if (step === 'embeddings' && process.stdout.isTTY) {
                      process.stdout.write('\n');
                    }
                    console.log(`  [${step}] done`);
                  }
                },
          });

          if (isJson) {
            console.log(JSON.stringify(result, null, 2));
            return;
          }

          // Human-readable summary
          console.log('\nMaintenance complete.');
          console.log(`  Duration: ${result.duration}ms`);

          if (!opts.skipDecay) {
            console.log(`  Decay:         ${result.decay.affected} learning(s) updated`);
          }
          if (!opts.skipConsolidation) {
            console.log(
              `  Consolidation: ${result.consolidation.merged} merged, ${result.consolidation.removed} archived`,
            );
          }
          if (!opts.skipEmbeddings) {
            console.log(
              `  Embeddings:    ${result.embeddings.processed} processed, ${result.embeddings.skipped} skipped, ${result.embeddings.errors} errors`,
            );
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (isJson) {
            console.log(JSON.stringify({ error: message }));
          } else {
            console.error(`Brain maintenance failed: ${message}`);
          }
          process.exit(1);
        }
      },
    );
}
