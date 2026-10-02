/**
 * Removing the change journal from a store (journal spec §2.3a rules 4 and 10).
 *
 * {@link dropSyncMachinery} is the ONLY code allowed to drop `_sync_*`
 * tables; gate 36 forbids `DROP TABLE _sync_…` anywhere else. It drops every
 * capture trigger first, then the tables, in one transaction, so no state
 * with a trigger but without `_sync_capture` is ever committed.
 *
 * It never drops `cleo_trigger_suspend`: that table is schema-owned, and the
 * owned guard and side-effect triggers read it (C2). Nor does anything else;
 * gate 36 forbids dropping it.
 *
 * @task T12819
 * @module store/sync/machinery
 */

import type { DatabaseSync } from 'node:sqlite';
import { removeCaptureStamp } from './capture.js';
import { CAPTURE_TRIGGER_PREFIX, TRIGGER_SUSPEND_TABLE } from './trigger-classes.js';

/** What {@link dropSyncMachinery} removed. */
export interface DroppedSyncMachinery {
  readonly triggers: string[];
  readonly tables: string[];
}

/**
 * Drop every capture trigger, then every `_sync_*` table, in one
 * transaction (a savepoint when the caller holds one).
 */
export function dropSyncMachinery(db: DatabaseSync): DroppedSyncMachinery {
  const names = (type: 'trigger' | 'table', prefix: string) =>
    (
      db
        .prepare(
          'SELECT name FROM main.sqlite_master WHERE type = ? AND substr(name, 1, length(?)) = ? ORDER BY name',
        )
        .all(type, prefix, prefix) as Array<{ name: string }>
    ).map((r) => r.name);
  const triggers = names('trigger', CAPTURE_TRIGGER_PREFIX);
  const tables = names('table', '_sync_').filter((t) => t !== TRIGGER_SUSPEND_TABLE);
  const nested = db.isTransaction;
  removeCaptureStamp(db);
  db.exec(nested ? 'SAVEPOINT drop_sync_machinery' : 'BEGIN IMMEDIATE');
  try {
    for (const t of triggers) db.exec(`DROP TRIGGER IF EXISTS "${t}"`);
    for (const t of tables) db.exec(`DROP TABLE IF EXISTS "${t}"`);
    db.exec(nested ? 'RELEASE drop_sync_machinery' : 'COMMIT');
  } catch (err) {
    db.exec(nested ? 'ROLLBACK TO drop_sync_machinery; RELEASE drop_sync_machinery' : 'ROLLBACK');
    throw err;
  }
  return { triggers, tables };
}
