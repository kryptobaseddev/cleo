/**
 * Capture: persistent pure-SQL triggers that record every change to a
 * sync-set row into `_sync_capture`, in the writing statement (journal spec
 * §2.3; S2, `sync.capture`; T12343 AC1 / R4).
 *
 * Per sync-set table the generator emits up to five AFTER triggers, all
 * carrying the `capture` suspension clause (§3.5 Rule 4):
 *
 * | Trigger | Fires on | Records |
 * |---|---|---|
 * | `_sync_cap_<t>_i` | INSERT | full image; identity read from the LIVE row (N4) |
 * | `_sync_cap_<t>_u` | UPDATE OF captured columns, when one changed | changed columns `[old, new]` |
 * | `_sync_cap_<t>_d` | DELETE | full before-image |
 * | `_sync_cap_<t>_k` | UPDATE OF uid / birth_fp of a keyed row | the re-key (H5) |
 * | `_sync_cap_<t>_f` | UPDATE OF uid / birth_fp from NULL | patches the latest live I capture (N4, N11) |
 *
 * - Values are `enc()`-encoded before any JSON function sees them (`quote()`,
 *   and `'r' || printf('%!.17g')` for REAL: `-0.0` becomes `0.0`, ±Inf is
 *   `Inf` / `-Inf`, L4).
 * - A reference column records `[enc(local key), target uid]`, the uid read at
 *   write time (H5). JSON-array references are translated at seal time.
 * - A secret column records only the `<changed>` marker, never its value
 *   (§2.7); before-images never hold secret values. `strip` columns are
 *   captured whole and stripped at seal. Local-only columns (claim leases)
 *   and identity columns never fire an update capture.
 * - Full images are chunked `json_patch(json_object(≤60 pairs), …)` (L3); the
 *   update image uses a `UNION ALL` of per-column terms (no argument limit).
 * - Each trigger also writes `_sync_undo` for the same seq, but only while
 *   `_sync_meta.undo_enabled` exists (push on, §3.5 Rule 2); S2 runs with it
 *   off (shadow mode). Append-only tables keep only `rk` and `uid` there.
 *   An update's undo holds only the changed columns, old and new (D5
 *   amendment); a delete's holds the full row.
 * - I and D images omit NULL columns: the sender's column set is pinned by
 *   its trigger set, so an absent column is NULL.
 *
 * The open pass installs the triggers only to match the persisted
 * `sync.capture` flag ({@link syncCaptureOpenPass}); the kill switch
 * `CLEO_SYNC_CAPTURE=0` never touches them (M3). `accessor.transaction()`
 * opens a frame ({@link openCaptureFrame}); finishing it labels the frame's
 * captures with the connection, frame and kind in one UPDATE
 * ({@link finishCaptureFrame}).
 *
 * @task T12343
 * @module store/sync/capture
 */

import { randomUUID } from 'node:crypto';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type { RowIdentityRef, TableScope } from '@cleocode/contracts';
import {
  BIRTH_FP_COLUMN,
  rowIdentityColumns,
  rowIdentitySpec,
  UID_COLUMN,
} from '../row-identity-registry.js';
import { classifyTable } from '../table-classification.js';
import { readSyncFlags, setSyncFlag, syncSetTables } from './flags.js';
import { mergeGroupsOf } from './merge/rules.js';
import { ensureSyncSchema, hasTable, healSyncSchema } from './schema.js';
import { canonicalizeStoreTimestamps } from './timestamps.js';
import {
  atomicDdl,
  CAPTURE_TRIGGER_PREFIX,
  normalizeSql,
  suspendClause,
} from './trigger-classes.js';
import { raiseMinWriterVersion } from './writer-version.js';

/** How one table is captured. Built from the registries, or by tests. */
export interface CaptureTableDef {
  readonly table: string;
  /** Local key columns (the table's single-row identity on this device). */
  readonly key: readonly string[];
  /** Captured columns, in table order: every column except local-only ones. */
  readonly columns: readonly string[];
  /** Identity columns (recorded, read from the live row on insert; never fire U). */
  readonly identity: readonly string[];
  /** Secret columns: recorded as `<changed>` only. */
  readonly secret: ReadonlySet<string>;
  /** Reference columns: target table and its local key column. */
  readonly refs: ReadonlyMap<string, { table: string; key: string }>;
  /** Rows never change: undo keeps only `rk` and `uid`. */
  readonly appendOnly: boolean;
}

/** One generated trigger. */
export interface CaptureTrigger {
  readonly name: string;
  readonly table: string;
  readonly sql: string;
  /** Every table the trigger's text references (SYNC_TRIGGER_REFS, N3). */
  readonly refs: readonly string[];
}

/** Largest number of key/value pairs per `json_object` call (L3). */
export const JSON_OBJECT_CHUNK = 60;

/** The marker a secret column records instead of its value (§2.7). */
export const SECRET_MARKER = '<changed>';

const q = (id: string): string => `"${id.replaceAll('"', '""')}"`;
const lit = (s: string): string => `'${s.replaceAll("'", "''")}'`;

/** `enc(v)`: lossless text for any SQLite value (§2.3). */
export function enc(expr: string): string {
  return `CASE typeof(${expr}) WHEN 'real' THEN 'r' || printf('%!.17g', ${expr}) ELSE quote(${expr}) END`;
}

/** Wall milliseconds from SQLite's clock, valid on every shipped SQLite (§1.2). */
export const AT_MS_SQL = "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)";

const CAPTURE_WHEN = suspendClause('capture');
const UNDO_ON = "EXISTS (SELECT 1 FROM _sync_meta WHERE key = 'undo_enabled')";

export { syncSetTables };

/**
 * The capture definition of a sync-set table in this store, or `undefined`
 * when the table is absent or not in the sync set.
 */
export function captureTableDef(
  db: DatabaseSync,
  scope: TableScope,
  table: string,
): CaptureTableDef | undefined {
  const spec = rowIdentitySpec(scope, table);
  const cls = classifyTable(scope, table);
  if (!spec || cls.kind !== 'entry' || !hasTable(db, table)) return undefined;
  const info = db.prepare(`PRAGMA main.table_info(${q(table)})`).all() as Array<{ name: string }>;
  const overrides = cls.entry.columns ?? [];
  const localOnly = new Set(overrides.filter((o) => o.class === 'local-only').map((o) => o.column));
  const wholeSecret = cls.class === 'portable-secret';
  const secret = new Set(
    wholeSecret
      ? info.map((c) => c.name).filter((c) => !spec.key.includes(c))
      : overrides.filter((o) => o.class === 'portable-secret').map((o) => o.column),
  );
  const identity = rowIdentityColumns(scope, table).filter((c) => info.some((i) => i.name === c));
  const refs = new Map<string, { table: string; key: string }>();
  const allRefs: RowIdentityRef[] = [
    ...(spec.refs ?? []),
    ...(spec.keyRefs ?? []),
    ...(spec.owners ?? []),
  ];
  for (const r of allRefs) {
    const target = rowIdentitySpec(scope, r.table);
    refs.set(r.column, { table: r.table, key: target?.key[0] ?? 'id' });
  }
  return {
    table,
    key: spec.key,
    columns: info.map((c) => c.name).filter((c) => !localOnly.has(c)),
    identity,
    secret,
    refs,
    appendOnly: (spec.content?.length ?? 0) > 0,
  };
}

/**
 * `enc(v)`, except that SQL NULL stays NULL (a JSON null in `json_object`,
 * which the full-image merge patch then removes).
 */
function encOrNull(expr: string): string {
  return `CASE typeof(${expr}) WHEN 'null' THEN NULL WHEN 'real' THEN 'r' || printf('%!.17g', ${expr}) ELSE quote(${expr}) END`;
}

/**
 * A column's value in an image, from row alias `row` (`NEW` or `OLD`). With
 * `omitNull`, a NULL value is SQL NULL (the full images drop the key); else
 * it is the text `NULL`.
 */
function valueExpr(
  def: CaptureTableDef,
  col: string,
  row: string,
  liveIdentity: boolean,
  omitNull = false,
): string {
  const e = omitNull ? encOrNull : enc;
  const nullText = omitNull ? 'NULL' : "'NULL'";
  if (def.secret.has(col)) {
    return `CASE WHEN ${row}.${q(col)} IS NULL THEN ${nullText} ELSE ${lit(SECRET_MARKER)} END`;
  }
  if (liveIdentity && def.identity.includes(col)) {
    return `(SELECT ${e(`x.${q(col)}`)} FROM ${q(def.table)} x WHERE ${keyMatch(def, 'x', row)})`;
  }
  const ref = def.refs.get(col);
  if (ref) {
    const pair = `json_array(${enc(`${row}.${q(col)}`)}, (SELECT r.${q(UID_COLUMN)} FROM ${q(ref.table)} r WHERE r.${q(ref.key)} = ${row}.${q(col)}))`;
    return omitNull ? `CASE WHEN ${row}.${q(col)} IS NULL THEN NULL ELSE ${pair} END` : pair;
  }
  return e(`${row}.${q(col)}`);
}

function keyMatch(def: CaptureTableDef, alias: string, row: string): string {
  return def.key.map((k) => `${alias}.${q(k)} = ${row}.${q(k)}`).join(' AND ');
}

function rkExpr(def: CaptureTableDef, row: string): string {
  return `json_array(${def.key.map((k) => enc(`${row}.${q(k)}`)).join(', ')})`;
}

/** `json_patch(json_object(≤60 pairs), …)` over `pairs` (L3). */
export function chunkedObject(pairs: ReadonlyArray<readonly [string, string]>): string {
  if (pairs.length === 0) return 'json_object()';
  const chunks: string[] = [];
  for (let i = 0; i < pairs.length; i += JSON_OBJECT_CHUNK) {
    const part = pairs.slice(i, i + JSON_OBJECT_CHUNK);
    chunks.push(`json_object(${part.map(([k, v]) => `${lit(k)}, ${v}`).join(', ')})`);
  }
  return chunks.reduce((acc, c) => `json_patch(${acc}, ${c})`);
}

/**
 * The I and D image: every captured column that is not NULL (S2 ruling (a),
 * cheaper images). A column absent from the image is NULL; the column set a
 * sender had is pinned by its trigger set (replayPin), so absence is never
 * "unknown column". The JSON merge patch drops the null members.
 */
function fullImage(def: CaptureTableDef, row: string, liveIdentity: boolean): string {
  return `json_patch('{}', ${chunkedObject(
    def.columns.map((c) => [c, valueExpr(def, c, row, liveIdentity, true)] as const),
  )})`;
}

/**
 * The SQL images of a repair capture (§4.4, T12987), read from the live row
 * aliased `row`, in the shapes the triggers write, so the sealer reads a
 * repair capture like any other:
 * - `rk`: the row's local key;
 * - `insert`: the I image ({@link fullImage});
 * - `update`: a U image of every updatable column, `[null, after]`. The
 *   before slot is JSON null because only the content hash was kept; a
 *   trigger's before is always an `enc()` text, so null marks a repair.
 *   Secret columns are left out (their `shash` is a follow-up).
 */
export function repairImageSql(
  def: CaptureTableDef,
  row: string,
): { readonly rk: string; readonly insert: string; readonly update: string } {
  const updatable = def.columns.filter((c) => !def.identity.includes(c) && !def.secret.has(c));
  return {
    rk: rkExpr(def, row),
    insert: fullImage(def, row, false),
    update: chunkedObject(
      updatable.map((c) => [c, `json_array(NULL, ${valueExpr(def, c, row, false)})`] as const),
    ),
  };
}

/** The undo image: every captured column, secret ciphertext and strip included (Rule 2). */
function undoImage(def: CaptureTableDef, row: string, liveIdentity: boolean): string {
  return chunkedObject(
    def.columns.map((c) => {
      if (liveIdentity && def.identity.includes(c)) {
        return [
          c,
          `(SELECT ${enc(`x.${q(c)}`)} FROM ${q(def.table)} x WHERE ${keyMatch(def, 'x', row)})`,
        ] as const;
      }
      return [c, enc(`${row}.${q(c)}`)] as const;
    }),
  );
}

function hasUid(def: CaptureTableDef): boolean {
  return def.identity.includes(UID_COLUMN);
}

function hasBirthFp(def: CaptureTableDef): boolean {
  return def.identity.includes(BIRTH_FP_COLUMN);
}

/**
 * The undo image of an update (D5 amendment, S2 ruling (b)): exactly the
 * changed columns, from `row`, secret ciphertext included (Rule 2). A D keeps
 * the full row ({@link undoImage}).
 */
function changedUndoImage(updatable: readonly string[], row: 'OLD' | 'NEW'): string {
  const terms = updatable
    .map(
      (c) =>
        `SELECT ${lit(c)} AS k, ${enc(`${row}.${q(c)}`)} AS v WHERE OLD.${q(c)} IS NOT NEW.${q(c)}`,
    )
    .join(' UNION ALL ');
  return `(SELECT json_group_object(k, v) FROM (${terms}))`;
}

function undoInsert(
  def: CaptureTableDef,
  op: 'I' | 'U' | 'D' | 'K',
  row: string,
  uidExpr: string,
  before: string,
  after: string,
): string {
  const images = def.appendOnly ? 'NULL, NULL' : `${before}, ${after}`;
  return (
    `INSERT INTO _sync_undo (seq, tbl, rk, uid, op, before_full, after_full) ` +
    `SELECT last_insert_rowid(), ${lit(def.table)}, ${rkExpr(def, row)}, ${uidExpr}, '${op}', ${images} WHERE ${UNDO_ON};`
  );
}

/**
 * Generate every capture trigger for one table. Pure: the same definition
 * always yields the same text, so the open pass can compare live text.
 *
 * The image contract the sealer reads (§2.3):
 * - I and D: `{col: value}` for every non-NULL captured column
 *   ({@link fullImage}); a reference is `[localKey, uid]`, a secret
 *   {@link SECRET_MARKER}.
 * - U: `{col: [before, after]}` for every changed column. Both slots are
 *   always present and never JSON null: a value is an `enc()` text (a SQL
 *   NULL is the text `'NULL'`), a reference a `[localKey, uid]` array, a
 *   secret the marker.
 * - The ONE exception is a repair capture (§4.4, T12987;
 *   {@link repairImageSql}): its before slot is JSON null, meaning "unknown"
 *   (only the content hash was kept). It is valid only inside a `repair`
 *   frame; anywhere else the sealer quarantines it.
 * - K: `{uid: [old, new], birth_fp?: [old, new]}`.
 */
export function captureTriggers(def: CaptureTableDef): CaptureTrigger[] {
  const t = q(def.table);
  const name = (s: string) => `${CAPTURE_TRIGGER_PREFIX}${def.table}_${s}`;
  const refs = [
    ...new Set([def.table, ...[...def.refs.values()].map((r) => r.table)]),
    '_sync_capture',
    '_sync_undo',
    '_sync_meta',
    'cleo_trigger_suspend',
  ];
  const liveUid = hasUid(def)
    ? `(SELECT x.${q(UID_COLUMN)} FROM ${t} x WHERE ${keyMatch(def, 'x', 'NEW')})`
    : 'NULL';
  const oldUid = hasUid(def) ? `OLD.${q(UID_COLUMN)}` : 'NULL';
  const ins = (op: string, row: string, uid: string, img: string) =>
    `INSERT INTO _sync_capture (tbl, op, rk, uid, img, at_ms) VALUES (${lit(def.table)}, '${op}', ${rkExpr(def, row)}, ${uid}, ${img}, ${AT_MS_SQL});`;

  const out: CaptureTrigger[] = [];

  out.push({
    name: name('i'),
    table: def.table,
    refs,
    sql:
      `CREATE TRIGGER ${q(name('i'))} AFTER INSERT ON ${t} WHEN ${CAPTURE_WHEN} BEGIN ` +
      `${ins('I', 'NEW', liveUid, fullImage(def, 'NEW', true))} ` +
      `${undoInsert(def, 'I', 'NEW', liveUid, 'NULL', undoImage(def, 'NEW', true))} END`,
  });

  const updatable = def.columns.filter((c) => !def.identity.includes(c));
  if (updatable.length > 0) {
    const changed = updatable.map((c) => `OLD.${q(c)} IS NOT NEW.${q(c)}`).join(' OR ');
    // A merge group is recorded whole when any of its columns changes
    // (T13222), so the sealed op carries the group as one unit.
    const groups = mergeGroupsOf(def.table, updatable);
    const when = (c: string): string => {
      const g = groups.find((grp) => grp.includes(c)) ?? [c];
      const terms = g.map((x) => `OLD.${q(x)} IS NOT NEW.${q(x)}`);
      return terms.length === 1 ? (terms[0] as string) : `(${terms.join(' OR ')})`;
    };
    const terms = updatable
      .map((c) => {
        const v = def.secret.has(c)
          ? `json_array(${lit(SECRET_MARKER)}, ${lit(SECRET_MARKER)})`
          : `json_array(${valueExpr(def, c, 'OLD', false)}, ${valueExpr(def, c, 'NEW', false)})`;
        return `SELECT ${lit(c)} AS k, ${v} AS v WHERE ${when(c)}`;
      })
      .join(' UNION ALL ');
    const img = `(SELECT json_group_object(k, json(v)) FROM (${terms}))`;
    out.push({
      name: name('u'),
      table: def.table,
      refs,
      sql:
        `CREATE TRIGGER ${q(name('u'))} AFTER UPDATE OF ${updatable.map(q).join(', ')} ON ${t} ` +
        `WHEN (${changed}) AND ${CAPTURE_WHEN} BEGIN ` +
        `${ins('U', 'NEW', oldUid, img)} ` +
        `${undoInsert(def, 'U', 'NEW', oldUid, changedUndoImage(updatable, 'OLD'), changedUndoImage(updatable, 'NEW'))} END`,
    });
  }

  out.push({
    name: name('d'),
    table: def.table,
    refs,
    sql:
      `CREATE TRIGGER ${q(name('d'))} AFTER DELETE ON ${t} WHEN ${CAPTURE_WHEN} BEGIN ` +
      `${ins('D', 'OLD', oldUid, fullImage(def, 'OLD', false))} ` +
      `${undoInsert(def, 'D', 'OLD', oldUid, undoImage(def, 'OLD', false), 'NULL')} END`,
  });

  if (hasUid(def)) {
    const idCols = [UID_COLUMN, ...(hasBirthFp(def) ? [BIRTH_FP_COLUMN] : [])];
    const kImg = chunkedObject(
      idCols.map((c) => [c, `json_array(${enc(`OLD.${q(c)}`)}, ${enc(`NEW.${q(c)}`)})`] as const),
    );
    const rekeyed = idCols.map((c) => `OLD.${q(c)} IS NOT NEW.${q(c)}`).join(' OR ');
    out.push({
      name: name('k'),
      table: def.table,
      refs,
      sql:
        `CREATE TRIGGER ${q(name('k'))} AFTER UPDATE OF ${idCols.map(q).join(', ')} ON ${t} ` +
        `WHEN OLD.${q(UID_COLUMN)} IS NOT NULL AND (${rekeyed}) AND ${CAPTURE_WHEN} BEGIN ` +
        `${ins('K', 'NEW', 'OLD.' + q(UID_COLUMN), kImg)} ` +
        `${undoInsert(def, 'K', 'NEW', 'OLD.' + q(UID_COLUMN), kImg, kImg)} END`,
    });

    const filled = idCols
      .map((c) => `(OLD.${q(c)} IS NULL AND NEW.${q(c)} IS NOT NULL)`)
      .join(' OR ');
    const patch = idCols
      .map(
        (c) =>
          `'$.${c}', CASE WHEN coalesce(json_extract(img, '$.${c}'), 'NULL') = 'NULL' THEN ${enc(`NEW.${q(c)}`)} ELSE json_extract(img, '$.${c}') END`,
      )
      .join(', ');
    out.push({
      name: name('f'),
      table: def.table,
      refs,
      sql:
        `CREATE TRIGGER ${q(name('f'))} AFTER UPDATE OF ${idCols.map(q).join(', ')} ON ${t} ` +
        `WHEN (${filled}) AND ${CAPTURE_WHEN} BEGIN ` +
        `UPDATE _sync_capture SET uid = coalesce(uid, NEW.${q(UID_COLUMN)}), img = json_set(img, ${patch}) ` +
        `WHERE seq = (SELECT max(seq) FROM _sync_capture WHERE tbl = ${lit(def.table)} AND rk = ${rkExpr(def, 'NEW')} AND op = 'I' AND state = 'live'); END`,
    });
  }
  return out;
}

/**
 * Re-mint captures (T12806 × S2): a captured write that CLEARED a row's
 * identity (a snapshot-overwrite import: K old → NULL) is followed by a fill
 * that mints the new uid outside capture (the open-time fill runs with the
 * capture triggers dropped). For every such row, write the K that journals
 * the new identity (NULL → new uid, and birth_fp), so the pair nets to
 * old → new. Call inside the fill's bracket, after the fill.
 *
 * A row qualifies when its latest live K capture set the uid to NULL and the
 * row now has a uid. Undo is written only while `undo_enabled` (Rule 2).
 *
 * @returns K captures written, per table.
 */
export function captureRemints(db: DatabaseSync, scope: TableScope): Record<string, number> {
  const out: Record<string, number> = {};
  if (!hasTable(db, '_sync_capture')) return out;
  const undoOn =
    hasTable(db, '_sync_meta') &&
    (db.prepare(`SELECT ${UNDO_ON} AS v`).get() as { v: number }).v === 1;
  for (const table of syncSetTables(scope)) {
    const def = captureTableDef(db, scope, table);
    if (!def || !hasUid(def)) continue;
    const idCols = [UID_COLUMN, ...(hasBirthFp(def) ? [BIRTH_FP_COLUMN] : [])];
    const img = chunkedObject(
      idCols.map((c) => [c, `json_array('NULL', ${enc(`x.${q(c)}`)})`] as const),
    );
    const rows = db
      .prepare(
        `SELECT c.rk AS rk, x.rowid AS rid FROM _sync_capture c JOIN ${q(table)} x ON ${rkExpr(def, 'x')} = c.rk ` +
          `WHERE c.tbl = ${lit(table)} AND c.op = 'K' AND c.state = 'live' ` +
          `AND c.seq = (SELECT max(m.seq) FROM _sync_capture m WHERE m.tbl = c.tbl AND m.rk = c.rk AND m.op = 'K' AND m.state = 'live') ` +
          `AND json_extract(c.img, '$.${UID_COLUMN}[1]') = 'NULL' AND x.${q(UID_COLUMN)} IS NOT NULL`,
      )
      .all() as Array<{ rk: string; rid: number }>;
    if (rows.length === 0) continue;
    const ins = db.prepare(
      `INSERT INTO _sync_capture (tbl, op, rk, uid, img, at_ms) SELECT ${lit(table)}, 'K', ?, NULL, ${img}, ${AT_MS_SQL} FROM ${q(table)} x WHERE x.rowid = ?`,
    );
    const undo = db.prepare(
      `INSERT INTO _sync_undo (seq, tbl, rk, uid, op, before_full, after_full) SELECT last_insert_rowid(), ${lit(table)}, ?, NULL, 'K', ${img}, ${img} FROM ${q(table)} x WHERE x.rowid = ?`,
    );
    for (const r of rows) {
      ins.run(r.rk, r.rid);
      if (undoOn) undo.run(r.rk, r.rid);
    }
    out[table] = rows.length;
  }
  return out;
}

/** Every capture trigger for the store's sync set. */
export function generateCaptureTriggers(db: DatabaseSync, scope: TableScope): CaptureTrigger[] {
  const out: CaptureTrigger[] = [];
  for (const table of syncSetTables(scope)) {
    const def = captureTableDef(db, scope, table);
    if (def) out.push(...captureTriggers(def));
  }
  return out;
}

/** SYNC_TRIGGER_REFS: trigger → every table its text references (N3). */
export function syncTriggerRefs(
  db: DatabaseSync,
  scope: TableScope,
): Map<string, readonly string[]> {
  return new Map(generateCaptureTriggers(db, scope).map((t) => [t.name, t.refs]));
}

function liveCaptureTriggers(db: DatabaseSync): Map<string, string> {
  return new Map(
    (
      db
        .prepare(
          "SELECT name, sql FROM main.sqlite_master WHERE type = 'trigger' AND substr(name, 1, length(?)) = ?",
        )
        .all(CAPTURE_TRIGGER_PREFIX, CAPTURE_TRIGGER_PREFIX) as Array<{ name: string; sql: string }>
    ).map((r) => [r.name, r.sql]),
  );
}

/** What {@link installCaptureTriggers} changed. */
export interface CaptureInstallReport {
  readonly installed: string[];
  readonly replaced: string[];
  readonly dropped: string[];
}

/**
 * Make the live capture triggers exactly the generated set: create the
 * missing, replace the differing, drop the orphaned. Writes nothing when
 * they already match. Requires the sync schema.
 */
export function installCaptureTriggers(db: DatabaseSync, scope: TableScope): CaptureInstallReport {
  const want = generateCaptureTriggers(db, scope);
  const live = liveCaptureTriggers(db);
  const report: CaptureInstallReport = { installed: [], replaced: [], dropped: [] };
  const wanted = new Set(want.map((t) => t.name));
  for (const [name] of live) if (!wanted.has(name)) report.dropped.push(name);
  const changes = want.filter((t) => {
    const have = live.get(t.name);
    if (have !== undefined && normalizeSql(have) === normalizeSql(t.sql)) return false;
    (have === undefined ? report.installed : report.replaced).push(t.name);
    return true;
  });
  if (report.dropped.length + changes.length === 0) return report;
  // One unit (T13024 MED-2): a failed CREATE never leaves a dropped trigger committed.
  atomicDdl(db, () => {
    for (const name of report.dropped) db.exec(`DROP TRIGGER IF EXISTS ${q(name)}`);
    for (const t of changes) {
      if (live.has(t.name)) db.exec(`DROP TRIGGER IF EXISTS ${q(t.name)}`);
      db.exec(t.sql);
    }
  });
  return report;
}

/** Drop every capture trigger. Returns their names. */
export function dropCaptureTriggers(db: DatabaseSync): string[] {
  const names = [...liveCaptureTriggers(db).keys()];
  for (const n of names) db.exec(`DROP TRIGGER IF EXISTS ${q(n)}`);
  return names;
}

// ── per-connection provenance stamp and frames ─────────────────────────────

const stamped = new WeakMap<DatabaseSync, string>();

/**
 * Install the provenance stamp on a chokepoint connection (§2.3). A
 * persistent trigger cannot read a TEMP table, so the capture triggers write
 * rows unlabelled; the labels (connection, frame, kind) are written ONCE per
 * frame by {@link finishCaptureFrame}, over the frame's seq range. Writes are
 * serialized by the write lock, so every capture from the frame's
 * `first_seq` on belongs to it. This replaces a TEMP trigger that ran one
 * UPDATE per capture (S2 insert-path ruling (a)). Also turns
 * `recursive_triggers` on for this connection (M1; the REPLACE audit is
 * T12787's zero-tolerance ban plus `recursive-triggers-audit.test.ts`).
 *
 * @returns This connection's id.
 */
export function installCaptureStamp(db: DatabaseSync): string {
  const existing = stamped.get(db);
  if (existing) return existing;
  const conn = randomUUID();
  db.exec('PRAGMA recursive_triggers = ON');
  stamped.set(db, conn);
  return conn;
}

/** Remove the stamp (capture turned off, or the sync tables dropped). */
export function removeCaptureStamp(db: DatabaseSync): void {
  stamped.delete(db);
  frameStatements.delete(db);
}

/** Whether this connection carries the capture stamp. */
export function hasCaptureStamp(db: DatabaseSync): boolean {
  return stamped.has(db);
}

/** The kinds a frame can have (§2.3). */
export type FrameKind =
  | 'write'
  | 'apply'
  | 'rebase'
  | 'repair'
  | 'exodus'
  | 'import'
  | 'remint'
  | 'rekey';

/** Frames whose undo is dropped at once (D1). */
const NO_UNDO_KINDS: ReadonlySet<string> = new Set(['apply', 'rebase']);

interface FrameStatements {
  readonly next: StatementSync;
  readonly open: StatementSync;
  readonly frameOf: StatementSync;
  readonly labelCaptures: StatementSync;
  readonly labelUndo: StatementSync;
  readonly dropUndo: StatementSync;
  readonly dropEmpty: StatementSync;
}

const frameStatements = new WeakMap<DatabaseSync, FrameStatements>();

function statementsFor(db: DatabaseSync): FrameStatements {
  let s = frameStatements.get(db);
  if (!s) {
    s = {
      next: db.prepare('SELECT coalesce(max(seq), 0) + 1 AS n FROM main._sync_capture'),
      open: db.prepare(
        'INSERT INTO _sync_frame (frame, kind, actor, first_seq) VALUES (?, ?, ?, ?)',
      ),
      frameOf: db.prepare('SELECT kind, first_seq FROM _sync_frame WHERE frame = ?'),
      labelCaptures: db.prepare(
        'UPDATE _sync_capture SET conn = ?, frame = ?, kind = ? WHERE seq >= ? AND frame IS NULL',
      ),
      labelUndo: db.prepare(
        'UPDATE _sync_undo SET txn_local = ?, kind = ? WHERE seq >= ? AND txn_local IS NULL',
      ),
      dropUndo: db.prepare('DELETE FROM _sync_undo WHERE seq >= ? AND txn_local IS NULL'),
      dropEmpty: db.prepare(
        'DELETE FROM _sync_frame WHERE frame = ? AND NOT EXISTS (SELECT 1 FROM main._sync_capture WHERE frame = ?)',
      ),
    };
    frameStatements.set(db, s);
  }
  return s;
}

/**
 * Open a frame for the caller's transaction, right after its
 * `BEGIN IMMEDIATE`: insert the `_sync_frame` row with the first seq its
 * captures can take. A connection without the stamp (capture off) gets
 * `null` and nothing is written.
 */
export function openCaptureFrame(
  db: DatabaseSync,
  kind: FrameKind = 'write',
  actor: string | null = null,
): string | null {
  if (!stamped.has(db)) return null;
  const st = statementsFor(db);
  const frame = randomUUID();
  const next = (st.next.get() as { n: number }).n;
  st.open.run(frame, kind, actor, next);
  return frame;
}

/**
 * Before COMMIT: label the frame's captures and undo rows (one UPDATE each
 * over its seq range), drop the undo of an `apply` / `rebase` frame (D1), and
 * delete the frame's row when no capture carries it, so a read-only
 * transaction leaves nothing (N10). A transaction that commits without this
 * call leaves its captures unframed, never mislabelled.
 */
export function finishCaptureFrame(db: DatabaseSync, frame: string | null): void {
  if (!frame) return;
  const st = statementsFor(db);
  const row = st.frameOf.get(frame) as { kind: string; first_seq: number } | undefined;
  if (row) {
    st.labelCaptures.run(stamped.get(db) ?? null, frame, row.kind, row.first_seq);
    if (NO_UNDO_KINDS.has(row.kind)) st.dropUndo.run(row.first_seq);
    else st.labelUndo.run(frame, row.kind, row.first_seq);
  }
  st.dropEmpty.run(frame, frame);
}

/**
 * In `finally`: nothing is left to clear (the labels are written by
 * {@link finishCaptureFrame}); kept so callers need not change.
 */
export function clearCaptureFrame(_db: DatabaseSync, _frame: string | null): void {}

// ── flag and open pass ─────────────────────────────────────────────────────

/**
 * `cleo sync capture on|off` (the storage primitive): persist the flag and
 * install or drop the triggers, in one transaction.
 */
export function setCaptureEnabled(
  db: DatabaseSync,
  scope: TableScope,
  on: boolean,
  options: { schemaRoot?: string } = {},
): CaptureInstallReport | { dropped: string[] } {
  if (on) ensureSyncSchema(db, { root: options.schemaRoot });
  db.exec('BEGIN IMMEDIATE');
  try {
    setSyncFlag(db, 'sync.capture', on, { schemaRoot: options.schemaRoot });
    // Ruling (c): a store with capture on requires a framing writer.
    if (on) raiseMinWriterVersion(db);
    // §1.8: the one-time timestamp rewrite runs before the triggers go in.
    if (on) canonicalizeStoreTimestamps(db, scope);
    const report = on ? installCaptureTriggers(db, scope) : { dropped: dropCaptureTriggers(db) };
    db.exec('COMMIT');
    if (on) installCaptureStamp(db);
    else removeCaptureStamp(db);
    return report;
  } catch (err) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw err;
  }
}

/** What the capture open pass did. */
export type CaptureOpenResult =
  | { readonly capture: 'off'; readonly dropped: string[] }
  | { readonly capture: 'on'; readonly report: CaptureInstallReport; readonly conn: string };

/**
 * The capture step of the open pass, after migrations: triggers match the
 * persisted flag. With the flag off and no trigger present it only reads.
 */
export function syncCaptureOpenPass(
  db: DatabaseSync,
  scope: TableScope,
  options: { schemaRoot?: string } = {},
): CaptureOpenResult {
  const on = readSyncFlags(db)['sync.capture'];
  if (!on) {
    removeCaptureStamp(db);
    const live = liveCaptureTriggers(db);
    if (live.size === 0) return { capture: 'off', dropped: [] };
    return { capture: 'off', dropped: dropCaptureTriggers(db) };
  }
  ensureSyncSchema(db, { root: options.schemaRoot });
  // §2.3a rule 9: a missing outbox table with triggers present breaks every
  // captured write; re-create it before anything else writes.
  healSyncSchema(db, ['_sync_capture', '_sync_frame', '_sync_undo', '_sync_meta'], {
    root: options.schemaRoot,
  });
  // §1.8: a store whose capture went on before S3c gets its one-time
  // timestamp rewrite here, with capture suspended, before the reinstall.
  canonicalizeStoreTimestamps(db, scope);
  const report = installCaptureTriggers(db, scope);
  return { capture: 'on', report, conn: installCaptureStamp(db) };
}

/**
 * Migration-runner hooks (§2.3a rules 1 and 5): drop every capture trigger
 * inside the bracket before a migration's statements, and regenerate them for
 * the new schema before its COMMIT. Only when capture is on.
 */
export function captureBracketHooks(
  db: DatabaseSync,
  scope: TableScope,
): { suspendCapture?(db: DatabaseSync): void; reinstallCapture?(db: DatabaseSync): void } {
  if (!readSyncFlags(db)['sync.capture']) return {};
  return {
    suspendCapture: (d) => {
      dropCaptureTriggers(d);
    },
    reinstallCapture: (d) => {
      if (hasTable(d, '_sync_capture')) installCaptureTriggers(d, scope);
    },
  };
}
