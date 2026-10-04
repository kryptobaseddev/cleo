/**
 * The change journal's migration-runner hooks (journal spec §2.3a rules 1, 3
 * and 5; T12343, T12775).
 *
 * - Inside each bracket, the capture triggers are dropped before a
 *   migration's statements and regenerated for the new schema before its
 *   COMMIT ({@link captureBracketHooks}).
 * - Before the first pending migration, the rows in baseline (`chash` equal
 *   to the live hash) are recorded ({@link chashBaselineSnapshot}). Inside
 *   each migration's bracket, before its COMMIT, only those rows are
 *   re-baselined, keyed by the new
 *   sync-set version, and nothing is emitted: a migration's backfill is
 *   deterministic and every replica runs it itself. A row that already
 *   diverged (an uncaptured edit) keeps its hash, and its table is marked
 *   suspect for the repair diff ({@link rebaselineChash}).
 *
 * @task T12775
 * @module store/sync/migration-hooks
 */

import type { DatabaseSync } from 'node:sqlite';
import type { TableScope } from '@cleocode/contracts';
import type { MigrationBracketHooks } from '../migration-runner.js';
import { captureBracketHooks } from './capture.js';
import { hasTable } from './schema.js';
import { type ChashSnapshot, chashBaselineSnapshot, rebaselineChash } from './sealer.js';

/**
 * The hooks the canonical open passes to the migration runner for `scope`.
 * The re-baseline runs only on a store that has sealed rows (row meta).
 *
 * @param db - The store being migrated.
 * @param scope - Its scope.
 */
export function syncMigrationHooks(db: DatabaseSync, scope: TableScope): MigrationBracketHooks {
  const hooks: MigrationBracketHooks = { ...captureBracketHooks(db, scope) };
  if (!hasTable(db, '_sync_row_meta')) return hooks;
  // The snapshot is taken before the first pending migration, under the old
  // schema; each re-baseline hands the next one its updated snapshot.
  let snapshot: ChashSnapshot | null = null;
  return {
    ...hooks,
    beforeMigrations: (d) => {
      hooks.beforeMigrations?.(d);
      snapshot = chashBaselineSnapshot(d, scope);
    },
    // Inside each bracket, after the statements and before COMMIT: the
    // re-baseline is part of the migration's transaction, so a crash or a
    // throw rolls both back and the next open runs them again.
    reinstallCapture: (d) => {
      hooks.reinstallCapture?.(d);
      if (snapshot !== null) snapshot = rebaselineChash(d, scope, snapshot).snapshot;
    },
  };
}
