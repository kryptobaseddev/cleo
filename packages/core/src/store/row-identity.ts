/**
 * Row uids (T12341): the merge key every syncing row carries.
 *
 * A table whose Gate A class syncs gets a `uid TEXT` column. The local primary
 * key (`T####`, an AC id, a session id, a composite edge key) stays the local
 * key, and local foreign keys keep pointing at it; the uid is what a merge
 * compares. Spec: `cleo docs fetch t12341-uid-scheme`.
 *
 * ## How a uid is made
 *
 * - **Minted, new row** (this build writes it): a random UUIDv7
 *   ({@link mintRowUid}), set by the Drizzle `$defaultFn` or by the writer.
 * - **Minted, no uid yet** (an existing row, or one an older build or a raw-SQL
 *   writer inserted): a DETERMINISTIC v7-layout uid. Its timestamp is the
 *   row's birth; its other 74 bits are SHA-256 over (scope, table, key, birth,
 *   the uids of its owning rows, and, for append-only tables, its content)
 *   ({@link mintedRowUid}). Two devices that share a history derive the same
 *   uid for the same row; the same `T####` with a different `created_at` (the
 *   split-brain case, T12329) derives a different one.
 * - **Natural** (edges, labels): a UUIDv8 over the key with every reference
 *   replaced by the referenced row's uid ({@link naturalRowUid}). It is a pure
 *   function of the row, so delete-and-reinsert keeps it.
 *
 * ## When uids are filled
 *
 * {@link prepareRowIdentity} runs on every open of a `cleo.db`, inside the
 * cold-open lease right after the migrations:
 *
 * 1. re-asserts the uid columns and indexes (idempotent; heals a migration the
 *    journal probe stamped without running its index DDL);
 * 2. registers the deterministic SQL function `cleo_row_uid` on the
 *    connection and fills every NULL uid, minted tables first (owners before
 *    their children), then natural tables, then the stored reference uids
 *    (`ac_uid`), in one savepoint;
 * 3. installs one TEMP `AFTER INSERT` trigger per declared table on this
 *    connection, so a row inserted here without a uid gets the same value the
 *    open pass would give it, in the same statement.
 *
 * A row an older build inserts keeps a NULL uid until the next open by this
 * build: there is no persistent trigger (see the migration's header).
 * `CLEO_DISABLE_ROW_UID_FILL=1` skips steps 2 and 3.
 *
 * A failure never fails the open: it is logged, and the rows keep a NULL uid
 * until a later open succeeds.
 *
 * @module
 * @task T12341
 * @epic T12323
 */

import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { RowIdentityRef, RowIdentitySpec, TableScope } from '@cleocode/contracts';
import { uuidv7 } from '../cloud/uuidv7.js';
import { getLogger } from '../logger.js';
import {
  ROW_IDENTITY,
  rowIdentityColumns,
  rowIdentitySpec,
  UID_COLUMN,
} from './row-identity-registry.js';

export { ROW_IDENTITY, rowIdentityColumns, rowIdentitySpec, UID_COLUMN };

/** Domain separator hashed into every deterministic uid. Changing it re-keys every row. */
export const ROW_UID_DOMAIN = 'cleo/row-uid/v1';

/** Name of the per-connection SQL function that computes a deterministic uid. */
export const ROW_UID_SQL_FUNCTION = 'cleo_row_uid';

/** Environment switch that skips the fill and the per-connection triggers. */
export const ROW_UID_FILL_KILL_SWITCH = 'CLEO_DISABLE_ROW_UID_FILL';

/** A SQL value as node:sqlite passes it to a function. */
export type UidInput = string | number | bigint | Uint8Array | null;

/**
 * Unambiguous encoding of uid inputs: per value a type tag (0 null, 1 text,
 * 2 integer, 3 real, 4 blob), a big-endian u32 byte length, and the bytes
 * (UTF-8 text, decimal numbers).
 *
 * @param values - Inputs in hash order.
 * @returns The encoded bytes.
 */
export function encodeUidInputs(values: readonly UidInput[]): Buffer {
  const parts: Buffer[] = [];
  for (const value of values) {
    let tag: number;
    let bytes: Buffer;
    if (value === null) {
      tag = 0;
      bytes = Buffer.alloc(0);
    } else if (typeof value === 'string') {
      tag = 1;
      bytes = Buffer.from(value, 'utf8');
    } else if (typeof value === 'bigint' || Number.isInteger(value)) {
      tag = 2;
      bytes = Buffer.from(String(value), 'utf8');
    } else if (typeof value === 'number') {
      tag = 3;
      bytes = Buffer.from(String(value), 'utf8');
    } else {
      tag = 4;
      bytes = Buffer.from(value);
    }
    const head = Buffer.alloc(5);
    head.writeUInt8(tag, 0);
    head.writeUInt32BE(bytes.length, 1);
    parts.push(head, bytes);
  }
  return Buffer.concat(parts);
}

/**
 * Epoch milliseconds of a stored timestamp, or `null` when absent or
 * unparseable. `datetime('now')` writes `YYYY-MM-DD HH:MM:SS` with no zone,
 * meaning UTC, so a zoneless value is read as UTC. Comparing that text against
 * ISO text is wrong within a day (`' '` sorts before `'T'`), so every
 * comparison and every uid birth goes through this function (T12329).
 *
 * @param value - Stored timestamp.
 * @returns Epoch milliseconds, or `null`.
 */
export function parseStoreTimestamp(value: UidInput | undefined): number | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(value)
    ? `${value.replace(' ', 'T')}Z`
    : value;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/** Largest value a UUIDv7 timestamp field holds. */
const MAX_UUID_MS = 2 ** 48 - 1;

/** Format 16 bytes as a lowercase canonical UUID string. */
function formatUuid(bytes: Buffer): string {
  const h = bytes.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/**
 * A new uid for a row this build creates: a random UUIDv7.
 *
 * @returns Canonical lowercase UUID string.
 */
export function mintRowUid(): string {
  return uuidv7();
}

/**
 * The deterministic uid of a minted row that has none: a v7 layout whose
 * timestamp is the row's birth (0 when unknown) and whose other 74 bits come
 * from SHA-256 over the row's identity.
 *
 * @param scope - Store scope.
 * @param table - Physical table name.
 * @param key - Local key values.
 * @param birth - Stored birth value (any format, or null).
 * @param ownerUids - Uids of the owning rows.
 * @param content - Content values of an append-only row.
 * @returns Canonical lowercase UUID string.
 */
export function mintedRowUid(
  scope: TableScope,
  table: string,
  key: readonly UidInput[],
  birth: UidInput,
  ownerUids: readonly UidInput[] = [],
  content: readonly UidInput[] = [],
): string {
  const birthMs = parseStoreTimestamp(birth);
  const canonicalBirth: UidInput = birthMs ?? birth;
  const h = createHash('sha256')
    .update(
      encodeUidInputs([
        ROW_UID_DOMAIN,
        'minted',
        scope,
        table,
        ...key,
        canonicalBirth,
        ...ownerUids,
        ...content,
      ]),
    )
    .digest();
  const ms = birthMs !== null && birthMs >= 0 && birthMs <= MAX_UUID_MS ? birthMs : 0;
  const b = Buffer.alloc(16);
  b.writeUIntBE(ms, 0, 6);
  b[6] = 0x70 | ((h[0] ?? 0) & 0x0f);
  b[7] = h[1] ?? 0;
  b[8] = 0x80 | ((h[2] ?? 0) & 0x3f);
  h.copy(b, 9, 3, 10);
  return formatUuid(b);
}

/**
 * The uid of a natural row: a UUIDv8 over (scope, table, key), with every
 * reference in the key already replaced by the referenced row's uid.
 *
 * @param scope - Store scope.
 * @param table - Physical table name.
 * @param parts - Key values, references as uids.
 * @returns Canonical lowercase UUID string.
 */
export function naturalRowUid(
  scope: TableScope,
  table: string,
  parts: readonly UidInput[],
): string {
  const h = createHash('sha256')
    .update(encodeUidInputs([ROW_UID_DOMAIN, 'natural', scope, table, ...parts]))
    .digest();
  const b = Buffer.from(h.subarray(0, 16));
  b[6] = 0x80 | ((b[6] ?? 0) & 0x0f);
  b[8] = 0x80 | ((b[8] ?? 0) & 0x3f);
  return formatUuid(b);
}

/** Quote an identifier for SQL. */
function q(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** One argument of the uid function: its SQL expression and whether NULL means "not yet". */
interface UidArg {
  readonly sql: string;
  readonly required: boolean;
}

/** Layout of one table's uid-function arguments (after the table name). */
interface UidLayout {
  readonly spec: RowIdentitySpec;
  readonly args: readonly UidArg[];
}

/** The local key column of a referenced table (its declared single-column key). */
function targetKey(scope: TableScope, table: string): string {
  const target = rowIdentitySpec(scope, table);
  if (!target || target.key.length !== 1) {
    throw new Error(`row identity: ${table} is not a declared single-key table`);
  }
  return target.key[0] as string;
}

/** SQL for the uid of the row `ref` points at, read from `row`. */
function refUidSql(scope: TableScope, ref: RowIdentityRef, row: string): string {
  return (
    `(SELECT _r.${q(UID_COLUMN)} FROM main.${q(ref.table)} AS _r ` +
    `WHERE _r.${q(targetKey(scope, ref.table))} = ${row}.${q(ref.column)})`
  );
}

/**
 * The uid-function arguments of one table, as SQL over `row` (`NEW` inside a
 * trigger, the table name inside an UPDATE).
 */
function uidLayout(scope: TableScope, spec: RowIdentitySpec, row: string): UidLayout {
  const col = (name: string): UidArg => ({ sql: `${row}.${q(name)}`, required: false });
  if (spec.kind === 'minted') {
    return {
      spec,
      args: [
        ...spec.key.map(col),
        spec.birth ? col(spec.birth) : { sql: 'NULL', required: false },
        ...(spec.owners ?? []).map((ref) => ({ sql: refUidSql(scope, ref, row), required: true })),
        ...(spec.content ?? []).map(col),
      ],
    };
  }
  return {
    spec,
    args: spec.key.map((column) => {
      const ref = spec.keyRefs?.find((r) => r.column === column);
      return ref ? { sql: refUidSql(scope, ref, row), required: true } : col(column);
    }),
  };
}

/** SQL call of the uid function for one table. */
function uidCallSql(scope: TableScope, spec: RowIdentitySpec, row: string): string {
  const args = uidLayout(scope, spec, row).args.map((a) => a.sql);
  return `${ROW_UID_SQL_FUNCTION}(${[`'${spec.table}'`, ...args].join(', ')})`;
}

/**
 * Compute a deterministic uid from the arguments the SQL function receives.
 * Returns `null` while a referenced row has no uid yet.
 */
function uidFromArgs(scope: TableScope, table: string, args: readonly UidInput[]): string | null {
  const spec = rowIdentitySpec(scope, table);
  if (!spec) throw new Error(`row identity: ${table} is not declared in scope ${scope}`);
  const layout = uidLayout(scope, spec, 'x');
  if (args.length !== layout.args.length) {
    throw new Error(`row identity: ${table} expects ${layout.args.length} arguments`);
  }
  if (layout.args.some((a, i) => a.required && args[i] === null)) return null;
  if (spec.kind === 'natural') return naturalRowUid(scope, table, args);
  const k = spec.key.length;
  const owners = spec.owners?.length ?? 0;
  return mintedRowUid(
    scope,
    table,
    args.slice(0, k),
    args[k] ?? null,
    args.slice(k + 1, k + 1 + owners),
    args.slice(k + 1 + owners),
  );
}

/**
 * Register the deterministic uid function on a connection.
 *
 * @param db - Connection on a `cleo.db`.
 * @param scope - The store's scope.
 */
export function registerRowUidFunction(db: DatabaseSync, scope: TableScope): void {
  db.function(ROW_UID_SQL_FUNCTION, { varargs: true, deterministic: true }, (table, ...args) => {
    if (typeof table !== 'string') throw new Error('row identity: table name must be text');
    return uidFromArgs(scope, table, args as UidInput[]);
  });
}

/** Whether a table exists in `main`. */
function hasTable(db: DatabaseSync, table: string): boolean {
  return (
    db.prepare("SELECT 1 FROM main.sqlite_master WHERE type = 'table' AND name = ?").get(table) !==
    undefined
  );
}

/** Column names of a `main` table. */
function columnsOf(db: DatabaseSync, table: string): Set<string> {
  const rows = db.prepare('SELECT name FROM pragma_table_info(?)').all(table) as { name: string }[];
  return new Set(rows.map((r) => r.name));
}

/** Declared tables present in this store, minted before natural, owners before children. */
function fillOrder(db: DatabaseSync, scope: TableScope): RowIdentitySpec[] {
  const present = ROW_IDENTITY[scope].filter((spec) => hasTable(db, spec.table));
  const done = new Set<string>();
  const ordered: RowIdentitySpec[] = [];
  const deps = (spec: RowIdentitySpec): string[] =>
    [...(spec.owners ?? []), ...(spec.keyRefs ?? [])]
      .map((ref) => ref.table)
      .filter((t) => t !== spec.table);
  for (const kind of ['minted', 'natural'] as const) {
    let pending = present.filter((spec) => spec.kind === kind);
    while (pending.length > 0) {
      const ready = pending.filter((spec) =>
        deps(spec).every((t) => done.has(t) || !present.some((p) => p.table === t)),
      );
      if (ready.length === 0) {
        throw new Error(
          `row identity: cyclic owners among ${pending.map((s) => s.table).join(', ')}`,
        );
      }
      for (const spec of ready) {
        ordered.push(spec);
        done.add(spec.table);
      }
      pending = pending.filter((spec) => !ready.includes(spec));
    }
  }
  return ordered;
}

/** Whether the uid column is the table's primary key (no separate index needed). */
function uidIsPrimaryKey(db: DatabaseSync, table: string): boolean {
  const rows = db.prepare('SELECT name, pk FROM pragma_table_info(?)').all(table) as {
    name: string;
    pk: number;
  }[];
  return rows.some((r) => r.name === UID_COLUMN && r.pk > 0);
}

/**
 * Re-assert the identity columns and indexes of every declared table present
 * in the store. Idempotent; the migration normally created them already.
 *
 * @param db - Connection on a `cleo.db`.
 * @param scope - The store's scope.
 * @returns Statements that had to be run (empty on a healthy store).
 */
export function ensureRowIdentitySchema(db: DatabaseSync, scope: TableScope): string[] {
  const healed: string[] = [];
  for (const spec of ROW_IDENTITY[scope]) {
    if (!hasTable(db, spec.table)) continue;
    const cols = columnsOf(db, spec.table);
    for (const column of rowIdentityColumns(scope, spec.table)) {
      if (cols.has(column)) continue;
      const stmt = `ALTER TABLE main.${q(spec.table)} ADD COLUMN ${q(column)} TEXT`;
      db.exec(stmt);
      healed.push(stmt);
    }
    const indexes: string[] = [];
    if (!uidIsPrimaryKey(db, spec.table)) {
      indexes.push(
        `CREATE UNIQUE INDEX IF NOT EXISTS main.${q(`uq_${spec.table}_uid`)} ON ${q(spec.table)} (${q(UID_COLUMN)})`,
      );
    }
    for (const ref of spec.storedRefUids ?? []) {
      indexes.push(
        `CREATE INDEX IF NOT EXISTS main.${q(`idx_${spec.table}_${ref.column}`)} ON ${q(spec.table)} (${q(ref.column)})`,
      );
    }
    for (const stmt of indexes) {
      const name = /INDEX IF NOT EXISTS main\."([^"]+)"/.exec(stmt)?.[1];
      const exists =
        db
          .prepare("SELECT 1 FROM main.sqlite_master WHERE type = 'index' AND name = ?")
          .get(name ?? '') !== undefined;
      if (exists) continue;
      db.exec(stmt);
      healed.push(stmt);
    }
  }
  return healed;
}

/** What one fill pass did. */
export interface RowUidFillReport {
  /** Uids written per table. */
  readonly filled: Readonly<Record<string, number>>;
  /** Stored reference uids written, per `table.column`. */
  readonly refsFilled: Readonly<Record<string, number>>;
  /** Rows left without a uid, per table (a referenced row without a uid, or a uniqueness clash). */
  readonly unfilled: Readonly<Record<string, number>>;
  /** Schema statements the pass had to re-run. */
  readonly healed: readonly string[];
}

/** Count of rows with a NULL value in `column`. */
function nullCount(db: DatabaseSync, table: string, column: string): number {
  const row = db
    .prepare(`SELECT count(*) AS n FROM main.${q(table)} WHERE ${q(column)} IS NULL`)
    .get() as { n: number };
  return row.n;
}

/** Whether an error is a SQLite UNIQUE constraint failure. */
function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed/i.test(error.message);
}

/**
 * Fill the NULL uids of one table. A bulk UPDATE normally does it; if a
 * computed uid clashes with an existing one, the rows are filled one by one
 * and a clashing row keeps its NULL (reported, never fatal).
 */
function fillTable(db: DatabaseSync, scope: TableScope, spec: RowIdentitySpec): number {
  const before = nullCount(db, spec.table, UID_COLUMN);
  if (before === 0) return 0;
  const call = uidCallSql(scope, spec, `main.${q(spec.table)}`);
  const bulk = `UPDATE main.${q(spec.table)} SET ${q(UID_COLUMN)} = ${call} WHERE ${q(UID_COLUMN)} IS NULL`;
  db.exec('SAVEPOINT row_uid_fill_table');
  try {
    db.exec(bulk);
    db.exec('RELEASE SAVEPOINT row_uid_fill_table');
  } catch (error) {
    db.exec('ROLLBACK TO SAVEPOINT row_uid_fill_table');
    db.exec('RELEASE SAVEPOINT row_uid_fill_table');
    if (!isUniqueViolation(error)) throw error;
    const rowids = db
      .prepare(`SELECT rowid AS r FROM main.${q(spec.table)} WHERE ${q(UID_COLUMN)} IS NULL`)
      .all() as { r: number }[];
    const one = db.prepare(`${bulk} AND rowid = ?`);
    for (const { r } of rowids) {
      try {
        one.run(r);
      } catch (rowError) {
        if (!isUniqueViolation(rowError)) throw rowError;
      }
    }
  }
  return before - nullCount(db, spec.table, UID_COLUMN);
}

/** Fill the stored reference uids (`ac_uid`) that resolve. */
function fillStoredRefs(
  db: DatabaseSync,
  scope: TableScope,
  spec: RowIdentitySpec,
  out: Record<string, number>,
): void {
  for (const ref of spec.storedRefUids ?? []) {
    const before = nullCount(db, spec.table, ref.column);
    if (before === 0) continue;
    const lookup = refUidSql(
      scope,
      { column: ref.from, table: ref.table },
      `main.${q(spec.table)}`,
    );
    db.exec(
      `UPDATE main.${q(spec.table)} SET ${q(ref.column)} = ${lookup} WHERE ${q(ref.column)} IS NULL`,
    );
    const written = before - nullCount(db, spec.table, ref.column);
    if (written > 0) out[`${spec.table}.${ref.column}`] = written;
  }
}

/**
 * Fill every NULL uid and stored reference uid of the declared tables, in one
 * savepoint. Requires {@link registerRowUidFunction} on the connection.
 * Idempotent: a filled store writes nothing.
 *
 * @param db - Connection on a `cleo.db`.
 * @param scope - The store's scope.
 * @returns What was written and what could not be.
 */
export function fillRowUids(db: DatabaseSync, scope: TableScope): Omit<RowUidFillReport, 'healed'> {
  const filled: Record<string, number> = {};
  const refsFilled: Record<string, number> = {};
  const unfilled: Record<string, number> = {};
  const order = fillOrder(db, scope);
  db.exec('SAVEPOINT row_uid_fill');
  try {
    for (const spec of order) {
      const n = fillTable(db, scope, spec);
      if (n > 0) filled[spec.table] = n;
    }
    for (const spec of order) fillStoredRefs(db, scope, spec, refsFilled);
    for (const spec of order) {
      const left = nullCount(db, spec.table, UID_COLUMN);
      if (left > 0) unfilled[spec.table] = left;
    }
    db.exec('RELEASE SAVEPOINT row_uid_fill');
  } catch (error) {
    db.exec('ROLLBACK TO SAVEPOINT row_uid_fill');
    db.exec('RELEASE SAVEPOINT row_uid_fill');
    throw error;
  }
  return { filled, refsFilled, unfilled };
}

/**
 * Install the per-connection TEMP triggers that fill a uid (and a stored
 * reference uid) on insert. Requires {@link registerRowUidFunction}.
 *
 * @param db - Connection on a `cleo.db`.
 * @param scope - The store's scope.
 */
export function installRowUidTriggers(db: DatabaseSync, scope: TableScope): void {
  for (const spec of ROW_IDENTITY[scope]) {
    if (!hasTable(db, spec.table) || uidIsPrimaryKey(db, spec.table)) continue;
    const table = q(spec.table);
    db.exec(
      `CREATE TEMP TRIGGER IF NOT EXISTS ${q(`trg_row_uid_${spec.table}`)} ` +
        `AFTER INSERT ON main.${table} WHEN NEW.${q(UID_COLUMN)} IS NULL BEGIN ` +
        `UPDATE main.${table} SET ${q(UID_COLUMN)} = ${uidCallSql(scope, spec, 'NEW')} ` +
        `WHERE rowid = NEW.rowid; END`,
    );
    for (const ref of spec.storedRefUids ?? []) {
      const lookup = refUidSql(scope, { column: ref.from, table: ref.table }, 'NEW');
      db.exec(
        `CREATE TEMP TRIGGER IF NOT EXISTS ${q(`trg_row_ref_uid_${spec.table}_${ref.column}`)} ` +
          `AFTER INSERT ON main.${table} WHEN NEW.${q(ref.column)} IS NULL BEGIN ` +
          `UPDATE main.${table} SET ${q(ref.column)} = ${lookup} WHERE rowid = NEW.rowid; END`,
      );
    }
  }
}

/**
 * Bring a freshly opened `cleo.db` connection's row identity up to date:
 * schema, fill, per-connection triggers. Never throws: a failure is logged and
 * the store opens with the uids it has.
 *
 * @param db - Connection on a `cleo.db`, after its migrations ran.
 * @param scope - The store's scope.
 * @param options - `triggers: false` skips the per-connection triggers (a
 *   dedicated migration connection: exodus refuses copies whose triggers call
 *   an opaque function, so its rows are filled at the next open instead).
 * @returns The fill report, or `null` when skipped or failed.
 */
export function prepareRowIdentity(
  db: DatabaseSync,
  scope: TableScope,
  options: { readonly triggers?: boolean } = {},
): RowUidFillReport | null {
  if (ROW_IDENTITY[scope].length === 0) return null;
  if (process.env[ROW_UID_FILL_KILL_SWITCH] === '1') return null;
  const log = getLogger('row-identity');
  try {
    const healed = ensureRowIdentitySchema(db, scope);
    registerRowUidFunction(db, scope);
    const report = { ...fillRowUids(db, scope), healed };
    if (options.triggers !== false) installRowUidTriggers(db, scope);
    if (Object.keys(report.unfilled).length > 0) {
      log.warn(
        { scope, unfilled: report.unfilled },
        'rows left without a uid (filled on a later open)',
      );
    }
    if (healed.length > 0 || Object.keys(report.filled).length > 0) {
      log.debug({ scope, ...report }, 'row uids filled');
    }
    return report;
  } catch (error) {
    log.error({ scope, error }, 'row uid fill failed; rows keep a NULL uid until a later open');
    return null;
  }
}
