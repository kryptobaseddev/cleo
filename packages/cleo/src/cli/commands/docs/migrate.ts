/**
 * `cleo docs migrate` CLI command — the T13360 honest legacy docs migration
 * (spec `cleodocs-rearch-design` §5).
 *
 *   cleo docs migrate          — import legacy docs + history into the
 *                                re-keyed conduit store, inside the T13448
 *                                safety harness (pre-step VACUUM INTO backup,
 *                                before/after fingerprints, COMMIT only on
 *                                full verification)
 *
 * Additive only — nothing is deleted, so no `--force`. Idempotent: a re-run
 * is a verified no-op (docs already in `conduit_doc_migration_ledger` are
 * skipped; every write carries a natural uid). Every imported history row is
 * labeled `origin: migrated`; authors come from the legacy audit log, or the
 * honest `system:migration` attribution when no provenance exists; docs whose
 * content pointers dangle are content-captured when the bytes survive in the
 * blob store, or recorded dangling in the ledger — never silently imported.
 *
 * @task T13360
 * @saga T13339
 */

import { dispatchFromCli } from '../../../dispatch/adapters/cli.js';
import { defineCommand } from '../../lib/define-cli-command.js';

/** `cleo docs migrate` — honest legacy docs import, harness-bracketed. */
export const migrateCommand = defineCommand({
  meta: {
    name: 'migrate',
    description:
      'Migrate legacy docs + history into the re-keyed store (T13360, spec §5): ' +
      'runs inside the migration safety harness (backup → verify → commit/rollback), ' +
      'labels imported rows origin:migrated, content-captures or records dangling ' +
      'docs, and is idempotent (re-runs are verified no-ops).',
  },
  args: {} as const,
  async run() {
    await dispatchFromCli('mutate', 'docs', 'migrate', {}, { command: 'docs migrate' });
  },
});
