/**
 * CLI command: cleo backfill
 *
 * Retroactively adds acceptance criteria and verification metadata to
 * existing tasks that were created before T058 (AC enforcement) and
 * T061 (verification gate auto-init).
 *
 * Also supports retroactive embedding of existing brain observations
 * via the --embeddings flag (T142).
 *
 * Usage:
 *   cleo backfill            -- apply changes (defaults to dry-run prompt)
 *   cleo backfill --dry-run  -- preview without modifying
 *   cleo backfill --rollback -- revert a previous backfill
 *   cleo backfill --embeddings -- backfill embeddings for brain observations
 *
 * @epic T056
 * @task T066
 * @task T142
 */

import { backfillTasks, getProjectRoot, populateEmbeddings } from '@cleocode/core/internal';
import type { ShimCommand as Command } from '../commander-shim.js';

/**
 * Register the `cleo backfill` CLI command.
 *
 * @remarks
 * Wires the backfill module from core into the CLI command tree.
 * Supports both task AC/verification backfill and embedding backfill.
 *
 * @param program - The root CLI command to attach to
 *
 * @example
 * ```ts
 * registerBackfillCommand(rootCommand);
 * // Adds: cleo backfill [--dry-run] [--rollback] [--embeddings]
 * ```
 */
export function registerBackfillCommand(program: Command): void {
  program
    .command('backfill')
    .description(
      'Retroactively add acceptance criteria and verification metadata to existing tasks',
    )
    .option('--dry-run', 'Show what would be changed without modifying any tasks')
    .option('--rollback', 'Revert a previous backfill (clear auto-generated AC and verification)')
    .option(
      '--tasks <ids>',
      'Comma-separated list of task IDs to restrict backfill to (e.g. T001,T002)',
    )
    .option(
      '--embeddings',
      'Retroactively generate embeddings for brain observations that lack them',
    )
    .action(
      async (opts: {
        dryRun?: boolean;
        rollback?: boolean;
        tasks?: string;
        embeddings?: boolean;
      }) => {
        const root = getProjectRoot();

        // --embeddings mode: embedding backfill for brain observations
        if (opts.embeddings) {
          try {
            let lastLine = '';
            const result = await populateEmbeddings(root, {
              onProgress: (current, total) => {
                // Overwrite current line for progress display
                if (process.stdout.isTTY) {
                  process.stdout.clearLine(0);
                  process.stdout.cursorTo(0);
                  process.stdout.write(`Embedding ${current}/${total}...`);
                } else {
                  const line = `Embedding ${current}/${total}...`;
                  if (line !== lastLine) {
                    console.log(line);
                    lastLine = line;
                  }
                }
              },
            });

            // Move to new line after inline progress
            if (process.stdout.isTTY && result.processed + result.skipped + result.errors > 0) {
              process.stdout.write('\n');
            }

            if (result.processed === 0 && result.skipped === 0 && result.errors === 0) {
              console.log(
                'No observations to embed (provider unavailable or nothing to backfill).',
              );
              return;
            }

            console.log(
              `Processed ${result.processed}, skipped ${result.skipped}, errors ${result.errors}`,
            );
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(`Embedding backfill failed: ${message}`);
            process.exit(1);
          }
          return;
        }

        // Default mode: task AC/verification backfill
        const dryRun = !!opts.dryRun;
        const rollback = !!opts.rollback;
        const taskIds = opts.tasks?.trim()
          ? opts.tasks
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean)
          : undefined;

        if (dryRun) {
          console.log('[dry run] No changes will be made.\n');
        }
        if (rollback) {
          console.log('[rollback] Reverting previously backfilled tasks.\n');
        }

        try {
          const result = await backfillTasks(root, { dryRun, rollback, taskIds });

          console.log(`Scanned: ${result.tasksScanned} task(s)`);
          console.log(`Changed: ${result.tasksChanged} task(s)`);

          if (!rollback) {
            console.log(`  AC added:           ${result.acAdded}`);
            console.log(`  Verification added: ${result.verificationAdded}`);
          }

          if (result.changes.length === 0) {
            console.log('\nNothing to do — all tasks already have AC and verification metadata.');
            return;
          }

          console.log('\nDetails:');
          for (const change of result.changes) {
            const parts: string[] = [];
            if (change.addedAc) parts.push('AC');
            if (change.addedVerification) parts.push('verification');
            if (change.addedNote) parts.push('note');
            if (change.rolledBack && change.rolledBack.length > 0) {
              parts.push(`rolled back [${change.rolledBack.join(', ')}]`);
            }

            console.log(`  ${change.taskId}: ${change.title}`);
            console.log(`    Actions: ${parts.join(', ')}`);

            if (change.addedAc && change.generatedAc.length > 0) {
              console.log('    Generated AC:');
              for (const ac of change.generatedAc) {
                console.log(`      - ${ac}`);
              }
            }
          }

          if (dryRun) {
            console.log('\n[dry run] Run without --dry-run to apply these changes.');
          } else {
            console.log('\nBackfill complete.');
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`Backfill failed: ${message}`);
          process.exit(1);
        }
      },
    );
}
