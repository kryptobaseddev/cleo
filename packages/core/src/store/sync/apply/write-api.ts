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
import { UID_COLUMN } from '../../row-identity-registry.js';
import {
  type ApplyIntent,
  INTENT_DELETE,
  INTENT_INSERT,
  recordApplyIntents,
  SECRET_INTENT,
} from '../apply-intent.js';
import { type CaptureTableDef, captureTableDef, enc } from '../capture.js';
import { type RowMetaRow, readRowMeta, upsertRowMetaFromFields } from '../row-meta.js';
import { decodeEnc } from '../sealer-values.js';

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
   * captured column.
   *
   * @returns The stored `enc()` per captured column (NULLs included).
   */
  insertRow(
    table: string,
    uid: string,
    values: Readonly<Record<string, LedgerWireValue>>,
  ): StoredEncs;
  /**
   * DELETE the row; records `*D`.
   *
   * @returns Whether a row was deleted.
   */
  deleteRow(table: string, uid: string): boolean;
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
  const record = (intents: ApplyIntent[]): void => {
    if (frame !== null && intents.length > 0) recordApplyIntents(db, frame, intents);
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
      const res = db
        .prepare(`DELETE FROM main.${ident(table)} WHERE ${ident(UID_COLUMN)} = ?`)
        .run(uid);
      if (Number(res.changes) === 0) return false;
      record([{ tbl: table, uid, col: INTENT_DELETE, enc: '' }]);
      return true;
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
  };
}
