/**
 * The sealer, S3a + S3b (journal spec §2.5 phase B, §2.4, §1.6, §2.6, §4.3;
 * T12984, T12985).
 *
 * `sealPending` turns live `_sync_capture` rows into sealed transactions:
 *
 * 1. **Group (§2.4).** A validated frame (its `_sync_frame` row exists) is
 *    one transaction. Every capture with no validated frame is a singleton
 *    transaction flagged `unframed`, provenance `foreign` (ruling (c)): the
 *    sealer never claims atomicity it did not observe. A batch ends on a
 *    group boundary. Apply and rebase frames wait for S5's intent subtraction.
 * 2. **Draft ops (§2.6).** Each capture becomes one draft. Values are decoded
 *    from the capture's `enc()` text to typed wire values; references become
 *    uids (resolved from the local key when the capture saw none); secret
 *    columns and the local columns a stored ref uid is derived from (`ac_id`)
 *    are removed. Natural rows carry `k`, their key with references as uids.
 *    An unreadable capture is quarantined (`_sync_quarantine`, its table
 *    suspect) and never stalls the outbox (T13036).
 * 3. **Net (§2.4, {@link netTransaction}).** Per (table, uid) inside the
 *    transaction. Across transactions, the dead incarnation of a row that
 *    never got a uid (its captures up to its delete) is dropped whole
 *    (T13036). A minted row with no uid or `birth_fp` keeps its group
 *    pending, and nothing after it seals first (§2.9).
 * 4. **HLC.** `tick(at_ms)` per op in order, at its last capture's time; the
 *    transaction's HLC is its maximum.
 * 5. **Write.** `_sync_txn`, `_sync_op`; `_sync_row_meta` upserted per op
 *    (version, origin, actor, per-field `fhlc`, tombstone on D, key on
 *    natural rows) and MOVED on K (hlc, fhlc, version and chash kept);
 *    `chash` recomputed from the live row once no live capture of that row
 *    remains; `_sync_ledger` per table; the `sealer.local_seq` counter.
 * 6. **Consume.** Sealed, dropped and quarantined captures are deleted, and
 *    frames no live capture references.
 *
 * S3c: timestamp columns are canonical on the wire and in `chash`
 * ({@link canonicalStoreTimestamp}; local rows are never rewritten here), and
 * a delete in an append-only table leaves no per-row tombstone (§1.7 R5-5).
 * The step-0 fill and the repair diff of suspect tables are S3d. `sync.seal`
 * stays unreleased until those land: the sealer refuses a persisted flag too.
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
  syncSetTables,
} from './capture.js';
import { tickClock, withImmediateTransaction } from './clock-store.js';
import { isSyncFlagOn, UNRELEASED_FLAGS } from './flags.js';
import { type DraftOp, type MetaFacts, type NettedOp, netTransaction } from './netting.js';
import { activeReplica } from './replica.js';
import { hasTable } from './schema.js';
import { canonicalJson, decodeEnc, type WireValue } from './sealer-values.js';
import { markSuspect } from './structural.js';
import { canonicalStoreTimestamp, timestampColumns } from './timestamps.js';

export { sealBacklog } from './seal-backlog.js';
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
  /** Captures of dead incarnations dropped whole (I … D of a row with no uid; T13036). */
  readonly dropped: number;
  /** Unreadable captures moved to `_sync_quarantine` (T13036). */
  readonly quarantined: ReadonlyArray<{
    readonly seq: number;
    readonly tbl: string;
    readonly reason: string;
  }>;
  /** Why nothing was sealed, when the preconditions refused. */
  readonly refused: string | null;
}

const emptyReport = (refused: string | null): SealReport => ({
  txns: 0,
  ops: 0,
  captures: 0,
  unframed: 0,
  pending: [],
  dropped: 0,
  quarantined: [],
  refused,
});

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
  /**
   * Seal although `sync.seal` is unreleased (tests only; T13037). Never set
   * from user input.
   */
  readonly allowUnreleased?: boolean;
}

/** The two identity columns an op carries as `u` / `bfp` instead of in its images. */
const OP_IDENTITY: ReadonlySet<string> = new Set([UID_COLUMN, BIRTH_FP_COLUMN]);

/** A capture the sealer cannot read (a table left the sync set, a malformed image). */
class SealInputError extends Error {}

class TableContext {
  private readonly defs = new Map<string, CaptureTableDef | null>();
  private readonly stmts = new Map<string, StatementSync>();
  private readonly sources = new Map<string, ReadonlySet<string>>();
  private readonly stamps = new Map<string, ReadonlySet<string>>();
  constructor(
    readonly db: DatabaseSync,
    readonly scope: TableScope,
  ) {}

  /** A statement prepared once per sealing pass (T13032). */
  stmt(sql: string): StatementSync {
    let st = this.stmts.get(sql);
    if (!st) {
      st = this.db.prepare(sql);
      this.stmts.set(sql, st);
    }
    return st;
  }

  /**
   * The local columns a stored ref uid is derived from (`ac_id` for
   * `ac_uid`): another replica's local ids, so they never travel or hash;
   * the stored uid carries the reference (T13037).
   */
  refSources(table: string): ReadonlySet<string> {
    let out = this.sources.get(table);
    if (!out) {
      const spec = rowIdentitySpec(this.scope, table);
      out = new Set((spec?.storedRefUids ?? []).map((r) => r.from));
      this.sources.set(table, out);
    }
    return out;
  }

  /** The table's key columns: a D-then-I U never carries them (§2.4). */
  keyColumns(table: string): readonly string[] {
    return rowIdentitySpec(this.scope, table)?.key ?? [];
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
    // @sync-invariant none:input-shape a capture of a table outside the sync set is quarantined, never sealed
    if (d === null) throw new SealInputError(`capture for ${table}, which is not in the sync set`);
    return d;
  }

  minted(table: string): boolean {
    return rowIdentitySpec(this.scope, table)?.kind === 'minted';
  }

  /** The table's captured timestamp columns (§1.8). */
  timestamps(table: string): ReadonlySet<string> {
    let t = this.stamps.get(table);
    if (!t) {
      t = timestampColumns(this.scope, table);
      this.stamps.set(table, t);
    }
    return t;
  }

  /** The uid of `table`'s row whose first key column is `key`. */
  uidOf(table: string, keyColumn: string, key: WireValue): string | null {
    if (key === null || typeof key === 'object') return null;
    const row = this.stmt(
      `SELECT ${q(UID_COLUMN)} AS u FROM ${q(table)} WHERE ${q(keyColumn)} = ?`,
    ).get(key) as { u: string | null } | undefined;
    return row?.u ?? null;
  }

  /**
   * The first live delete of (table, rk) after `seq`, if any (T13041). The
   * live row under that local key is then a later incarnation, so it must
   * not lend its uid to an earlier capture.
   */
  laterDelete(table: string, rk: string, seq: number): { uid: string | null } | undefined {
    return this.stmt(
      "SELECT uid FROM _sync_capture WHERE state = 'live' AND tbl = ? AND rk = ? AND op = 'D' AND seq > ? ORDER BY seq LIMIT 1",
    ).get(table, rk, seq) as { uid: string | null } | undefined;
  }
}

/**
 * A timestamp column's wire value: canonical when the canonicalizer accepts
 * it, else the raw text (`timestamp_ambiguous`, §1.8).
 */
function wireTimestamp(stamps: ReadonlySet<string>, col: string, v: WireValue): WireValue {
  if (typeof v !== 'string' || !stamps.has(col)) return v;
  return canonicalStoreTimestamp(v) ?? v;
}

/**
 * A decoded column value: references become uids, secrets disappear,
 * timestamps are canonical. Decoded by the value's shape (T13029): a
 * `[local key, uid]` pair is a reference however the column is declared now,
 * a string is an `enc()` value.
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
    // @sync-invariant none:input-shape a malformed capture image is quarantined, never sealed
    throw new SealInputError(`${def.table}.${col}: unexpected image value`);
  if (raw === SECRET_MARKER) return undefined;
  let v: WireValue;
  try {
    v = decodeEnc(raw);
  } catch (err) {
    // @sync-invariant none:input-shape an undecodable capture value is quarantined, never sealed
    throw new SealInputError(`${def.table}.${col}: ${(err as Error).message}`);
  }
  return wireTimestamp(ctx.timestamps(def.table), col, v);
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
    if (ctx.refSources(def.table).has(col)) continue;
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
        if (f) {
          // A K that changes only birth_fp keeps its uid (the capture's).
          const [ou, nu] = u
            ? [str(decodeEnc(u[0])), str(decodeEnc(u[1]))]
            : [c.uid ?? undefined, c.uid ?? undefined];
          const [of, nf] = [str(decodeEnc(f[0])), str(decodeEnc(f[1]))];
          if (ou && of && ou !== nu) out.set(rowKey(c.tbl, ou), of);
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
  // Resolve a missing uid from the live row by its local key (§2.5 step 3),
  // unless a later capture deletes that local row: the live row is then a
  // later incarnation, and this one is resolved by the netting or dropped as
  // dead (T13041).
  if (uid === null && !ctx.laterDelete(c.tbl, c.rk, c.seq)) uid = ctx.uidByKey(c.tbl, c.rk);
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
        if (ctx.refSources(def.table).has(col)) continue;
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
 * their uids; NULL columns are omitted, as in an I image; and timestamp
 * columns hash their canonical form (§1.8), so a replica holding legacy text
 * hashes like one that received the canonical value.
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
  const sources = ctx.refSources(def.table);
  const cols = def.columns.filter(
    (c) => !def.secret.has(c) && !OP_IDENTITY.has(c) && !localKey.has(c) && !sources.has(c),
  );
  if (cols.length === 0) return null;
  const stamps = ctx.timestamps(def.table);
  const row = ctx
    .stmt(
      `SELECT ${chunkedObject(cols.map((c) => [c, enc(q(c))] as const))} AS img FROM ${q(def.table)} WHERE ${q(UID_COLUMN)} = ?`,
    )
    .get(uid) as { img: string } | undefined;
  if (!row) return null;
  const wire: Record<string, WireValue> = {};
  for (const [col, raw] of Object.entries(JSON.parse(row.img) as Record<string, string>)) {
    const local = decodeEnc(raw);
    const ref = def.refs.get(col);
    const v =
      ref && local !== null
        ? ctx.uidOf(ref.table, ref.key, local)
        : wireTimestamp(stamps, col, local);
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

/**
 * Why the sealer refuses to run, or `null` when it may. A persisted
 * `sync.seal` is refused while the flag is unreleased (T13037), whatever
 * wrote it.
 */
export function sealPreconditions(
  db: DatabaseSync,
  env: NodeJS.ProcessEnv,
  allowUnreleased = false,
): string | null {
  if (!hasTable(db, '_sync_capture') || !hasTable(db, '_sync_txn')) {
    return 'sync schema not installed';
  }
  if (!isSyncFlagOn(db, 'sync.seal', env)) return 'sync.seal is off';
  if (UNRELEASED_FLAGS.has('sync.seal') && !allowUnreleased) {
    return 'sync.seal is unreleased until S3b–S3d land (T13032)';
  }
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
  const refused = sealPreconditions(db, opts.env ?? process.env, opts.allowUnreleased === true);
  if (refused) return emptyReport(refused);
  const replica = opts.replica ?? activeReplica(db, opts.scope)?.replicaId;
  if (!replica) return emptyReport('no bound replica');
  const now = opts.now ?? Date.now;
  const budget = Math.max(1, opts.budget ?? 5000);
  return withImmediateTransaction(db, () =>
    sealInTransaction(db, { ...opts, replica }, budget, now),
  );
}

const CAPTURE_COLS = 'seq, tbl, op, rk, uid, img, at_ms, frame';

/** The uid pair a K capture's image records, decoded; null when unreadable. */
function kUids(img: string): [string | null, string | null] | null {
  try {
    const pair = (JSON.parse(img) as Record<string, unknown>)[UID_COLUMN];
    if (!Array.isArray(pair) || typeof pair[0] !== 'string' || typeof pair[1] !== 'string') {
      return null;
    }
    return [str(decodeEnc(pair[0])) ?? null, str(decodeEnc(pair[1])) ?? null];
  } catch {
    return null;
  }
}

/**
 * A clear K(x → NULL) and what follows it on the same local row (T13041).
 * Until the row's next delete or its refill K(NULL → y), the row is still x:
 * those captures are pointed at x (in `_sync_capture`, so a later pass sees
 * it too) and the clear is consumed. A cleared-then-deleted row then seals as
 * D(x), and a clear and refill in different transactions as K(x → y) (N8).
 * With neither yet, the clear waits.
 *
 * @returns x and the seqs pointed at it, or null when `c` is not a clear or
 *   must wait.
 */
function resolveClear(ctx: TableContext, c: CaptureRow): { uid: string; seqs: number[] } | null {
  if (c.op !== 'K' || c.uid === null) return null;
  const pair = kUids(c.img);
  if (pair === null || pair[1] !== null) return null;
  const end = ctx
    .stmt(
      "SELECT seq, op, img FROM _sync_capture WHERE state = 'live' AND tbl = ? AND rk = ? AND seq > ? AND op IN ('D', 'K') ORDER BY seq LIMIT 1",
    )
    .get(c.tbl, c.rk, c.seq) as { seq: number; op: string; img: string } | undefined;
  if (!end) return null;
  // Only a refill (a K from NULL) continues the cleared row.
  if (end.op === 'K' && kUids(end.img)?.[0] !== null) return null;
  const seqs = (
    ctx
      .stmt(
        "SELECT seq FROM _sync_capture WHERE state = 'live' AND tbl = ? AND rk = ? AND seq > ? AND seq <= ? AND uid IS NULL ORDER BY seq",
      )
      .all(c.tbl, c.rk, c.seq, end.seq) as Array<{ seq: number }>
  ).map((r) => r.seq);
  ctx
    .stmt(
      "UPDATE _sync_capture SET uid = ? WHERE state = 'live' AND tbl = ? AND rk = ? AND seq > ? AND seq <= ? AND uid IS NULL",
    )
    .run(c.uid, c.tbl, c.rk, c.seq, end.seq);
  return { uid: c.uid, seqs };
}

/**
 * The seqs of the dead incarnation that starts at draft `d` (T13036), or
 * null. `d` has no uid; its row's live captures from `d` on run to a delete
 * of the same local row; none of them names a uid row meta knows as live;
 * and no earlier capture of this incarnation (back to the previous delete of
 * the local row) names a uid some sealed op carried (T13041). Otherwise some
 * replica knew the row, and it waits.
 */
function deadIncarnation(ctx: TableContext, facts: MetaFacts, d: DraftOp): number[] | null {
  const earlier = ctx
    .stmt(
      "SELECT op, uid, img FROM _sync_capture WHERE state = 'live' AND tbl = ? AND rk = ? AND seq < ? ORDER BY seq DESC",
    )
    .all(d.t, d.rk, d.seq) as Array<{ op: string; uid: string | null; img: string }>;
  for (const r of earlier) {
    if (r.op === 'D') break;
    const named = r.op === 'K' ? [r.uid, ...(kUids(r.img) ?? [])] : [r.uid];
    if (named.some((u) => u !== null && u !== undefined && facts.known(d.t, u))) return null;
  }
  const rows = ctx
    .stmt(
      "SELECT seq, op, uid, img FROM _sync_capture WHERE state = 'live' AND tbl = ? AND rk = ? AND seq >= ? ORDER BY seq",
    )
    .all(d.t, d.rk, d.seq) as Array<{ seq: number; op: string; uid: string | null; img: string }>;
  const out: number[] = [];
  for (const r of rows) {
    out.push(r.seq);
    const uids = [r.uid];
    if (r.op === 'K') {
      try {
        const pair = (JSON.parse(r.img) as Record<string, unknown>)[UID_COLUMN];
        if (Array.isArray(pair) && typeof pair[1] === 'string')
          uids.push(str(decodeEnc(pair[1])) ?? null);
      } catch {
        return null;
      }
    }
    if (uids.some((u) => u !== null && u !== undefined && facts.live(d.t, u))) return null;
    if (r.op === 'D') return out;
  }
  return null;
}

/**
 * The net row-count effect of a table's live captures, for the ledger's
 * first sight (§4.3; T13037), mirroring how they will seal: per local row,
 * `(exists after the last capture) − (existed before the first)`. A first I
 * counts as a new row unless its uid is one row meta knows live: that is a
 * foreign REPLACE, which seals as a U and adds nothing.
 */
function waitingEffect(db: DatabaseSync, tbl: string, facts: MetaFacts): number {
  const rows = db
    .prepare("SELECT rk, op, uid FROM _sync_capture WHERE tbl = ? AND state = 'live' ORDER BY seq")
    .all(tbl) as Array<{ rk: string; op: string; uid: string | null }>;
  const span = new Map<string, { first: (typeof rows)[number]; last: (typeof rows)[number] }>();
  for (const r of rows) {
    const s = span.get(r.rk);
    if (s) s.last = r;
    else span.set(r.rk, { first: r, last: r });
  }
  let n = 0;
  for (const { first, last } of span.values()) {
    const before = first.op === 'I' && !(first.uid !== null && facts.live(tbl, first.uid)) ? 0 : 1;
    const after = last.op === 'D' ? 0 : 1;
    n += after - before;
  }
  return n;
}

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
  if (batch.length === 0) return emptyReport(null);
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
    `INSERT INTO _sync_txn (txn, local_seq, replica, hlc, scope, via, kind, actor, frame, unframed, partial, op_count, sealed_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
  const consumed = new Set<number>();
  const pending: Array<{ firstSeq: number; reason: string }> = [];
  const touched = new Map<string, { tbl: string; uid: string; rk: string }>();
  const ledgerDelta = new Map<string, number>();

  const metaFacts: MetaFacts = {
    sent: (t, u) => (meta.flags.get(t, u) as { sent: number } | undefined)?.sent === 1,
    live: (t, u) => (meta.flags.get(t, u) as { deleted: number } | undefined)?.deleted === 0,
    known: (t, u) => meta.flags.get(t, u) !== undefined,
  };
  const quarantine = db.prepare(
    `INSERT INTO _sync_quarantine
       (seq, tbl, op, rk, uid, img, at_ms, frame, reason, quarantined_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (seq) DO NOTHING`,
  );
  const dead = new Set<number>();
  // Captures pointed at a cleared row's uid in this pass (T13041).
  const pointedAt = new Map<number, string>();
  let dropped = 0;
  const quarantined: Array<{ seq: number; tbl: string; reason: string }> = [];

  for (const g of groups) {
    // Bound the time this transaction holds the write lock (T13032).
    if (txns > 0 && performance.now() - started > maxMs) break;
    // T13041: a clear whose row is deleted or refilled later is consumed, and
    // what follows it on the row is pointed at the cleared uid.
    for (const c of g.captures) {
      if (dead.has(c.seq)) continue;
      const cleared = resolveClear(ctx, c);
      if (cleared === null) continue;
      for (const seq of cleared.seqs) pointedAt.set(seq, cleared.uid);
      dead.add(c.seq);
      consumed.add(c.seq);
    }
    const captures = g.captures
      .filter((c) => !dead.has(c.seq))
      .map((c) => (pointedAt.has(c.seq) ? { ...c, uid: pointedAt.get(c.seq) ?? null } : c));
    if (captures.length === 0) continue;
    const head = captures[0]?.seq ?? 0;
    if (g.frame !== null && (g.kind === 'apply' || g.kind === 'rebase')) {
      // §3.3: an apply or rebase frame is sealed only after its apply intents
      // are subtracted, which is S5. Until then it waits (T13037).
      pending.push({ firstSeq: head, reason: `${g.kind} frames wait for S5 intent subtraction` });
      break;
    }
    const capOf = new Map(captures.map((c) => [c.seq, c] as const));
    let drafts: DraftOp[] = [];
    let partial = false;
    for (const c of captures) {
      try {
        drafts.push(buildDraft(ctx, c, births));
      } catch (err) {
        if (!(err instanceof SealInputError)) throw err;
        // T13036: an unreadable capture never stalls the outbox. It moves to
        // _sync_quarantine, which marks its table suspect for S3d's repair
        // diff, and the rest of the group seals.
        quarantine.run(
          c.seq,
          c.tbl,
          c.op,
          c.rk,
          c.uid,
          c.img,
          c.at_ms,
          c.frame,
          err.message,
          now(),
        );
        markSuspect(db, opts.scope, [c.tbl]);
        quarantined.push({ seq: c.seq, tbl: c.tbl, reason: err.message });
        consumed.add(c.seq);
        partial = true;
      }
    }
    // T13036: a row that never had a uid and is gone again is a dead
    // incarnation no replica ever knew (§2.4: an I and a later D of a uid
    // that never left the device drop both). Its captures, up to its delete,
    // are dropped wherever they sit, so it cannot hold the outbox forever.
    for (const d of drafts) {
      if (d.u !== null || d.o === 'K' || dead.has(d.seq)) continue;
      for (const seq of deadIncarnation(ctx, metaFacts, d) ?? []) {
        if (dead.has(seq)) continue;
        dead.add(seq);
        consumed.add(seq);
        dropped += 1;
      }
    }
    drafts = drafts.filter((d) => !dead.has(d.seq));
    const netted = netTransaction(drafts, metaFacts, { keyColumns: (t) => ctx.keyColumns(t) });
    const wait = netted.ops.map((op) => unsealable(ctx, op)).find((r) => r !== null) ?? null;
    if (wait !== null) {
      // §2.9: stop here. Nothing after a waiting group seals before it.
      pending.push({ firstSeq: head, reason: wait });
      break;
    }
    // Dropped re-keys (no sealed op carried the old uid): the meta follows the row.
    for (const r of netted.renames) {
      meta.remove.run(r.t, r.to);
      meta.move.run(r.to, null, null, r.t, r.from);
    }
    for (const c of captures) consumed.add(c.seq);
    if (netted.ops.length === 0) continue; // everything netted away

    localSeq += 1;
    const txn = `${replica}:${localSeq}`;
    // An op's time and local key are its LAST capture's (T13037).
    const at = (op: { seq: number; last: number }) => capOf.get(op.last) ?? capOf.get(op.seq);
    const sealedOps: Array<SealedOp & { readonly seq: number; readonly last: number }> =
      netted.ops.map((op) => {
        const { seq, last, ...rest } = op;
        return {
          ...(rest as Omit<SealedOp, 'h'>),
          seq,
          last,
          h: tickClock(db, replica, at(op)?.at_ms ?? now()),
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
      partial ? 1 : 0,
      sealedOps.length,
      now(),
    );
    sealedOps.forEach(({ seq, last, ...op }, i) => {
      const rk = at({ seq, last })?.rk ?? '';
      insOp.run(txn, i, op.t, op.u, op.o, op.h, canonicalJson(op));
      const def = ctx.def(op.t);
      const prev = meta.get.get(op.t, op.u) as MetaRow | undefined;
      const keyJson = op.k ? canonicalJson(op.k) : null;
      if (op.o === 'K' && op.nu !== undefined) {
        // A K that keeps its uid changes only birth_fp: its meta stays put.
        if (op.nu !== op.u) meta.remove.run(op.t, op.nu);
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
      if (op.o === 'D' && def.appendOnly) {
        // §1.7 R5-5: append-only rows get no per-row tombstone; deleted vs
        // never seen is decided by the prune cutoff. The D op still travels.
        meta.remove.run(op.t, op.u);
        ledgerDelta.set(op.t, (ledgerDelta.get(op.t) ?? 0) - 1);
        touched.delete(rowKey(op.t, op.u));
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
    ledgerSet.run(tbl, count - waitingEffect(db, tbl, metaFacts));
  }

  return {
    txns,
    ops,
    captures: consumed.size,
    unframed,
    pending,
    dropped,
    quarantined,
    refused: null,
  };
}

/** `_sync_meta` key of the sync-set version the row-meta `chash` baseline matches (§2.3a rule 3). */
export const CHASH_BASELINE_KEY = 'sync.set_version';

/**
 * The sync set's version: a hash of every sync-set table's captured columns,
 * secret columns and references as this store's schema has them (§2.3a,
 * §2.9). A migration that changes what is captured changes it.
 *
 * @param db - The store.
 * @param scope - Its scope.
 */
export function syncSetVersion(db: DatabaseSync, scope: TableScope): string {
  const shape = syncSetTables(scope)
    .sort()
    .map((table) => {
      const def = hasTable(db, table) ? captureTableDef(db, scope, table) : undefined;
      if (!def) return [table, null];
      return [
        table,
        {
          columns: [...def.columns],
          secret: [...def.secret].sort(),
          refs: [...def.refs].map(([col, r]) => [col, r.table, r.key]).sort(),
        },
      ];
    });
  return createHash('sha256').update(canonicalJson(shape)).digest('hex').slice(0, 32);
}

/** What {@link rebaselineChash} changed. */
export interface ChashRebaseline {
  /** Row-meta rows whose `chash` moved to the live row's hash. */
  readonly rows: number;
  /** The sync-set version the baseline now matches. */
  readonly version: string;
}

/**
 * Re-baseline `_sync_row_meta.chash` to the live rows, emitting nothing
 * (§2.3a rule 3; B, T12775). A migration's backfill is deterministic and
 * every replica runs it itself, so its changes must not travel; but the row
 * meta's content hash would otherwise make the next repair diff see every
 * migrated row as an uncaptured edit. Live rows only: a tombstone keeps the
 * hash it was deleted with. Records {@link CHASH_BASELINE_KEY}.
 *
 * Runs in its own `BEGIN IMMEDIATE` transaction (the migration runner calls
 * it after each migration's commit).
 *
 * @param db - The store.
 * @param scope - Its scope.
 */
export function rebaselineChash(db: DatabaseSync, scope: TableScope): ChashRebaseline {
  if (!hasTable(db, '_sync_row_meta') || !hasTable(db, '_sync_meta')) {
    return { rows: 0, version: syncSetVersion(db, scope) };
  }
  return withImmediateTransaction(db, () => {
    const ctx = new TableContext(db, scope);
    const syncSet = new Set(syncSetTables(scope).filter((t) => hasTable(db, t)));
    const setChash = db.prepare('UPDATE _sync_row_meta SET chash = ? WHERE tbl = ? AND uid = ?');
    let rows = 0;
    for (const m of db
      .prepare('SELECT tbl, uid, chash FROM _sync_row_meta WHERE deleted = 0')
      .all() as Array<{ tbl: string; uid: string; chash: string | null }>) {
      if (!syncSet.has(m.tbl)) continue;
      const def = captureTableDef(db, scope, m.tbl);
      if (!def) continue;
      const next = chashOf(ctx, def, m.uid);
      if (next === m.chash) continue;
      setChash.run(next, m.tbl, m.uid);
      rows += 1;
    }
    const version = syncSetVersion(db, scope);
    db.prepare(
      'INSERT INTO _sync_meta (key, value, updated_at) VALUES (?, ?, ?) ' +
        'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
    ).run(CHASH_BASELINE_KEY, version, new Date().toISOString());
    return { rows, version };
  });
}
