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
 *
 * The open pass installs the triggers only to match the persisted
 * `sync.capture` flag ({@link syncCaptureOpenPass}); the kill switch
 * `CLEO_SYNC_CAPTURE=0` never touches them (M3). The per-connection TEMP
 * stamp labels each capture with the connection, frame and kind
 * ({@link installCaptureStamp}); `accessor.transaction()` opens a frame
 * ({@link openCaptureFrame}).
 *
 * @task T12343
 * @module store/sync/capture
 */

import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { RowIdentityRef, TableScope } from '@cleocode/contracts';
import {
  BIRTH_FP_COLUMN,
  ROW_IDENTITY,
  rowIdentityColumns,
  rowIdentitySpec,
  UID_COLUMN,
} from '../row-identity-registry.js';
import { classifyTable, isPortableTableClass } from '../table-classification.js';
import { readSyncFlags, setSyncFlag } from './flags.js';
import { ensureSyncSchema, hasTable, healSyncSchema } from './schema.js';
import { CAPTURE_TRIGGER_PREFIX, normalizeSql, suspendClause } from './trigger-classes.js';

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

/** The sync set: portable, not frozen-legacy, declared in ROW_IDENTITY (§2.1). */
export function syncSetTables(scope: TableScope): string[] {
  return ROW_IDENTITY[scope]
    .map((spec) => spec.table)
    .filter((t) => {
      const c = classifyTable(scope, t);
      return (
        c.kind === 'entry' && isPortableTableClass(c.class) && c.entry.status !== 'frozen-legacy'
      );
    });
}

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

/** A column's value in an image, from row alias `row` (`NEW` or `OLD`). */
function valueExpr(def: CaptureTableDef, col: string, row: string, liveIdentity: boolean): string {
  if (def.secret.has(col)) {
    return `CASE WHEN ${row}.${q(col)} IS NULL THEN 'NULL' ELSE ${lit(SECRET_MARKER)} END`;
  }
  if (liveIdentity && def.identity.includes(col)) {
    return `(SELECT ${enc(`x.${q(col)}`)} FROM ${q(def.table)} x WHERE ${keyMatch(def, 'x', row)})`;
  }
  const ref = def.refs.get(col);
  if (ref) {
    return `json_array(${enc(`${row}.${q(col)}`)}, (SELECT r.${q(UID_COLUMN)} FROM ${q(ref.table)} r WHERE r.${q(ref.key)} = ${row}.${q(col)}))`;
  }
  return enc(`${row}.${q(col)}`);
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

function fullImage(def: CaptureTableDef, row: string, liveIdentity: boolean): string {
  return chunkedObject(def.columns.map((c) => [c, valueExpr(def, c, row, liveIdentity)] as const));
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
    const terms = updatable
      .map((c) => {
        const v = def.secret.has(c)
          ? `json_array(${lit(SECRET_MARKER)}, ${lit(SECRET_MARKER)})`
          : `json_array(${valueExpr(def, c, 'OLD', false)}, ${valueExpr(def, c, 'NEW', false)})`;
        return `SELECT ${lit(c)} AS k, ${v} AS v WHERE OLD.${q(c)} IS NOT NEW.${q(c)}`;
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
        `${undoInsert(def, 'U', 'NEW', oldUid, undoImage(def, 'OLD', false), undoImage(def, 'NEW', false))} END`,
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
          `'$.${c}', CASE WHEN json_extract(img, '$.${c}') = 'NULL' THEN ${enc(`NEW.${q(c)}`)} ELSE json_extract(img, '$.${c}') END`,
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
  for (const [name] of live) {
    if (!wanted.has(name)) {
      db.exec(`DROP TRIGGER IF EXISTS ${q(name)}`);
      report.dropped.push(name);
    }
  }
  for (const t of want) {
    const have = live.get(t.name);
    if (have !== undefined && normalizeSql(have) === normalizeSql(t.sql)) continue;
    if (have !== undefined) db.exec(`DROP TRIGGER IF EXISTS ${q(t.name)}`);
    db.exec(t.sql);
    (have === undefined ? report.installed : report.replaced).push(t.name);
  }
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
 * Install the TEMP provenance stamp on a chokepoint connection (§2.3): the
 * single-row `temp.cleo_sync_ctx`, a TEMP trigger that labels every capture
 * with the connection, frame and kind, and one that labels undo rows and
 * drops the undo of `apply` / `rebase` frames at once (D1). Also turns
 * `recursive_triggers` on for this connection (M1; the REPLACE audit is
 * T12787's zero-tolerance ban plus `recursive-triggers-audit.test.ts`).
 *
 * @returns This connection's id.
 */
export function installCaptureStamp(db: DatabaseSync): string {
  const existing = stamped.get(db);
  if (existing) return existing;
  const conn = randomUUID();
  db.exec(`
    CREATE TEMP TABLE IF NOT EXISTS cleo_sync_ctx (conn TEXT, frame TEXT, kind TEXT, actor TEXT);
    DELETE FROM temp.cleo_sync_ctx;
    CREATE TEMP TRIGGER IF NOT EXISTS cleo_sync_stamp AFTER INSERT ON main._sync_capture
    BEGIN
      UPDATE _sync_capture
         SET conn = (SELECT conn FROM temp.cleo_sync_ctx),
             frame = (SELECT frame FROM temp.cleo_sync_ctx),
             kind = (SELECT kind FROM temp.cleo_sync_ctx)
       WHERE seq = NEW.seq;
    END;
    CREATE TEMP TRIGGER IF NOT EXISTS cleo_sync_undo_stamp AFTER INSERT ON main._sync_undo
    BEGIN
      DELETE FROM _sync_undo
       WHERE seq = NEW.seq
         AND (SELECT kind FROM temp.cleo_sync_ctx) IN ('apply', 'rebase')
         AND EXISTS (SELECT 1 FROM main._sync_frame WHERE frame = (SELECT frame FROM temp.cleo_sync_ctx));
      UPDATE _sync_undo
         SET txn_local = (SELECT frame FROM temp.cleo_sync_ctx),
             kind = (SELECT kind FROM temp.cleo_sync_ctx)
       WHERE seq = NEW.seq;
    END;
    PRAGMA recursive_triggers = ON;
  `);
  db.prepare('INSERT INTO temp.cleo_sync_ctx (conn) VALUES (?)').run(conn);
  stamped.set(db, conn);
  return conn;
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

/**
 * Open a frame for the caller's transaction, right after its
 * `BEGIN IMMEDIATE`: insert the `_sync_frame` row and point the TEMP ctx at
 * it. A connection without the stamp (capture off) gets `null` and nothing is
 * written.
 */
export function openCaptureFrame(
  db: DatabaseSync,
  kind: FrameKind = 'write',
  actor: string | null = null,
): string | null {
  if (!stamped.has(db)) return null;
  const frame = randomUUID();
  const next = (
    db.prepare('SELECT coalesce(max(seq), 0) + 1 AS n FROM main._sync_capture').get() as {
      n: number;
    }
  ).n;
  db.prepare('INSERT INTO _sync_frame (frame, kind, actor, first_seq) VALUES (?, ?, ?, ?)').run(
    frame,
    kind,
    actor,
    next,
  );
  db.prepare('UPDATE temp.cleo_sync_ctx SET frame = ?, kind = ?, actor = ?').run(
    frame,
    kind,
    actor,
  );
  return frame;
}

/**
 * Before COMMIT: delete the frame's row when no capture carries it, so a
 * read-only transaction leaves nothing (N10).
 */
export function finishCaptureFrame(db: DatabaseSync, frame: string | null): void {
  if (!frame) return;
  db.prepare(
    'DELETE FROM _sync_frame WHERE frame = ? AND NOT EXISTS (SELECT 1 FROM main._sync_capture WHERE frame = ?)',
  ).run(frame, frame);
}

/** In `finally`: clear the ctx, so a later autocommit write is unframed. */
export function clearCaptureFrame(db: DatabaseSync, frame: string | null): void {
  if (!frame || !db.isOpen) return;
  db.prepare('UPDATE temp.cleo_sync_ctx SET frame = NULL, kind = NULL, actor = NULL').run();
}

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
    const report = on ? installCaptureTriggers(db, scope) : { dropped: dropCaptureTriggers(db) };
    db.exec('COMMIT');
    if (on) installCaptureStamp(db);
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
