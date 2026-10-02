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
import type { DatabaseSync, StatementSync } from 'node:sqlite';
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
import { activeReplica } from './replica.js';
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
  /**
   * This store's replica id (the HLC's replica part, `origin`).
   * @defaultValue the store's active replica (`_sync_replica`)
   */
  readonly replica?: string;
  /** Most captures to consume; the batch still ends on a group boundary. @defaultValue 5000 */
  readonly budget?: number;
  /** Wall clock in ms. @defaultValue Date.now */
  readonly now?: () => number;
  /** Environment for the kill switch. @defaultValue process.env */
  readonly env?: NodeJS.ProcessEnv;
  /**
   * Stop starting new groups after this long in one transaction, so a batch
   * never holds the write lock for long (T13032). @defaultValue 200
   */
  readonly maxMs?: number;
}

/** The two identity columns an op carries as `u` / `bfp` instead of in its images. */
const OP_IDENTITY: ReadonlySet<string> = new Set([UID_COLUMN, BIRTH_FP_COLUMN]);

/** A capture the sealer cannot read (a table left the sync set, a malformed image). */
class SealInputError extends Error {}

class TableContext {
  private readonly defs = new Map<string, CaptureTableDef | null>();
  private readonly stmts = new Map<string, StatementSync>();
  constructor(
    readonly db: DatabaseSync,
    readonly scope: TableScope,
  ) {}

  /** A statement prepared once per sealing pass (T13032). */
  private stmt(sql: string): StatementSync {
    let st = this.stmts.get(sql);
    if (!st) {
      st = this.db.prepare(sql);
      this.stmts.set(sql, st);
    }
    return st;
  }

  /** The birth_fp row meta recorded for a uid (survives a delete or a re-key). */
  metaBirthFp(table: string, uid: string): string | undefined {
    const row = this.stmt('SELECT bfp AS f FROM _sync_row_meta WHERE tbl = ? AND uid = ?').get(
      table,
      uid,
    ) as { f: string | null } | undefined;
    return row?.f ?? undefined;
  }

  /** The live row's uid by its local key (the capture's `rk`). */
  uidByKey(table: string, rk: string): string | null {
    const def = this.def(table);
    if (!def.identity.includes(UID_COLUMN)) return null;
    const parts = (JSON.parse(rk) as string[]).map((p) => decodeEnc(p));
    if (parts.some((v) => v !== null && typeof v === 'object')) return null;
    const where = def.key.map((k) => `${q(k)} = ?`).join(' AND ');
    const row = this.stmt(`SELECT ${q(UID_COLUMN)} AS u FROM ${q(table)} WHERE ${where}`).get(
      ...(parts as Array<string | number | null>),
    ) as { u: string | null } | undefined;
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
    const row = this.stmt(
      `SELECT ${q(BIRTH_FP_COLUMN)} AS f FROM ${q(table)} WHERE ${q(UID_COLUMN)} = ?`,
    ).get(uid) as { f: string | null } | undefined;
    return row?.f ?? undefined;
  }

  def(table: string): CaptureTableDef {
    let d = this.defs.get(table);
    if (d === undefined) {
      d = captureTableDef(this.db, this.scope, table) ?? null;
      this.defs.set(table, d);
    }
    // §2.10: every op's table is in the sync set. A capture of any other table
    // holds its group (reported), never aborts the batch (T13029).
    if (d === null) throw new SealInputError(`capture for ${table}, which is not in the sync set`);
    return d;
  }

  minted(table: string): boolean {
    return rowIdentitySpec(this.scope, table)?.kind === 'minted';
  }

  /** The uid of `table`'s row whose first key column is `key`. */
  uidOf(table: string, keyColumn: string, key: WireValue): string | null {
    if (key === null || typeof key === 'object') return null;
    const row = this.stmt(
      `SELECT ${q(UID_COLUMN)} AS u FROM ${q(table)} WHERE ${q(keyColumn)} = ?`,
    ).get(key) as { u: string | null } | undefined;
    return row?.u ?? null;
  }
}

/**
 * A decoded column value: references become uids, secrets disappear. Decoded
 * by the value's shape (T13029): a `[local key, uid]` pair is a reference
 * however the column is declared now, a string is an `enc()` value.
 */
function columnValue(
  ctx: TableContext,
  def: CaptureTableDef,
  col: string,
  raw: unknown,
): WireValue | undefined {
  if (def.secret.has(col)) return undefined;
  if (Array.isArray(raw)) {
    const [localKey, uid] = raw as [unknown, unknown];
    if (typeof uid === 'string') return uid;
    const local = typeof localKey === 'string' ? decodeEnc(localKey) : null;
    if (local === null) return null;
    const ref = def.refs.get(col);
    return ref ? ctx.uidOf(ref.table, ref.key, local) : local;
  }
  if (typeof raw !== 'string')
    throw new SealInputError(`${def.table}.${col}: unexpected image value`);
  if (raw === SECRET_MARKER) return undefined;
  try {
    return decodeEnc(raw);
  } catch (err) {
    throw new SealInputError(`${def.table}.${col}: ${(err as Error).message}`);
  }
}

function imageValues(
  ctx: TableContext,
  def: CaptureTableDef,
  img: Record<string, unknown>,
  skipIdentity: boolean,
): Record<string, WireValue> {
  const out: Record<string, WireValue> = {};
  for (const [col, raw] of Object.entries(img)) {
    // Only uid and birth_fp move to `u` / `bfp`; stored ref uids (ac_uid,
    // ac_text_hash) are row content and stay in the image (T13030).
    if (skipIdentity && OP_IDENTITY.has(col)) continue;
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

/** birth_fp per `tbl\0uid`, as the batch's own images record it (T13030). */
type BatchBirths = Map<string, string>;

const rowKey = (t: string, u: string): string => `${t}\u0000${u}`;

/**
 * The birth_fp every capture of the batch records: I and D images, and both
 * sides of a K. A later op on a row that was since deleted or re-keyed then
 * still carries `bfp` (T13030). Unreadable captures are skipped here; their
 * group reports them.
 */
function batchBirths(batch: readonly CaptureRow[]): BatchBirths {
  const out: BatchBirths = new Map();
  for (const c of batch) {
    try {
      const img = JSON.parse(c.img) as Record<string, unknown>;
      if (c.op === 'K') {
        const u = img[UID_COLUMN] as [string, string] | undefined;
        const f = img[BIRTH_FP_COLUMN] as [string, string] | undefined;
        if (u && f) {
          const [ou, nu] = [str(decodeEnc(u[0])), str(decodeEnc(u[1]))];
          const [of, nf] = [str(decodeEnc(f[0])), str(decodeEnc(f[1]))];
          if (ou && of) out.set(rowKey(c.tbl, ou), of);
          if (nu && nf) out.set(rowKey(c.tbl, nu), nf);
        }
        continue;
      }
      const uid =
        c.uid ??
        (typeof img[UID_COLUMN] === 'string'
          ? str(decodeEnc(img[UID_COLUMN] as string))
          : undefined);
      const bfp =
        typeof img[BIRTH_FP_COLUMN] === 'string'
          ? str(decodeEnc(img[BIRTH_FP_COLUMN] as string))
          : undefined;
      if (uid && bfp) out.set(rowKey(c.tbl, uid), bfp);
    } catch {
      // reported by the capture's group
    }
  }
  return out;
}

/**
 * A minted row's birth_fp when its own image lacks it (T13029, T13030): the
 * batch first, then row meta (kept across a delete or re-key), then the live
 * row.
 */
function resolveBirthFp(
  ctx: TableContext,
  births: BatchBirths,
  table: string,
  uid: string | null,
): string | undefined {
  if (uid === null) return undefined;
  return (
    births.get(rowKey(table, uid)) ?? ctx.metaBirthFp(table, uid) ?? ctx.liveBirthFp(table, uid)
  );
}

/**
 * Build one draft op from a capture (S3b: netting runs on drafts). The uid
 * may stay NULL here; the netted op is checked afterwards, so a clear-and-
 * refill pair (K x → NULL, K NULL → y) can net to one K first (N8).
 */
function buildDraft(ctx: TableContext, c: CaptureRow, births: BatchBirths): DraftOp {
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
      // The uid may have come from the live row (the capture predates the
      // fill): take birth_fp the same way, so the I never waits forever (T13029).
      const bfp =
        str(columnValue(ctx, def, BIRTH_FP_COLUMN, img[BIRTH_FP_COLUMN] ?? 'NULL')) ??
        (minted ? resolveBirthFp(ctx, births, c.tbl, uid) : undefined);
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
      const bfp = minted ? resolveBirthFp(ctx, births, c.tbl, uid) : undefined;
      return { ...base, o: 'U', u: uid, ...(bfp ? { bfp } : {}), ...natural, a, b };
    }
    case 'D': {
      const bfp =
        str(columnValue(ctx, def, BIRTH_FP_COLUMN, img[BIRTH_FP_COLUMN] ?? 'NULL')) ??
        (minted ? resolveBirthFp(ctx, births, c.tbl, uid) : undefined);
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
  bfp: string | null;
}

/**
 * sha256 of a row's canonical WIRE image (§2.7, M6; T13031): the values an I
 * op of the row would carry, so every replica hashes identical bytes. Secret
 * columns, uid and birth_fp, and a minted table's local key (a display id or
 * an autoincrement id, which differ per replica) are left out; references are
 * their uids; NULL columns are omitted, as in an I image.
 */
export function rowChash(
  db: DatabaseSync,
  scope: TableScope,
  def: CaptureTableDef,
  uid: string,
): string | null {
  return chashOf(new TableContext(db, scope), def, uid);
}

function chashOf(ctx: TableContext, def: CaptureTableDef, uid: string): string | null {
  const spec = rowIdentitySpec(ctx.scope, def.table);
  const localKey = new Set(spec?.kind === 'minted' ? spec.key : []);
  const cols = def.columns.filter(
    (c) => !def.secret.has(c) && !OP_IDENTITY.has(c) && !localKey.has(c),
  );
  if (cols.length === 0) return null;
  const row = ctx.db
    .prepare(
      `SELECT ${chunkedObject(cols.map((c) => [c, enc(q(c))] as const))} AS img FROM ${q(def.table)} WHERE ${q(UID_COLUMN)} = ?`,
    )
    .get(uid) as { img: string } | undefined;
  if (!row) return null;
  const wire: Record<string, WireValue> = {};
  for (const [col, raw] of Object.entries(JSON.parse(row.img) as Record<string, string>)) {
    const local = decodeEnc(raw);
    const ref = def.refs.get(col);
    const v = ref && local !== null ? ctx.uidOf(ref.table, ref.key, local) : local;
    if (v !== null) wire[col] = v;
  }
  return createHash('sha256').update(canonicalJson(wire)).digest('hex');
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

/** Where the sealer's transaction counter is persisted (T13033). */
export const SEAL_COUNTER_KEY = 'sealer.local_seq';

/**
 * Seal up to `budget` live captures (ending on a group boundary) into
 * transactions, in one synchronous `BEGIN IMMEDIATE` transaction.
 *
 * Groups seal strictly in capture order (§2.9): the first group that cannot
 * seal yet (a row without uid or birth_fp, an unreadable capture) stops the
 * batch, and is reported in `pending` until it can. Nothing after it gets an
 * HLC first.
 *
 * @returns what was sealed, what stays pending, or why nothing ran.
 */
export function sealPending(db: DatabaseSync, opts: SealOptions): SealReport {
  const refused = sealPreconditions(db, opts.env ?? process.env);
  if (refused) {
    return { txns: 0, ops: 0, captures: 0, unframed: 0, pending: [], refused };
  }
  const replica = opts.replica ?? activeReplica(db, opts.scope)?.replicaId;
  if (!replica) {
    return { txns: 0, ops: 0, captures: 0, unframed: 0, pending: [], refused: 'no bound replica' };
  }
  const now = opts.now ?? Date.now;
  const budget = Math.max(1, opts.budget ?? 5000);
  return withImmediateTransaction(db, () =>
    sealInTransaction(db, { ...opts, replica }, budget, now),
  );
}

/**
 * The capture backlog, for `cleo doctor` (T13029): live captures, and the
 * oldest one's seq and age. A head that stays put across seals is stuck.
 * Read-only.
 */
export function sealBacklog(db: DatabaseSync): {
  readonly live: number;
  readonly oldestSeq: number | null;
  readonly oldestAtMs: number | null;
} {
  if (!hasTable(db, '_sync_capture')) return { live: 0, oldestSeq: null, oldestAtMs: null };
  const r = db
    .prepare(
      "SELECT count(*) AS n, min(seq) AS s, (SELECT at_ms FROM _sync_capture WHERE state = 'live' ORDER BY seq LIMIT 1) AS a FROM _sync_capture WHERE state = 'live'",
    )
    .get() as { n: number; s: number | null; a: number | null };
  return { live: r.n, oldestSeq: r.s, oldestAtMs: r.a };
}

const CAPTURE_COLS = 'seq, tbl, op, rk, uid, img, at_ms, frame';

function sealInTransaction(
  db: DatabaseSync,
  opts: SealOptions & { readonly replica: string },
  budget: number,
  now: () => number,
): SealReport {
  const ctx = new TableContext(db, opts.scope);
  const started = performance.now();
  const maxMs = opts.maxMs ?? 200;
  const replica = opts.replica;

  // 1. Read a batch. A frame cut by the budget is completed only when it is
  //    the batch's first group (it must seal whole); otherwise it is left for
  //    the next batch, so the extension stays bounded (T13032).
  let batch = db
    .prepare(`SELECT ${CAPTURE_COLS} FROM _sync_capture WHERE state = 'live' ORDER BY seq LIMIT ?`)
    .all(budget) as unknown as CaptureRow[];
  if (batch.length === 0)
    return { txns: 0, ops: 0, captures: 0, unframed: 0, pending: [], refused: null };
  const lastFrame = batch[batch.length - 1]?.frame ?? null;
  if (lastFrame !== null && batch.length === budget) {
    if (batch[0]?.frame === lastFrame) {
      const maxSeq = batch[batch.length - 1]?.seq ?? 0;
      batch.push(
        ...(db
          .prepare(
            `SELECT ${CAPTURE_COLS} FROM _sync_capture WHERE state = 'live' AND frame = ? AND seq > ? ORDER BY seq`,
          )
          .all(lastFrame, maxSeq) as unknown as CaptureRow[]),
      );
    } else {
      batch = batch.filter((c) => c.frame !== lastFrame);
    }
  }
  const births = batchBirths(batch);

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

  // 3–5. Seal each group, in order.
  const meta = {
    get: db.prepare(
      'SELECT hlc, fhlc, version, deleted, key_json, chash, bfp FROM _sync_row_meta WHERE tbl = ? AND uid = ?',
    ),
    upsert: db.prepare(
      `INSERT INTO _sync_row_meta (tbl, uid, hlc, fhlc, origin, actor, version, deleted, key_json, chash, bfp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (tbl, uid) DO UPDATE SET hlc = excluded.hlc, fhlc = excluded.fhlc,
         origin = excluded.origin, actor = excluded.actor, version = excluded.version,
         deleted = excluded.deleted, key_json = coalesce(excluded.key_json, key_json),
         chash = excluded.chash, bfp = coalesce(excluded.bfp, bfp)`,
    ),
    remove: db.prepare('DELETE FROM _sync_row_meta WHERE tbl = ? AND uid = ?'),
    // A re-key moves the row's meta and keeps hlc, fhlc, version and chash
    // (§2.5 step 5, T13031); only the key and birth_fp follow the new uid.
    move: db.prepare(
      `UPDATE _sync_row_meta SET uid = ?, key_json = coalesce(?, key_json), bfp = coalesce(?, bfp)
       WHERE tbl = ? AND uid = ?`,
    ),
    flags: db.prepare('SELECT sent, deleted FROM _sync_row_meta WHERE tbl = ? AND uid = ?'),
  };
  const insTxn = db.prepare(
    `INSERT INTO _sync_txn (txn, local_seq, replica, hlc, scope, via, kind, actor, frame, unframed, op_count, sealed_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insOp = db.prepare(
    'INSERT INTO _sync_op (txn, idx, tbl, uid, o, hlc, body) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  // The counter only rises: a txn id is never reused after old rows are
  // collected (T13033).
  const stored = db.prepare('SELECT value FROM _sync_meta WHERE key = ?').get(SEAL_COUNTER_KEY) as
    | { value: string }
    | undefined;
  const maxRow = (
    db.prepare('SELECT coalesce(max(local_seq), 0) AS n FROM _sync_txn').get() as { n: number }
  ).n;
  let localSeq = Math.max(Number(stored?.value ?? 0) || 0, maxRow);
  const firstSeq = localSeq;

  let txns = 0;
  let ops = 0;
  let unframed = 0;
  const consumed: number[] = [];
  const pending: Array<{ firstSeq: number; reason: string }> = [];
  const touched = new Map<string, { tbl: string; uid: string; rk: string }>();
  const ledgerDelta = new Map<string, number>();

  const metaFacts: MetaFacts = {
    sent: (t, u) => (meta.flags.get(t, u) as { sent: number } | undefined)?.sent === 1,
    live: (t, u) => (meta.flags.get(t, u) as { deleted: number } | undefined)?.deleted === 0,
  };

  for (const g of groups) {
    // Bound the time this transaction holds the write lock (T13032).
    if (txns > 0 && performance.now() - started > maxMs) break;
    const head = g.captures[0]?.seq ?? 0;
    const capOf = new Map(g.captures.map((c) => [c.seq, c] as const));
    let drafts: DraftOp[] = [];
    let unreadable: string | null = null;
    for (const c of g.captures) {
      try {
        drafts.push(buildDraft(ctx, c, births));
      } catch (err) {
        if (!(err instanceof SealInputError)) throw err;
        unreadable = `${c.tbl} seq ${c.seq}: ${err.message}`;
        drafts = [];
        break;
      }
    }
    const netted = unreadable === null ? netTransaction(drafts, metaFacts) : null;
    const wait =
      unreadable ?? netted?.ops.map((op) => unsealable(ctx, op)).find((r) => r !== null) ?? null;
    if (wait !== null || netted === null) {
      // §2.9: stop here. Nothing after a waiting group seals before it.
      pending.push({ firstSeq: head, reason: wait ?? 'unreadable capture' });
      break;
    }
    // Dropped re-keys (uid never left the device): the meta follows the row.
    for (const r of netted.renames) {
      meta.remove.run(r.t, r.to);
      meta.move.run(r.to, null, null, r.t, r.from);
    }
    for (const c of g.captures) consumed.push(c.seq);
    if (netted.ops.length === 0) continue; // everything netted away

    localSeq += 1;
    const txn = `${replica}:${localSeq}`;
    const sealedOps: Array<SealedOp & { readonly seq: number }> = netted.ops.map((op) => {
      const { seq, ...rest } = op;
      return {
        ...(rest as Omit<SealedOp, 'h'>),
        seq,
        h: tickClock(db, replica, capOf.get(seq)?.at_ms ?? now()),
      };
    });
    const txnHlc = sealedOps.reduce((m, o) => (o.h > m ? o.h : m), sealedOps[0]?.h ?? '');
    const kind = g.frame !== null && TXN_KINDS.has(g.kind) ? g.kind : 'write';
    insTxn.run(
      txn,
      localSeq,
      replica,
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
        meta.remove.run(op.t, op.nu);
        if (prev) {
          meta.move.run(op.nu, keyJson, op.bfp ?? null, op.t, op.u);
        } else {
          meta.upsert.run(
            op.t,
            op.nu,
            op.h,
            null,
            replica,
            g.actor,
            1,
            0,
            keyJson,
            null,
            op.bfp ?? null,
          );
        }
        touched.delete(rowKey(op.t, op.u));
        touched.set(rowKey(op.t, op.nu), { tbl: op.t, uid: op.nu, rk });
        return;
      }
      const changed = op.o === 'U' ? Object.keys(op.a ?? {}) : [];
      const fhlc = op.o === 'U' ? nextFhlc(prev, def, changed, op.h) : null;
      meta.upsert.run(
        op.t,
        op.u,
        op.h,
        fhlc,
        replica,
        g.actor,
        (prev?.version ?? 0) + 1,
        op.o === 'D' ? 1 : 0,
        keyJson,
        op.o === 'D' ? (prev?.chash ?? null) : null,
        op.bfp ?? null,
      );
      if (op.o === 'I') ledgerDelta.set(op.t, (ledgerDelta.get(op.t) ?? 0) + 1);
      if (op.o === 'D') ledgerDelta.set(op.t, (ledgerDelta.get(op.t) ?? 0) - 1);
      if (op.o === 'D') touched.delete(rowKey(op.t, op.u));
      else touched.set(rowKey(op.t, op.u), { tbl: op.t, uid: op.u, rk });
    });
    txns += 1;
    ops += sealedOps.length;
    if (g.frame === null) unframed += 1;
  }

  if (localSeq !== firstSeq) {
    db.prepare(
      'INSERT INTO _sync_meta (key, value, updated_at) VALUES (?, ?, ?) ' +
        'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
    ).run(SEAL_COUNTER_KEY, String(localSeq), new Date(now()).toISOString());
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
    setChash.run(chashOf(ctx, ctx.def(tbl), uid), tbl, uid);
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
