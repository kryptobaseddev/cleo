/**
 * The apply frame's write API (T12344; journal spec §3.2 "The API", §3.3).
 *
 * The ONLY calls that write synced rows during apply. Each performs the SQL
 * and, in the same transaction, records what it wrote in `_sync_apply_intent`
 * through {@link recordApplyIntents}, from the STORED value: every write uses
 * `RETURNING` with the same SQL `enc()` the capture triggers use, so an intent
 * is byte-equal to what the trigger captures after column affinity, defaults,
 * CHECK coercions and trigger rewrites. The sealer then subtracts each apply
 * frame's intents from its captures, so an applied remote change is never
 * echoed back with fresh HLCs (§3.3).
 *
 * Rules, all enforced here:
 * - INSERT, UPDATE and DELETE only. Never `REPLACE` / `INSERT OR REPLACE`: it
 *   deletes the old row first, so its capture is a D + I with no `*D` intent
 *   and the D would seal (gate 28 bans it too). Nothing in the apply module
 *   writes raw SQL outside this file (K11, test-enforced).
 * - Values are LOCAL values: references are already translated to local keys
 *   (the applier resolves uids before it calls this API).
 * - An insert records `*I` plus an intent for every non-NULL stored captured
 *   column, read back with `RETURNING`; captures omit NULLs.
 * - A secret column records `<secret>`, which {@link recordApplyIntents}
 *   binds to the capture the write produced. Intents are recorded right
 *   after each write, before the frame writes that column again.
 * - Without a capture frame (capture off) the writes run and no intent is
 *   recorded: there are no captures to subtract.
 *
 * @module store/sync/apply/write-api
 * @task T12344
 */

import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { TableScope } from '@cleocode/contracts';
import type { LedgerWireValue } from '@cleocode/contracts/ledger';
import { BIRTH_FP_COLUMN, UID_COLUMN } from '../../row-identity-registry.js';
import {
  type ApplyIntent,
  INTENT_DELETE,
  INTENT_INSERT,
  INTENT_REKEY,
  recordApplyIntents,
  SECRET_INTENT,
} from '../apply-intent.js';
import { type CaptureTableDef, captureTableDef, enc } from '../capture.js';
import { moveFieldState } from '../field-leave.js';
import {
  compressFieldHlcs,
  fieldHlcsOf,
  moveRowMeta,
  type RowMetaRow,
  readRowMeta,
  upsertRowMeta,
  upsertRowMetaFromFields,
} from '../row-meta.js';
import { decodeEnc } from '../sealer-values.js';
import { isTriggerClassSuspended } from '../trigger-classes.js';
import { type ChildKey, localChildKeys, syncSetChildKeys } from './fk.js';

/** A write the API refuses (unknown table or column, a missing row). */
export class ApplyWriteError extends Error {
  readonly code = 'E_SYNC_APPLY_WRITE';

  constructor(message: string) {
    super(message);
    this.name = 'ApplyWriteError';
  }
}

/** Quote an SQL identifier. */
function ident(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/**
 * A typed wire value as a node:sqlite parameter: `$i` as a BigInt, `$r` as a
 * number (`Inf`, `+Inf`, `-Inf` accepted), `$b` as a Buffer.
 *
 * @param v - The wire value.
 * @returns The parameter.
 */
export function wireToSql(v: LedgerWireValue): SQLInputValue {
  // A wire number is a safe integer (§2.6; REALs travel as `$r`). node:sqlite
  // binds a JS number as REAL, which a TEXT column then stores as '42.0';
  // bind integers as BigInt so they keep integer storage.
  if (typeof v === 'number') return Number.isInteger(v) ? BigInt(v) : v;
  if (v === null || typeof v === 'string') return v;
  if ('$i' in v) return BigInt(v.$i);
  if ('$r' in v) {
    const t = v.$r.trim();
    if (/^\+?Inf$/.test(t)) return Number.POSITIVE_INFINITY;
    if (t === '-Inf') return Number.NEGATIVE_INFINITY;
    return Number(t);
  }
  return Buffer.from(v.$b, 'base64');
}

/** What one write stored, per column, as `enc()` text. */
export type StoredEncs = Readonly<Record<string, string>>;

/**
 * What a DELETE of a row would remove outside the sync set through foreign
 * key actions: the rows a `CASCADE` deletes (parents before children) and the
 * columns a `SET NULL` / `SET DEFAULT` clears. Capture never records these,
 * so a rebase rewind snapshots them before deleting a row it will replay
 * (§3.5 R7-2, T13267).
 */
export interface LocalDescendants {
  /** Rows a cascade deletes, each with every column as stored. */
  readonly rows: ReadonlyArray<{
    readonly table: string;
    readonly values: Readonly<Record<string, SQLInputValue>>;
  }>;
  /** Child columns an action clears: the child row's key, the column, its value. */
  readonly cleared: ReadonlyArray<{
    readonly table: string;
    readonly where: Readonly<Record<string, SQLInputValue>>;
    readonly column: string;
    readonly value: SQLInputValue;
  }>;
}

/** The write API bound to one apply frame. */
export interface ApplyWriteApi {
  /**
   * UPDATE columns of an existing row; records one intent per column.
   *
   * @returns The stored `enc()` per written column.
   * @throws {ApplyWriteError} When the row does not exist.
   */
  writeFields(
    table: string,
    uid: string,
    values: Readonly<Record<string, LedgerWireValue>>,
  ): StoredEncs;
  /**
   * INSERT a row with `uid`; records `*I` and one intent per non-NULL stored
   * captured column. Every identity column but `uid` must be given.
   *
   * @returns The stored `enc()` per captured column (NULLs included).
   * @throws {ApplyWriteError} When an identity column is missing.
   */
  insertRow(
    table: string,
    uid: string,
    values: Readonly<Record<string, LedgerWireValue>>,
  ): StoredEncs;
  /**
   * DELETE the row; records `*D`, plus an intent for every sync-set child
   * column the delete's `ON DELETE SET NULL` action clears, so the FK
   * action is never sealed as a local write (§3.2 FK actions).
   *
   * @returns Whether a row was deleted.
   */
  deleteRow(table: string, uid: string): boolean;
  /**
   * Re-key a row (a K op): its uid, and its birth fingerprint when `newBfp`
   * is given. Records `*K` (enc = the new uid) and moves the row's meta and
   * typed-rule state to the new uid.
   *
   * @returns Whether a row was re-keyed.
   */
  rekeyRow(table: string, uid: string, newUid: string, newBfp: string | null): boolean;
  /**
   * The row's local-only columns (every column capture never records: claims,
   * leases, local keys of other devices), or null when the row is absent. A
   * rebase snapshots them before it rewinds an insert (§3.5 R7-2).
   */
  readLocalOnly(table: string, uid: string): Record<string, SQLInputValue> | null;
  /** Write back local-only columns a rebase snapshotted (never captured, never intents). */
  writeLocalOnly(table: string, uid: string, values: Readonly<Record<string, SQLInputValue>>): void;
  /**
   * What deleting the row would remove outside the sync set through FK
   * actions (recursively through cascades), for a rebase rewind to put back
   * after the replay (§3.5 R7-2). Empty when the row is absent.
   */
  readLocalDescendants(table: string, uid: string): LocalDescendants;
  /** Put back what {@link ApplyWriteApi.readLocalDescendants} saw (never captured, never intents). */
  writeLocalDescendants(snapshot: LocalDescendants): void;
  /** The live sync-set children of a row, per child key (for the parent-delete policy). */
  childRows(
    table: string,
    uid: string,
  ): ReadonlyArray<{ readonly key: ChildKey; readonly uid: string }>;
  /** The row's captured columns as wire values, or null when it does not exist. */
  readRow(table: string, uid: string): Record<string, LedgerWireValue> | null;
  /** The row's stored replication meta, or undefined when it has none. */
  rowMeta(table: string, uid: string): RowMetaRow | undefined;
  /**
   * Record the row's replication meta after the merge (§1.6) through the
   * shared writer (`upsertRowMetaFromFields`, the sealer's own). Pass the
   * post-merge WINNING field HLCs; the writer keeps the newer of stored and
   * incoming per field, so a losing field never moves back, and a write in
   * which no field wins changes nothing. A remote delete names the row's
   * fields at the delete's HLC with `deleted: true`. The first write of a
   * row names every non-identity column.
   *
   * @returns The row HLC stored.
   */
  setRowMeta(
    table: string,
    uid: string,
    meta: {
      readonly fieldHlc: Readonly<Record<string, string>>;
      readonly origin: string;
      readonly actor: string | null;
      readonly deleted: boolean;
      readonly keyJson?: string | null;
      readonly chash?: string | null;
      readonly bfp?: string | null;
    },
  ): string;
  /**
   * Record the row's replication meta EXACTLY as the merge engine decided
   * it (the applier's writer). Unlike {@link ApplyWriteApi.setRowMeta} it
   * does not keep the newer of stored and incoming per field: the engine
   * already did, and some of its decisions move a field HLC back on purpose
   * (an absorbing write that overrides a newer edit keeps its own HLC), or
   * pin the tombstone to the delete's HLC although a field was newer.
   *
   * - Live row: `fieldHlc` names the merged HLC per field; a column it omits
   *   keeps its stored HLC, and a first write must name every field.
   * - Tombstone: `tombstone` is the delete's HLC; `fieldHlc` is ignored.
   *
   * @returns The row HLC stored.
   */
  setMergedRowMeta(
    table: string,
    uid: string,
    meta: {
      readonly fieldHlc: Readonly<Record<string, string>>;
      readonly tombstone: string | null;
      readonly origin: string;
      readonly actor: string | null;
      readonly keyJson?: string | null;
      readonly chash?: string | null;
      readonly bfp?: string | null;
    },
  ): string;
}

/**
 * Bind the write API to a store, scope and apply frame.
 *
 * @param db - The store, inside the frame's transaction.
 * @param scope - The store's scope.
 * @param frame - The apply frame id, or null when capture is off.
 * @param assertActive - Throws once the frame has ended.
 * @returns The API.
 */
export function createApplyWriteApi(
  db: DatabaseSync,
  scope: TableScope,
  frame: string | null,
  assertActive: () => void,
): ApplyWriteApi {
  const defs = new Map<string, CaptureTableDef>();
  const defOf = (table: string): CaptureTableDef => {
    let def = defs.get(table);
    if (!def) {
      def = captureTableDef(db, scope, table);
      if (!def) {
        // @sync-invariant none:input-shape the apply API writes only sync-set tables of this store
        throw new ApplyWriteError(`${table} is not a sync-set table of this ${scope} store`);
      }
      defs.set(table, def);
    }
    return def;
  };
  const checkColumns = (def: CaptureTableDef, cols: readonly string[]): void => {
    const known = new Set([...def.columns, ...def.identity]);
    const bad = cols.filter((c) => c === UID_COLUMN || !known.has(c));
    if (bad.length > 0) {
      // @sync-invariant none:input-shape the merge engine refuses unknown columns before any write
      throw new ApplyWriteError(`${def.table}: cannot write ${bad.join(', ')}`);
    }
  };
  const localOnly = new Map<string, string[]>();
  /** Columns of `table` capture never records (minus the uid, which identifies the row). */
  const localOnlyColumns = (table: string): string[] => {
    let cols = localOnly.get(table);
    if (!cols) {
      const def = defOf(table);
      const captured = new Set([...def.columns, ...def.identity, UID_COLUMN]);
      cols = (
        db.prepare('SELECT name FROM pragma_table_info(?)').all(table) as Array<{ name: string }>
      )
        .map((r) => r.name)
        .filter((c) => !captured.has(c));
      localOnly.set(table, cols);
    }
    return cols;
  };
  let localKeys: ReadonlyMap<string, readonly ChildKey[]> | undefined;
  const keyCols = new Map<string, string[]>();
  /** The columns identifying a row of `table`: `rowid`, or a WITHOUT ROWID table's primary key. */
  const rowKeyColumns = (table: string): string[] => {
    let cols = keyCols.get(table);
    if (!cols) {
      const wr = db
        .prepare("SELECT wr FROM pragma_table_list WHERE schema = 'main' AND name = ?")
        .get(table) as { wr: number } | undefined;
      cols =
        wr?.wr === 1
          ? (
              db
                .prepare('SELECT name FROM pragma_table_info(?) WHERE pk > 0 ORDER BY pk')
                .all(table) as Array<{ name: string }>
            ).map((r) => r.name)
          : ['rowid'];
      keyCols.set(table, cols);
    }
    return cols;
  };
  /** Rows of `table` where `col = v`, with `rowid` when the table has one. */
  // Integers are read as BigInt so a snapshot keeps every 64-bit value (T13272).
  const rowsWhere = (table: string, col: string, v: SQLInputValue) => {
    const st = db.prepare(
      `SELECT ${rowKeyColumns(table)[0] === 'rowid' ? 'rowid AS "rowid", ' : ''}* FROM main.${ident(table)} WHERE ${ident(col)} = ?`,
    );
    st.setReadBigInts(true);
    return st.all(v) as Array<Record<string, SQLInputValue>>;
  };
  const collectDescendants = (
    table: string,
    row: Readonly<Record<string, SQLInputValue>>,
    out: {
      rows: LocalDescendants['rows'][number][];
      cleared: LocalDescendants['cleared'][number][];
    },
    depth: number,
  ): void => {
    localKeys ??= localChildKeys(db, scope);
    for (const key of localKeys.get(table) ?? []) {
      const v = row[key.to];
      if (v === undefined || v === null) continue;
      const kcols = rowKeyColumns(key.child);
      for (const kid of rowsWhere(key.child, key.from, v)) {
        if (key.onDelete === 'CASCADE') {
          const values: Record<string, SQLInputValue> = {};
          for (const [c, x] of Object.entries(kid)) if (c !== 'rowid') values[c] = x;
          out.rows.push({ table: key.child, values });
          if (depth < 32) collectDescendants(key.child, kid, out, depth + 1);
        } else {
          const where: Record<string, SQLInputValue> = {};
          for (const c of kcols) where[c] = kid[c] as SQLInputValue;
          out.cleared.push({ table: key.child, where, column: key.from, value: v });
        }
      }
    }
  };
  const rowExists = (table: string, uid: string): boolean =>
    db.prepare(`SELECT 1 FROM main.${ident(table)} WHERE ${ident(UID_COLUMN)} = ?`).get(uid) !==
    undefined;
  let childKeys: ReadonlyMap<string, readonly ChildKey[]> | undefined;
  /** The live sync-set rows referencing `table`/`uid` through a foreign key. */
  const children = (
    table: string,
    uid: string,
  ): Array<{ readonly key: ChildKey; readonly uid: string }> => {
    childKeys ??= syncSetChildKeys(db, scope);
    const out: Array<{ key: ChildKey; uid: string }> = [];
    for (const key of childKeys.get(table) ?? []) {
      const parent = db
        .prepare(
          `SELECT ${ident(key.to)} AS v FROM main.${ident(table)} WHERE ${ident(UID_COLUMN)} = ?`,
        )
        .get(uid) as { v: SQLInputValue } | undefined;
      if (!parent || parent.v === null) continue;
      const rows = db
        .prepare(
          `SELECT ${ident(UID_COLUMN)} AS uid FROM main.${ident(key.child)} WHERE ${ident(key.from)} = ? AND ${ident(UID_COLUMN)} IS NOT NULL`,
        )
        .all(parent.v) as Array<{ uid: string }>;
      for (const r of rows) out.push({ key, uid: r.uid });
    }
    return out;
  };
  // An intent mirrors a capture: while capture is suspended (a rebase rewind
  // or replay, §3.5 Rule 4) nothing is captured, so nothing is recorded, and
  // the incoming op's own intents stay the ones its captures are matched to.
  const record = (intents: ApplyIntent[]): void => {
    if (frame === null || intents.length === 0) return;
    if (isTriggerClassSuspended(db, 'capture')) return;
    recordApplyIntents(db, frame, intents);
  };
  const intentFor = (
    def: CaptureTableDef,
    uid: string,
    col: string,
    stored: string,
  ): ApplyIntent => ({
    tbl: def.table,
    uid,
    col,
    enc: def.secret.has(col) ? SECRET_INTENT : stored,
  });
  const returning = (cols: readonly string[]): string =>
    cols.map((c, i) => `${enc(ident(c))} AS c${i}`).join(', ');
  const unpack = (
    row: Record<string, unknown>,
    cols: readonly string[],
  ): Record<string, string> => {
    const out: Record<string, string> = {};
    cols.forEach((c, i) => {
      out[c] = String(row[`c${i}`]);
    });
    return out;
  };

  return {
    writeFields(table, uid, values) {
      assertActive();
      const def = defOf(table);
      const cols = Object.keys(values).sort();
      if (cols.length === 0) return {};
      checkColumns(def, cols);
      const row = db
        .prepare(
          `UPDATE main.${ident(table)} SET ${cols.map((c) => `${ident(c)} = ?`).join(', ')} ` +
            `WHERE ${ident(UID_COLUMN)} = ? RETURNING ${returning(cols)}`,
        )
        .get(...cols.map((c) => wireToSql(values[c] as LedgerWireValue)), uid) as
        | Record<string, unknown>
        | undefined;
      if (!row) {
        // @sync-invariant none:input-shape the merge engine sends updates only for live rows; a missing one is a caller bug
        throw new ApplyWriteError(`${table}: no row with uid ${uid}`);
      }
      const stored = unpack(row, cols);
      record(cols.map((c) => intentFor(def, uid, c, stored[c] as string)));
      return stored;
    },

    insertRow(table, uid, values) {
      assertActive();
      const def = defOf(table);
      const cols = Object.keys(values).sort();
      checkColumns(def, cols);
      // The insert capture reads identity from the live row; a trigger-filled
      // identity column would have no intent and seal as residual (N4).
      const noIdentity = def.identity.filter(
        (c) => c !== UID_COLUMN && (values[c] === undefined || values[c] === null),
      );
      if (noIdentity.length > 0) {
        // @sync-invariant none:input-shape an applied insert carries its identity; nothing is written
        throw new ApplyWriteError(`${table}: insert of ${uid} lacks ${noIdentity.join(', ')}`);
      }
      const all = def.columns;
      const row = db
        .prepare(
          `INSERT INTO main.${ident(table)} (${[UID_COLUMN, ...cols].map(ident).join(', ')}) ` +
            `VALUES (${['?', ...cols.map(() => '?')].join(', ')}) RETURNING ${returning(all)}`,
        )
        .get(uid, ...cols.map((c) => wireToSql(values[c] as LedgerWireValue))) as Record<
        string,
        unknown
      >;
      const stored = unpack(row, all);
      record([
        { tbl: table, uid, col: INTENT_INSERT, enc: '' },
        ...all
          .filter((c) => stored[c] !== 'NULL')
          .map((c) => intentFor(def, uid, c, stored[c] as string)),
      ]);
      return stored;
    },

    deleteRow(table, uid) {
      assertActive();
      defOf(table);
      const nulled = children(table, uid).filter((c) => c.key.onDelete === 'SET NULL');
      const res = db
        .prepare(`DELETE FROM main.${ident(table)} WHERE ${ident(UID_COLUMN)} = ?`)
        .run(uid);
      if (Number(res.changes) === 0) return false;
      record([
        { tbl: table, uid, col: INTENT_DELETE, enc: '' },
        ...nulled.map((c) => ({ tbl: c.key.child, uid: c.uid, col: c.key.from, enc: 'NULL' })),
      ]);
      return true;
    },

    rekeyRow(table, uid, newUid, newBfp) {
      assertActive();
      const def = defOf(table);
      const setBfp = newBfp !== null && def.identity.includes(BIRTH_FP_COLUMN);
      const res = db
        .prepare(
          `UPDATE main.${ident(table)} SET ${ident(UID_COLUMN)} = ?` +
            (setBfp ? `, ${ident(BIRTH_FP_COLUMN)} = ?` : '') +
            ` WHERE ${ident(UID_COLUMN)} = ?`,
        )
        .run(...(setBfp ? [newUid, newBfp, uid] : [newUid, uid]));
      if (Number(res.changes) === 0) return false;
      record([{ tbl: table, uid, col: INTENT_REKEY, enc: newUid }]);
      if (newUid !== uid || newBfp !== null) moveRowMeta(db, table, uid, newUid, newBfp);
      moveFieldState(db, table, uid, newUid);
      return true;
    },

    readLocalOnly(table, uid) {
      assertActive();
      const cols = localOnlyColumns(table);
      if (cols.length === 0) return rowExists(table, uid) ? {} : null;
      const row = db
        .prepare(
          `SELECT ${cols.map(ident).join(', ')} FROM main.${ident(table)} WHERE ${ident(UID_COLUMN)} = ?`,
        )
        .get(uid) as Record<string, SQLInputValue> | undefined;
      return row ?? null;
    },

    writeLocalOnly(table, uid, values) {
      assertActive();
      const allowed = new Set(localOnlyColumns(table));
      const cols = Object.keys(values).filter((c) => allowed.has(c));
      if (cols.length === 0) return;
      db.prepare(
        `UPDATE main.${ident(table)} SET ${cols.map((c) => `${ident(c)} = ?`).join(', ')} WHERE ${ident(UID_COLUMN)} = ?`,
      ).run(...cols.map((c) => values[c] as SQLInputValue), uid);
    },

    readLocalDescendants(table, uid) {
      assertActive();
      defOf(table);
      const out: {
        rows: LocalDescendants['rows'][number][];
        cleared: LocalDescendants['cleared'][number][];
      } = { rows: [], cleared: [] };
      const [root] = rowsWhere(table, UID_COLUMN, uid);
      if (root) collectDescendants(table, root, out, 0);
      return out;
    },

    writeLocalDescendants(snapshot) {
      assertActive();
      for (const r of snapshot.rows) {
        const cols = Object.keys(r.values);
        db.prepare(
          `INSERT INTO main.${ident(r.table)} (${cols.map(ident).join(', ')}) VALUES (${cols.map(() => '?').join(', ')}) ON CONFLICT DO NOTHING`,
        ).run(...cols.map((c) => r.values[c] as SQLInputValue));
      }
      for (const c of snapshot.cleared) {
        const keys = Object.keys(c.where);
        db.prepare(
          `UPDATE main.${ident(c.table)} SET ${ident(c.column)} = ? WHERE ${keys.map((k) => `${ident(k)} = ?`).join(' AND ')}`,
        ).run(c.value, ...keys.map((k) => c.where[k] as SQLInputValue));
      }
    },

    childRows(table, uid) {
      assertActive();
      defOf(table);
      return children(table, uid);
    },

    readRow(table, uid) {
      assertActive();
      const def = defOf(table);
      const cols = def.columns;
      const row = db
        .prepare(
          `SELECT ${returning(cols)} FROM main.${ident(table)} WHERE ${ident(UID_COLUMN)} = ?`,
        )
        .get(uid) as Record<string, unknown> | undefined;
      if (!row) return null;
      const out: Record<string, LedgerWireValue> = {};
      for (const [c, e] of Object.entries(unpack(row, cols))) out[c] = decodeEnc(e);
      return out;
    },

    rowMeta(table, uid) {
      assertActive();
      defOf(table);
      return readRowMeta(db, table, uid);
    },

    setRowMeta(table, uid, meta) {
      assertActive();
      return upsertRowMetaFromFields(db, defOf(table), { tbl: table, uid, ...meta });
    },

    setMergedRowMeta(table, uid, meta) {
      assertActive();
      const def = defOf(table);
      const prev = readRowMeta(db, table, uid);
      let hlc: string;
      let fhlc: string | null = null;
      if (meta.tombstone !== null) {
        hlc = meta.tombstone;
      } else {
        const fields: Record<string, string> = prev && !prev.deleted ? fieldHlcsOf(def, prev) : {};
        for (const c of def.columns) {
          const at = meta.fieldHlc[c];
          if (!def.identity.includes(c) && at !== undefined) fields[c] = at;
        }
        const missing = def.columns.filter((c) => !def.identity.includes(c) && !fields[c]);
        if (missing.length > 0) {
          // @sync-invariant none:input-shape the applier names every field of a row's first live meta; nothing is written
          throw new ApplyWriteError(`row meta for ${table}/${uid}: misses ${missing.join(', ')}`);
        }
        hlc = Object.values(fields).reduce((m, h) => (h > m ? h : m));
        fhlc = compressFieldHlcs(def, fields, hlc);
      }
      upsertRowMeta(db, {
        tbl: table,
        uid,
        hlc,
        fhlc,
        origin: meta.origin,
        actor: meta.actor,
        version: (prev?.version ?? 0) + 1,
        deleted: meta.tombstone !== null,
        keyJson: meta.keyJson,
        chash: meta.chash,
        bfp: meta.bfp,
      });
      return hlc;
    },
  };
}
