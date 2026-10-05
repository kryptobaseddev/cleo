/**
 * Uid remaps propagate to everything still pending (journal spec §3.3 G;
 * T12779).
 *
 * A capture records a reference as `[enc(local key), target uid]`, with the
 * target's uid read when the write happened. When that uid is later replaced
 * without the stream ever learning the old one (a re-key netted into the
 * row's own insert, a refill), every pending capture and every sealed but
 * unsegmented op that still names the old uid would send a reference to a
 * row no replica has. {@link remapPending} rewrites them, in the remap's own
 * transaction: reference uids, the remapped row's own uid, and its birth
 * fingerprint when that changed too.
 *
 * Segmented transactions are never rewritten: what a segment carries is
 * history.
 *
 * @task T12779
 * @module store/sync/remap
 */

import type { DatabaseSync } from 'node:sqlite';
import type { TableScope } from '@cleocode/contracts';
import { BIRTH_FP_COLUMN, rowIdentitySpec, UID_COLUMN } from '../row-identity-registry.js';
import { hasTable } from './schema.js';
import { canonicalJson, decodeEnc } from './sealer-values.js';

/** `enc()` of a text value, as the capture triggers write it (`quote()`). */
export function encText(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** One remap: `oldUid` became `newUid` (the same uid when only `bfp` changed). */
export interface UidRemap {
  readonly table: string;
  readonly oldUid: string;
  readonly newUid: string;
  /** The row's new birth fingerprint, or null when it is unchanged. */
  readonly newBfp: string | null;
}

/** A capture's remappable fields. */
export interface RemappableCapture {
  readonly tbl: string;
  readonly op: 'I' | 'U' | 'D' | 'K';
  readonly uid: string | null;
  readonly img: string;
}

const CAPTURE_OPS: ReadonlySet<string> = new Set(['I', 'U', 'D', 'K']);

/** Whether a stored `op` is one of the capture ops. */
function isCaptureOp(op: unknown): op is RemappableCapture['op'] {
  return typeof op === 'string' && CAPTURE_OPS.has(op);
}

/** Rewrite every reference pair `[local key, oldUid]` anywhere in a value. */
function remapRefs(value: unknown, oldUid: string, newUid: string): unknown {
  if (!Array.isArray(value)) return value;
  if (
    value.length === 2 &&
    value[1] === oldUid &&
    (typeof value[0] === 'string' || value[0] === null)
  ) {
    return [value[0], newUid];
  }
  const mapped = value.map((v) => remapRefs(v, oldUid, newUid));
  return mapped.some((v, i) => v !== value[i]) ? mapped : value;
}

/** Whether an identity cell (an `enc()` text) holds `uid`. */
function encIs(raw: unknown, uid: string): boolean {
  if (typeof raw !== 'string') return false;
  try {
    return decodeEnc(raw) === uid;
  } catch {
    return false;
  }
}

/**
 * A capture with `remap` applied: its reference pairs, and, when it is the
 * remapped row's own I or D capture, its uid and birth fingerprint. A K's
 * own (old, new) pair holds `enc()` texts, never a bare uid, so it is never
 * mistaken for a reference and keeps recording the remap itself. Returns the
 * same object when nothing changed.
 */
export function remapCapture<C extends RemappableCapture>(c: C, remap: UidRemap): C {
  const img = JSON.parse(c.img) as Record<string, unknown>;
  let changed = false;
  const own =
    c.tbl === remap.table && (c.uid === remap.oldUid || encIs(img[UID_COLUMN], remap.oldUid));
  for (const [col, raw] of Object.entries(img)) {
    if (own && (c.op === 'I' || c.op === 'D') && col === UID_COLUMN && encIs(raw, remap.oldUid)) {
      if (raw !== encText(remap.newUid)) {
        img[col] = encText(remap.newUid);
        changed = true;
      }
      continue;
    }
    if (own && (c.op === 'I' || c.op === 'D') && col === BIRTH_FP_COLUMN && remap.newBfp !== null) {
      if (raw !== encText(remap.newBfp)) {
        img[col] = encText(remap.newBfp);
        changed = true;
      }
      continue;
    }
    const next = remapRefs(raw, remap.oldUid, remap.newUid);
    if (next !== raw) {
      img[col] = next;
      changed = true;
    }
  }
  const uid = own && c.uid === remap.oldUid ? remap.newUid : c.uid;
  if (!changed && uid === c.uid) return c;
  return { ...c, uid, img: JSON.stringify(img) };
}

/** A sealed op body with `remap` applied (reference values are plain uids there). */
export function remapOpBody(
  body: Record<string, unknown>,
  remap: UidRemap,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...body };
  for (const part of ['a', 'b', 'k'] as const) {
    const values = body[part];
    if (values === null || typeof values !== 'object' || Array.isArray(values)) continue;
    const next: Record<string, unknown> = {};
    for (const [col, v] of Object.entries(values))
      next[col] = v === remap.oldUid ? remap.newUid : v;
    out[part] = next;
  }
  if (body.t === remap.table && body.u === remap.oldUid) {
    out.u = remap.newUid;
    if (remap.newBfp !== null && body.o !== 'K') out.bfp = remap.newBfp;
  }
  if (body.t === remap.table && body.nu === remap.oldUid) out.nu = remap.newUid;
  return out;
}

/** What {@link remapPending} rewrote. */
export interface RemapReport {
  readonly captures: number;
  readonly ops: number;
}

/**
 * Apply a uid remap to every live capture and every op of a sealed,
 * unsegmented transaction (§3.3 G), in the caller's transaction.
 *
 * @param db - The store, inside the remap's transaction.
 * @param remap - What changed.
 * @returns How many captures and ops were rewritten.
 */
export function remapPending(db: DatabaseSync, remap: UidRemap): RemapReport {
  let captures = 0;
  let ops = 0;
  const needle = `%${remap.oldUid}%`;
  if (hasTable(db, '_sync_capture')) {
    const update = db.prepare('UPDATE _sync_capture SET uid = ?, img = ? WHERE seq = ?');
    const rows = db
      .prepare(
        "SELECT seq, tbl, op, uid, img FROM _sync_capture WHERE state = 'live' AND (uid = ? OR img LIKE ?)",
      )
      .all(remap.oldUid, needle);
    for (const row of rows) {
      const op = row.op;
      if (!isCaptureOp(op)) continue;
      const c = {
        seq: Number(row.seq),
        tbl: String(row.tbl),
        op,
        uid: typeof row.uid === 'string' ? row.uid : null,
        img: String(row.img),
      };
      const next = remapCapture(c, remap);
      if (next === c) continue;
      update.run(next.uid, next.img, c.seq);
      captures += 1;
    }
  }
  if (hasTable(db, '_sync_op') && hasTable(db, '_sync_txn')) {
    const update = db.prepare('UPDATE _sync_op SET uid = ?, body = ? WHERE txn = ? AND idx = ?');
    for (const r of db
      .prepare(
        `SELECT o.txn, o.idx, o.body FROM _sync_op o JOIN _sync_txn t ON t.txn = o.txn
         WHERE t.state = 'sealed' AND o.body LIKE ?`,
      )
      .all(needle) as Array<{ txn: string; idx: number; body: string }>) {
      const body = JSON.parse(r.body) as Record<string, unknown>;
      const next = remapOpBody(body, remap);
      const text = canonicalJson(next);
      if (text === r.body) continue;
      update.run(String(next.u), text, r.txn, r.idx);
      ops += 1;
    }
  }
  return { captures, ops };
}

/**
 * After a refill re-derived birth fingerprints (§12.1, before any uid has
 * synced), point every pending capture and unsegmented op of a minted row at
 * the row's current `birth_fp` (§3.3 G; T12779). Uids are unchanged by a
 * refill. A row that no longer exists is left alone.
 *
 * @returns How many captures and ops were rewritten.
 */
export function refreshPendingBirthFps(db: DatabaseSync, scope: TableScope): RemapReport {
  if (!hasTable(db, '_sync_capture')) return { captures: 0, ops: 0 };
  const rows = new Set<string>();
  const add = (tbl: string, uid: string | null) => {
    if (uid !== null && rowIdentitySpec(scope, tbl)?.kind === 'minted')
      rows.add(`${tbl}\u0000${uid}`);
  };
  for (const r of db
    .prepare("SELECT DISTINCT tbl, uid FROM _sync_capture WHERE state = 'live' AND uid IS NOT NULL")
    .all() as Array<{ tbl: string; uid: string }>) {
    add(r.tbl, r.uid);
  }
  if (hasTable(db, '_sync_txn')) {
    for (const r of db
      .prepare(
        "SELECT DISTINCT o.tbl, o.uid FROM _sync_op o JOIN _sync_txn t ON t.txn = o.txn WHERE t.state = 'sealed'",
      )
      .all() as Array<{ tbl: string; uid: string }>) {
      add(r.tbl, r.uid);
    }
  }
  let captures = 0;
  let ops = 0;
  for (const key of rows) {
    const [table, uid] = key.split('\u0000') as [string, string];
    const row = db
      .prepare(`SELECT ${q(BIRTH_FP_COLUMN)} AS fp FROM ${q(table)} WHERE ${q(UID_COLUMN)} = ?`)
      .get(uid) as { fp: string | null } | undefined;
    if (!row?.fp) continue;
    const r = remapPending(db, { table, oldUid: uid, newUid: uid, newBfp: row.fp });
    captures += r.captures;
    ops += r.ops;
  }
  return { captures, ops };
}

const q = (id: string): string => `"${id.replaceAll('"', '""')}"`;
