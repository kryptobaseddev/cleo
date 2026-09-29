/**
 * Row uids (T12341): the merge key every syncing row carries.
 *
 * A table whose Gate A class syncs gets a `uid TEXT` column. The local primary
 * key (`T####`, an AC id, a session id, a composite edge key) stays the local
 * key, and local foreign keys keep pointing at it; the uid is what a merge
 * compares, as (project, uid). Spec: `cleo docs fetch t12341-uid-scheme`.
 *
 * ## How a uid is made
 *
 * - **Minted, new row** (this build writes it): a random UUIDv7
 *   ({@link mintRowUid}), set by the Drizzle `$defaultFn` or by the writer.
 * - **Minted, no uid yet** (an existing row, or one an older build or a raw-SQL
 *   writer inserted): a DETERMINISTIC v7-layout uid. Its timestamp is the
 *   row's birth; its other 74 bits are SHA-256 over (scope, table, key, birth,
 *   the uids of its owning rows, and, for append-only tables, a frozen content
 *   list) ({@link mintedRowUid}). A `randomOnly` table (portable-secret) gets a
 *   random uid instead.
 * - **Natural** (edges, labels): a UUIDv8 over the key with every reference
 *   replaced by the referenced row's uid ({@link naturalRowUid}); a pure
 *   function of the row. Symmetric relation types hash their endpoints in
 *   sorted order; the reversed twin of a symmetric edge stored both ways takes
 *   the `natural-mirror` recipe. A reference whose row does not exist hashes
 *   `dangling:<raw key>` and is reported.
 *
 * Deterministic identity can coincide for different rows (the same `T100`
 * with the same `created_at` in two stores). Every minted row therefore also
 * carries a birth fingerprint ({@link birthFingerprint}, `birth_fp`), hashed
 * once from creation facts no edit changes. Same uid and same `birth_fp` is
 * the same row; same uid and a different `birth_fp` is a COLLISION
 * ({@link classifyUidMatch}), which the merge never merges.
 *
 * ## When uids are filled
 *
 * {@link prepareRowIdentity} runs on every open of a `cleo.db`, inside the
 * cold-open lease right after the migrations:
 *
 * 1. re-asserts the identity columns and indexes (idempotent; heals a
 *    migration the journal probe stamped without running its index DDL);
 * 2. registers the deterministic SQL functions on the connection, re-links
 *    acceptance criteria an older build recreated without their uid (the AC
 *    uid graveyard, spec §6.5), then fills every NULL uid (minted tables,
 *    owners first; then natural tables), the stored reference facts (`ac_uid`,
 *    `ac_text_hash`) and the birth fingerprints, in one savepoint;
 * 3. installs one TEMP `AFTER INSERT` trigger per declared table on this
 *    connection, so a row inserted here without them gets the same values the
 *    open pass would give it, in the same statement. A trigger never fails the
 *    insert: a value that would clash is left NULL and reported at the next
 *    open.
 *
 * A row an older build inserts keeps NULL values until the next open by this
 * build: there is no persistent trigger that computes them (see the
 * migration's header). `CLEO_DISABLE_ROW_UID_FILL=1` skips steps 2 and 3.
 *
 * A failure never fails the open: it is logged, and the rows keep NULL values
 * until a later open succeeds. A uid's timestamp is ordering sugar only: HLC
 * (T12342) never reads time from a uid.
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
import { acTextHash } from '../tasks/ac-table.js';
import {
  BIRTH_FP_COLUMN,
  ROW_IDENTITY,
  rowIdentityColumns,
  rowIdentitySpec,
  UID_COLUMN,
} from './row-identity-registry.js';

export { BIRTH_FP_COLUMN, ROW_IDENTITY, rowIdentityColumns, rowIdentitySpec, UID_COLUMN };

/** Domain separator hashed into every deterministic uid. Changing it re-keys every row. */
export const ROW_UID_DOMAIN = 'cleo/row-uid/v1';

/** Domain separator hashed into every birth fingerprint. */
export const ROW_BIRTH_DOMAIN = 'cleo/row-birth/v1';

/** Per-connection SQL function computing a deterministic uid. */
export const ROW_UID_SQL_FUNCTION = 'cleo_row_uid';

/** Per-connection SQL function computing a birth fingerprint. */
export const ROW_BIRTH_FP_SQL_FUNCTION = 'cleo_row_birth_fp';

/** Per-connection SQL function returning a fresh random UUIDv7 (`randomOnly` tables). */
export const ROW_RANDOM_UID_SQL_FUNCTION = 'cleo_row_random_uid';

/** Per-connection SQL function hashing AC text like `acTextHash`. */
export const AC_TEXT_HASH_SQL_FUNCTION = 'cleo_ac_text_hash';

/** Environment switch that skips the fill and the per-connection triggers. */
export const ROW_UID_FILL_KILL_SWITCH = 'CLEO_DISABLE_ROW_UID_FILL';

/** Physical name of the AC uid graveyard (spec §6.5). */
export const AC_UID_GRAVEYARD = 'tasks_ac_uid_graveyard';

/** A SQL value as node:sqlite passes it to a function. */
export type UidInput = string | number | bigint | Uint8Array | null;

/**
 * Unambiguous encoding of uid inputs: per value a type tag (0 null, 1 text,
 * 2 integer, 3 real, 4 blob), a big-endian u32 byte length, and the bytes. An
 * integer-valued number is tag 2 (SQLite `3` and `3.0` encode alike); any other
 * number is tag 3 with its ECMAScript shortest round-trip text. Frozen for
 * recipe v1.
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
      bytes = Buffer.from(value.toString(), 'utf8');
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
 * @param birthMs - The row's own birth, for a row imported with one (an
 *   importer must never stamp import time into an old row's uid).
 * @returns Canonical lowercase UUID string.
 */
export function mintRowUid(birthMs?: number): string {
  return birthMs === undefined ? uuidv7() : uuidv7(birthMs);
}

/**
 * The deterministic uid of a minted row that has none: a v7 layout whose
 * timestamp is the row's birth and whose other 74 bits come from SHA-256 over
 * the row's identity. An unknown birth gives timestamp 0; the row's birth
 * fingerprint flags it (`birth:unknown`), and {@link rowIdentityFindings}
 * lists it.
 *
 * @param scope - Store scope.
 * @param table - Physical table name.
 * @param key - Local key values.
 * @param birth - Stored birth value (any format, or null).
 * @param ownerUids - Uids of the owning rows.
 * @param content - Frozen content values of an append-only row.
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

/** Recipe of a natural uid: the edge itself, or the reversed twin of a symmetric edge. */
export type NaturalRecipe = 'natural' | 'natural-mirror';

/**
 * The uid of a natural row: a UUIDv8 over (scope, table, key), with every
 * reference in the key already replaced by the referenced row's uid.
 *
 * @param scope - Store scope.
 * @param table - Physical table name.
 * @param parts - Key values, references as uids.
 * @param recipe - `natural-mirror` for the reversed twin of a symmetric edge.
 * @returns Canonical lowercase UUID string.
 */
export function naturalRowUid(
  scope: TableScope,
  table: string,
  parts: readonly UidInput[],
  recipe: NaturalRecipe = 'natural',
): string {
  const h = createHash('sha256')
    .update(encodeUidInputs([ROW_UID_DOMAIN, recipe, scope, table, ...parts]))
    .digest();
  const b = Buffer.from(h.subarray(0, 16));
  b[6] = 0x80 | ((b[6] ?? 0) & 0x0f);
  b[8] = 0x80 | ((b[8] ?? 0) & 0x3f);
  return formatUuid(b);
}

/**
 * The birth-token part of a birth fingerprint: the stored birth at full
 * precision, or a flag when it is missing or unparseable.
 */
function birthToken(birth: UidInput): string {
  if (birth === null) return 'birth:unknown';
  if (typeof birth === 'string' && parseStoreTimestamp(birth) !== null) return birth;
  return `birth:unparseable:${String(birth)}`;
}

/**
 * A minted row's birth fingerprint: 128 bits of SHA-256 over the stored birth
 * (full precision, not canonicalised) and the table's frozen birth facts.
 * Computed once, with the uid; never updated.
 *
 * @param table - Physical table name.
 * @param birth - Stored birth value.
 * @param facts - Birth fact values, in declared order.
 * @returns 32 lowercase hex characters.
 */
export function birthFingerprint(
  table: string,
  birth: UidInput,
  facts: readonly UidInput[],
): string {
  return createHash('sha256')
    .update(encodeUidInputs([ROW_BIRTH_DOMAIN, table, birthToken(birth), ...facts]))
    .digest('hex')
    .slice(0, 32);
}

/** How two rows that carry the same uid relate. */
export type UidMatch = 'same-row' | 'collision' | 'unknown';

/**
 * Classify two rows of one table that carry the same uid (merge contract,
 * spec §6.4): equal birth fingerprints are one row; different ones are a
 * COLLISION that must never be merged; a missing fingerprint must be filled
 * before the row is emitted.
 *
 * @param a - Birth fingerprint of one row.
 * @param b - Birth fingerprint of the other.
 * @returns The relation.
 */
export function classifyUidMatch(a: string | null, b: string | null): UidMatch {
  if (a === null || b === null) return 'unknown';
  return a === b ? 'same-row' : 'collision';
}

/** Quote an identifier for SQL. */
function q(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
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

/** SQL for "the row `ref` points at exists". */
function refExistsSql(scope: TableScope, ref: RowIdentityRef, row: string): string {
  return (
    `EXISTS(SELECT 1 FROM main.${q(ref.table)} AS _e ` +
    `WHERE _e.${q(targetKey(scope, ref.table))} = ${row}.${q(ref.column)})`
  );
}

/** A reference passed to the uid function as (uid, raw key, target exists). */
function refArgs(scope: TableScope, ref: RowIdentityRef, row: string): string[] {
  return [refUidSql(scope, ref, row), `${row}.${q(ref.column)}`, refExistsSql(scope, ref, row)];
}

/**
 * Resolve one reference argument triple: the target's uid; `dangling:<key>`
 * when the target does not exist; `undefined` when it exists but has no uid
 * yet (fill later).
 */
function resolveRef(uid: UidInput, raw: UidInput, exists: UidInput): UidInput | undefined {
  if (uid !== null) return uid;
  if (raw === null) return null;
  if (Number(exists) === 1) return undefined;
  return `dangling:${String(raw)}`;
}

/** Whether a table's symmetric-type twin check applies (two key refs). */
function symmetricTwinSql(spec: RowIdentitySpec, row: string): string {
  const [a, b] = spec.keyRefs ?? [];
  const sym = spec.symmetric;
  if (!a || !b || !sym) throw new Error(`row identity: ${spec.table} symmetric needs two key refs`);
  return (
    `EXISTS(SELECT 1 FROM main.${q(spec.table)} AS _t WHERE _t.${q(a.column)} = ${row}.${q(b.column)} ` +
    `AND _t.${q(b.column)} = ${row}.${q(a.column)} AND _t.${q(sym.column)} = ${row}.${q(sym.column)})`
  );
}

/**
 * The uid-function arguments of one table, as SQL over `row` (`NEW` inside a
 * trigger, the qualified table name inside an UPDATE).
 */
function uidArgSql(scope: TableScope, spec: RowIdentitySpec, row: string): string[] {
  const col = (name: string) => `${row}.${q(name)}`;
  if (spec.kind === 'minted') {
    return [
      ...spec.key.map(col),
      spec.birth ? col(spec.birth) : 'NULL',
      ...(spec.owners ?? []).flatMap((ref) => refArgs(scope, ref, row)),
      ...(spec.content ?? []).map(col),
    ];
  }
  return [
    ...spec.key.flatMap((column) => {
      const ref = spec.keyRefs?.find((r) => r.column === column);
      return ref ? refArgs(scope, ref, row) : [col(column)];
    }),
    ...(spec.symmetric ? [symmetricTwinSql(spec, row)] : []),
  ];
}

/** SQL call of the uid function for one table; `variant` 1 forces the mirror recipe. */
function uidCallSql(scope: TableScope, spec: RowIdentitySpec, row: string, variant = 0): string {
  if (spec.randomOnly) return `${ROW_RANDOM_UID_SQL_FUNCTION}()`;
  const args = uidArgSql(scope, spec, row);
  return `${ROW_UID_SQL_FUNCTION}(${[`'${spec.table}'`, String(variant), ...args].join(', ')})`;
}

/**
 * Compute a deterministic uid from the arguments the SQL function receives,
 * in {@link uidArgSql} order. Returns `null` while a referenced row exists but
 * has no uid yet.
 */
function uidFromArgs(
  scope: TableScope,
  table: string,
  variant: number,
  args: readonly UidInput[],
): string | null {
  const spec = rowIdentitySpec(scope, table);
  if (!spec) throw new Error(`row identity: ${table} is not declared in scope ${scope}`);
  let i = 0;
  const take = (): UidInput => {
    if (i >= args.length) throw new Error(`row identity: ${table} got too few arguments`);
    return args[i++] ?? null;
  };
  const takeRef = (): UidInput | undefined => resolveRef(take(), take(), take());
  if (spec.kind === 'minted') {
    const key = spec.key.map(() => take());
    const birth = take();
    const owners: UidInput[] = [];
    for (const _ of spec.owners ?? []) {
      const owner = takeRef();
      if (owner === undefined) return null;
      owners.push(owner);
    }
    const content = (spec.content ?? []).map(() => take());
    return mintedRowUid(scope, table, key, birth, owners, content);
  }
  const parts: UidInput[] = [];
  for (const column of spec.key) {
    if (spec.keyRefs?.some((r) => r.column === column)) {
      const value = takeRef();
      if (value === undefined) return null;
      parts.push(value);
    } else parts.push(take());
  }
  if (!spec.symmetric) return naturalRowUid(scope, table, parts);
  const twinExists = Number(take()) === 1;
  const typeIndex = spec.key.indexOf(spec.symmetric.column);
  const type = parts[typeIndex];
  if (typeof type !== 'string' || !spec.symmetric.values.includes(type)) {
    return naturalRowUid(scope, table, parts);
  }
  const [a, b] = [parts[0], parts[1]].map((p) => String(p));
  const sorted = a <= b ? [a, b] : [b, a];
  const rest = parts.filter((_, k) => k > 1);
  const mirror = variant === 1 || (a > b && twinExists);
  return naturalRowUid(scope, table, [...sorted, ...rest], mirror ? 'natural-mirror' : 'natural');
}

/** SQL for one birth fact of a minted table. */
function birthFactSql(
  db: DatabaseSync,
  scope: TableScope,
  spec: RowIdentitySpec,
  fact: string,
  row: string,
): string {
  if (fact === '@auditTitle') {
    // `+` keeps the planner on the task_id index: on the action or timestamp
    // index this lookup scans the audit log once per task (11 s on cleocode).
    if (!hasTable(db, 'tasks_audit_log')) return `${row}.${q('title')}`;
    return (
      `COALESCE((SELECT json_extract(_a.details_json, '$.title') FROM main.tasks_audit_log AS _a ` +
      `WHERE _a.task_id = ${row}.${q('id')} AND +_a.action = 'task_created' AND json_valid(_a.details_json) ` +
      `ORDER BY +_a.timestamp, +_a.id LIMIT 1), ${row}.${q('title')})`
    );
  }
  if (fact.startsWith('@owner:')) {
    const column = fact.slice('@owner:'.length);
    const ref = spec.owners?.find((r) => r.column === column);
    if (!ref) throw new Error(`row identity: ${spec.table} birth fact ${fact} names no owner`);
    return refUidSql(scope, ref, row);
  }
  return `${row}.${q(fact)}`;
}

/** SQL call of the birth-fingerprint function for one minted table. */
function birthFpCallSql(
  db: DatabaseSync,
  scope: TableScope,
  spec: RowIdentitySpec,
  row: string,
): string {
  const birth = spec.birth ? `${row}.${q(spec.birth)}` : 'NULL';
  const facts = (spec.birthFacts ?? []).map((f) => birthFactSql(db, scope, spec, f, row));
  return `${ROW_BIRTH_FP_SQL_FUNCTION}(${[`'${spec.table}'`, birth, ...facts].join(', ')})`;
}

/** SQL for a stored reference fact (`ac_uid`, `ac_text_hash`) read from `row`. */
function storedRefSql(
  scope: TableScope,
  ref: NonNullable<RowIdentitySpec['storedRefUids']>[number],
  row: string,
): string {
  if (ref.source === 'text_hash') {
    return (
      `${AC_TEXT_HASH_SQL_FUNCTION}((SELECT _r.${q('text')} FROM main.${q(ref.table)} AS _r ` +
      `WHERE _r.${q(targetKey(scope, ref.table))} = ${row}.${q(ref.from)}))`
    );
  }
  return refUidSql(scope, { column: ref.from, table: ref.table }, row);
}

/**
 * Register the identity SQL functions on a connection: the deterministic uid
 * and birth fingerprint, the AC text hash, and a random v7 for `randomOnly`
 * tables.
 *
 * @param db - Connection on a `cleo.db`.
 * @param scope - The store's scope.
 */
export function registerRowUidFunction(db: DatabaseSync, scope: TableScope): void {
  db.function(
    ROW_UID_SQL_FUNCTION,
    { varargs: true, deterministic: true },
    (table, variant, ...args) => {
      if (typeof table !== 'string') throw new Error('row identity: table name must be text');
      return uidFromArgs(scope, table, Number(variant), args as UidInput[]);
    },
  );
  db.function(
    ROW_BIRTH_FP_SQL_FUNCTION,
    { varargs: true, deterministic: true },
    (table, birth, ...facts) => {
      if (typeof table !== 'string') throw new Error('row identity: table name must be text');
      const spec = rowIdentitySpec(scope, table);
      const ownerFacts = (spec?.birthFacts ?? []).map((f) => f.startsWith('@owner:'));
      if (facts.some((v, k) => ownerFacts[k] && v === null)) return null;
      return birthFingerprint(table, birth as UidInput, facts as UidInput[]);
    },
  );
  db.function(AC_TEXT_HASH_SQL_FUNCTION, { deterministic: true }, (text) =>
    typeof text === 'string' ? acTextHash(text) : null,
  );
  db.function(ROW_RANDOM_UID_SQL_FUNCTION, { deterministic: false }, () => mintRowUid());
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

/** Findings the open pass reports (and `cleo doctor` can list). */
export interface RowIdentityFindings {
  /** Minted rows whose birth is missing or unparseable (uid timestamp 0), per table. */
  readonly unknownBirth: Readonly<Record<string, number>>;
  /** Natural rows with a key reference to a row that does not exist, per table. */
  readonly danglingRefs: Readonly<Record<string, number>>;
  /** Reversed twins of symmetric edges stored both ways (duplicates to drop), per table. */
  readonly mirrorEdges: Readonly<Record<string, number>>;
}

/** What one fill pass did. */
export interface RowUidFillReport {
  /** Uids written per table. */
  readonly filled: Readonly<Record<string, number>>;
  /** Stored reference facts written, per `table.column`. */
  readonly refsFilled: Readonly<Record<string, number>>;
  /** Birth fingerprints written per table. */
  readonly fingerprinted: Readonly<Record<string, number>>;
  /** Acceptance criteria re-linked to their uid from the graveyard. */
  readonly relinked: number;
  /** Rows left without a uid or fingerprint, per table (a uniqueness clash). */
  readonly unfilled: Readonly<Record<string, number>>;
  /** Rows the recipes flag. */
  readonly findings: RowIdentityFindings;
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
 * (a symmetric edge then tries its mirror recipe) and a row that still clashes
 * keeps its NULL (reported, never fatal).
 */
function fillTable(db: DatabaseSync, scope: TableScope, spec: RowIdentitySpec): number {
  const before = nullCount(db, spec.table, UID_COLUMN);
  if (before === 0) return 0;
  const table = `main.${q(spec.table)}`;
  const update = (variant: number) =>
    `UPDATE ${table} SET ${q(UID_COLUMN)} = ${uidCallSql(scope, spec, table, variant)} WHERE ${q(UID_COLUMN)} IS NULL`;
  db.exec('SAVEPOINT row_uid_fill_table');
  try {
    db.exec(update(0));
    db.exec('RELEASE SAVEPOINT row_uid_fill_table');
  } catch (error) {
    db.exec('ROLLBACK TO SAVEPOINT row_uid_fill_table');
    db.exec('RELEASE SAVEPOINT row_uid_fill_table');
    if (!isUniqueViolation(error)) throw error;
    const rowids = db
      .prepare(`SELECT rowid AS r FROM ${table} WHERE ${q(UID_COLUMN)} IS NULL ORDER BY rowid`)
      .all() as { r: number }[];
    const variants = spec.symmetric ? [0, 1] : [0];
    const statements = variants.map((v) => db.prepare(`${update(v)} AND rowid = ?`));
    for (const { r } of rowids) {
      for (const one of statements) {
        try {
          if (Number(one.run(r).changes) > 0) break;
        } catch (rowError) {
          if (!isUniqueViolation(rowError)) throw rowError;
        }
      }
    }
  }
  return before - nullCount(db, spec.table, UID_COLUMN);
}

/**
 * Fill the NULL uids of one declared table (the open pass's recipe). Requires
 * {@link registerRowUidFunction} on the connection. Used after a uid re-key,
 * which clears the uids of the natural rows keyed by the re-keyed row.
 *
 * @param db - Connection on a `cleo.db`.
 * @param scope - The store's scope.
 * @param table - Declared table.
 * @returns Uids written.
 */
export function fillTableUids(db: DatabaseSync, scope: TableScope, table: string): number {
  const spec = rowIdentitySpec(scope, table);
  if (!spec) throw new Error(`row identity: ${table} is not declared in scope ${scope}`);
  return fillTable(db, scope, spec);
}

/** Fill the stored reference facts (`ac_uid`, `ac_text_hash`) that resolve. */
function fillStoredRefs(
  db: DatabaseSync,
  scope: TableScope,
  spec: RowIdentitySpec,
  out: Record<string, number>,
): void {
  const table = `main.${q(spec.table)}`;
  for (const ref of spec.storedRefUids ?? []) {
    const before = nullCount(db, spec.table, ref.column);
    if (before === 0) continue;
    db.exec(
      `UPDATE ${table} SET ${q(ref.column)} = ${storedRefSql(scope, ref, table)} WHERE ${q(ref.column)} IS NULL`,
    );
    const written = before - nullCount(db, spec.table, ref.column);
    if (written > 0) out[`${spec.table}.${ref.column}`] = written;
  }
}

/** Fill the NULL birth fingerprints of one minted table. */
function fillBirthFp(db: DatabaseSync, scope: TableScope, spec: RowIdentitySpec): number {
  if (spec.kind !== 'minted') return 0;
  const before = nullCount(db, spec.table, BIRTH_FP_COLUMN);
  if (before === 0) return 0;
  const table = `main.${q(spec.table)}`;
  db.exec(
    `UPDATE ${table} SET ${q(BIRTH_FP_COLUMN)} = ${birthFpCallSql(db, scope, spec, table)} WHERE ${q(BIRTH_FP_COLUMN)} IS NULL`,
  );
  return before - nullCount(db, spec.table, BIRTH_FP_COLUMN);
}

/**
 * Re-link acceptance criteria an older build deleted and recreated without
 * their uid (spec §6.5). For each task with criteria lacking a uid, the uids
 * its deleted criteria carried (recorded by the graveyard trigger) are handed
 * back by the carry rule of `planAcUpdate`: same text first, then same
 * ordinal. Returns how many criteria got their uid back. The graveyard is
 * emptied afterwards: an entry whose criterion was not recreated is a real
 * deletion.
 */
function relinkAcUids(db: DatabaseSync): number {
  if (!hasTable(db, AC_UID_GRAVEYARD) || !hasTable(db, 'tasks_task_acceptance_criteria')) return 0;
  let relinked = 0;
  const orphans = db
    .prepare(
      `SELECT id, task_id AS taskId, ordinal, text FROM main.tasks_task_acceptance_criteria
        WHERE uid IS NULL AND task_id IN (SELECT task_id FROM main.${AC_UID_GRAVEYARD})
        ORDER BY task_id, ordinal`,
    )
    .all() as { id: string; taskId: string; ordinal: number; text: string }[];
  const dead = db.prepare(
    `SELECT uid, ordinal, text FROM main.${AC_UID_GRAVEYARD} g
      WHERE task_id = ? AND NOT EXISTS (SELECT 1 FROM main.tasks_task_acceptance_criteria a WHERE a.uid = g.uid)
      ORDER BY seq DESC`,
  );
  const assign = db.prepare(
    'UPDATE main.tasks_task_acceptance_criteria SET uid = ? WHERE id = ? AND uid IS NULL',
  );
  const byTask = new Map<string, typeof orphans>();
  for (const row of orphans) byTask.set(row.taskId, [...(byTask.get(row.taskId) ?? []), row]);
  for (const [taskId, rows] of byTask) {
    const seen = new Set<string>();
    const pool = (dead.all(taskId) as { uid: string; ordinal: number; text: string }[]).filter(
      (d) => !seen.has(d.uid) && seen.add(d.uid),
    );
    const claimed = new Set<string>();
    const pick = (match: (d: (typeof pool)[number]) => boolean) =>
      pool.find((d) => !claimed.has(d.uid) && match(d));
    const pending = rows.filter((row) => {
      const same = pick((d) => d.text === row.text);
      if (!same) return true;
      claimed.add(same.uid);
      relinked += Number(assign.run(same.uid, row.id).changes);
      return false;
    });
    for (const row of pending) {
      const same = pick((d) => d.ordinal === row.ordinal);
      if (!same) continue;
      claimed.add(same.uid);
      relinked += Number(assign.run(same.uid, row.id).changes);
    }
  }
  db.exec(`DELETE FROM main.${AC_UID_GRAVEYARD}`);
  return relinked;
}

/** Count rows per table matching `where`, keeping non-zero counts. */
function countWhere(
  db: DatabaseSync,
  table: string,
  where: string,
  out: Record<string, number>,
): void {
  const n = (
    db.prepare(`SELECT count(*) AS n FROM main.${q(table)} AS x WHERE ${where}`).get() as {
      n: number;
    }
  ).n;
  if (n > 0) out[table] = n;
}

/**
 * Rows the recipes flag: minted rows with an unknown birth (uid timestamp 0),
 * natural rows with a dangling key reference, and reversed twins of symmetric
 * edges stored both ways.
 *
 * @param db - Connection on a `cleo.db`.
 * @param scope - The store's scope.
 * @returns Counts per table (tables without findings are absent).
 */
export function rowIdentityFindings(db: DatabaseSync, scope: TableScope): RowIdentityFindings {
  const unknownBirth: Record<string, number> = {};
  const danglingRefs: Record<string, number> = {};
  const mirrorEdges: Record<string, number> = {};
  for (const spec of ROW_IDENTITY[scope]) {
    if (!hasTable(db, spec.table)) continue;
    if (spec.kind === 'minted' && spec.birth) {
      const b = `x.${q(spec.birth)}`;
      countWhere(
        db,
        spec.table,
        `${b} IS NULL OR (julianday(replace(${b}, 'T', ' ')) IS NULL AND julianday(${b}) IS NULL)`,
        unknownBirth,
      );
    }
    const refs = spec.kind === 'natural' ? (spec.keyRefs ?? []) : (spec.owners ?? []);
    if (refs.length > 0) {
      countWhere(
        db,
        spec.table,
        refs
          .map((ref) => `(x.${q(ref.column)} IS NOT NULL AND NOT ${refExistsSql(scope, ref, 'x')})`)
          .join(' OR '),
        danglingRefs,
      );
    }
    if (spec.symmetric) {
      const [a, b] = spec.keyRefs ?? [];
      if (a && b) {
        const values = spec.symmetric.values.map((v) => `'${v.replaceAll("'", "''")}'`).join(', ');
        countWhere(
          db,
          spec.table,
          `x.${q(spec.symmetric.column)} IN (${values}) AND ${symmetricTwinSql(spec, 'x')} ` +
            `AND ${refUidSql(scope, a, 'x')} > ${refUidSql(scope, b, 'x')}`,
          mirrorEdges,
        );
      }
    }
  }
  return { unknownBirth, danglingRefs, mirrorEdges };
}

/**
 * Fill every NULL uid, stored reference fact and birth fingerprint of the
 * declared tables, in one savepoint, after re-linking graveyard AC uids.
 * Requires {@link registerRowUidFunction} on the connection. Idempotent: a
 * filled store writes nothing.
 *
 * @param db - Connection on a `cleo.db`.
 * @param scope - The store's scope.
 * @returns What was written and what could not be.
 */
export function fillRowUids(
  db: DatabaseSync,
  scope: TableScope,
): Omit<RowUidFillReport, 'healed' | 'findings'> {
  const filled: Record<string, number> = {};
  const refsFilled: Record<string, number> = {};
  const fingerprinted: Record<string, number> = {};
  const unfilled: Record<string, number> = {};
  const order = fillOrder(db, scope);
  db.exec('SAVEPOINT row_uid_fill');
  try {
    const relinked = scope === 'project' ? relinkAcUids(db) : 0;
    for (const spec of order) {
      const n = fillTable(db, scope, spec);
      if (n > 0) filled[spec.table] = n;
    }
    for (const spec of order) fillStoredRefs(db, scope, spec, refsFilled);
    for (const spec of order) {
      const n = fillBirthFp(db, scope, spec);
      if (n > 0) fingerprinted[spec.table] = n;
    }
    for (const spec of order) {
      const left =
        nullCount(db, spec.table, UID_COLUMN) +
        (spec.kind === 'minted' ? nullCount(db, spec.table, BIRTH_FP_COLUMN) : 0);
      if (left > 0) unfilled[spec.table] = left;
    }
    db.exec('RELEASE SAVEPOINT row_uid_fill');
    return { filled, refsFilled, fingerprinted, relinked, unfilled };
  } catch (error) {
    db.exec('ROLLBACK TO SAVEPOINT row_uid_fill');
    db.exec('RELEASE SAVEPOINT row_uid_fill');
    throw error;
  }
}

/**
 * Install the per-connection TEMP triggers that fill a uid, the stored
 * reference facts and the birth fingerprint on insert, in that order. Each
 * step is guarded so the trigger never fails the insert: a uid that would
 * clash is left NULL (a symmetric edge first tries its mirror recipe).
 * Requires {@link registerRowUidFunction}.
 *
 * @param db - Connection on a `cleo.db`.
 * @param scope - The store's scope.
 */
export function installRowUidTriggers(db: DatabaseSync, scope: TableScope): void {
  for (const spec of ROW_IDENTITY[scope]) {
    if (!hasTable(db, spec.table) || uidIsPrimaryKey(db, spec.table)) continue;
    const table = `main.${q(spec.table)}`;
    const uid = q(UID_COLUMN);
    const steps: string[] = [];
    for (const variant of spec.symmetric ? [0, 1] : [0]) {
      const value = uidCallSql(scope, spec, 'NEW', variant);
      steps.push(
        `UPDATE ${table} SET ${uid} = ${value} WHERE rowid = NEW.rowid AND ${uid} IS NULL ` +
          `AND NOT EXISTS (SELECT 1 FROM ${table} AS _u WHERE _u.${uid} = ${value});`,
      );
    }
    for (const ref of spec.storedRefUids ?? []) {
      steps.push(
        `UPDATE ${table} SET ${q(ref.column)} = ${storedRefSql(scope, ref, 'NEW')} ` +
          `WHERE rowid = NEW.rowid AND ${q(ref.column)} IS NULL;`,
      );
    }
    if (spec.kind === 'minted') {
      // Reads the row as stored, so the facts filled above (ac_text_hash) count.
      steps.push(
        `UPDATE ${table} SET ${q(BIRTH_FP_COLUMN)} = ${birthFpCallSql(db, scope, spec, table)} ` +
          `WHERE rowid = NEW.rowid AND ${q(BIRTH_FP_COLUMN)} IS NULL;`,
      );
    }
    db.exec(
      `CREATE TEMP TRIGGER IF NOT EXISTS ${q(`trg_row_uid_${spec.table}`)} ` +
        `AFTER INSERT ON ${table} BEGIN ${steps.join(' ')} END`,
    );
  }
}

/**
 * Bring a freshly opened `cleo.db` connection's row identity up to date:
 * schema, graveyard re-link, fill, per-connection triggers. Never throws: a
 * failure is logged and the store opens with the values it has.
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
    const filled = fillRowUids(db, scope);
    const findings = rowIdentityFindings(db, scope);
    const report: RowUidFillReport = { ...filled, findings, healed };
    if (options.triggers !== false) installRowUidTriggers(db, scope);
    if (Object.keys(report.unfilled).length > 0) {
      log.warn(
        { scope, unfilled: report.unfilled },
        'rows left without a uid (filled on a later open)',
      );
    }
    if (healed.length > 0 || Object.keys(report.filled).length > 0 || report.relinked > 0) {
      log.debug({ scope, ...report }, 'row uids filled');
    }
    return report;
  } catch (error) {
    log.error({ scope, error }, 'row uid fill failed; rows keep a NULL uid until a later open');
    return null;
  }
}
