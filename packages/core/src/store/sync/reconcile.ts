/**
 * The rebind reconcile (journal spec §1.5 N7; T12763, T13278).
 *
 * After a rebind, what the old replica changed and the stream never saw is
 * `inherited` (`inherit.ts`): live captures, sealed transactions, and the
 * transactions of segments it never pushed. The new replica re-emits those
 * fields, deciding each one by the three-way rule
 * ({@link decideReconcileField}):
 *
 * 1. changed by an inherited capture or an inherited sealed-but-unpushed op:
 *    emit it at `tick(at_ms)` of that change, under the new replica;
 * 2. untouched, and the local field HLC is below the merged one: adopt the
 *    merged value locally, emitting nothing;
 * 3. otherwise (a local HLC at or above the merged one that no inherited
 *    change explains): emit it with that HLC unchanged.
 *
 * These are `repair` transactions with `via: 'rebind'`, and they break the
 * per-replica monotonic-HLC promise on purpose (§1.3, K10).
 *
 * {@link reconcileInPlace} is the reconcile of a rebind of the SAME file
 * after a pull to head (the undo-budget rebind, D5): the store itself is the
 * merged state, since the pull applied the stream and rebased the old
 * replica's unsequenced writes over it. Every field no inherited change
 * touched therefore already equals the merged value (rule 2 has nothing left
 * to adopt and rule 3 nothing to explain), and every touched field is rule 1.
 * It writes the touched rows as the captures of one `rebind` frame, read
 * from the live rows (the current value, which is what every replica must
 * converge on, whichever side the rebase let win), at the time of the last
 * inherited change of each row; the sealer seals the frame as one `repair`
 * transaction, `via: 'rebind'`, ticking each op at its row's time. A copy's
 * reconcile against a restored checkpoint (rules 2 and 3 over a scratch
 * store) is a separate pass.
 *
 * @task T12763
 * @task T13278
 * @module store/sync/reconcile
 */

import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { TableScope } from '@cleocode/contracts';
import { LedgerOp } from '@cleocode/contracts/ledger';
import { BIRTH_FP_COLUMN, UID_COLUMN } from '../row-identity-registry.js';
import { type CaptureTableDef, captureTableDef, repairImageSql } from './capture.js';
import { parseHlc } from './hlc.js';
import { keyValues, keyWhere } from './repair.js';
import { hasTable } from './schema.js';
import { undoEnabled } from './sequencing.js';

/** What the three-way rule does with one differing field (§1.5 N7). */
export type ReconcileRule = 'emit-tick' | 'adopt-merged' | 'emit-pinned';

/** The facts the three-way rule decides one field by. */
export interface ReconcileField {
  /** An inherited capture, or an inherited sealed-but-unpushed op, changed the field. */
  readonly touchedByInherited: boolean;
  /** The field's HLC in this store's row meta, or null when the store has no meta for it. */
  readonly localHlc: string | null;
  /** The field's HLC in the merged state (checkpoint plus stream to head). */
  readonly mergedHlc: string;
}

/**
 * The three-way rule for one field that differs from the merged state.
 * Pure.
 *
 * @param f - Whether an inherited change touched it, and both HLCs.
 * @returns `emit-tick` (rule 1), `adopt-merged` (rule 2) or `emit-pinned` (rule 3).
 */
export function decideReconcileField(f: ReconcileField): ReconcileRule {
  if (f.touchedByInherited) return 'emit-tick';
  if (f.localHlc === null || f.localHlc < f.mergedHlc) return 'adopt-merged';
  return 'emit-pinned';
}

/** One row an inherited change touched, under its current uid. */
interface TouchedRow {
  readonly tbl: string;
  uid: string;
  /** The stream never saw the row: an inherited change inserted it. */
  inserted: boolean;
  /** An inherited change deleted it. */
  deleted: boolean;
  /** Columns an inherited U changed. */
  readonly cols: Set<string>;
  /** The time of its last inherited change (ms). */
  atMs: number;
}

/** A re-key the stream never saw, re-emitted ahead of the row changes. */
interface Rekey {
  readonly tbl: string;
  readonly rk: string;
  readonly oldUid: string;
  readonly img: string;
  readonly atMs: number;
}

/** What {@link reconcileInPlace} did. */
export interface ReconcileReport {
  /** The `rebind` frame the re-emitted rows were captured in, or null when nothing was touched. */
  readonly frame: string | null;
  /** Rows re-emitted as I, U and D, and re-keys re-emitted. */
  readonly inserts: number;
  readonly updates: number;
  readonly deletes: number;
  readonly rekeys: number;
  /** Inherited captures consumed. */
  readonly captures: number;
  /** Inherited transactions whose ops were read. */
  readonly txns: number;
}

const q = (id: string): string => `"${id.replaceAll('"', '""')}"`;
const rowKey = (tbl: string, uid: string): string => `${tbl}\u0000${uid}`;

/** An `enc()` text of a string or null, as a capture image carries it. */
const encText = (v: string | null | undefined): string =>
  v == null ? 'NULL' : `'${v.replaceAll("'", "''")}'`;

/** The physical ms of an op's HLC; 0 when unparseable. */
function physMs(hlc: string): number {
  try {
    return parseHlc(hlc).phys;
  } catch {
    return 0;
  }
}

/**
 * Re-emit what the previous replica changed and the stream never saw, as the
 * captures of one `rebind` frame, in the caller's (rebind) transaction
 * (module docs). Afterwards:
 * - the inherited captures are consumed (deleted): their changes now travel
 *   in the frame;
 * - the ledger forgets the row-count effect of the previous replica's
 *   inherited sealed transactions, which the frame's I and D ops count again
 *   when they seal;
 * - while undo is on, each capture gets its undo row (a reconcile repair
 *   keeps its undo until its echo, D1).
 *
 * @param db - The store, inside the rebind transaction.
 * @param o - Scope and the previous (retired) replica.
 * @returns What was re-emitted.
 */
export function reconcileInPlace(
  db: DatabaseSync,
  o: { readonly scope: TableScope; readonly previousReplica: string },
): ReconcileReport {
  // @sync-invariant none:local-only programming-error guard: the reconcile commits with its rebind
  if (!db.isTransaction) throw new Error('reconcileInPlace must run inside the rebind transaction');
  const defs = new Map<string, CaptureTableDef | null>();
  const defOf = (t: string): CaptureTableDef | null => {
    if (!defs.has(t)) defs.set(t, captureTableDef(db, o.scope, t) ?? null);
    return defs.get(t) ?? null;
  };
  const rows = new Map<string, TouchedRow>();
  const rekeys: Rekey[] = [];
  const ledger = new Map<string, number>();
  const alias = new Map<string, string>();
  const current = (tbl: string, uid: string): string => alias.get(rowKey(tbl, uid)) ?? uid;
  const touch = (tbl: string, uid: string, atMs: number): TouchedRow => {
    const key = rowKey(tbl, current(tbl, uid));
    let r = rows.get(key);
    if (!r) {
      r = {
        tbl,
        uid: current(tbl, uid),
        inserted: false,
        deleted: false,
        cols: new Set(),
        atMs,
      };
      rows.set(key, r);
    }
    r.atMs = Math.max(r.atMs, atMs);
    return r;
  };
  const rekey = (tbl: string, oldUid: string, newUid: string): void => {
    const was = rows.get(rowKey(tbl, oldUid));
    alias.set(rowKey(tbl, oldUid), newUid);
    if (was) {
      rows.delete(rowKey(tbl, oldUid));
      was.uid = newUid;
      rows.set(rowKey(tbl, newUid), was);
    }
  };
  const uidByRk = (def: CaptureTableDef, rk: string): string | null => {
    if (!def.identity.includes(UID_COLUMN)) return null;
    const r = db
      .prepare(`SELECT x.${q(UID_COLUMN)} AS uid FROM ${q(def.table)} x WHERE ${keyWhere(def)}`)
      .get(...keyValues(rk)) as { uid: string | null } | undefined;
    return r?.uid ?? null;
  };

  // 1. Inherited sealed transactions of the previous replica, in commit
  //    order: what they changed, and the row counts they already moved.
  let txns = 0;
  if (hasTable(db, '_sync_txn')) {
    const txnRows = db
      .prepare(
        "SELECT txn FROM _sync_txn WHERE state = 'inherited' AND replica = ? ORDER BY local_seq",
      )
      .all(o.previousReplica) as Array<{ txn: string }>;
    const ops = db.prepare('SELECT body FROM _sync_op WHERE txn = ? ORDER BY idx');
    for (const t of txnRows) {
      txns += 1;
      for (const raw of ops.all(t.txn) as Array<{ body: string }>) {
        const op = LedgerOp.parse(JSON.parse(raw.body));
        const at = physMs(op.h);
        if (op.o === 'K') {
          const nu = op.nu ?? op.u;
          const known = rows.get(rowKey(op.t, current(op.t, op.u)));
          if (!known?.inserted && nu !== op.u) {
            const def = defOf(op.t);
            const img = JSON.stringify({
              [UID_COLUMN]: [encText(op.u), encText(nu)],
              ...(op.bfp !== undefined || op.obfp !== undefined
                ? { [BIRTH_FP_COLUMN]: [encText(op.obfp), encText(op.bfp)] }
                : {}),
            });
            const rk = def ? liveRk(db, def, nu) : null;
            if (rk !== null) rekeys.push({ tbl: op.t, rk, oldUid: op.u, img, atMs: at });
          }
          rekey(op.t, op.u, nu);
          continue;
        }
        const r = touch(op.t, op.u, at);
        if (op.o === 'I') {
          r.inserted = true;
          r.deleted = false;
          ledger.set(op.t, (ledger.get(op.t) ?? 0) + 1);
        } else if (op.o === 'D') {
          r.deleted = true;
          ledger.set(op.t, (ledger.get(op.t) ?? 0) - 1);
        } else {
          for (const c of Object.keys(op.a ?? {})) r.cols.add(c);
        }
      }
    }
  }

  // 2. Inherited captures, in capture order: changes never sealed.
  let captures = 0;
  if (hasTable(db, '_sync_capture')) {
    const caps = db
      .prepare(
        "SELECT seq, tbl, op, rk, uid, img, at_ms FROM _sync_capture WHERE state = 'inherited' ORDER BY seq",
      )
      .all() as Array<{
      seq: number;
      tbl: string;
      op: 'I' | 'U' | 'D' | 'K';
      rk: string;
      uid: string | null;
      img: string;
      at_ms: number;
    }>;
    for (const c of caps) {
      captures += 1;
      const def = defOf(c.tbl);
      if (!def) continue; // the table left the sync set: nothing to re-emit
      const at = Number(c.at_ms);
      if (c.op === 'K') {
        const pair = (JSON.parse(c.img) as Record<string, [string, string]>)[UID_COLUMN];
        const oldUid = c.uid ?? (pair ? decodeText(pair[0]) : null);
        const newUid = pair ? decodeText(pair[1]) : null;
        if (oldUid === null || newUid === null) continue; // a fill: the I carries the uid
        const known = rows.get(rowKey(c.tbl, current(c.tbl, oldUid)));
        if (!known?.inserted && newUid !== oldUid) {
          rekeys.push({ tbl: c.tbl, rk: c.rk, oldUid, img: c.img, atMs: at });
        }
        rekey(c.tbl, oldUid, newUid);
        continue;
      }
      const uid = c.uid ?? uidByRk(def, c.rk);
      if (uid === null) continue; // a row that never got a uid and is gone: never known
      const r = touch(c.tbl, uid, at);
      if (c.op === 'I') {
        r.inserted = true;
        r.deleted = false;
      } else if (c.op === 'D') {
        r.deleted = true;
      } else {
        for (const col of Object.keys(JSON.parse(c.img) as Record<string, unknown>)) {
          r.cols.add(col);
        }
      }
    }
    db.prepare("DELETE FROM _sync_capture WHERE state = 'inherited'").run();
  }

  // 3. The ledger forgets the inherited sealed row counts (the frame recounts).
  if (hasTable(db, '_sync_ledger')) {
    const move = db.prepare('UPDATE _sync_ledger SET live = live - ? WHERE tbl = ?');
    for (const [tbl, delta] of ledger) if (delta !== 0) move.run(delta, tbl);
  }

  if (rows.size === 0 && rekeys.length === 0) {
    return { frame: null, inserts: 0, updates: 0, deletes: 0, rekeys: 0, captures, txns };
  }

  // 4. One rebind frame: the re-keys first, then each row from its live state.
  const frame = randomUUID();
  const first = (
    db.prepare('SELECT coalesce(max(seq), 0) + 1 AS n FROM main._sync_capture').get() as {
      n: number;
    }
  ).n;
  db.prepare('INSERT INTO _sync_frame (frame, kind, actor, first_seq) VALUES (?, ?, ?, ?)').run(
    frame,
    'rebind',
    null,
    first,
  );
  const undoOn = undoEnabled(db);
  const undo = db.prepare(
    `INSERT INTO _sync_undo (seq, txn_local, kind, tbl, rk, uid, op, before_full, after_full)
     SELECT c.seq, ?, 'repair', c.tbl, c.rk, c.uid, c.op, ?, CASE WHEN c.op IN ('I', 'U') THEN c.img END
       FROM _sync_capture c WHERE c.seq = last_insert_rowid()`,
  );
  const insRaw = db.prepare(
    `INSERT INTO _sync_capture (tbl, op, rk, uid, img, at_ms, frame, kind) VALUES (?, ?, ?, ?, ?, ?, ?, 'rebind')`,
  );
  let inserts = 0;
  let updates = 0;
  let deletes = 0;
  for (const k of rekeys) {
    insRaw.run(k.tbl, 'K', k.rk, k.oldUid, k.img, k.atMs, frame);
    if (undoOn) undo.run(frame, null);
  }
  for (const r of rows.values()) {
    const def = defOf(r.tbl);
    if (!def) continue;
    const rk = liveRk(db, def, r.uid);
    if (rk === null) {
      // Gone here. A row the stream never saw needs nothing; else it is a D.
      if (r.inserted) continue;
      insRaw.run(r.tbl, 'D', JSON.stringify(['<orphan>', r.uid]), r.uid, '{}', r.atMs, frame);
      if (undoOn) undo.run(frame, metaKey(db, r.tbl, r.uid));
      deletes += 1;
      continue;
    }
    const img = repairImageSql(def, 'x');
    if (r.inserted) {
      // The stream never saw this row: the meta an inherited seal wrote must
      // not make the sealer read the re-emitted insert as a REPLACE (a U).
      db.prepare('DELETE FROM _sync_row_meta WHERE tbl = ? AND uid = ?').run(r.tbl, r.uid);
      captureFromLive(db, def, img.insert, 'I', rk, r.uid, r.atMs, frame);
      if (undoOn) undo.run(frame, null);
      inserts += 1;
      continue;
    }
    const cols = new Set(
      [...r.cols].filter(
        (c) => def.columns.includes(c) && !def.identity.includes(c) && !def.secret.has(c),
      ),
    );
    if (r.deleted && !r.inserted) {
      // Deleted by an inherited change, then re-created locally: the whole row.
      captureFromLive(db, def, img.insert, 'I', rk, r.uid, r.atMs, frame);
      if (undoOn) undo.run(frame, null);
      inserts += 1;
      continue;
    }
    if (cols.size === 0) continue;
    captureFromLive(db, def, repairImageSql(def, 'x', cols).update, 'U', rk, r.uid, r.atMs, frame);
    if (undoOn) undo.run(frame, null);
    updates += 1;
  }
  return { frame, inserts, updates, deletes, rekeys: rekeys.length, captures, txns };
}

/** The text an `enc()` string value decodes to, or null. */
function decodeText(v: string | undefined): string | null {
  if (v === undefined || v === 'NULL') return null;
  return v.startsWith("'") && v.endsWith("'") ? v.slice(1, -1).replaceAll("''", "'") : null;
}

/** A live row's local key `rk`, found by uid, or null when the row is gone. */
function liveRk(db: DatabaseSync, def: CaptureTableDef, uid: string): string | null {
  if (!def.identity.includes(UID_COLUMN)) return null;
  const r = db
    .prepare(
      `SELECT ${repairImageSql(def, 'x').rk} AS rk FROM ${q(def.table)} x WHERE x.${q(UID_COLUMN)} = ?`,
    )
    .get(uid) as { rk: string } | undefined;
  return r?.rk ?? null;
}

/** The natural key row meta keeps for a uid (a D's undo before-image), or null. */
function metaKey(db: DatabaseSync, tbl: string, uid: string): string | null {
  if (!hasTable(db, '_sync_row_meta')) return null;
  const r = db
    .prepare('SELECT key_json FROM _sync_row_meta WHERE tbl = ? AND uid = ?')
    .get(tbl, uid) as { key_json: string | null } | undefined;
  return r?.key_json ?? null;
}

/** Insert one capture of the live row `rk` with the SQL image `image`. */
function captureFromLive(
  db: DatabaseSync,
  def: CaptureTableDef,
  image: string,
  op: 'I' | 'U',
  rk: string,
  uid: string,
  atMs: number,
  frame: string,
): void {
  db.prepare(
    `INSERT INTO _sync_capture (tbl, op, rk, uid, img, at_ms, frame, kind)
     SELECT ?, '${op}', ?, ?, ${image}, ?, ?, 'rebind' FROM ${q(def.table)} x WHERE ${keyWhere(def)}`,
  ).run(def.table, rk, uid, atMs, frame, ...keyValues(rk));
}
