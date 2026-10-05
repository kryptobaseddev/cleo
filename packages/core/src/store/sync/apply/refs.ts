/**
 * Reference translation for apply (T12344 PR-4; journal spec §3.2 "Missing
 * references", NEW-2, T12782).
 *
 * On the wire a reference column carries the target row's uid; in the store
 * it holds the target's LOCAL key. The applier translates both ways:
 *
 * - **Writing** ({@link resolveRef}): the uid becomes the target's local key.
 *   A target the receiver knows only through `tasks_uid_aliases` (re-keyed or
 *   re-minted) is followed to its current uid. A target with a tombstone is
 *   `tombstoned` (the op becomes a `dangling-ref` conflict plus a revivable
 *   void); a target never seen is `missing` (the transaction waits, pending).
 * - **Reading** ({@link uidOfKey}): the merge compares stream values, so the
 *   row state it reads carries uids, not local keys.
 *
 * Read-only.
 *
 * @module store/sync/apply/refs
 * @task T12344
 */

import type { DatabaseSync } from 'node:sqlite';
import type { LedgerWireValue } from '@cleocode/contracts/ledger';
import { UID_ALIAS_TABLE } from '../../display-id-alias.js';
import { UID_COLUMN } from '../../row-identity-registry.js';
import { enc } from '../capture.js';
import { hasTable } from '../schema.js';
import { decodeEnc } from '../sealer-values.js';
import { wireToSql } from './write-api.js';

/** Where a wire reference points on this replica. */
export type RefResolution =
  | { readonly kind: 'row'; readonly uid: string; readonly key: LedgerWireValue }
  | { readonly kind: 'tombstoned'; readonly uid: string }
  | { readonly kind: 'missing'; readonly uid: string };

const ident = (s: string): string => `"${s.replaceAll('"', '""')}"`;
const MAX_ALIAS_HOPS = 32;

/** The target's current uid, following re-key aliases. */
function currentUid(db: DatabaseSync, table: string, uid: string): string {
  if (!hasTable(db, UID_ALIAS_TABLE)) return uid;
  let cur = uid;
  for (let hop = 0; hop < MAX_ALIAS_HOPS; hop++) {
    const next = db
      .prepare(
        `SELECT new_uid AS uid FROM main.${ident(UID_ALIAS_TABLE)} WHERE entity_table = ? AND old_uid = ? ORDER BY created_at DESC LIMIT 1`,
      )
      .get(table, cur) as { uid: string } | undefined;
    if (!next || next.uid === cur) break;
    cur = next.uid;
  }
  return cur;
}

/**
 * Resolve a wire reference (a target uid) to the target's local key.
 *
 * @param db - The store.
 * @param target - The referenced table and its local key column.
 * @param uid - The target uid on the wire.
 * @returns The row's key, or why there is none.
 */
export function resolveRef(
  db: DatabaseSync,
  target: { readonly table: string; readonly key: string },
  uid: string,
): RefResolution {
  const find = (u: string): LedgerWireValue | undefined => {
    const row = db
      .prepare(
        `SELECT ${enc(ident(target.key))} AS k FROM main.${ident(target.table)} WHERE ${ident(UID_COLUMN)} = ?`,
      )
      .get(u) as { k: string } | undefined;
    return row ? decodeEnc(row.k) : undefined;
  };
  const direct = find(uid);
  if (direct !== undefined) return { kind: 'row', uid, key: direct };
  const aliased = currentUid(db, target.table, uid);
  if (aliased !== uid) {
    const key = find(aliased);
    if (key !== undefined) return { kind: 'row', uid: aliased, key };
  }
  const tomb = db
    .prepare('SELECT deleted FROM _sync_row_meta WHERE tbl = ? AND uid = ?')
    .get(target.table, aliased) as { deleted: number } | undefined;
  if (tomb?.deleted) return { kind: 'tombstoned', uid: aliased };
  return { kind: 'missing', uid };
}

/**
 * The uid of the row a local key references, or null when that row has no
 * uid (or is absent).
 *
 * @param db - The store.
 * @param target - The referenced table and its local key column.
 * @param key - The local key the reference column holds.
 * @returns The target's uid, or null.
 */
export function uidOfKey(
  db: DatabaseSync,
  target: { readonly table: string; readonly key: string },
  key: LedgerWireValue,
): string | null {
  const row = db
    .prepare(
      `SELECT ${ident(UID_COLUMN)} AS uid FROM main.${ident(target.table)} WHERE ${ident(target.key)} = ?`,
    )
    .get(wireToSql(key)) as { uid: string | null } | undefined;
  return row?.uid ?? null;
}
