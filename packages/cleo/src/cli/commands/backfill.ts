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
import { defineCommand } from 'citty';
import { cliError, cliOutput } from '../renderers/index.js';

/**
 * Native citty command for `cleo backfill`.
 *
 * @remarks
 * Wires the backfill module from core into the CLI command tree.
 * Supports both task AC/verification backfill and embedding backfill.
 *
 * @example
 * ```ts
 * // Registered in index.ts as:
 * // backfill: backfillCommand
 * // Adds: cleo backfill [--dry-run] [--rollback] [--embeddings]
 * ```
 */
export const backfillCommand = defineCommand({
  meta: {
    name: 'backfill',
    description:
      'Retroactively add acceptance criteria and verification metadata to existing tasks',
  },
  args: {
    'dry-run': {
      type: 'boolean',
      description: 'Show what would be changed without modifying any tasks',
      default: false,
    },
    rollback: {
      type: 'boolean',
      description: 'Revert a previous backfill (clear auto-generated AC and verification)',
      default: false,
    },
    tasks: {
      type: 'string',
      description: 'Comma-separated list of task IDs to restrict backfill to (e.g. T001,T002)',
    },
    embeddings: {
      type: 'boolean',
      description: 'Retroactively generate embeddings for brain observations that lack them',
      default: false,
    },
  },
  async run({ args }) {
    const root = getProjectRoot();

    // --embeddings mode: embedding backfill for brain observations
    if (args.embeddings) {
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
          cliOutput(
            {
              processed: 0,
              skipped: 0,
              errors: 0,
              message: 'No observations to embed (provider unavailable or nothing to backfill).',
            },
            { command: 'backfill', operation: 'admin.backfill', message: 'Nothing to embed' },
          );
          return;
        }

        cliOutput(
          { processed: result.processed, skipped: result.skipped, errors: result.errors },
          {
            command: 'backfill',
            operation: 'admin.backfill',
            message: `Processed ${result.processed}, skipped ${result.skipped}, errors ${result.errors}`,
          },
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        cliError(
          `Embedding backfill failed: ${message}`,
          'E_INTERNAL',
          {
            name: 'E_INTERNAL',
          },
          { operation: 'admin.backfill' },
        );
        process.exit(1);
      }
      return;
    }

    // Default mode: task AC/verification backfill
    const dryRun = !!args['dry-run'];
    const rollback = !!args.rollback;
    const taskIds = args.tasks?.trim()
      ? args.tasks
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined;

    // Safety: require --dry-run or explicit confirmation for destructive backfill
    if (!dryRun && !rollback && !process.env['CLEO_NONINTERACTIVE']) {
      process.stderr.write(
        'Warning: Backfill will modify tasks in-place. Run with --dry-run first to preview changes.\n' +
          '  Set CLEO_NONINTERACTIVE=1 or pass --dry-run to suppress this warning.\n\n',
      );
    }

    try {
      const result = await backfillTasks(root, { dryRun, rollback, taskIds });

      const output: Record<string, unknown> = {
        dryRun,
        rollback,
        tasksScanned: result.tasksScanned,
        tasksChanged: result.tasksChanged,
        changes: result.changes,
      };

      if (!rollback) {
        output['acAdded'] = result.acAdded;
        output['verificationAdded'] = result.verificationAdded;
      }

      const messagePrefix = dryRun ? '[dry run] ' : rollback ? '[rollback] ' : '';
      const messageSuffix =
        result.changes.length === 0
          ? 'Nothing to do — all tasks already have AC and verification metadata.'
          : `Scanned ${result.tasksScanned}, changed ${result.tasksChanged} task(s).`;

      cliOutput(output, {
        command: 'backfill',
        operation: 'admin.backfill',
        message: `${messagePrefix}${messageSuffix}`,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      cliError(
        `Backfill failed: ${message}`,
        'E_INTERNAL',
        {
          name: 'E_INTERNAL',
        },
        { operation: 'admin.backfill' },
      );
      process.exit(1);
    }
  },
});
