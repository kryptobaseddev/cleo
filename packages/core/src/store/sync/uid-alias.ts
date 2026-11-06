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
 * - **references**: a reference to the old uid written by a replica that
 *   had placed the loser, before that replica's K, meant the loser, so it
 *   takes the new uid. The origin's K draws that boundary for the origin.
 *   Any other replica that placed the loser first (a third replica the
 *   origin's insert reached before the winner's) announces the re-key under
 *   its own name once it applies the origin's K (T13399,
 *   store/sync/collision-settle `announcePlacedRekeys`): an alias-only K
 *   that draws its own boundary. A reference written after the writer's
 *   boundary, or by a replica that never placed the loser, means the winner
 *   and is left alone.
 *
 * The aliases are local-only: each replica derives them from the K ops it
 * applied. {@link recordUidAlias} writes them; {@link markAliasPlaced} and
 * {@link markAliasAnnounced} track the announcement this replica owes.
 *
 * @module store/sync/uid-alias
 * @task T13397
 */

import type { DatabaseSync } from 'node:sqlite';
import type { LedgerOp } from '@cleocode/contracts/ledger';
import type { CaptureTableDef } from './capture.js';
import { compareHlc, parseHlc } from './hlc.js';
import type { StagedTxn } from './inbox.js';
import { hasTable, UID_ALIAS_JOURNAL_TABLE, UID_REF_ALIAS_JOURNAL_TABLE } from './schema.js';

export { UID_ALIAS_JOURNAL_TABLE, UID_REF_ALIAS_JOURNAL_TABLE };

const MAX_ALIAS_HOPS = 32;

/** One re-keyed row, as a K op names it. */
export interface UidAlias {
  readonly table: string;
  readonly oldUid: string;
  /** The row's birth fingerprint before the re-key (the K's `obfp`). */
  readonly oldBfp: string;
  readonly newUid: string;
  /**
   * The row's birth fingerprint after the re-key (the K's `bfp`), when the K
   * moved it (T14335). Omitted or null: the fingerprint did not change.
   */
  readonly newBfp?: string | null;
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
  // T14335: the new fingerprint, when the K moved it (a journal from before
  // the column records the uid only, as it always did).
  const newBfp =
    alias.newBfp != null && alias.newBfp !== alias.oldBfp && hasNewBfpColumn(db)
      ? alias.newBfp
      : null;
  if (newBfp !== null) {
    db.prepare(
      `INSERT INTO ${UID_ALIAS_JOURNAL_TABLE} (tbl, old_uid, old_bfp, new_uid, new_bfp, origin, hlc, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (tbl, old_uid, old_bfp) DO NOTHING`,
    ).run(
      alias.table,
      alias.oldUid,
      alias.oldBfp,
      alias.newUid,
      newBfp,
      alias.origin,
      alias.hlc,
      nowIso,
    );
  } else {
    db.prepare(
      `INSERT INTO ${UID_ALIAS_JOURNAL_TABLE} (tbl, old_uid, old_bfp, new_uid, origin, hlc, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (tbl, old_uid, old_bfp) DO NOTHING`,
    ).run(alias.table, alias.oldUid, alias.oldBfp, alias.newUid, alias.origin, alias.hlc, nowIso);
  }
  // Every K, the origin's and each announcement, draws its writer's boundary.
  if (hasTable(db, UID_REF_ALIAS_JOURNAL_TABLE)) {
    db.prepare(
      `INSERT INTO ${UID_REF_ALIAS_JOURNAL_TABLE} (tbl, old_uid, origin, new_uid, hlc)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (tbl, old_uid, origin) DO NOTHING`,
    ).run(alias.table, alias.oldUid, alias.origin, alias.newUid, alias.hlc);
  }
}

/**
 * Applying a K moved a loser this replica had placed, and another replica
 * wrote the K (T13399): this replica owes the re-key's announcement, since
 * its own earlier references to the old uid meant the loser.
 *
 * @param db - The store, inside the apply frame's transaction.
 * @param table - The re-keyed row's table.
 * @param oldUid - Its uid before the K.
 * @param oldBfp - Its birth fingerprint.
 */
export function markAliasPlaced(
  db: DatabaseSync,
  table: string,
  oldUid: string,
  oldBfp: string,
): void {
  if (!hasTable(db, UID_REF_ALIAS_JOURNAL_TABLE)) return;
  db.prepare(
    `UPDATE ${UID_ALIAS_JOURNAL_TABLE} SET placed = 1 WHERE tbl = ? AND old_uid = ? AND old_bfp = ?`,
  ).run(table, oldUid, oldBfp);
}

/**
 * Record, before planning, the alias of every staged K whose row is not
 * placed here (T14336). Applying such a K records its alias and nothing else
 * ({@link recordUidAlias} is its first write), so recording it first is the
 * same write, earlier. Without it a K published after the insert it re-keys
 * deadlocks where that insert is held: the held transaction waits for the K
 * to follow it, and the K's transaction waits behind the held one.
 *
 * @param db - The store.
 * @param staged - The staged transactions of this pass.
 * @param defs - Capture definitions by table (unknown tables are skipped).
 * @param nowIso - The time.
 */
export function recordStagedRekeyAliases(
  db: DatabaseSync,
  staged: readonly StagedTxn[],
  defs: (table: string) => CaptureTableDef | null,
  nowIso: string,
): void {
  if (!hasTable(db, UID_ALIAS_JOURNAL_TABLE)) return;
  for (const st of staged) {
    for (const op of st.txn.ops) {
      const oldBfp = op.obfp ?? op.bfp;
      if (op.o !== 'K' || !op.nu || op.nu === op.u || !oldBfp || !defs(op.t)) continue;
      const placed = db
        .prepare(`SELECT 1 FROM main."${op.t.replaceAll('"', '""')}" WHERE uid = ?`)
        .get(op.u);
      if (placed !== undefined) continue;
      recordUidAlias(
        db,
        {
          table: op.t,
          oldUid: op.u,
          oldBfp,
          newUid: op.nu,
          newBfp: op.bfp ?? null,
          origin: st.replicaId,
          hlc: op.h,
        },
        nowIso,
      );
    }
  }
}

/** One announcement this replica owes ({@link markAliasPlaced}). */
export interface OwedAnnouncement {
  readonly table: string;
  readonly oldUid: string;
  readonly oldBfp: string;
  readonly newUid: string;
}

/**
 * The re-key announcements this replica owes, oldest first.
 *
 * @param db - The store.
 */
export function owedAnnouncements(db: DatabaseSync): OwedAnnouncement[] {
  if (!hasTable(db, UID_REF_ALIAS_JOURNAL_TABLE)) return [];
  return db
    .prepare(
      `SELECT tbl AS "table", old_uid AS oldUid, old_bfp AS oldBfp, new_uid AS newUid
         FROM ${UID_ALIAS_JOURNAL_TABLE} WHERE placed = 1 AND followed_at IS NULL ORDER BY created_at, tbl, old_uid`,
    )
    .all() as Array<{ table: string; oldUid: string; oldBfp: string; newUid: string }>;
}

/**
 * The announcement of `a` was captured (T13399).
 *
 * @param db - The store, inside the announcing transaction.
 * @param a - The announced re-key.
 * @param nowIso - The time.
 */
export function markAliasAnnounced(db: DatabaseSync, a: OwedAnnouncement, nowIso: string): void {
  db.prepare(
    `UPDATE ${UID_ALIAS_JOURNAL_TABLE} SET followed_at = ? WHERE tbl = ? AND old_uid = ? AND old_bfp = ?`,
  ).run(nowIso, a.table, a.oldUid, a.oldBfp);
}

/**
 * Per handle: whether the alias journal has the `new_bfp` column. The sync
 * journal migrations run before apply, so the answer holds for the handle;
 * it is cached only once the journal exists (capture may be enabled later).
 */
const newBfpColumn = new WeakMap<DatabaseSync, boolean>();

/** Whether the alias journal has the T14335 `new_bfp` column, read once per handle. */
function hasNewBfpColumn(db: DatabaseSync): boolean {
  const cached = newBfpColumn.get(db);
  if (cached !== undefined) return cached;
  const has =
    db
      .prepare(
        `SELECT 1 FROM pragma_table_info('${UID_ALIAS_JOURNAL_TABLE}') WHERE name = 'new_bfp'`,
      )
      .get() !== undefined;
  if (has || hasTable(db, UID_ALIAS_JOURNAL_TABLE)) newBfpColumn.set(db, has);
  return has;
}

/**
 * Where the row (table, uid, fingerprint) lives now, following re-keys, or
 * null when it was never re-keyed here. Each hop is matched on the row's
 * fingerprint at that hop: a re-key that moved the fingerprint (T14335)
 * carries it into the next lookup and into the result.
 */
function rowAlias(
  db: DatabaseSync,
  table: string,
  uid: string,
  bfp: string,
): { readonly uid: string; readonly bfp: string } | null {
  const next = db.prepare(
    hasNewBfpColumn(db)
      ? `SELECT new_uid AS uid, new_bfp AS bfp FROM ${UID_ALIAS_JOURNAL_TABLE} WHERE tbl = ? AND old_uid = ? AND old_bfp = ?`
      : `SELECT new_uid AS uid, NULL AS bfp FROM ${UID_ALIAS_JOURNAL_TABLE} WHERE tbl = ? AND old_uid = ? AND old_bfp = ?`,
  );
  let cur = uid;
  let curBfp = bfp;
  for (let hop = 0; hop < MAX_ALIAS_HOPS; hop++) {
    const row = next.get(table, cur, curBfp) as { uid: string; bfp: string | null } | undefined;
    if (!row || (row.uid === cur && (row.bfp ?? curBfp) === curBfp)) break;
    cur = row.uid;
    curBfp = row.bfp ?? curBfp;
  }
  return cur === uid && curBfp === bfp ? null : { uid: cur, bfp: curBfp };
}

/**
 * The new uid a reference to `uid` written by `replica` at `txnHlc` means,
 * or null: only a replica that placed the re-keyed row (its origin, or one
 * that announced the re-key), before its own K, meant it.
 */
function refAlias(
  db: DatabaseSync,
  table: string,
  uid: string,
  replica: string,
  txnHlc: string,
): string | null {
  const from = hasTable(db, UID_REF_ALIAS_JOURNAL_TABLE)
    ? UID_REF_ALIAS_JOURNAL_TABLE
    : UID_ALIAS_JOURNAL_TABLE;
  const rows = db
    .prepare(`SELECT new_uid AS uid, hlc FROM ${from} WHERE tbl = ? AND old_uid = ? AND origin = ?`)
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
    // T14335: the op takes the row's identity now, its fingerprint included,
    // so a held loser arrives as the row it was re-keyed onto and is placed
    // as that row, never as a collision with it.
    // A K is never moved by its own alias (recorded before it applies, T14336).
    if (moved !== null && !(op.o === 'K' && moved.uid === op.nu)) {
      out =
        op.o === 'K'
          ? { ...out, u: moved.uid, obfp: moved.bfp }
          : { ...out, u: moved.uid, ...(op.bfp !== undefined ? { bfp: moved.bfp } : {}) };
    }
    const def = defs(op.t);
    if (def && op.a) {
      const a: NonNullable<LedgerOp['a']> = { ...op.a };
      let refsMoved = false;
      for (const [col, v] of Object.entries(op.a)) {
        // A reference column, or (T14335) a column holding the target's uid.
        const targetTable = def.refs.get(col)?.table ?? def.uidRefs?.get(col);
        if (!targetTable || typeof v !== 'string') continue;
        const to = refAlias(db, targetTable, v, st.replicaId, st.txn.hlc);
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
