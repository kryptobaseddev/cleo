/**
 * Test helper: write as an older build would, with no per-connection row-uid
 * fill (row uids are on by default since T13305), so rows keep NULL identity
 * for the sealer's step 0 and the repair diff to resolve (T13311).
 */

import type { DatabaseSync } from 'node:sqlite';
import type { TableScope } from '@cleocode/contracts';
import { installRowUidTriggers } from '../../row-identity.js';

/**
 * Run `fn` with the connection's TEMP row-uid fill triggers dropped, then
 * reinstall them.
 *
 * @param db - Connection on a `cleo.db`.
 * @param scope - The store's scope.
 * @param fn - The writes an older build makes.
 * @returns What `fn` returns.
 */
export function asOlderBuild<T>(db: DatabaseSync, scope: TableScope, fn: () => T): T {
  const fills = db
    .prepare(
      "SELECT name FROM sqlite_temp_master WHERE type = 'trigger' AND name LIKE 'trg_row_uid_%'",
    )
    .all() as Array<{ name: string }>;
  for (const { name } of fills) db.exec(`DROP TRIGGER temp."${name}"`);
  try {
    return fn();
  } finally {
    installRowUidTriggers(db, scope);
  }
}
