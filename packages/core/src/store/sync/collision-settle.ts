/**
 * The origin settles a uid collision it lost (T13397; T12341 §6.4 "Re-key",
 * §9.2 origin rule).
 *
 * Apply holds an incoming row whose uid a local row holds with another birth
 * fingerprint (T13394) and records a `uid-collision` conflict naming the
 * loser, the greater fingerprint. When the local row is the loser and this
 * replica authored it, this replica is the authority that re-keys it: the row
 * gets a fresh uid in a local `rekey` frame, so the capture triggers journal
 * the K (and the cascade's K ops) and the next push publishes it. The held
 * winner then places under the freed uid on the next pass, and every receiver
 * holding the loser follows the K through its alias (store/sync/uid-alias).
 *
 * A loser this replica only received (its origin is elsewhere) is never
 * re-keyed here: it waits for its origin's K, which moves it like any re-key.
 *
 * @module store/sync/collision-settle
 * @task T13397
 */

import type { DatabaseSync } from 'node:sqlite';
import type { TableScope } from '@cleocode/contracts';
import { rekeyRowUid } from '../display-id-alias.js';
import { mintRowUid } from '../row-identity.js';
import { BIRTH_FP_COLUMN, rowIdentitySpec, UID_COLUMN } from '../row-identity-registry.js';
import { setRowUidNative } from '../sqlite-data-accessor.js';
import {
  captureRekeyAnnouncement,
  captureTableDef,
  finishCaptureFrame,
  openCaptureFrame,
} from './capture.js';
import { stagedTxns } from './inbox.js';
import { hasTable } from './schema.js';
import { markAliasAnnounced, owedAnnouncements } from './uid-alias.js';

/** What {@link settleLostUidCollisions} needs. */
export interface SettleOptions {
  readonly scope: TableScope;
  readonly stream: string;
  /** This replica's id. */
  readonly replica: string;
}

/** One re-key this replica made as the loser's origin. */
export interface SettledCollision {
  readonly table: string;
  readonly oldUid: string;
  readonly newUid: string;
  /** The loser's birth fingerprint (it keeps it). */
  readonly birthFp: string;
}

const q = (id: string): string => `"${id.replaceAll('"', '""')}"`;

/** The incoming (winner) fingerprint of each open lost collision, by row. */
function lostCollisions(
  db: DatabaseSync,
  stream: string,
): Map<string, { table: string; uid: string; incomingFp: string }> {
  const open = db
    .prepare(
      `SELECT seq, txn_idx AS txnIdx, op_idx AS opIdx, tbl, uid FROM _sync_conflict
        WHERE stream = ? AND kind = 'uid-collision' AND rule = 'loser:local' AND resolved_at IS NULL`,
    )
    .all(stream) as Array<{ seq: number; txnIdx: number; opIdx: number; tbl: string; uid: string }>;
  const out = new Map<string, { table: string; uid: string; incomingFp: string }>();
  if (open.length === 0) return out;
  const staged = stagedTxns(db, stream);
  for (const c of open) {
    const st = staged.find((s) => s.key.seq === c.seq && s.key.txnIdx === c.txnIdx);
    const fp = st?.txn.ops[c.opIdx]?.bfp;
    if (fp) out.set(`${c.tbl}\u0000${c.uid}`, { table: c.tbl, uid: c.uid, incomingFp: fp });
  }
  return out;
}

/**
 * Whether this replica sealed the insert of the row (table, uid,
 * fingerprint). `_sync_authored` keeps it after the transaction's ops are
 * folded or collected (T13399); a store without it falls back to the ops.
 */
function authoredHere(
  db: DatabaseSync,
  table: string,
  uid: string,
  fp: string,
  replica: string,
): boolean {
  if (
    hasTable(db, '_sync_authored') &&
    db
      .prepare('SELECT 1 FROM _sync_authored WHERE tbl = ? AND uid = ? AND bfp = ? AND replica = ?')
      .get(table, uid, fp, replica) !== undefined
  ) {
    return true;
  }
  return (
    hasTable(db, '_sync_op') &&
    db
      .prepare(
        `SELECT 1 FROM _sync_op o JOIN _sync_txn t ON t.txn = o.txn
          WHERE o.tbl = ? AND o.uid = ? AND o.o = 'I' AND t.replica = ?
            AND json_extract(o.body, '$.bfp') = ? LIMIT 1`,
      )
      .get(table, uid, replica, fp) !== undefined
  );
}

/**
 * Re-key every row this replica lost a uid collision with and authored
 * (module doc). Each re-key is its own local transaction in a `rekey` frame;
 * the caller seals and applies again.
 *
 * @param db - The store; must not be inside a transaction.
 * @param opts - Scope, stream and this replica.
 * @returns The re-keys made.
 */
export function settleLostUidCollisions(db: DatabaseSync, opts: SettleOptions): SettledCollision[] {
  if (!hasTable(db, '_sync_conflict')) return [];
  const settled: SettledCollision[] = [];
  for (const c of lostCollisions(db, opts.stream).values()) {
    const row = db
      .prepare(
        `SELECT ${q(BIRTH_FP_COLUMN)} AS fp FROM main.${q(c.table)} WHERE ${q(UID_COLUMN)} = ?`,
      )
      .get(c.uid) as { fp: string | null } | undefined;
    const fp = row?.fp ?? null;
    // Only the loser (the greater fingerprint) is re-keyed, and only by its origin.
    if (fp === null || !(c.incomingFp < fp)) continue;
    if (!authoredHere(db, c.table, c.uid, fp, opts.replica)) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      const frame = openCaptureFrame(db, 'rekey', null);
      let newUid: string;
      if (opts.scope === 'project' && rowIdentitySpec('project', c.table)?.kind === 'minted') {
        // The project re-key cascades owned children and natural rows, and
        // writes the portable uid alias (T12341 §6.4).
        newUid = rekeyRowUid(
          db,
          c.table,
          c.uid,
          { loserBirthFp: fp, winnerBirthFp: c.incomingFp },
          { origin: opts.replica },
        ).newUid;
      } else {
        // The global store's minted tables (brain) own no children by uid.
        newUid = mintRowUid();
        setRowUidNative(db, c.table, c.uid, fp, newUid);
      }
      finishCaptureFrame(db, frame);
      db.exec('COMMIT');
      settled.push({ table: c.table, oldUid: c.uid, newUid, birthFp: fp });
    } catch (err) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw err;
    }
  }
  return settled;
}

/**
 * Announce every re-key this replica applied to a loser it had placed
 * (T13399). The loser's origin draws the boundary for its own references with
 * its K; a replica the origin's insert reached before the winner's may also
 * have written references to the old uid that meant the loser. Receivers only
 * read a writer's references through an alias that writer drew, so this
 * replica re-states the re-key under its own name: an alias-only K in a local
 * `rekey` frame (it moves nothing here). The caller seals.
 *
 * @param db - The store; must not be inside a transaction.
 * @param opts - Scope, stream and this replica.
 * @param nowIso - The time.
 * @returns The announcements captured.
 */
export function announcePlacedRekeys(
  db: DatabaseSync,
  opts: SettleOptions,
  nowIso: string,
): number {
  const owed = owedAnnouncements(db);
  if (owed.length === 0) return 0;
  let n = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    const frame = openCaptureFrame(db, 'rekey', null);
    // Capture off: nothing can be announced, and the debt stays.
    if (frame !== null) {
      for (const a of owed) {
        const def = captureTableDef(db, opts.scope, a.table);
        if (def) n += captureRekeyAnnouncement(db, def, a.oldUid, a.newUid, a.oldBfp);
        markAliasAnnounced(db, a, nowIso);
      }
      finishCaptureFrame(db, frame);
    }
    db.exec('COMMIT');
  } catch (err) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw err;
  }
  return n;
}
