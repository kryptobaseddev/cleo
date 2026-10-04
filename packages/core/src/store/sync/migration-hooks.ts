/**
 * The change journal's migration-runner hooks (journal spec §2.3a rules 1, 3
 * and 5; T12343, T12775).
 *
 * - Inside each bracket, the capture triggers are dropped before a
 *   migration's statements and regenerated for the new schema before its
 *   COMMIT ({@link captureBracketHooks}).
 * - After each migration, `_sync_row_meta.chash` is re-baselined to the live
 *   rows, keyed by the new sync-set version, and nothing is emitted: a
 *   migration's backfill is deterministic and every replica runs it itself
 *   ({@link rebaselineChash}).
 *
 * @task T12775
 * @module store/sync/migration-hooks
 */

import type { DatabaseSync } from 'node:sqlite';
import type { TableScope } from '@cleocode/contracts';
import type { MigrationBracketHooks } from '../migration-runner.js';
import { captureBracketHooks } from './capture.js';
import { hasTable } from './schema.js';
import { rebaselineChash } from './sealer.js';

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
  return {
    ...hooks,
    afterMigration: (d) => {
      rebaselineChash(d, scope);
    },
  };
}
