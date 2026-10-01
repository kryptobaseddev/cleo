/**
 * The sealer, S3a (journal spec §2.5 phase B, §1.6, §2.6, §4.3; T12984).
 *
 * `sealPending` turns live `_sync_capture` rows into sealed transactions:
 *
 * 1. **Group (§2.4).** A validated frame (its `_sync_frame` row exists) is
 *    one transaction. Every capture with no validated frame is a singleton
 *    transaction flagged `unframed`, provenance `foreign` (ruling (c)): the
 *    sealer never claims atomicity it did not observe. A batch ends on a
 *    group boundary.
 * 2. **Ops (§2.6).** Each capture becomes one op. Values are decoded from the
 *    capture's `enc()` text to typed wire values; references become uids
 *    (resolved from the local key when the capture saw none); secret columns
 *    are removed (their home-stream companion ops are S3c). Natural rows
 *    carry `k`, their key with references as uids. A minted row with no uid
 *    or `birth_fp` keeps its whole group pending.
 * 3. **HLC.** `tick(at_ms)` per op in `seq` order; the transaction's HLC is
 *    its maximum.
 * 4. **Write.** `_sync_txn`, `_sync_op`; `_sync_row_meta` upserted per op
 *    (version, origin, actor, per-field `fhlc`, tombstone on D, key on
 *    natural rows) and MOVED on K (hlc, fhlc, version and chash kept);
 *    `chash` recomputed from the live row once no live capture of that row
 *    remains; `_sync_ledger` per table.
 * 5. **Consume.** Sealed captures are deleted, and frames no live capture
 *    references.
 *
 * Netting (§2.4 table, S3b), intent subtraction (S3b), `$inc` counters
 * (S3b), canonical wire timestamps (S3c), tombstone minimisation (S3c) and
 * the step-0 fill and repair diff (S3d) are later slices; this module leaves
 * each op exactly as captured.
 *
 * Phase B is synchronous: one `BEGIN IMMEDIATE` … `COMMIT` with no await, so
 * a caller on the accessor's transaction queue serializes it with every
 * writer on the handle.
 *
 * @module store/sync/sealer
 * @task T12984
 * @epic T12323
 */

import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { TableScope } from '@cleocode/contracts';
import { naturalRowUid } from '../row-identity.js';
import { BIRTH_FP_COLUMN, rowIdentitySpec, UID_COLUMN } from '../row-identity-registry.js';
import {
  type CaptureTableDef,
  captureTableDef,
  chunkedObject,
  enc,
  SECRET_MARKER,
} from './capture.js';
import { tickClock, withImmediateTransaction } from './clock-store.js';
import { isSyncFlagOn } from './flags.js';
import { type DraftOp, type MetaFacts, type NettedOp, netTransaction } from './netting.js';
import { hasTable } from './schema.js';
import { canonicalJson, decodeEnc, type WireValue } from './sealer-values.js';

export { canonicalJson, decodeEnc, type WireValue } from './sealer-values.js';

// ---------------------------------------------------------------------------
// Ops (§2.6)
// ---------------------------------------------------------------------------

/** One sealed op (§2.6 `LedgerOp`, without the transaction-level fields). */
export interface SealedOp {
  readonly t: string;
  /** Row uid; for K the OLD uid. */
  readonly u: string;
  readonly o: 'I' | 'U' | 'D' | 'K';
  readonly h: string;
  readonly nu?: string;
  readonly bfp?: string;
  readonly obfp?: string;
  readonly k?: Record<string, WireValue>;
  readonly a?: Record<string, WireValue>;
  readonly b?: Record<string, WireValue>;
}

/** What one `sealPending` call did. */
export interface SealReport {
  readonly txns: number;
  readonly ops: number;
  readonly captures: number;
  readonly unframed: number;
  /** Groups left pending (a minted row without uid or birth_fp), by first seq. */
  readonly pending: ReadonlyArray<{ readonly firstSeq: number; readonly reason: string }>;
  /** Why nothing was sealed, when the preconditions refused. */
  readonly refused: string | null;
}

interface CaptureRow {
  readonly seq: number;
  readonly tbl: string;
  readonly op: 'I' | 'U' | 'D' | 'K';
  readonly rk: string;
  readonly uid: string | null;
  readonly img: string;
  readonly at_ms: number;
  readonly frame: string | null;
}

interface Group {
  readonly frame: string | null;
  readonly kind: string;
  readonly actor: string | null;
  readonly captures: CaptureRow[];
}

/** Ledger transaction kinds a frame kind maps to (§2.6). */
const TXN_KINDS = new Set(['write', 'remint', 'rekey', 'repair', 'exodus', 'import']);

const q = (id: string): string => `"${id.replaceAll('"', '""')}"`;

/** Options for {@link sealPending}. */
export interface SealOptions {
  readonly scope: TableScope;
  /** This store's replica id (the HLC's replica part, `origin`). */
  readonly replica: string;
  /** Most captures to consume; the batch still ends on a group boundary. @defaultValue 5000 */
  readonly budget?: number;
  /** Wall clock in ms. @defaultValue Date.now */
  readonly now?: () => number;
  /** Environment for the kill switch. @defaultValue process.env */
  readonly env?: NodeJS.ProcessEnv;
}

class TableContext {
  private readonly defs = new Map<string, CaptureTableDef | null>();
  constructor(
    readonly db: DatabaseSync,
    private readonly scope: TableScope,
  ) {}

  /** The live row's uid by its local key (the capture's `rk`). */
  uidByKey(table: string, rk: string): string | null {
    const def = this.def(table);
    if (!def.identity.includes(UID_COLUMN)) return null;
    const parts = (JSON.parse(rk) as string[]).map((p) => decodeEnc(p));
    if (parts.some((v) => v !== null && typeof v === 'object')) return null;
    const where = def.key.map((k) => `${q(k)} = ?`).join(' AND ');
    const row = this.db
      .prepare(`SELECT ${q(UID_COLUMN)} AS u FROM ${q(table)} WHERE ${where}`)
      .get(...(parts as Array<string | number | null>)) as { u: string | null } | undefined;
    return row?.u ?? null;
  }

  /** A non-symmetric natural row's uid from its key (refs as uids), or null. */
  naturalUid(table: string, key: Record<string, WireValue>): string | null {
    const spec = rowIdentitySpec(this.scope, table);
    if (!spec || spec.kind === 'minted' || spec.symmetric) return null;
    const parts = spec.key.map((c) => key[c]);
    if (parts.some((v) => v === null || v === undefined || typeof v === 'object')) return null;
    return naturalRowUid(this.scope, table, parts as Array<string | number>);
  }

  /** The live row's birth_fp, so U ops of minted rows carry `bfp` (H5). */
  liveBirthFp(table: string, uid: string): string | undefined {
    const row = this.db
      .prepare(`SELECT ${q(BIRTH_FP_COLUMN)} AS f FROM ${q(table)} WHERE ${q(UID_COLUMN)} = ?`)
      .get(uid) as { f: string | null } | undefined;
    return row?.f ?? undefined;
  }

  def(table: string): CaptureTableDef {
    let d = this.defs.get(table);
    if (d === undefined) {
      d = captureTableDef(this.db, this.scope, table) ?? null;
      this.defs.set(table, d);
    }
    // §2.10: every op's table is in the sync set; a violation is a hard error.
    if (d === null) throw new Error(`sealer: capture for ${table}, which is not in the sync set`);
    return d;
  }

  minted(table: string): boolean {
    return rowIdentitySpec(this.scope, table)?.kind === 'minted';
  }

  /** The uid of `table`'s row whose first key column is `key`. */
  uidOf(table: string, keyColumn: string, key: WireValue): string | null {
    if (key === null || typeof key === 'object') return null;
    const row = this.db
      .prepare(`SELECT ${q(UID_COLUMN)} AS u FROM ${q(table)} WHERE ${q(keyColumn)} = ?`)
      .get(key) as { u: string | null } | undefined;
    return row?.u ?? null;
  }
}

/** A decoded column value: references become uids, secrets disappear. */
function columnValue(
  ctx: TableContext,
  def: CaptureTableDef,
  col: string,
  raw: unknown,
): WireValue | undefined {
  if (def.secret.has(col)) return undefined;
  const ref = def.refs.get(col);
  if (ref && Array.isArray(raw)) {
    const [localKey, uid] = raw as [string, string | null];
    if (uid !== null && uid !== undefined) return uid;
    const local = decodeEnc(localKey);
    return local === null ? null : ctx.uidOf(ref.table, ref.key, local);
  }
  if (typeof raw !== 'string')
    throw new Error(`sealer: ${def.table}.${col}: unexpected image value`);
  if (raw === SECRET_MARKER) return undefined;
  return decodeEnc(raw);
}

function imageValues(
  ctx: TableContext,
  def: CaptureTableDef,
  img: Record<string, unknown>,
  skipIdentity: boolean,
): Record<string, WireValue> {
  const out: Record<string, WireValue> = {};
  for (const [col, raw] of Object.entries(img)) {
    if (skipIdentity && def.identity.includes(col)) continue;
    const v = columnValue(ctx, def, col, raw);
    if (v !== undefined) out[col] = v;
  }
  return out;
}

/** Natural rows: the key, with references as uids, from the capture's `rk`. */
function naturalKey(
  ctx: TableContext,
  def: CaptureTableDef,
  rk: string,
): Record<string, WireValue> {
  const parts = JSON.parse(rk) as string[];
  const out: Record<string, WireValue> = {};
  def.key.forEach((col, i) => {
    const local = decodeEnc(parts[i] as string);
    const ref = def.refs.get(col);
    out[col] = ref ? ctx.uidOf(ref.table, ref.key, local) : local;
  });
  return out;
}

function str(v: WireValue | undefined): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/**
 * Build one draft op from a capture (S3b: netting runs on drafts). The uid
 * may stay NULL here; the netted op is checked afterwards, so a clear-and-
 * refill pair (K x → NULL, K NULL → y) can net to one K first (N8).
 */
function buildDraft(ctx: TableContext, c: CaptureRow): DraftOp {
  const def = ctx.def(c.tbl);
  const img = JSON.parse(c.img) as Record<string, unknown>;
  const minted = ctx.minted(c.tbl);
  const natural = !minted ? { k: naturalKey(ctx, def, c.rk) } : {};
  const base = { t: c.tbl, rk: c.rk, seq: c.seq };
  if (c.op === 'K') {
    const pair = (col: string) => {
      const p = img[col] as [string, string] | undefined;
      return p ? [str(decodeEnc(p[0])), str(decodeEnc(p[1]))] : [undefined, undefined];
    };
    const [, nu] = pair(UID_COLUMN);
    const [obfp, bfp] = pair(BIRTH_FP_COLUMN);
    return {
      ...base,
      o: 'K',
      u: c.uid,
      nu: nu ?? null,
      ...(bfp ? { bfp } : {}),
      ...(obfp ? { obfp } : {}),
      ...natural,
    };
  }
  let uid = c.uid;
  if (uid === null && def.identity.includes(UID_COLUMN)) {
    const raw = img[UID_COLUMN];
    if (typeof raw === 'string') uid = str(decodeEnc(raw)) ?? null;
  }
  // Resolve a missing uid from the live row by its local key (§2.5 step 3).
  if (uid === null) uid = ctx.uidByKey(c.tbl, c.rk);
  // A natural row's uid is a function of its key with references as uids
  // (T12341 §5.3), so a capture taken before the fill still seals. Symmetric
  // edges need the fill's twin rule and wait for it (the step-0 fill, S3d).
  if (uid === null && !minted && natural.k) uid = ctx.naturalUid(c.tbl, natural.k);

  switch (c.op) {
    case 'I': {
      const bfp = str(columnValue(ctx, def, BIRTH_FP_COLUMN, img[BIRTH_FP_COLUMN] ?? 'NULL'));
      return {
        ...base,
        o: 'I',
        u: uid,
        ...(bfp ? { bfp } : {}),
        ...natural,
        a: imageValues(ctx, def, img, true),
      };
    }
    case 'U': {
      const a: Record<string, WireValue> = {};
      const b: Record<string, WireValue> = {};
      for (const [col, pair] of Object.entries(img)) {
        const [before, after] = pair as [unknown, unknown];
        const nv = columnValue(ctx, def, col, after);
        const ov = columnValue(ctx, def, col, before);
        if (nv !== undefined) a[col] = nv;
        if (ov !== undefined) b[col] = ov;
      }
      const bfp = minted && uid !== null ? ctx.liveBirthFp(c.tbl, uid) : undefined;
      return { ...base, o: 'U', u: uid, ...(bfp ? { bfp } : {}), ...natural, a, b };
    }
    case 'D': {
      const bfp = str(columnValue(ctx, def, BIRTH_FP_COLUMN, img[BIRTH_FP_COLUMN] ?? 'NULL'));
      return {
        ...base,
        o: 'D',
        u: uid,
        ...(bfp ? { bfp } : {}),
        ...natural,
        b: imageValues(ctx, def, img, true),
      };
    }
  }
}

/** Why a netted op cannot be sealed yet, or null. */
function unsealable(ctx: TableContext, op: NettedOp): string | null {
  if (op.u === null) return `${op.t} seq ${op.seq}: row has no uid`;
  if (op.o === 'K' && (op.nu ?? null) === null)
    return `${op.t} seq ${op.seq}: re-key to a NULL uid`;
  if (
    op.o === 'I' &&
    ctx.minted(op.t) &&
    ctx.def(op.t).identity.includes(BIRTH_FP_COLUMN) &&
    op.bfp === undefined
  ) {
    return `${op.t} seq ${op.seq}: minted row has no birth_fp`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Row meta, chash, ledger
// ---------------------------------------------------------------------------

interface MetaRow {
  hlc: string;
  fhlc: string | null;
  version: number;
  deleted: number;
  key_json: string | null;
  chash: string | null;
}

/**
 * sha256 of a row's canonical image without secret columns (§2.7, M6). The
 * image is read through the same `enc()` text capture uses, so every replica
 * hashes identical bytes; NULL columns are omitted, as in an I image.
 */
export function rowChash(db: DatabaseSync, def: CaptureTableDef, uid: string): string | null {
  const cols = def.columns.filter((c) => !def.secret.has(c));
  if (cols.length === 0) return null;
  const row = db
    .prepare(
      `SELECT ${chunkedObject(cols.map((c) => [c, enc(q(c))] as const))} AS img FROM ${q(def.table)} WHERE ${q(UID_COLUMN)} = ?`,
    )
    .get(uid) as { img: string } | undefined;
  if (!row) return null;
  const decoded: Record<string, WireValue> = {};
  for (const [col, raw] of Object.entries(JSON.parse(row.img) as Record<string, string>)) {
    const v = decodeEnc(raw);
    if (v !== null) decoded[col] = v;
  }
  return createHash('sha256').update(canonicalJson(decoded)).digest('hex');
}

function nextFhlc(
  prev: MetaRow | undefined,
  def: CaptureTableDef,
  changed: readonly string[],
  h: string,
): string | null {
  if (!prev) return null;
  const old = prev.fhlc ? (JSON.parse(prev.fhlc) as Record<string, string>) : {};
  const out: Record<string, string> = {};
  for (const col of def.columns) {
    if (def.identity.includes(col) || changed.includes(col)) continue;
    const at = old[col] ?? prev.hlc;
    if (at < h) out[col] = at;
  }
  return Object.keys(out).length > 0 ? canonicalJson(out) : null;
}

// ---------------------------------------------------------------------------
// sealPending
// ---------------------------------------------------------------------------

/** Why the sealer refuses to run, or `null` when it may. */
export function sealPreconditions(db: DatabaseSync, env: NodeJS.ProcessEnv): string | null {
  if (!hasTable(db, '_sync_capture') || !hasTable(db, '_sync_txn')) {
    return 'sync schema not installed';
  }
  if (!isSyncFlagOn(db, 'sync.seal', env)) return 'sync.seal is off';
  return null;
}

/**
 * Seal up to `budget` live captures (ending on a group boundary) into
 * transactions, in one synchronous `BEGIN IMMEDIATE` transaction.
 *
 * @returns what was sealed, what stays pending, or why nothing ran.
 */
export function sealPending(db: DatabaseSync, opts: SealOptions): SealReport {
  const refused = sealPreconditions(db, opts.env ?? process.env);
  if (refused) {
    return { txns: 0, ops: 0, captures: 0, unframed: 0, pending: [], refused };
  }
  const now = opts.now ?? Date.now;
  const budget = Math.max(1, opts.budget ?? 5000);
  return withImmediateTransaction(db, () => sealInTransaction(db, opts, budget, now));
}

function sealInTransaction(
  db: DatabaseSync,
  opts: SealOptions,
  budget: number,
  now: () => number,
): SealReport {
  const ctx = new TableContext(db, opts.scope);

  // 1. Read a batch and extend it to the end of its last frame.
  const batch = db
    .prepare(
      "SELECT seq, tbl, op, rk, uid, img, at_ms, frame FROM _sync_capture WHERE state = 'live' ORDER BY seq LIMIT ?",
    )
    .all(budget) as unknown as CaptureRow[];
  if (batch.length === 0)
    return { txns: 0, ops: 0, captures: 0, unframed: 0, pending: [], refused: null };
  const lastFrame = batch[batch.length - 1]?.frame ?? null;
  if (lastFrame !== null) {
    const maxSeq = batch[batch.length - 1]?.seq ?? 0;
    batch.push(
      ...(db
        .prepare(
          "SELECT seq, tbl, op, rk, uid, img, at_ms, frame FROM _sync_capture WHERE state = 'live' AND frame = ? AND seq > ? ORDER BY seq",
        )
        .all(lastFrame, maxSeq) as unknown as CaptureRow[]),
    );
  }

  // 2. Group: a validated frame is one transaction; anything else a singleton.
  const frames = new Map<string, { kind: string; actor: string | null }>();
  for (const f of db.prepare('SELECT frame, kind, actor FROM _sync_frame').all() as Array<{
    frame: string;
    kind: string;
    actor: string | null;
  }>) {
    frames.set(f.frame, { kind: f.kind, actor: f.actor });
  }
  const groups: Group[] = [];
  const byFrame = new Map<string, Group>();
  for (const c of batch) {
    const f = c.frame !== null ? frames.get(c.frame) : undefined;
    if (c.frame !== null && f) {
      let g = byFrame.get(c.frame);
      if (!g) {
        g = { frame: c.frame, kind: f.kind, actor: f.actor, captures: [] };
        byFrame.set(c.frame, g);
        groups.push(g);
      }
      g.captures.push(c);
    } else {
      groups.push({ frame: null, kind: 'write', actor: null, captures: [c] });
    }
  }

  // 3–5. Seal each group.
  const meta = {
    get: db.prepare(
      'SELECT hlc, fhlc, version, deleted, key_json, chash FROM _sync_row_meta WHERE tbl = ? AND uid = ?',
    ),
    upsert: db.prepare(
      `INSERT INTO _sync_row_meta (tbl, uid, hlc, fhlc, origin, actor, version, deleted, key_json, chash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (tbl, uid) DO UPDATE SET hlc = excluded.hlc, fhlc = excluded.fhlc,
         origin = excluded.origin, actor = excluded.actor, version = excluded.version,
         deleted = excluded.deleted, key_json = coalesce(excluded.key_json, key_json),
         chash = excluded.chash`,
    ),
    remove: db.prepare('DELETE FROM _sync_row_meta WHERE tbl = ? AND uid = ?'),
  };
  const insTxn = db.prepare(
    `INSERT INTO _sync_txn (txn, local_seq, replica, hlc, scope, via, kind, actor, frame, unframed, op_count, sealed_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insOp = db.prepare(
    'INSERT INTO _sync_op (txn, idx, tbl, uid, o, hlc, body) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  let localSeq = (
    db.prepare('SELECT coalesce(max(local_seq), 0) AS n FROM _sync_txn').get() as { n: number }
  ).n;

  let txns = 0;
  let ops = 0;
  let unframed = 0;
  const consumed: number[] = [];
  const pending: Array<{ firstSeq: number; reason: string }> = [];
  const touched = new Map<string, { tbl: string; uid: string; rk: string }>();
  const ledgerDelta = new Map<string, number>();

  const metaFacts: MetaFacts = {
    sent: (t, u) =>
      (
        db.prepare('SELECT sent FROM _sync_row_meta WHERE tbl = ? AND uid = ?').get(t, u) as
          | { sent: number }
          | undefined
      )?.sent === 1,
    live: (t, u) =>
      (
        db.prepare('SELECT deleted FROM _sync_row_meta WHERE tbl = ? AND uid = ?').get(t, u) as
          | { deleted: number }
          | undefined
      )?.deleted === 0,
  };
  const moveMeta = db.prepare('UPDATE _sync_row_meta SET uid = ? WHERE tbl = ? AND uid = ?');

  for (const g of groups) {
    const capOf = new Map(g.captures.map((c) => [c.seq, c] as const));
    const netted = netTransaction(
      g.captures.map((c) => buildDraft(ctx, c)),
      metaFacts,
    );
    const wait = netted.ops.map((op) => unsealable(ctx, op)).find((r) => r !== null) ?? null;
    if (wait !== null) {
      pending.push({ firstSeq: g.captures[0]?.seq ?? 0, reason: wait });
      continue;
    }
    // Dropped re-keys (uid never left the device): the meta follows the row.
    for (const r of netted.renames) {
      meta.remove.run(r.t, r.to);
      moveMeta.run(r.to, r.t, r.from);
    }
    for (const c of g.captures) consumed.push(c.seq);
    if (netted.ops.length === 0) continue; // everything netted away

    localSeq += 1;
    const txn = `${opts.replica}:${localSeq}`;
    const sealedOps: Array<SealedOp & { readonly seq: number }> = netted.ops.map((op) => {
      const { seq, ...rest } = op;
      return {
        ...(rest as Omit<SealedOp, 'h'>),
        seq,
        h: tickClock(db, opts.replica, capOf.get(seq)?.at_ms ?? now()),
      };
    });
    const txnHlc = sealedOps.reduce((m, o) => (o.h > m ? o.h : m), sealedOps[0]?.h ?? '');
    const kind = g.frame !== null && TXN_KINDS.has(g.kind) ? g.kind : 'write';
    insTxn.run(
      txn,
      localSeq,
      opts.replica,
      txnHlc,
      opts.scope,
      g.frame === null ? 'foreign' : 'accessor',
      kind,
      g.actor,
      g.frame,
      g.frame === null ? 1 : 0,
      sealedOps.length,
      now(),
    );
    sealedOps.forEach(({ seq, ...op }, i) => {
      const rk = capOf.get(seq)?.rk ?? '';
      insOp.run(txn, i, op.t, op.u, op.o, op.h, canonicalJson(op));
      const def = ctx.def(op.t);
      const prev = meta.get.get(op.t, op.u) as MetaRow | undefined;
      const keyJson = op.k ? canonicalJson(op.k) : null;
      if (op.o === 'K' && op.nu !== undefined) {
        // Move the row's meta to its new uid, keeping hlc/fhlc/version/chash.
        meta.remove.run(op.t, op.u);
        meta.upsert.run(
          op.t,
          op.nu,
          op.h,
          prev?.fhlc ?? null,
          opts.replica,
          g.actor,
          (prev?.version ?? 0) + 1,
          0,
          keyJson ?? prev?.key_json ?? null,
          prev?.chash ?? null,
        );
        touched.delete(`${op.t}\u0000${op.u}`);
        touched.set(`${op.t}\u0000${op.nu}`, { tbl: op.t, uid: op.nu, rk });
        return;
      }
      const changed = op.o === 'U' ? Object.keys(op.a ?? {}) : [];
      const fhlc = op.o === 'U' ? nextFhlc(prev, def, changed, op.h) : null;
      meta.upsert.run(
        op.t,
        op.u,
        op.h,
        fhlc,
        opts.replica,
        g.actor,
        (prev?.version ?? 0) + 1,
        op.o === 'D' ? 1 : 0,
        keyJson,
        op.o === 'D' ? (prev?.chash ?? null) : null,
      );
      if (op.o === 'I') ledgerDelta.set(op.t, (ledgerDelta.get(op.t) ?? 0) + 1);
      if (op.o === 'D') ledgerDelta.set(op.t, (ledgerDelta.get(op.t) ?? 0) - 1);
      if (op.o === 'D') touched.delete(`${op.t}\u0000${op.u}`);
      else touched.set(`${op.t}\u0000${op.u}`, { tbl: op.t, uid: op.u, rk });
    });
    txns += 1;
    ops += sealedOps.length;
    if (g.frame === null) unframed += 1;
  }

  // Consume the sealed captures (and frames nothing references any more).
  const del = db.prepare('DELETE FROM _sync_capture WHERE seq = ?');
  for (const seq of consumed) del.run(seq);
  db.exec(
    "DELETE FROM _sync_frame WHERE NOT EXISTS (SELECT 1 FROM _sync_capture c WHERE c.frame = _sync_frame.frame AND c.state = 'live')",
  );

  // chash from the live row, once no live capture of that row remains.
  const stillLive = db.prepare(
    "SELECT 1 FROM _sync_capture WHERE tbl = ? AND rk = ? AND state = 'live' LIMIT 1",
  );
  const setChash = db.prepare('UPDATE _sync_row_meta SET chash = ? WHERE tbl = ? AND uid = ?');
  for (const { tbl, uid, rk } of touched.values()) {
    if (stillLive.get(tbl, rk)) continue;
    setChash.run(rowChash(db, ctx.def(tbl), uid), tbl, uid);
  }

  // Ledger: sealed live rows per table. First sight: count(*) minus the net
  // effect of captures still waiting to be sealed.
  const ledgerGet = db.prepare('SELECT live FROM _sync_ledger WHERE tbl = ?');
  const ledgerSet = db.prepare(
    'INSERT INTO _sync_ledger (tbl, live) VALUES (?, ?) ON CONFLICT (tbl) DO UPDATE SET live = excluded.live',
  );
  for (const [tbl, delta] of ledgerDelta) {
    const row = ledgerGet.get(tbl) as { live: number } | undefined;
    if (row) {
      ledgerSet.run(tbl, row.live + delta);
      continue;
    }
    const count = (db.prepare(`SELECT count(*) AS n FROM ${q(tbl)}`).get() as { n: number }).n;
    const waiting = (
      db
        .prepare(
          "SELECT coalesce(sum(CASE op WHEN 'I' THEN 1 WHEN 'D' THEN -1 ELSE 0 END), 0) AS n FROM _sync_capture WHERE tbl = ? AND state = 'live'",
        )
        .get(tbl) as { n: number }
    ).n;
    ledgerSet.run(tbl, count - waiting);
  }

  return { txns, ops, captures: consumed.length, unframed, pending, refused: null };
}
