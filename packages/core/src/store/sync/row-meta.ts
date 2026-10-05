/**
 * The one writer of `_sync_row_meta` (journal spec §1.6; T13204).
 *
 * Row meta holds a row's replication facts: `hlc` (the newest field HLC),
 * `fhlc` (only the columns whose HLC is OLDER than `hlc`, so a row whose
 * fields all share one HLC stores none), the origin replica and actor, the
 * version, the tombstone flag, the natural key, the content hash and the
 * birth fingerprint. The sealer writes it for local ops; the apply engine
 * (T12344) writes it for applied remote ops. Both go through this module, so
 * the `fhlc` compression can never disagree between them.
 *
 * @task T13204
 * @module store/sync/row-meta
 */

import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { canonicalJson } from './sealer-values.js';

/** A row's stored meta, as the writers read it back. */
export interface RowMetaRow {
  readonly hlc: string;
  readonly fhlc: string | null;
  readonly version: number;
  readonly deleted: number;
  readonly key_json: string | null;
  readonly chash: string | null;
  readonly bfp: string | null;
}

/** The columns a row's field HLCs cover: captured, minus identity. */
export interface FieldColumns {
  readonly columns: readonly string[];
  readonly identity: readonly string[];
}

/** One row-meta write. */
export interface RowMetaWrite {
  readonly tbl: string;
  readonly uid: string;
  /** The newest field HLC of the row. */
  readonly hlc: string;
  /** Compressed field HLCs ({@link compressFieldHlcs}), or null. */
  readonly fhlc: string | null;
  /** The replica the newest change came from. */
  readonly origin: string;
  readonly actor: string | null;
  readonly version: number;
  readonly deleted: boolean;
  /** The natural key (canonical JSON); kept when null. */
  readonly keyJson?: string | null;
  /** The content hash, or null (recomputed by the sealer later). */
  readonly chash?: string | null;
  /** The birth fingerprint; kept when null. */
  readonly bfp?: string | null;
}

const statements = new WeakMap<DatabaseSync, { get: StatementSync; upsert: StatementSync }>();

function stmts(db: DatabaseSync): { get: StatementSync; upsert: StatementSync } {
  let s = statements.get(db);
  if (!s) {
    s = {
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
    };
    statements.set(db, s);
  }
  return s;
}

/** The row's stored meta, or undefined. */
export function readRowMeta(db: DatabaseSync, tbl: string, uid: string): RowMetaRow | undefined {
  return stmts(db).get.get(tbl, uid) as RowMetaRow | undefined;
}

/** Write one row's meta (insert, or replace its facts; key and bfp are kept when absent). */
export function upsertRowMeta(db: DatabaseSync, w: RowMetaWrite): void {
  stmts(db).upsert.run(
    w.tbl,
    w.uid,
    w.hlc,
    w.fhlc,
    w.origin,
    w.actor,
    w.version,
    w.deleted ? 1 : 0,
    w.keyJson ?? null,
    w.chash ?? null,
    w.bfp ?? null,
  );
}

/**
 * Compress a row's full per-field HLC map against its row HLC (§1.6): keep
 * only the columns whose HLC is older than `rowHlc`. Identity columns carry
 * no field HLC.
 *
 * @returns Canonical JSON of the kept columns, or null when none.
 */
export function compressFieldHlcs(
  def: FieldColumns,
  fieldHlc: Readonly<Record<string, string>>,
  rowHlc: string,
): string | null {
  const out: Record<string, string> = {};
  for (const col of def.columns) {
    if (def.identity.includes(col)) continue;
    const at = fieldHlc[col];
    if (at !== undefined && at < rowHlc) out[col] = at;
  }
  return Object.keys(out).length > 0 ? canonicalJson(out) : null;
}

/** A row's full per-field HLC map from its stored meta (a column absent from `fhlc` is at `hlc`). */
export function fieldHlcsOf(def: FieldColumns, prev: RowMetaRow): Record<string, string> {
  const old = prev.fhlc ? (JSON.parse(prev.fhlc) as Record<string, string>) : {};
  const out: Record<string, string> = {};
  for (const col of def.columns) {
    if (!def.identity.includes(col)) out[col] = old[col] ?? prev.hlc;
  }
  return out;
}

/**
 * The `fhlc` after a local op at HLC `h` changed `changed` (the sealer's
 * rule): changed columns move to `h`, the rest keep theirs. A row with no
 * meta yet has every field at `h`, so none is stored.
 */
export function nextFhlc(
  prev: RowMetaRow | undefined,
  def: FieldColumns,
  changed: readonly string[],
  h: string,
): string | null {
  if (!prev) return null;
  const fields = fieldHlcsOf(def, prev);
  for (const col of changed) fields[col] = h;
  return compressFieldHlcs(def, fields, h);
}

/** A row-meta write fed from a full per-field HLC map (the apply engine). */
export interface RowMetaFromFields {
  readonly tbl: string;
  readonly uid: string;
  /** Field HLCs after the merge (identity columns ignored); partial only when the row has meta. */
  readonly fieldHlc: Readonly<Record<string, string>>;
  readonly origin: string;
  readonly actor: string | null;
  readonly deleted: boolean;
  readonly keyJson?: string | null;
  readonly chash?: string | null;
  readonly bfp?: string | null;
}

/**
 * Write a row's meta from its per-field HLC map: `hlc` is the newest field
 * HLC, `fhlc` holds only the older ones, and the version rises by one.
 *
 * The map may be partial when the row already has meta: an absent column
 * keeps the field HLC it had (never silently advanced to the new row HLC),
 * and a named column keeps the newer of its stored and incoming HLC (never
 * moved back, T13207). A write in which no named field wins writes nothing:
 * the losing op's origin, actor, tombstone and content hash never land.
 * A row's first write must name every non-identity column.
 *
 * @returns The row HLC written.
 * @throws {Error} When the map is empty, or a first write misses a column.
 */
export function upsertRowMetaFromFields(
  db: DatabaseSync,
  def: FieldColumns,
  w: RowMetaFromFields,
): string {
  const prev = readRowMeta(db, w.tbl, w.uid);
  const fields: Record<string, string> = prev ? fieldHlcsOf(def, prev) : {};
  const named = def.columns.filter((c) => !def.identity.includes(c) && w.fieldHlc[c] !== undefined);
  // @sync-invariant none:input-shape a row-meta write needs at least one field HLC; nothing is written
  if (named.length === 0) throw new Error(`row meta for ${w.tbl}/${w.uid}: no field HLC`);
  // Keep the newer HLC per field (T13207): a field the caller names with an
  // older HLC than the stored one (a losing remote field) never moves back.
  let won = prev === undefined;
  for (const c of named) {
    const incoming = w.fieldHlc[c] as string;
    const stored = fields[c];
    if (stored === undefined || incoming > stored) won = true;
    fields[c] = stored !== undefined && stored > incoming ? stored : incoming;
  }
  // A write in which no named field wins changes nothing: a losing op never
  // stamps its origin, actor or tombstone on the row, nor bumps its version.
  if (!won && prev) return prev.hlc;
  const missing = def.columns.filter((c) => !def.identity.includes(c) && fields[c] === undefined);
  if (missing.length > 0) {
    // @sync-invariant none:input-shape a row's first meta write must name every field; nothing is written
    throw new Error(`row meta for ${w.tbl}/${w.uid}: first write misses ${missing.join(', ')}`);
  }
  const hlc = Object.values(fields).reduce((m, h) => (h > m ? h : m));
  upsertRowMeta(db, {
    tbl: w.tbl,
    uid: w.uid,
    hlc,
    fhlc: compressFieldHlcs(def, fields, hlc),
    origin: w.origin,
    actor: w.actor,
    version: (prev?.version ?? 0) + 1,
    deleted: w.deleted,
    keyJson: w.keyJson,
    chash: w.chash,
    bfp: w.bfp,
  });
  return hlc;
}
