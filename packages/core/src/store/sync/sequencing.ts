/**
 * Own-echo sequencing and the foreign-touch index (T13193; journal spec §3.5
 * Rules 2-3, R7-6).
 *
 * A sealed local transaction stays **unsequenced** until its own echo comes
 * back through the stream. Until then it keeps its undo (`_sync_undo`, the
 * values) and its row undo (`_sync_row_undo`, the merge state: row meta,
 * leaves, frontiers), so a scoped rebase can rewind it.
 *
 * When the echo applies, the **fast path** decides whether a rebase is needed:
 * if no foreign transaction applied after this transaction's commit touched
 * its rows, the stream order and the local order agree, so the echo is simply
 * sequenced and its undo dropped. The order is exact, with no clock: a local
 * transaction's position is its first capture's seq, and a foreign touch
 * records the capture sequence (`sqlite_sequence` of `_sync_capture`) when its
 * transaction applied. Both come from the one AUTOINCREMENT counter.
 *
 * The index holds only entries at or after the oldest unsequenced local
 * transaction and is bounded by {@link FOREIGN_TOUCH_MAX}; past the bound it
 * is marked incomplete and the fast path declines (falling back to the scoped
 * rebase) until the unsequenced backlog drains.
 *
 * @module store/sync/sequencing
 * @task T13193
 */

import type { DatabaseSync } from 'node:sqlite';
import { readFieldFrontiers, readFieldLeaves } from './field-leave.js';
import { readRowMeta } from './row-meta.js';
import { canonicalJson } from './sealer-values.js';

/** The foreign-touch index's bound (spec R7-6). */
export const FOREIGN_TOUCH_MAX = 200_000;

/** `_sync_meta` key set while the foreign-touch index overflowed its bound. */
export const FOREIGN_TOUCH_INCOMPLETE_KEY = 'sync.foreign_touch_incomplete';

/** One row a transaction touched. */
export interface TouchedRow {
  readonly table: string;
  readonly uid: string;
}

/** Whether undo is being written (§3.5 Rule 2: on exactly while push is on). */
export function undoEnabled(db: DatabaseSync): boolean {
  return db.prepare("SELECT 1 FROM _sync_meta WHERE key = 'undo_enabled'").get() !== undefined;
}

/**
 * Snapshot a row's merge state before a local op moves it (the sealer calls
 * this per sealed op while undo is enabled): its row meta, leaves and
 * frontiers, so a rewind can restore them with the values.
 *
 * @param db - The store, inside the sealer's transaction.
 * @param txn - The sealed transaction id.
 * @param idx - The op's index in it.
 * @param tbl - The row's table.
 * @param uid - The row's uid before the op.
 */
export function snapshotRowUndo(
  db: DatabaseSync,
  txn: string,
  idx: number,
  tbl: string,
  uid: string,
): void {
  const meta = readRowMeta(db, tbl, uid);
  const leaves = readFieldLeaves(db, tbl, uid);
  const frontiers = readFieldFrontiers(db, tbl, uid);
  const state =
    Object.keys(leaves).length + Object.keys(frontiers).length > 0
      ? canonicalJson({ leaves, frontiers })
      : null;
  db.prepare(
    `INSERT INTO _sync_row_undo (txn, idx, tbl, uid, meta_json, leave_json) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (txn, idx) DO NOTHING`,
  ).run(txn, idx, tbl, uid, meta ? canonicalJson(meta) : null, state);
}

/**
 * The capture position now: the last seq `_sync_capture` handed out (0 when
 * none). A write made after this point has a larger seq.
 */
export function capturePosition(db: DatabaseSync): number {
  const row = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = '_sync_capture'").get() as
    | { seq: number }
    | undefined;
  return Number(row?.seq ?? 0);
}

/** The oldest unsequenced local transaction's position, or null when none has undo. */
function oldestUnsequencedPosition(db: DatabaseSync): number | null {
  const row = db
    .prepare(
      `SELECT min(u.seq) AS p FROM _sync_undo u JOIN _sync_txn t ON t.frame = u.txn_local
        WHERE t.state = 'sealed' AND NOT EXISTS (SELECT 1 FROM _sync_sequenced s WHERE s.txn = t.txn)`,
    )
    .get() as { p: number | null };
  return row.p === null ? null : Number(row.p);
}

/**
 * Record the rows an applied foreign transaction touched, at `pos`. Nothing
 * is recorded while no local transaction is unsequenced (no echo will ask).
 *
 * @param db - The store, inside the apply frame.
 * @param rows - The rows the transaction wrote.
 * @param pos - {@link capturePosition} when the transaction began applying.
 */
export function recordForeignTouches(
  db: DatabaseSync,
  rows: readonly TouchedRow[],
  pos: number,
): void {
  if (rows.length === 0 || oldestUnsequencedPosition(db) === null) return;
  const ins = db.prepare(
    'INSERT INTO _sync_foreign_touch (tbl, uid, pos) VALUES (?, ?, ?) ON CONFLICT DO NOTHING',
  );
  for (const r of rows) ins.run(r.table, r.uid, pos);
  const n = (db.prepare('SELECT count(*) AS n FROM _sync_foreign_touch').get() as { n: number }).n;
  if (Number(n) > FOREIGN_TOUCH_MAX) {
    db.prepare(
      `INSERT INTO _sync_meta (key, value, updated_at) VALUES (?, '1', datetime('now'))
       ON CONFLICT (key) DO NOTHING`,
    ).run(FOREIGN_TOUCH_INCOMPLETE_KEY);
  }
}

/** A sealed local transaction as the fast path sees it. */
export interface LocalTxn {
  readonly txn: string;
  readonly frame: string | null;
  /** Its first capture's seq, or null when it kept no undo. */
  readonly position: number | null;
}

/**
 * The unsequenced sealed local transaction with this id, or null (not ours,
 * or already sequenced).
 *
 * @param db - The store.
 * @param txn - The transaction id the echo carries.
 * @returns The local transaction, or null.
 */
export function unsequencedLocalTxn(db: DatabaseSync, txn: string): LocalTxn | null {
  const t = db
    .prepare(
      `SELECT t.txn, t.frame FROM _sync_txn t WHERE t.txn = ?
         AND NOT EXISTS (SELECT 1 FROM _sync_sequenced s WHERE s.txn = t.txn)`,
    )
    .get(txn) as { txn: string; frame: string | null } | undefined;
  if (!t) return null;
  const p =
    t.frame === null
      ? undefined
      : (db.prepare('SELECT min(seq) AS p FROM _sync_undo WHERE txn_local = ?').get(t.frame) as {
          p: number | null;
        });
  return { txn: t.txn, frame: t.frame, position: p?.p == null ? null : Number(p.p) };
}

/**
 * The own-echo fast path (Rule 3): whether no foreign transaction applied at
 * or after `local`'s commit touched any of `rows`. False while the index is
 * incomplete.
 *
 * @param db - The store.
 * @param local - The echoed local transaction.
 * @param rows - The rows its ops wrote.
 * @returns True when the echo can be sequenced without a rebase.
 */
export function ownEchoFastPath(
  db: DatabaseSync,
  local: LocalTxn,
  rows: readonly TouchedRow[],
): boolean {
  if (local.position === null) return true; // nothing to rewind
  if (
    db.prepare('SELECT 1 FROM _sync_meta WHERE key = ?').get(FOREIGN_TOUCH_INCOMPLETE_KEY) !==
    undefined
  ) {
    return false;
  }
  const hit = db.prepare(
    'SELECT 1 FROM _sync_foreign_touch WHERE tbl = ? AND uid = ? AND pos >= ? LIMIT 1',
  );
  return !rows.some((r) => hit.get(r.table, r.uid, local.position) !== undefined);
}

/**
 * Mark an own transaction sequenced by its echo: record it, drop its undo
 * and row undo, and prune the foreign-touch index past the new oldest
 * unsequenced transaction (resetting it, and its incomplete mark, when none
 * is left).
 *
 * @param db - The store, inside the apply frame.
 * @param local - The echoed local transaction.
 * @param at - The echo's stream position and the time.
 */
export function markSequenced(
  db: DatabaseSync,
  local: LocalTxn,
  at: { readonly stream: string; readonly seq: number; readonly nowIso: string },
): void {
  db.prepare(
    'INSERT INTO _sync_sequenced (txn, stream, seq, at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING',
  ).run(local.txn, at.stream, at.seq, at.nowIso);
  if (local.frame !== null) {
    db.prepare('DELETE FROM _sync_undo WHERE txn_local = ?').run(local.frame);
  }
  db.prepare('DELETE FROM _sync_row_undo WHERE txn = ?').run(local.txn);
  const oldest = oldestUnsequencedPosition(db);
  if (oldest === null) {
    db.prepare('DELETE FROM _sync_foreign_touch').run();
    db.prepare('DELETE FROM _sync_meta WHERE key = ?').run(FOREIGN_TOUCH_INCOMPLETE_KEY);
  } else {
    db.prepare('DELETE FROM _sync_foreign_touch WHERE pos < ?').run(oldest);
  }
}
