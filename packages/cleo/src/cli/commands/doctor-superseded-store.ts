/**
 * `cleo doctor superseded-store` — answer "which database is the real one?".
 *
 * After the E6 dual-scope migration (ADR-068) a project's store is
 * `.cleo/cleo.db`, with task rows in PREFIXED tables (`tasks_tasks`, …). The
 * pre-migration `.cleo/tasks.db` is left on disk under the name that every doc,
 * ADR-013 §9 note, and `cleo restore backup --file tasks.db` invocation still
 * uses — and snapshots are written as `tasks-<ts>.db` while actually
 * snapshotting `cleo.db`. A 408 KB `tasks.db` therefore sits beside 58 MB files
 * bearing its own name, which reads exactly like a truncated live database.
 *
 * Measured 2026-08-09: an agent in a project with 1,123 healthy tasks looped on
 * "the current tasks.db is 417KB, much smaller than the backups (58MB) — maybe
 * it was rotated/rebuilt", and moved on to guessing the store might be
 * `llmtxt.db`. The data was fine. This command exists so that question costs one
 * call: it names the superseded file and PROVES which store is authoritative by
 * counting rows in both.
 *
 * Read-only by default. It never deletes anything — the recommendation is
 * printed and the operator decides.
 *
 * `--reconcile` (T12319) copies the rows a superseded file still holds that
 * are missing from `cleo.db`, through the exodus copy engine: additive only,
 * verified by key afterwards, reverted on any mismatch, legacy file left in
 * place, receipt written. `--dry-run` reports what it would copy.
 *
 * @task T12095
 * @task T12319
 * @see ADR-068 — dual-scope DB chokepoint
 */

import { getProjectRoot } from '@cleocode/core';
import { scanSupersededStores } from '@cleocode/core/doctor/superseded-store.js';
import { reconcileSupersededStores } from '@cleocode/core/store/exodus/index.js';
import { defineCommand } from '../lib/define-cli-command.js';
import { cliError, cliOutput } from '../renderers/index.js';

/**
 * `cleo doctor superseded-store` subcommand.
 *
 * Exits non-zero when at least one superseded file is present, so it can gate a
 * cleanup step in a script. A clean project exits 0 with an empty list.
 *
 * @task T12095
 */
export const doctorSupersededStoreCommand = defineCommand({
  meta: {
    name: 'superseded-store',
    description:
      'Report pre-dual-scope store files (.cleo/tasks.db, .cleo/brain.db) still on disk under ' +
      'their old LIVE names after the cleo.db migration, proving which store holds the data. ' +
      'Read-only — deletes nothing.',
  },
  args: {
    reconcile: {
      type: 'boolean',
      description:
        'Copy rows the superseded files hold that are missing from cleo.db (additive, verified, ' +
        'reverted on mismatch; legacy files are never touched). Writes a receipt.',
    },
    'dry-run': {
      type: 'boolean',
      description:
        'With --reconcile: report per-table counts and what would be copied; write nothing',
    },
    json: { type: 'boolean', description: 'Output as JSON' },
    human: { type: 'boolean', description: 'Force human-readable output' },
    quiet: { type: 'boolean', description: 'Suppress non-essential output' },
  },
  async run({ args }) {
    if (args.reconcile === true) {
      const receipt = await reconcileSupersededStores(getProjectRoot(), {
        dryRun: args['dry-run'] === true,
      });
      if (receipt.outcome === 'refused') {
        cliError(receipt.reason, 'E_RECONCILE_REFUSED', {
          details: receipt,
          fix: `Inspect ${receipt.receiptPath ?? 'the receipt'}; the legacy files are unchanged, so it is safe to retry after fixing the cause.`,
        });
        process.exitCode = 1;
        return;
      }
      cliOutput(
        { kind: 'generic', ...receipt },
        {
          command: 'doctor',
          operation: 'doctor.superseded-store.reconcile',
          message: receipt.reason,
        },
      );
      return;
    }

    const result = scanSupersededStores(getProjectRoot());

    cliOutput(result, {
      command: 'doctor',
      operation: 'doctor.superseded-store.run',
    });

    if (result.entries.length > 0 && (process.exitCode === undefined || process.exitCode === 0)) {
      process.exitCode = 1;
    }
  },
});
