/**
 * Foreign keys between sync-set tables, as the apply sees them (T12344
 * PR-4; journal spec §3.2 "FK actions", R5-7).
 *
 * Read-only: from `PRAGMA foreign_key_list`. Only sync-set children count:
 * local-only and derived children cascade locally as SQLite does, and nothing
 * about them is replicated.
 *
 * @module store/sync/apply/fk
 * @task T12344
 */

import type { DatabaseSync } from 'node:sqlite';
import type { TableScope } from '@cleocode/contracts';
import { syncSetTables } from '../capture.js';

/** One sync-set child foreign key onto a parent table. */
export interface ChildKey {
  /** The child table. */
  readonly child: string;
  /** The child's referencing column. */
  readonly from: string;
  /** The parent's referenced column. */
  readonly to: string;
  /** `ON DELETE` action, upper-case (`CASCADE`, `SET NULL`, `RESTRICT`, `NO ACTION` …). */
  readonly onDelete: string;
}

type FkRow = {
  table: string;
  from: string;
  to: string | null;
  on_delete: string;
};

function primaryKey(db: DatabaseSync, table: string): string {
  const pk = db
    .prepare('SELECT name FROM pragma_table_info(?) WHERE pk = 1 ORDER BY pk')
    .get(table) as { name: string } | undefined;
  return pk?.name ?? 'rowid';
}

/**
 * Every sync-set table's sync-set children, by parent table.
 *
 * @param db - The store.
 * @param scope - The store's scope.
 * @returns Parent table → its children's foreign keys.
 */
export function syncSetChildKeys(
  db: DatabaseSync,
  scope: TableScope,
): ReadonlyMap<string, readonly ChildKey[]> {
  const tables = new Set(syncSetTables(scope));
  const out = new Map<string, ChildKey[]>();
  for (const child of tables) {
    const fks = db
      .prepare('SELECT "table", "from", "to", on_delete FROM pragma_foreign_key_list(?)')
      .all(child) as FkRow[];
    for (const fk of fks) {
      if (!tables.has(fk.table)) continue;
      const key: ChildKey = {
        child,
        from: fk.from,
        to: fk.to ?? primaryKey(db, fk.table),
        onDelete: fk.on_delete.toUpperCase(),
      };
      out.set(fk.table, [...(out.get(fk.table) ?? []), key]);
    }
  }
  return out;
}
