/**
 * Uid aliases the applier follows (T13397; T12341 §6.4 step 1, journal spec
 * §2.6 "K ops").
 *
 * A held uid collision (T13394) settles when the loser's origin re-keys its
 * row and publishes the K. A receiver where the winner owns the uid never
 * placed the loser, so it records the K as an alias only
 * ({@link recordUidAlias}). Every staged transaction then reads through the
 * aliases ({@link followUidAliases}) before it is planned:
 *
 * - **the loser's own ops**: an op naming (uid, birth fingerprint) of a
 *   re-keyed row takes the new uid. The winner keeps the uid with another
 *   fingerprint, so it is never matched;
 * - **references**: a reference to the old uid written by the K's origin
 *   before its K meant the loser (until then the origin was the only replica
 *   that had placed it), so it takes the new uid. A reference written after
 *   the K, or by any other replica, means the winner and is left alone.
 *
 * The aliases are local-only: each replica derives them from the K ops it
 * applied. Read-mostly; {@link recordUidAlias} is the one writer.
 *
 * @module store/sync/uid-alias
 * @task T13397
 */

import type { DatabaseSync } from 'node:sqlite';
import type { LedgerOp } from '@cleocode/contracts/ledger';
import type { CaptureTableDef } from './capture.js';
import { compareHlc, parseHlc } from './hlc.js';
import type { StagedTxn } from './inbox.js';
import { hasTable } from './schema.js';

/** The local-only alias table (sync-journal folder `20261010150000_t13397-uid-alias`). */
export const UID_ALIAS_JOURNAL_TABLE = '_sync_uid_alias';

const MAX_ALIAS_HOPS = 32;

/** One re-keyed row, as a K op names it. */
export interface UidAlias {
  readonly table: string;
  readonly oldUid: string;
  /** The row's birth fingerprint before the re-key (the K's `obfp`). */
  readonly oldBfp: string;
  readonly newUid: string;
  /** The replica that wrote the K. */
  readonly origin: string;
  /** The K's HLC. */
  readonly hlc: string;
}

/**
 * Record a re-key as an alias. The first record of a (table, uid,
 * fingerprint) wins: a re-delivered K changes nothing.
 *
 * @param db - The store, inside the apply frame's transaction.
 * @param alias - The re-keyed row.
 * @param nowIso - The time.
 */
export function recordUidAlias(db: DatabaseSync, alias: UidAlias, nowIso: string): void {
  if (!hasTable(db, UID_ALIAS_JOURNAL_TABLE)) return;
  db.prepare(
    `INSERT INTO ${UID_ALIAS_JOURNAL_TABLE} (tbl, old_uid, old_bfp, new_uid, origin, hlc, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (tbl, old_uid, old_bfp) DO NOTHING`,
  ).run(alias.table, alias.oldUid, alias.oldBfp, alias.newUid, alias.origin, alias.hlc, nowIso);
}

/**
 * Where the row (table, uid, fingerprint) lives now, following re-keys, or
 * null when it was never re-keyed here.
 */
function rowAlias(db: DatabaseSync, table: string, uid: string, bfp: string): string | null {
  const next = db.prepare(
    `SELECT new_uid AS uid FROM ${UID_ALIAS_JOURNAL_TABLE} WHERE tbl = ? AND old_uid = ? AND old_bfp = ?`,
  );
  let cur = uid;
  for (let hop = 0; hop < MAX_ALIAS_HOPS; hop++) {
    const row = next.get(table, cur, bfp) as { uid: string } | undefined;
    if (!row || row.uid === cur) break;
    cur = row.uid;
  }
  return cur === uid ? null : cur;
}

/**
 * The new uid a reference to `uid` written by `replica` at `txnHlc` means,
 * or null: only the K's own origin, before its K, meant the re-keyed row.
 */
function refAlias(
  db: DatabaseSync,
  table: string,
  uid: string,
  replica: string,
  txnHlc: string,
): string | null {
  const rows = db
    .prepare(
      `SELECT new_uid AS uid, hlc FROM ${UID_ALIAS_JOURNAL_TABLE} WHERE tbl = ? AND old_uid = ? AND origin = ?`,
    )
    .all(table, uid, replica) as Array<{ uid: string; hlc: string }>;
  const at = parseHlc(txnHlc);
  const before = rows.filter((r) => compareHlc(at, parseHlc(r.hlc)) < 0);
  // One origin re-keys one of its rows on a uid once; more is ambiguous, left alone.
  return before.length === 1 ? (before[0] as { uid: string }).uid : null;
}

/**
 * A staged transaction read through the uid aliases (module doc). Unchanged,
 * and the same object, when nothing is aliased.
 *
 * @param db - The store.
 * @param st - The staged transaction.
 * @param defs - Capture definitions by table (for reference columns).
 * @returns The transaction its planning and apply see.
 */
export function followUidAliases(
  db: DatabaseSync,
  st: StagedTxn,
  defs: (table: string) => CaptureTableDef | null,
): StagedTxn {
  if (!hasTable(db, UID_ALIAS_JOURNAL_TABLE)) return st;
  let changed = false;
  const ops = st.txn.ops.map((op): LedgerOp => {
    let out = op;
    const fp = op.o === 'K' ? op.obfp : op.bfp;
    const moved = fp ? rowAlias(db, op.t, op.u, fp) : null;
    if (moved !== null) out = { ...out, u: moved };
    const def = defs(op.t);
    if (def && op.a) {
      const a: NonNullable<LedgerOp['a']> = { ...op.a };
      let refsMoved = false;
      for (const [col, v] of Object.entries(op.a)) {
        const target = def.refs.get(col);
        if (!target || typeof v !== 'string') continue;
        const to = refAlias(db, target.table, v, st.replicaId, st.txn.hlc);
        if (to === null) continue;
        a[col] = to;
        refsMoved = true;
      }
      if (refsMoved) out = { ...out, a };
    }
    if (out !== op) changed = true;
    return out;
  });
  return changed ? { ...st, txn: { ...st.txn, ops } } : st;
}
