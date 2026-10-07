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
 * migration's header). Row uids are OPT-IN: nothing here runs unless
 * `CLEO_ROW_UID_FILL=1` ({@link rowUidFillEnabled}).
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
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type {
  RowIdentityRef,
  RowIdentityShareSignal,
  RowIdentityShareSignalCode,
  RowIdentityShareState,
  RowIdentitySpec,
  TableScope,
} from '@cleocode/contracts';
import { resolveNexusVaultStatePath } from '@cleocode/paths';
import { uuidv7 } from '../cloud/uuidv7.js';
import { getLogger } from '../logger.js';
import { acTextHash } from '../tasks/ac-identity.js';
import { rowUidFillEnabled } from './row-identity-flag.js';
import {
  BIRTH_FP_COLUMN,
  ROW_IDENTITY,
  rowIdentityColumns,
  rowIdentitySpec,
  UID_COLUMN,
} from './row-identity-registry.js';
import { readSyncFlags } from './sync/flags.js';
import {
  hasTriggerSuspendTable,
  ownedTriggerDdl,
  TRIGGER_SUSPEND_TABLE_DDL,
} from './sync/trigger-classes.js';
import { schemaWritesAllowed } from './worktree-build-guard.js';

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

/** Physical name of the AC uid graveyard (spec §6.5). */
export const AC_UID_GRAVEYARD = 'tasks_ac_uid_graveyard';

/**
 * The literal-table writes the open pass makes, supplied by the tasks
 * chokepoint (`store/sqlite-data-accessor.ts`, which registers them when it
 * loads) so they stay enumerable by gate 28.
 */
export interface RowIdentityWriters {
  relinkAcUidNative(db: DatabaseSync, acId: string, uid: string, birthFp: string | null): number;
  clearAcUidGraveyardNative(db: DatabaseSync): void;
  writeRowIdentityMetaNative(db: DatabaseSync, key: string, value: string): void;
  fillIdentityColumnNative(
    db: DatabaseSync,
    table: string,
    column: string,
    valueSql: string,
    rowid?: number,
  ): number;
  clearBirthFpNative(db: DatabaseSync, table: string, rowid: number): void;
  /** Set the given identity columns of every row of `table` to NULL (T13231 full refill). */
  clearIdentityColumnsNative(db: DatabaseSync, table: string, columns: readonly string[]): void;
}

let registeredWriters: RowIdentityWriters | undefined;

/**
 * Register the chokepoint's row-identity writers (called once by
 * `store/sqlite-data-accessor.ts` at load).
 *
 * @param writers - The writers.
 */
export function registerRowIdentityWriters(writers: RowIdentityWriters): void {
  registeredWriters = writers;
}

/** The registered writers, or an error naming the module that registers them. */
function requireWriters(): RowIdentityWriters {
  if (!registeredWriters) {
    throw new Error('row identity writers are not registered: load store/sqlite-data-accessor.js');
  }
  return registeredWriters;
}

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

/** Strict ISO-8601 / SQLite timestamp: date, optional time, optional zone. */
const STORE_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?)?(Z|[+-]\d{2}:?\d{2})?$/;

/**
 * Epoch milliseconds of a stored timestamp, or `null` when absent or not a
 * strict ISO-8601 / SQLite timestamp. A value WITHOUT a zone is UTC:
 * `datetime('now')` writes `YYYY-MM-DD HH:MM:SS` meaning UTC, and a zoneless
 * `YYYY-MM-DDTHH:MM:SS` is read the same way, never as the device's local
 * time (`Date.parse` would, and a uid would then depend on the device's
 * timezone). Anything else (`Date.parse` extensions such as `Sep 24 2026`,
 * out-of-range fields) is `null`, i.e. an unparseable birth. Comparing that
 * text against ISO text is wrong within a day (`' '` sorts before `'T'`), so
 * every comparison and every uid birth goes through this function (T12329).
 *
 * @param value - Stored timestamp.
 * @returns Epoch milliseconds, or `null`.
 */
export function parseStoreTimestamp(value: UidInput | undefined): number | null {
  if (typeof value !== 'string') return null;
  const m = STORE_TIMESTAMP.exec(value);
  if (!m) return null;
  const [, y, mo, d, h = '0', mi = '0', sec = '0', frac = '', zone] = m;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const hour = Number(h);
  const minute = Number(mi);
  const second = Number(sec);
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) return null;
  const ms = Number(frac.padEnd(3, '0').slice(0, 3) || '0');
  const utc = Date.UTC(year, month - 1, day, hour, minute, second, ms);
  const check = new Date(utc);
  if (check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  if (!zone || zone === 'Z') return utc;
  const sign = zone.startsWith('-') ? -1 : 1;
  const digits = zone.slice(1).replace(':', '');
  const offset = (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4))) * 60_000;
  if (Number(digits.slice(0, 2)) > 23 || Number(digits.slice(2, 4)) > 59) return null;
  return utc - sign * offset;
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

/**
 * The new uid of a minted child row when its owner is re-keyed (spec §6.4):
 * derived from STORED identity only (the child's old uid and the owner's new
 * uid), never from a local key or content, so every replica that computes it
 * gets the same value whatever display ids it holds. The child's timestamp
 * bits are kept; the other 74 bits come from SHA-256.
 *
 * @param scope - Store scope.
 * @param table - Physical table of the child.
 * @param oldChildUid - The child's uid before the re-key.
 * @param newOwnerUid - The owner's new uid.
 * @returns Canonical lowercase UUID string.
 */
export function rekeyedChildUid(
  scope: TableScope,
  table: string,
  oldChildUid: string,
  newOwnerUid: string,
): string {
  const h = createHash('sha256')
    .update(
      encodeUidInputs([ROW_UID_DOMAIN, 'rekey-child', scope, table, oldChildUid, newOwnerUid]),
    )
    .digest();
  const b = Buffer.alloc(16);
  Buffer.from(oldChildUid.replaceAll('-', '').slice(0, 12), 'hex').copy(b, 0);
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
  const ms = parseStoreTimestamp(birth);
  if (ms !== null) return `ms:${ms}`;
  return `birth:unparseable:${canonicalText(String(birth))}`;
}

/**
 * Canonical form of a text input to a birth fingerprint: Unicode NFC, line
 * endings as LF, surrounding whitespace trimmed. Two stores that hold the same
 * text in different normal forms fingerprint it identically.
 *
 * @param text - Stored text.
 * @returns The canonical text.
 */
export function canonicalText(text: string): string {
  return text.normalize('NFC').replace(/\r\n?/g, '\n').trim();
}

/** Canonicalise one birth-fact value (text as {@link canonicalText}; others as stored). */
function canonicalFact(value: UidInput): UidInput {
  return typeof value === 'string' ? canonicalText(value) : value;
}

/**
 * A minted row's birth fingerprint: 128 bits of SHA-256 over the canonical
 * birth (epoch ms when it parses, so a format-only difference fingerprints
 * alike; a flagged token otherwise) and the table's frozen birth facts, each
 * canonicalised ({@link canonicalText}). Computed ONCE, when the row first
 * gets its identity, from the row as it is then; never recomputed. It is
 * write-once and syncs with the row: a receiver stores the value it receives.
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
    .update(
      encodeUidInputs([ROW_BIRTH_DOMAIN, table, birthToken(birth), ...facts.map(canonicalFact)]),
    )
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
function birthFactSql(scope: TableScope, spec: RowIdentitySpec, fact: string, row: string): string {
  const target = fingerprintRef(scope, spec, fact);
  if (target) {
    // The referenced row's fingerprint; a flag when there is no reference or
    // the row is gone; NULL (wait) while it exists without a fingerprint.
    const match = `_r.${q(target.key)} = ${row}.${q(target.column)}`;
    return (
      `(CASE WHEN ${row}.${q(target.column)} IS NULL THEN 'ref:none' ` +
      `WHEN NOT EXISTS (SELECT 1 FROM main.${q(target.table)} AS _r WHERE ${match}) THEN 'ref:missing' ` +
      `ELSE (SELECT _r.${q(BIRTH_FP_COLUMN)} FROM main.${q(target.table)} AS _r WHERE ${match}) END)`
    );
  }
  return `${row}.${q(fact)}`;
}

/**
 * The row a fingerprint fact reads the fingerprint of: `@ownerFp:<column>` is
 * the owner that column references (matched on the owner's key);
 * `@refFp:<column>` is a stored reference uid column (matched on the uid).
 */
function fingerprintRef(
  scope: TableScope,
  spec: RowIdentitySpec,
  fact: string,
): { table: string; column: string; key: string } | null {
  if (fact.startsWith('@ownerFp:')) {
    const column = fact.slice('@ownerFp:'.length);
    const ref = spec.owners?.find((r) => r.column === column);
    if (!ref) throw new Error(`row identity: ${spec.table} birth fact ${fact} names no owner`);
    return { table: ref.table, column, key: targetKey(scope, ref.table) };
  }
  if (fact.startsWith('@refFp:')) {
    const column = fact.slice('@refFp:'.length);
    const ref = spec.storedRefUids?.find(
      (r) => r.column === column && (r.source ?? 'uid') === 'uid',
    );
    if (!ref) throw new Error(`row identity: ${spec.table} birth fact ${fact} names no stored uid`);
    return { table: ref.table, column, key: UID_COLUMN };
  }
  return null;
}

/** Minted tables ordered so a table comes after every table its fingerprint facts read. */
function fingerprintOrder(scope: TableScope, specs: readonly RowIdentitySpec[]): RowIdentitySpec[] {
  const minted = specs.filter((s) => s.kind === 'minted');
  const deps = (spec: RowIdentitySpec) =>
    (spec.birthFacts ?? [])
      .map((f) => fingerprintRef(scope, spec, f)?.table)
      .filter((t): t is string => t !== undefined && t !== spec.table);
  const done = new Set<string>();
  const out: RowIdentitySpec[] = [];
  let pending = [...minted];
  while (pending.length > 0) {
    const ready = pending.filter((s) =>
      deps(s).every((t) => done.has(t) || !minted.some((m) => m.table === t)),
    );
    if (ready.length === 0) throw new Error('row identity: cyclic fingerprint facts');
    for (const s of ready) {
      out.push(s);
      done.add(s.table);
    }
    pending = pending.filter((s) => !ready.includes(s));
  }
  return out;
}

/** SQL call of the birth-fingerprint function for one minted table. */
function birthFpCallSql(scope: TableScope, spec: RowIdentitySpec, row: string): string {
  const birth = spec.birth ? `${row}.${q(spec.birth)}` : 'NULL';
  const facts = (spec.birthFacts ?? []).map((f) => birthFactSql(scope, spec, f, row));
  return `${ROW_BIRTH_FP_SQL_FUNCTION}(${[`'${spec.table}'`, birth, ...facts].join(', ')})`;
}

/**
 * SQL that is true exactly when {@link storedRefSql} would be NOT NULL for
 * `row`, without calling a JS function: the AC text hash is non-NULL iff the
 * referenced row's text is a string, which SQLite says as `typeof = 'text'`.
 * The pending probe uses it, so a store with many legitimately dangling refs
 * opens without one JS hash per dangling row (T13261).
 */
function storedRefPresentSql(
  scope: TableScope,
  ref: NonNullable<RowIdentitySpec['storedRefUids']>[number],
  row: string,
): string {
  if (ref.source === 'text_hash') {
    return (
      `(SELECT typeof(_r.${q('text')}) FROM main.${q(ref.table)} AS _r ` +
      `WHERE _r.${q(targetKey(scope, ref.table))} = ${row}.${q(ref.from)}) = 'text'`
    );
  }
  return `${refUidSql(scope, { column: ref.from, table: ref.table }, row)} IS NOT NULL`;
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
      const ownerFacts = (spec?.birthFacts ?? []).map(
        (f) => f.startsWith('@ownerFp:') || f.startsWith('@refFp:'),
      );
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
  /**
   * Pre-release identity values: `none` (the recipe marker is current, or
   * there were no values), `cleared` (values without the current recipe
   * marker were cleared and refilled), or `refused` (they were kept because
   * uids have already synced; spec §12.1).
   */
  readonly refill: 'none' | 'cleared' | 'refused';
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
function fillTable(
  db: DatabaseSync,
  scope: TableScope,
  spec: RowIdentitySpec,
  writers: RowIdentityWriters,
): number {
  const before = nullCount(db, spec.table, UID_COLUMN);
  if (before === 0) return 0;
  const table = `main.${q(spec.table)}`;
  const fill = (variant: number, rowid?: number) =>
    writers.fillIdentityColumnNative(
      db,
      spec.table,
      UID_COLUMN,
      uidCallSql(scope, spec, table, variant),
      rowid,
    );
  db.exec('SAVEPOINT row_uid_fill_table');
  try {
    fill(0);
    db.exec('RELEASE SAVEPOINT row_uid_fill_table');
  } catch (error) {
    db.exec('ROLLBACK TO SAVEPOINT row_uid_fill_table');
    db.exec('RELEASE SAVEPOINT row_uid_fill_table');
    if (!isUniqueViolation(error)) throw error;
    const rowids = db
      .prepare(`SELECT rowid AS r FROM ${table} WHERE ${q(UID_COLUMN)} IS NULL ORDER BY rowid`)
      .all() as { r: number }[];
    const variants = spec.symmetric ? [0, 1] : [0];
    for (const { r } of rowids) {
      for (const variant of variants) {
        try {
          if (fill(variant, r) > 0) break;
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
export function fillTableUids(
  db: DatabaseSync,
  scope: TableScope,
  table: string,
  writers: RowIdentityWriters = requireWriters(),
): number {
  const spec = rowIdentitySpec(scope, table);
  if (!spec) throw new Error(`row identity: ${table} is not declared in scope ${scope}`);
  return fillTable(db, scope, spec, writers);
}

/** Fill the stored reference facts (`ac_uid`, `ac_text_hash`) that resolve. */
function fillStoredRefs(
  db: DatabaseSync,
  scope: TableScope,
  spec: RowIdentitySpec,
  out: Record<string, number>,
  writers: RowIdentityWriters,
): void {
  const table = `main.${q(spec.table)}`;
  for (const ref of spec.storedRefUids ?? []) {
    const before = nullCount(db, spec.table, ref.column);
    if (before === 0) continue;
    writers.fillIdentityColumnNative(db, spec.table, ref.column, storedRefSql(scope, ref, table));
    const written = before - nullCount(db, spec.table, ref.column);
    if (written > 0) out[`${spec.table}.${ref.column}`] = written;
  }
}

/** Fill the NULL birth fingerprints of one minted table. */
function fillBirthFp(
  db: DatabaseSync,
  scope: TableScope,
  spec: RowIdentitySpec,
  writers: RowIdentityWriters,
): number {
  if (spec.kind !== 'minted') return 0;
  const before = nullCount(db, spec.table, BIRTH_FP_COLUMN);
  if (before === 0) return 0;
  const table = `main.${q(spec.table)}`;
  writers.fillIdentityColumnNative(
    db,
    spec.table,
    BIRTH_FP_COLUMN,
    birthFpCallSql(scope, spec, table),
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
function relinkAcUids(db: DatabaseSync, writers: RowIdentityWriters): number {
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
    `SELECT uid, ordinal, text, birth_fp AS birthFp FROM main.${AC_UID_GRAVEYARD} g
      WHERE task_id = ? AND NOT EXISTS (SELECT 1 FROM main.tasks_task_acceptance_criteria a WHERE a.uid = g.uid)
      ORDER BY seq DESC`,
  );
  const assign = (dead: { uid: string; birthFp: string | null }, acId: string) =>
    writers.relinkAcUidNative(db, acId, dead.uid, dead.birthFp);
  const byTask = new Map<string, typeof orphans>();
  for (const row of orphans) byTask.set(row.taskId, [...(byTask.get(row.taskId) ?? []), row]);
  for (const [taskId, rows] of byTask) {
    const seen = new Set<string>();
    const pool = (
      dead.all(taskId) as { uid: string; ordinal: number; text: string; birthFp: string | null }[]
    ).filter((d) => !seen.has(d.uid) && seen.add(d.uid));
    const claimed = new Set<string>();
    const pick = (match: (d: (typeof pool)[number]) => boolean) =>
      pool.find((d) => !claimed.has(d.uid) && match(d));
    const pending = rows.filter((row) => {
      const same = pick((d) => d.text === row.text);
      if (!same) return true;
      claimed.add(same.uid);
      relinked += assign(same, row.id);
      return false;
    });
    for (const row of pending) {
      const same = pick((d) => d.ordinal === row.ordinal);
      if (!same) continue;
      claimed.add(same.uid);
      relinked += assign(same, row.id);
    }
  }
  writers.clearAcUidGraveyardNative(db);
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
  writers: RowIdentityWriters = requireWriters(),
): Omit<RowUidFillReport, 'healed' | 'findings' | 'refill'> {
  const filled: Record<string, number> = {};
  const refsFilled: Record<string, number> = {};
  const fingerprinted: Record<string, number> = {};
  const unfilled: Record<string, number> = {};
  const order = fillOrder(db, scope);
  db.exec('SAVEPOINT row_uid_fill');
  try {
    const relinked = scope === 'project' ? relinkAcUids(db, writers) : 0;
    for (const spec of order) {
      const n = fillTable(db, scope, spec, writers);
      if (n > 0) filled[spec.table] = n;
    }
    for (const spec of order) fillStoredRefs(db, scope, spec, refsFilled, writers);
    for (const spec of fingerprintOrder(scope, order)) {
      const n = fillBirthFp(db, scope, spec, writers);
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
        `UPDATE ${table} SET ${q(BIRTH_FP_COLUMN)} = ${birthFpCallSql(scope, spec, table)} ` +
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
/**
 * Version of every identity recipe this build derives (uid, natural uid,
 * birth fingerprint, encoding). Written to {@link ROW_IDENTITY_META_TABLE} under
 * {@link ROW_IDENTITY_RECIPE_KEY} by the first fill; bumped by any change to a
 * recipe, a frozen content or birth-fact list, or the encoding.
 */
export const ROW_IDENTITY_RECIPE = 'cleo/row-identity/v2';

/**
 * The recipe 9.25 shipped (v1). v2 changed only the birth facts of AC history
 * and evidence bindings (@refFp:ac_uid and ac_text_hash → none / ac_id,
 * T12802); a store filled
 * with v1 has those two tables' fingerprints re-derived (see
 * {@link v1ReleaseBirthFp}).
 */
export const ROW_IDENTITY_RECIPE_V1 = 'cleo/row-identity/v1';

/**
 * The v1 fingerprint of an AC-history or binding row, to recognise a value
 * the 9.25 recipe derived: v1 hashed the criterion's fingerprint
 * (`@refFp:ac_uid`), or `ref:none` / `ref:missing`. Other tables: `null`
 * (their v1 and v2 recipes are the same).
 *
 * @param db - Connection on the project `cleo.db`.
 * @param table - Declared minted table.
 * @param row - The stored row.
 * @returns The v1 value, or `null`.
 * @task T12802
 */
export function v1ReleaseBirthFp(
  db: DatabaseSync,
  table: string,
  row: Readonly<Record<string, UidInput>>,
): string | null {
  const col = (c: string): UidInput => row[c] ?? null;
  const facts: UidInput[] =
    table === 'tasks_task_acceptance_criteria_history'
      ? [col('ac_id'), col('previous_text'), col('reason')]
      : table === 'tasks_evidence_ac_bindings'
        ? [col('evidence_atom_id'), col('binding_type'), col('ac_text_hash')]
        : [];
  if (facts.length === 0) return null;
  const acUid = col('ac_uid');
  let ref: UidInput = 'ref:none';
  if (acUid !== null) {
    const ac = db
      .prepare('SELECT birth_fp AS fp FROM main.tasks_task_acceptance_criteria WHERE uid = ?')
      .get(acUid) as { fp: UidInput } | undefined;
    ref = ac === undefined ? 'ref:missing' : ac.fp;
    if (ref === null) return null;
  }
  const spec = rowIdentitySpec('project', table);
  return birthFingerprint(table, spec?.birth ? col(spec.birth) : null, [...facts, ref]);
}

/**
 * Local-only key/value table of the row-identity layer. Not
 * `tasks_schema_meta`: the twin collapse drops twin-only keys of that table on
 * its first run (T12535), which would lose the marker.
 */
export const ROW_IDENTITY_META_TABLE = 'tasks_row_identity_meta';

/** Key holding the recipe version the store's identity values were derived with. */
export const ROW_IDENTITY_RECIPE_KEY = 'row_identity_recipe';

/**
 * Key the sync layer (T12342/T12343) writes BEFORE the
 * first uid leaves the device. Once present, identity values are shared and
 * are never cleared locally.
 */
export const ROW_IDENTITY_SYNCED_KEY = 'row_identity_synced';

/** Tables the uid migration creates, as `CREATE … IF NOT EXISTS` (kept equal to its SQL). */
const IDENTITY_TABLE_DDL: Readonly<Record<string, readonly string[]>> = {
  [ROW_IDENTITY_META_TABLE]: [
    `CREATE TABLE IF NOT EXISTS main.${ROW_IDENTITY_META_TABLE} (
      key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)`,
  ],
  tasks_display_id_aliases: [
    `CREATE TABLE IF NOT EXISTS main.tasks_display_id_aliases (
      uid TEXT PRIMARY KEY NOT NULL, entity_table TEXT NOT NULL, display_id TEXT NOT NULL,
      entity_uid TEXT NOT NULL, reason TEXT NOT NULL, origin TEXT, displaced_hlc TEXT,
      created_at TEXT NOT NULL, entity_birth_fp TEXT)`,
    'CREATE INDEX IF NOT EXISTS main.idx_tasks_display_id_aliases_lookup ON tasks_display_id_aliases (entity_table, display_id)',
    'CREATE INDEX IF NOT EXISTS main.idx_tasks_display_id_aliases_entity ON tasks_display_id_aliases (entity_uid)',
  ],
  tasks_uid_aliases: [
    `CREATE TABLE IF NOT EXISTS main.tasks_uid_aliases (
      uid TEXT PRIMARY KEY NOT NULL, entity_table TEXT NOT NULL, old_uid TEXT NOT NULL,
      old_birth_fp TEXT NOT NULL, new_uid TEXT NOT NULL, origin TEXT, displaced_hlc TEXT,
      created_at TEXT NOT NULL)`,
    'CREATE INDEX IF NOT EXISTS main.idx_tasks_uid_aliases_old ON tasks_uid_aliases (entity_table, old_uid)',
  ],
  tasks_identity_quarantine: [
    `CREATE TABLE IF NOT EXISTS main.tasks_identity_quarantine (
      entity_table TEXT NOT NULL, uid TEXT NOT NULL, birth_fp TEXT NOT NULL, reason TEXT NOT NULL,
      contested_id TEXT, row_json TEXT NOT NULL, received_hlc TEXT, created_at TEXT NOT NULL,
      PRIMARY KEY (entity_table, uid, birth_fp))`,
  ],
  [AC_UID_GRAVEYARD]: [
    `CREATE TABLE IF NOT EXISTS main.${AC_UID_GRAVEYARD} (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, ac_id TEXT NOT NULL, uid TEXT NOT NULL,
      task_id TEXT NOT NULL, ordinal INTEGER NOT NULL, text TEXT NOT NULL, birth_fp TEXT,
      deleted_at TEXT NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS main.idx_${AC_UID_GRAVEYARD}_task ON ${AC_UID_GRAVEYARD} (task_id)`,
  ],
};

/** Whether a schema object of `type` named `name` exists in `main`. */
function hasObject(db: DatabaseSync, type: string, name: string): boolean {
  return (
    db.prepare('SELECT 1 FROM main.sqlite_master WHERE type = ? AND name = ?').get(type, name) !==
    undefined
  );
}

/**
 * Re-create the tables, trigger and columns the uid migration adds when they
 * are missing: a store the journal probe stamped as migrated after only its
 * ADD COLUMNs had run (Scenario 3, Case A) otherwise never gets them.
 * Idempotent.
 *
 * @param db - Connection on the project `cleo.db`.
 * @returns Statements that had to be run.
 */
export function ensureIdentityTables(db: DatabaseSync): string[] {
  if (!hasTable(db, 'tasks_task_acceptance_criteria')) return [];
  const healed: string[] = [];
  for (const [table, ddl] of Object.entries(IDENTITY_TABLE_DDL)) {
    const tableExisted = hasTable(db, table);
    for (const stmt of ddl) {
      const index = /INDEX IF NOT EXISTS main\.(\w+)/.exec(stmt)?.[1];
      if (index ? hasObject(db, 'index', index) : tableExisted) continue;
      db.exec(stmt);
      healed.push(stmt);
    }
  }
  // Columns an early pre-release table lacks (the live-cleocode state, §12.1).
  for (const [table, column] of [
    ['tasks_display_id_aliases', 'displaced_hlc'],
    ['tasks_display_id_aliases', 'entity_birth_fp'],
    [AC_UID_GRAVEYARD, 'birth_fp'],
  ] as const) {
    if (columnsOf(db, table).has(column)) continue;
    const stmt = `ALTER TABLE main.${table} ADD COLUMN ${column} TEXT`;
    db.exec(stmt);
    healed.push(stmt);
  }
  if (!hasObject(db, 'trigger', 'trg_tasks_ac_uid_graveyard')) {
    // T12819: one source for the trigger, the owned DDL with its suspension
    // clause (never the t12341 migration's plain text), so a healed store and
    // a migrated one carry the same trigger. The clause reads the flag table.
    if (!hasTriggerSuspendTable(db)) db.exec(TRIGGER_SUSPEND_TABLE_DDL);
    const ddl = ownedTriggerDdl().get('trg_tasks_ac_uid_graveyard') as string;
    db.exec(ddl);
    healed.push(ddl);
  }
  return healed;
}

/** A row-identity meta value, or `undefined` (also when the table is absent). */
function readMeta(db: DatabaseSync, key: string): string | undefined {
  if (!hasTable(db, ROW_IDENTITY_META_TABLE)) return undefined;
  const row = db
    .prepare(`SELECT value FROM main.${ROW_IDENTITY_META_TABLE} WHERE key = ?`)
    .get(key) as { value: string } | undefined;
  return row?.value;
}

/** The pre-release (v4/v5 build) parse of a birth: a zoneless SQLite value as UTC, else `Date.parse`. */
function preReleaseParses(value: UidInput): boolean {
  if (typeof value !== 'string' || value.length === 0) return false;
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(value)
    ? `${value.replace(' ', 'T')}Z`
    : value;
  return !Number.isNaN(Date.parse(iso));
}

/**
 * The birth fingerprint the pre-release v4/v5 build derived (the recipe that
 * reached live cleocode on 2026-09-28): raw birth text, raw facts, the task
 * title from the earliest `task_created` audit event, and an AC's OWNER UID
 * instead of its owner's fingerprint. Used only to recognise those values.
 *
 * @param db - Connection on the project `cleo.db`.
 * @param table - Minted table.
 * @param row - The stored row.
 * @returns The pre-release fingerprint, or `null` when the table had none.
 */
export function preReleaseBirthFp(
  db: DatabaseSync,
  table: string,
  row: Readonly<Record<string, UidInput>>,
): string | null {
  const facts: UidInput[] = [];
  const col = (c: string): UidInput => row[c] ?? null;
  switch (table) {
    case 'tasks_tasks': {
      let title = col('title');
      if (hasTable(db, 'tasks_audit_log')) {
        const ev = db
          .prepare(
            `SELECT json_extract(details_json, '$.title') AS t FROM main.tasks_audit_log
              WHERE task_id = ? AND +action = 'task_created' AND json_valid(details_json)
              ORDER BY +timestamp, +id LIMIT 1`,
          )
          .get(col('id')) as { t: UidInput } | undefined;
        if (ev && ev.t !== null && ev.t !== undefined) title = ev.t;
      }
      facts.push(title, col('type'));
      break;
    }
    case 'tasks_sessions':
      facts.push(col('name'));
      break;
    case 'tasks_task_acceptance_criteria': {
      const owner = db
        .prepare('SELECT uid FROM main.tasks_tasks WHERE id = ?')
        .get(col('task_id')) as { uid: UidInput } | undefined;
      facts.push(col('text'), owner?.uid ?? null);
      break;
    }
    case 'tasks_task_acceptance_criteria_history':
      facts.push(col('ac_id'), col('previous_text'), col('reason'));
      break;
    case 'tasks_evidence_ac_bindings':
      facts.push(col('evidence_atom_id'), col('binding_type'), col('ac_text_hash'));
      break;
    default:
      return null;
  }
  const spec = rowIdentitySpec('project', table);
  const birth = spec?.birth ? col(spec.birth) : null;
  const token =
    birth === null
      ? 'birth:unknown'
      : preReleaseParses(birth)
        ? String(birth)
        : `birth:unparseable:${String(birth)}`;
  return createHash('sha256')
    .update(encodeUidInputs([ROW_BIRTH_DOMAIN, table, token, ...facts]))
    .digest('hex')
    .slice(0, 32);
}

/**
 * `_sync_*` tables whose rows do NOT make a store shared: the flags and
 * bookkeeping (`_sync_meta`, read key by key below), the replica binding
 * (`_sync_replica`, judged for a rebind below) and the clock. Every other
 * journal table keys its rows by uid, so a refill would orphan them, and a
 * journal table added later refuses by default (T13231).
 */
const JOURNAL_TABLES_NOT_SHARING: ReadonlySet<string> = new Set([
  '_sync_meta',
  '_sync_replica',
  '_sync_clock',
]);

/** `_sync_meta` key prefixes that record journal state about this store (exact prefixes). */
const JOURNAL_META_PREFIXES = ['suspect:', 'baseline:'] as const;

/**
 * Alias tables: their rows point at uids (a re-key, a re-mint, a split-brain
 * import). A store holding any is never refilled from scratch: the rewrite
 * would leave the aliases pointing at uids no row carries.
 */
const IDENTITY_ALIAS_TABLES = ['tasks_display_id_aliases', 'tasks_uid_aliases'] as const;

/** Options of {@link rowIdentityShareState}. */
export interface RowIdentityShareOptions {
  /**
   * Cleo Nexus answered, on every linked origin, that it holds no checkpoint
   * and no journal segment of this project (`cleo doctor row-identity
   * --refill`): the `nexus-linked-no-vault` signal is resolved. Every other
   * signal still counts.
   */
  readonly nexusCheckedNone?: boolean;
}

/** Whether `table` holds at least one row. */
function hasRows(db: DatabaseSync, table: string): boolean {
  return db.prepare(`SELECT 1 FROM main.${q(table)} LIMIT 1`).get() !== undefined;
}

/**
 * Decide, strictly, whether a project store's row identity is unshared
 * (T13231). Every signal that the uids may have left the store, or that
 * local journal state references them, makes it `shared`; any record that
 * cannot be read makes it `unknown`:
 *
 * - the shared marker (`row_identity_synced`: a receive or a send happened);
 * - `sync.seal`/`sync.push`/`sync.pull` on;
 * - rows in any `_sync_*` table except `_sync_meta`, `_sync_replica` and
 *   `_sync_clock` (captures, frames, row meta and repair baselines, undo
 *   images, sealed ops, the ledger, inbox, conflicts: all keyed by uid; a
 *   table added later counts by default);
 * - `suspect:` or `baseline:` keys in `_sync_meta` (journal state about this
 *   store a refill would invalidate);
 * - identity aliases exist (a re-key, re-mint or split-brain import pointed
 *   at uids);
 * - the store was rebound: a `_sync_replica` row not bound at `genesis`, or
 *   more than one row (a copy, move or restore);
 * - a vault snapshot of this store root was pushed or restored (an entry in
 *   `<CLEO_HOME>/nexus-vault.json` with a checkpoint or a push in flight);
 * - the project is linked to Cleo Nexus with no local vault entry for this
 *   root: the path-keyed vault state cannot rule out a push from a moved path
 *   or another CLEO_HOME, so this is `unknown` (resolved only by asking
 *   Nexus: {@link RowIdentityShareOptions.nexusCheckedNone}).
 *
 * @param db - Connection on a project `cleo.db` (its file locates the root).
 * @param options - Whether Cleo Nexus was asked and answered "none".
 * @returns The state and the signals behind it.
 * @task T13231
 */
export function rowIdentityShareState(
  db: DatabaseSync,
  options: RowIdentityShareOptions = {},
): RowIdentityShareState {
  const signals: RowIdentityShareSignal[] = [];
  const shared = (code: RowIdentityShareSignalCode, detail: string) =>
    signals.push({ code, kind: 'shared', detail });
  const unknown = (code: RowIdentityShareSignalCode, detail: string) =>
    signals.push({ code, kind: 'unknown', detail });
  if (readMeta(db, ROW_IDENTITY_SYNCED_KEY) !== undefined)
    shared('synced-marker', 'row_identity_synced is set');
  const flags = readSyncFlags(db);
  for (const flag of ['sync.seal', 'sync.push', 'sync.pull'] as const) {
    if (flags[flag]) shared('sync-flag', `${flag} is on`);
  }
  // Exact prefix match: `_` is a LIKE wildcard.
  const journal = db
    .prepare(
      "SELECT name FROM main.sqlite_master WHERE type = 'table' AND substr(name, 1, 6) = '_sync_' ORDER BY name",
    )
    .all() as Array<{ name: string }>;
  for (const { name } of journal) {
    if (!JOURNAL_TABLES_NOT_SHARING.has(name) && hasRows(db, name)) {
      shared('journal-rows', `${name} holds rows (journal state keyed by uid)`);
    }
  }
  if (hasTable(db, '_sync_meta')) {
    for (const prefix of JOURNAL_META_PREFIXES) {
      const n = (
        db
          .prepare('SELECT count(*) AS n FROM main._sync_meta WHERE substr(key, 1, ?) = ?')
          .get(prefix.length, prefix) as { n: number }
      ).n;
      if (n > 0) shared('journal-meta', `_sync_meta holds ${n} ${prefix} key(s)`);
    }
  }
  for (const table of IDENTITY_ALIAS_TABLES) {
    if (hasTable(db, table) && hasRows(db, table)) {
      shared('identity-aliases', `${table} holds rows (uids were re-keyed, re-minted or imported)`);
    }
  }
  if (hasTable(db, '_sync_replica')) {
    const rows = db.prepare('SELECT bound_why AS why FROM main._sync_replica').all() as Array<{
      why: string;
    }>;
    if (rows.length > 1 || rows.some((r) => r.why !== 'genesis')) {
      shared('rebound', 'the store was rebound (copied, moved or restored)');
    }
  }
  const location = db.location();
  if (!location) {
    unknown('unreadable', 'the store file has no location (in-memory)');
  } else {
    const root = resolve(dirname(dirname(location)));
    let linked = false;
    const linkFile = join(root, '.cleo', 'nexus-link.json');
    if (existsSync(linkFile)) {
      try {
        const parsed = JSON.parse(readFileSync(linkFile, 'utf8')) as {
          links?: Record<string, object>;
        };
        linked = Object.keys(parsed.links ?? {}).length > 0;
      } catch {
        unknown('unreadable', `${linkFile} is unreadable`);
      }
    }
    let vaultEntry = false;
    const stateFile = resolveNexusVaultStatePath();
    if (existsSync(stateFile)) {
      try {
        const parsed = JSON.parse(readFileSync(stateFile, 'utf8')) as {
          accounts?: Record<
            string,
            {
              streams?: Record<string, { lastCheckpointId?: string | null; pushInFlight?: object }>;
            }
          >;
        };
        for (const account of Object.values(parsed.accounts ?? {})) {
          for (const [key, stream] of Object.entries(account.streams ?? {})) {
            if (!key.endsWith(`|${root}`)) continue;
            vaultEntry = true;
            if (stream.lastCheckpointId || stream.pushInFlight) {
              shared('vault-pushed', 'a vault snapshot of this project was pushed or restored');
            }
          }
        }
      } catch {
        unknown('unreadable', `${stateFile} is unreadable`);
      }
    }
    if (linked && !vaultEntry && options.nexusCheckedNone !== true) {
      unknown(
        'nexus-linked-no-vault',
        'the project is linked to Cleo Nexus and no local vault record proves it was never pushed',
      );
    }
  }
  return shareStateOf(signals);
}

/**
 * Fold signals into a verdict: any `shared` signal makes it `shared`, else any
 * `unknown` one makes it `unknown`, else `unshared`.
 *
 * @param signals - Every signal found.
 * @returns The verdict.
 * @task T13231
 */
export function shareStateOf(signals: readonly RowIdentityShareSignal[]): RowIdentityShareState {
  const ordered = [
    ...signals.filter((s) => s.kind === 'shared'),
    ...signals.filter((s) => s.kind === 'unknown'),
  ];
  const state =
    ordered.length === 0 ? 'unshared' : ordered[0]?.kind === 'shared' ? 'shared' : 'unknown';
  return { state, signals: ordered, reasons: ordered.map((s) => s.detail) };
}

/** Meta key recording the snapshot taken before the last full identity refill (T13231). */
export const ROW_IDENTITY_REFILL_SNAPSHOT_KEY = 'row_identity_refill_snapshot';

/**
 * Snapshot the store before a full identity refill, so a rollback can restore
 * the old uids: `VACUUM INTO <project>/.cleo/backups/sqlite/cleo-identity-refill-<ts>.db`.
 *
 * @returns The snapshot path.
 */
function snapshotBeforeRefill(db: DatabaseSync): string {
  const location = db.location();
  // @sync-invariant none:local-only the local store has no file to snapshot; nothing is written
  if (!location) throw new Error('row identity refill: the store has no file to snapshot');
  const dir = join(dirname(location), 'backups', 'sqlite');
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = join(dir, `cleo-identity-refill-${stamp}.db`);
  db.exec(`VACUUM INTO '${file.replaceAll("'", "''")}'`);
  return file;
}

/**
 * Take the pre-refill snapshot when this open's refill will re-derive the
 * store from scratch (stale marker, identity values present, provably
 * unshared). A `VACUUM INTO` cannot run inside a transaction, so a caller that
 * runs the fill inside a bracket (identity-fill.ts) takes it first and passes
 * it in through `prepareRowIdentity`'s `refillSnapshot` option.
 *
 * @param db - Connection on a project `cleo.db`, outside any transaction.
 * @param scope - The store's scope.
 * @param share - Share-state options (whether Cleo Nexus answered "none").
 * @returns The snapshot path, or `null` when no full refill is due.
 * @task T13231
 */
export function snapshotIfFullRefillDue(
  db: DatabaseSync,
  scope: TableScope,
  share: RowIdentityShareOptions = {},
): string | null {
  if (scope !== 'project' || !rowUidFillEnabled() || !hasTable(db, ROW_IDENTITY_META_TABLE))
    return null;
  if (readMeta(db, ROW_IDENTITY_RECIPE_KEY) === ROW_IDENTITY_RECIPE) return null;
  const graveyard =
    hasTable(db, AC_UID_GRAVEYARD) &&
    db.prepare(`SELECT 1 FROM main.${AC_UID_GRAVEYARD} LIMIT 1`).get() !== undefined;
  if (!anyIdentityValue(db, scope) && !graveyard) return null;
  if (rowIdentityShareState(db, share).state !== 'unshared') return null;
  return snapshotBeforeRefill(db);
}

/**
 * Whether the store's identity follows the current recipe (its marker is
 * {@link ROW_IDENTITY_RECIPE}): no refill is due. Read-only.
 *
 * @param db - Connection on a project `cleo.db` (read-only is fine).
 * @returns `true` when the marker is current.
 * @task T13231
 */
export function rowIdentityRecipeCurrent(db: DatabaseSync): boolean {
  return (
    hasTable(db, ROW_IDENTITY_META_TABLE) &&
    readMeta(db, ROW_IDENTITY_RECIPE_KEY) === ROW_IDENTITY_RECIPE
  );
}

/**
 * What a full from-scratch refill clears: per declared table (alias tables
 * excluded), the rows carrying any identity value, plus the AC uid graveyard
 * rows under its table name. Read-only.
 *
 * @param db - Connection on a project `cleo.db` (read-only is fine).
 * @returns Row count per table; tables with nothing to clear are omitted.
 * @task T13231
 */
export function fullRefillPlan(db: DatabaseSync): Record<string, number> {
  const out: Record<string, number> = {};
  for (const spec of ROW_IDENTITY.project) {
    if (
      !hasTable(db, spec.table) ||
      (IDENTITY_ALIAS_TABLES as readonly string[]).includes(spec.table)
    ) {
      continue;
    }
    const cols = columnsOf(db, spec.table);
    const present = rowIdentityColumns('project', spec.table).filter((c) => cols.has(c));
    if (present.length === 0) continue;
    const where = present.map((c) => `${q(c)} IS NOT NULL`).join(' OR ');
    const n = (
      db.prepare(`SELECT count(*) AS n FROM main.${q(spec.table)} WHERE ${where}`).get() as {
        n: number;
      }
    ).n;
    if (n > 0) out[spec.table] = n;
  }
  if (hasTable(db, AC_UID_GRAVEYARD)) {
    const n = (
      db.prepare(`SELECT count(*) AS n FROM main.${AC_UID_GRAVEYARD}`).get() as { n: number }
    ).n;
    if (n > 0) out[AC_UID_GRAVEYARD] = n;
  }
  return out;
}

/** Whether any identity column of any declared table holds a value. */
function anyIdentityValue(db: DatabaseSync, scope: TableScope): boolean {
  for (const spec of ROW_IDENTITY[scope]) {
    if (!hasTable(db, spec.table)) continue;
    const cols = columnsOf(db, spec.table);
    for (const column of rowIdentityColumns(scope, spec.table)) {
      if (!cols.has(column)) continue;
      if (
        db
          .prepare(`SELECT 1 FROM main.${q(spec.table)} WHERE ${q(column)} IS NOT NULL LIMIT 1`)
          .get()
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Reset identity derived under an older recipe (T13231). Runs only while the
 * recipe marker is missing or stale:
 *
 * - no identity value and no graveyard row (a store the fill never ran on):
 *   `none`, and the fill writes the marker;
 * - provably unshared ({@link rowIdentityShareState}): a pre-refill snapshot
 *   (taken by the caller outside its transaction, or here when the fill runs
 *   bare), then every identity column of every declared table except the
 *   alias tables is cleared, so the fill re-derives the store from scratch:
 *   `cleared`;
 * - shared or unknown: every value is kept and the reasons are logged:
 *   `refused` (the marker is not written, so a later open, or
 *   `cleo doctor row-identity --refill`, can still decide).
 */
function resetStaleIdentity(
  db: DatabaseSync,
  scope: TableScope,
  writers: RowIdentityWriters,
  refillSnapshot?: string | null,
  shareOptions: RowIdentityShareOptions = {},
): RowUidFillReport['refill'] {
  if (scope !== 'project' || !hasTable(db, ROW_IDENTITY_META_TABLE)) return 'none';
  if (readMeta(db, ROW_IDENTITY_RECIPE_KEY) === ROW_IDENTITY_RECIPE) return 'none';
  // T13231: a provably unshared store re-derives ALL of its identity from
  // scratch. The targeted pass below kept uids "because the uid recipe did not
  // change", which was false for symmetric relation edges and criteria: a
  // device filling the same data from nothing derived different uids. Values
  // that may have left the store are never rewritten here.
  // Nothing to re-derive (a store the fill never ran on): the marker is
  // simply written, whatever the share state.
  const graveyardRows = hasTable(db, AC_UID_GRAVEYARD)
    ? (db.prepare(`SELECT count(*) AS n FROM main.${AC_UID_GRAVEYARD}`).get() as { n: number }).n
    : 0;
  if (!anyIdentityValue(db, scope) && graveyardRows === 0) return 'none';
  const share = rowIdentityShareState(db, shareOptions);
  if (share.state === 'unshared') {
    // The snapshot is taken outside any transaction: by the caller of a
    // bracketed fill, or here when the fill runs bare.
    const snapshot = refillSnapshot ?? (db.isTransaction ? null : snapshotBeforeRefill(db));
    if (!snapshot) {
      getLogger('row-identity').error(
        { scope },
        'a full identity refill is due but no pre-refill snapshot could be taken (inside a transaction); kept as they are',
      );
      return 'refused';
    }
    db.exec('SAVEPOINT row_identity_full_refill');
    try {
      if (graveyardRows > 0) writers.clearAcUidGraveyardNative(db);
      for (const spec of ROW_IDENTITY[scope]) {
        // The alias tables are empty here (non-empty is `shared`); never cleared.
        if (
          !hasTable(db, spec.table) ||
          (IDENTITY_ALIAS_TABLES as readonly string[]).includes(spec.table)
        ) {
          continue;
        }
        const cols = columnsOf(db, spec.table);
        const present = rowIdentityColumns(scope, spec.table).filter((c) => cols.has(c));
        if (present.length > 0) writers.clearIdentityColumnsNative(db, spec.table, present);
      }
      writers.writeRowIdentityMetaNative(db, ROW_IDENTITY_REFILL_SNAPSHOT_KEY, snapshot);
      db.exec('RELEASE SAVEPOINT row_identity_full_refill');
    } catch (error) {
      db.exec('ROLLBACK TO SAVEPOINT row_identity_full_refill');
      db.exec('RELEASE SAVEPOINT row_identity_full_refill');
      throw error;
    }
    getLogger('row-identity').info(
      { scope, snapshot },
      'stale identity on an unshared store: every identity value cleared for a from-scratch refill',
    );
    return 'cleared';
  }
  getLogger('row-identity').error(
    { scope, state: share.state, reasons: share.reasons },
    share.state === 'shared'
      ? 'identity values predate the current recipe but may have left this store; kept as they are'
      : 'identity values predate the current recipe and the store cannot be proven unshared; kept as they are. ' +
          'Remedy: `cleo doctor row-identity --refill` asks Cleo Nexus and shows the plan',
  );
  return 'refused';
}

/**
 * Record that the store's identity values follow {@link ROW_IDENTITY_RECIPE}.
 * The fill writes it; {@link markRowIdentityShared} writes it too on the
 * first receive (a device that pulls before it ever fills).
 *
 * @param db - Connection on the project `cleo.db`.
 */
export function writeRecipeMarker(
  db: DatabaseSync,
  writers: RowIdentityWriters = requireWriters(),
): void {
  if (!hasTable(db, ROW_IDENTITY_META_TABLE)) return;
  writers.writeRowIdentityMetaNative(db, ROW_IDENTITY_RECIPE_KEY, ROW_IDENTITY_RECIPE);
}

/**
 * Whether the store's identity values are shared with other devices
 * ({@link ROW_IDENTITY_SYNCED_KEY} present): from then on no local write may
 * clear or re-point a uid.
 *
 * @param db - Connection on the project `cleo.db`.
 * @returns True once identity has been sent or received.
 * @task T12806
 */
export function rowIdentityShared(db: DatabaseSync): boolean {
  return readMeta(db, ROW_IDENTITY_SYNCED_KEY) !== undefined;
}

/**
 * Record that identity values are now SHARED with other devices: the recipe
 * marker, and {@link ROW_IDENTITY_SYNCED_KEY} (first write wins, with the
 * direction). Called on the first receive (a pull-first clone that never
 * filled) as well as before the first send; once present, the open pass
 * never clears an identity value (spec §12.1).
 *
 * @param db - Connection on the project `cleo.db`.
 * @param direction - `receive` (the merge applied a row or op) or `send`.
 * @param writers - The chokepoint writers.
 * @task T12746
 */
export function markRowIdentityShared(
  db: DatabaseSync,
  direction: 'send' | 'receive',
  writers: RowIdentityWriters = requireWriters(),
): void {
  if (!hasTable(db, ROW_IDENTITY_META_TABLE)) return;
  if (readMeta(db, ROW_IDENTITY_RECIPE_KEY) === undefined) writeRecipeMarker(db, writers);
  if (readMeta(db, ROW_IDENTITY_SYNCED_KEY) !== undefined) return;
  writers.writeRowIdentityMetaNative(
    db,
    ROW_IDENTITY_SYNCED_KEY,
    JSON.stringify({ first: direction, at: new Date().toISOString() }),
  );
}

/**
 * Re-create the row-identity SCHEMA a store should have, on every open,
 * whatever the fill flag (T12878). DDL only: the identity tables, the
 * graveyard trigger, the columns an early table lacks, the uid columns and
 * their indexes. No row value is read or written. A store whose uid migration
 * was journaled without running its statements (journal Scenario 3 Case A:
 * live cleocode under 9.25, spec §12.2) gets the full schema here; the fill,
 * refill and TEMP triggers stay opt-in ({@link prepareRowIdentity}).
 *
 * Never throws: a failure is logged and the open continues.
 *
 * @param db - Connection on a `cleo.db`, inside the cold-open lease.
 * @param scope - The store's scope.
 * @returns The DDL statements it ran (empty when the schema was complete).
 * @task T12878
 */
export function healRowIdentitySchema(
  db: DatabaseSync,
  scope: TableScope,
  writers: RowIdentityWriters | undefined = registeredWriters,
): string[] {
  const log = getLogger('row-identity');
  if (ROW_IDENTITY[scope].length === 0) {
    // Nothing is declared in this scope yet (the global store today): there is
    // no identity schema to heal, so nothing to record either.
    return [];
  }
  // A build that may not change this store's schema (a worktree-built CLI on a
  // live store, T12687) never heals it: the released build will.
  if (!schemaWritesAllowed(db)) {
    log.debug({ scope }, 'row identity schema heal skipped: schema writes refused for this build');
    return [];
  }
  try {
    db.exec('SAVEPOINT row_identity_heal');
    try {
      const healed = [
        ...(scope === 'project' ? ensureIdentityTables(db) : []),
        ...ensureRowIdentitySchema(db, scope),
      ];
      if (healed.length > 0) recordHealReceipt(db, scope, healed, writers);
      db.exec('RELEASE SAVEPOINT row_identity_heal');
      if (healed.length > 0)
        log.info({ scope, healed: healed.length }, 'row identity schema healed');
      return healed;
    } catch (error) {
      db.exec('ROLLBACK TO SAVEPOINT row_identity_heal');
      db.exec('RELEASE SAVEPOINT row_identity_heal');
      throw error;
    }
  } catch (error) {
    log.error({ scope, error }, 'row identity schema heal failed');
    return [];
  }
}

/**
 * Meta key of the heal receipt: when the open last re-created missing
 * identity schema, and what (T12878). Local-only bookkeeping of the heal
 * itself, in `tasks_row_identity_meta`; no row value of any other table is
 * written. `cleo doctor` (the `row_identity` check) shows it.
 */
export const ROW_IDENTITY_HEAL_KEY = 'row_identity_schema_healed';

/** The receipt {@link healRowIdentitySchema} leaves when it re-created schema. */
export interface RowIdentityHealReceipt {
  readonly at: string;
  readonly scope?: TableScope;
  readonly statements: number;
  /** Objects re-created or columns added (table, index, trigger or `table.column`). */
  readonly objects: readonly string[];
}

/** The table holding each scope's heal receipts (`null`: the scope has none yet). */
const HEAL_RECEIPT_TABLE: Readonly<Record<TableScope, string | null>> = {
  project: ROW_IDENTITY_META_TABLE,
  // The global store declares no identity table yet (ROW_IDENTITY.global is
  // empty, so its heal never runs); the change that declares one adds its
  // meta table here.
  global: null,
};

/** How many heal receipts a store keeps (newest last). */
const HEAL_RECEIPTS_KEPT = 20;

function recordHealReceipt(
  db: DatabaseSync,
  scope: TableScope,
  healed: readonly string[],
  writers: RowIdentityWriters | undefined,
): void {
  const table = HEAL_RECEIPT_TABLE[scope];
  const log = getLogger('row-identity');
  if (table === null || !hasTable(db, table) || !writers) {
    log.warn({ scope, healed: healed.length }, 'row identity schema healed; no receipt table');
    return;
  }
  const objects = healed.map((stmt) => {
    const col = /ALTER TABLE main\.("?)(\w+)\1 ADD COLUMN ("?)(\w+)\3/.exec(stmt);
    if (col) return `${col[2]}.${col[4]}`;
    const obj = /(TABLE|INDEX|TRIGGER) IF NOT EXISTS main\.("?)(\w+)\2/.exec(stmt);
    return obj ? `${(obj[1] as string).toLowerCase()} ${obj[3]}` : stmt.slice(0, 60);
  });
  const receipt: RowIdentityHealReceipt = {
    at: new Date().toISOString(),
    scope,
    statements: healed.length,
    objects,
  };
  // Appended, never overwritten: a later partial heal keeps the earlier ones.
  const history = [...readRowIdentityHealHistory(db), receipt].slice(-HEAL_RECEIPTS_KEPT);
  writers.writeRowIdentityMetaNative(db, ROW_IDENTITY_HEAL_KEY, JSON.stringify(history));
}

/**
 * The last heal receipt of a store, read-only (`undefined` when the schema
 * never needed healing).
 *
 * @param db - Connection on a project `cleo.db` (read-only is fine).
 * @returns The receipt.
 * @task T12878
 */
export function readRowIdentityHealReceipt(db: DatabaseSync): RowIdentityHealReceipt | undefined {
  const history = readRowIdentityHealHistory(db);
  return history[history.length - 1];
}

/**
 * Every heal receipt a store kept, oldest first (read-only).
 *
 * @param db - Connection on a project `cleo.db` (read-only is fine).
 * @returns The receipts (empty when the schema never needed healing).
 * @task T12878
 */
export function readRowIdentityHealHistory(db: DatabaseSync): RowIdentityHealReceipt[] {
  const raw = readMeta(db, ROW_IDENTITY_HEAL_KEY);
  if (raw === undefined) return [];
  try {
    const parsed = JSON.parse(raw) as RowIdentityHealReceipt | RowIdentityHealReceipt[];
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

/**
 * Identity schema a project store lacks, read-only: missing identity tables,
 * the graveyard trigger, and the alias / graveyard columns an early table
 * lacks (T12878; the open heals them).
 *
 * @param db - Connection on a project `cleo.db` (read-only is fine).
 * @returns What is missing (empty when complete).
 * @task T12878
 */
export function missingRowIdentitySchema(db: DatabaseSync): string[] {
  if (!hasTable(db, 'tasks_task_acceptance_criteria')) return [];
  const missing: string[] = [];
  for (const table of Object.keys(IDENTITY_TABLE_DDL)) {
    if (!hasTable(db, table)) missing.push(`table ${table}`);
  }
  for (const [table, column] of [
    ['tasks_display_id_aliases', 'displaced_hlc'],
    ['tasks_display_id_aliases', 'entity_birth_fp'],
    [AC_UID_GRAVEYARD, 'birth_fp'],
  ] as const) {
    if (hasTable(db, table) && !columnsOf(db, table).has(column)) {
      missing.push(`column ${table}.${column}`);
    }
  }
  if (!hasObject(db, 'trigger', 'trg_tasks_ac_uid_graveyard')) {
    missing.push('trigger trg_tasks_ac_uid_graveyard');
  }
  // The uid columns and indexes ensureRowIdentitySchema heals.
  for (const spec of ROW_IDENTITY.project) {
    if (!hasTable(db, spec.table)) continue;
    const cols = columnsOf(db, spec.table);
    for (const column of rowIdentityColumns('project', spec.table)) {
      if (!cols.has(column)) missing.push(`column ${spec.table}.${column}`);
    }
    if (!uidIsPrimaryKey(db, spec.table) && !hasObject(db, 'index', `uq_${spec.table}_uid`)) {
      missing.push(`index uq_${spec.table}_uid`);
    }
    for (const ref of spec.storedRefUids ?? []) {
      const index = `idx_${spec.table}_${ref.column}`;
      if (!hasObject(db, 'index', index)) missing.push(`index ${index}`);
    }
  }
  return missing;
}

/**
 * Create the fill's partial indexes: per minted table, the rows still without
 * a birth fingerprint, so the open's pending probe finds them by index, not a
 * scan (T12341 C1). Fill-on only: they serve the fill and nothing else, so a
 * store the fill never ran on (the default) keeps exactly the identity schema
 * of the migration, and its opens heal nothing new.
 *
 * @returns The statements run (empty when every index exists).
 */
function ensureFillIndexes(db: DatabaseSync, scope: TableScope): string[] {
  const run: string[] = [];
  for (const spec of ROW_IDENTITY[scope]) {
    if (spec.kind !== 'minted' || !hasTable(db, spec.table)) continue;
    if (hasObject(db, 'index', birthFpNullIndex(spec.table))) continue;
    const stmt = `CREATE INDEX IF NOT EXISTS main.${q(birthFpNullIndex(spec.table))} ON ${q(spec.table)} (${q(BIRTH_FP_COLUMN)}) WHERE ${q(BIRTH_FP_COLUMN)} IS NULL`;
    db.exec(stmt);
    run.push(stmt);
  }
  return run;
}

/** Whether every fill partial index ({@link ensureFillIndexes}) exists. */
function fillIndexesPresent(db: DatabaseSync, scope: TableScope): boolean {
  return ROW_IDENTITY[scope].every(
    (spec) =>
      spec.kind !== 'minted' ||
      !hasTable(db, spec.table) ||
      hasObject(db, 'index', birthFpNullIndex(spec.table)),
  );
}

/** Name of a minted table's partial index over rows with a NULL birth fingerprint (T12341 C1). */
function birthFpNullIndex(table: string): string {
  // `idx_<table>_<column>`, the convention of the identity indexes, so a
  // rollback (spec §13) or a pre-migration fixture that drops each identity
  // column's index before the column drops this one too.
  return `idx_${table}_${BIRTH_FP_COLUMN}`;
}

/**
 * What the fill would do on this open, found by index probes alone (T12341
 * C1). A store the fill has already run on answers `[]` and the open skips the
 * fill pass (and never loads its writers). Every probe is correct regardless
 * of rowid reuse: it looks for the rows themselves, never a rowid watermark.
 *
 * - `schema`: part of the identity schema, or a fill partial index, is missing
 *   (the full pass creates it);
 * - `recipe`: the recipe marker is missing or stale (the refill runs, or is
 *   refused and reported once uids have synced);
 * - `graveyard:<n>`: an older build deleted acceptance criteria whose uids wait
 *   to be re-linked;
 * - `uid:<table>`: a row without a uid (the unique uid index, or the uid
 *   primary key, holds the NULLs);
 * - `birth_fp:<table>`: a minted row without a birth fingerprint (the partial
 *   index {@link birthFpNullIndex});
 * - `ref:<table>.<column>`: a NULL stored reference fact that now resolves
 *   (its column index holds the NULLs; a reference that still dangles is not
 *   work).
 *
 * Requires {@link registerRowUidFunction} on the connection (the stored
 * reference probe evaluates the AC text hash).
 *
 * @param db - Connection on a `cleo.db`.
 * @param scope - The store's scope.
 * @returns The pending work, `[]` when the identity is complete.
 * @task T12341
 */
export function rowIdentityFillPending(db: DatabaseSync, scope: TableScope): string[] {
  if (ROW_IDENTITY[scope].length === 0) return [];
  // The probes name identity columns: a store missing any of its identity
  // schema is pending the full pass, which heals it first.
  if (
    scope === 'project' &&
    (missingRowIdentitySchema(db).length > 0 || !fillIndexesPresent(db, scope))
  ) {
    return ['schema'];
  }
  const pending: string[] = [];
  // A stale marker is work even when the identity has synced: the pass then
  // refuses the refill and says so (refill 'refused'), every open, until the
  // store is repaired — that anomaly must stay loud, not become a fast path.
  if (scope === 'project' && readMeta(db, ROW_IDENTITY_RECIPE_KEY) !== ROW_IDENTITY_RECIPE) {
    pending.push('recipe');
  }
  if (
    scope === 'project' &&
    hasTable(db, AC_UID_GRAVEYARD) &&
    db.prepare(`SELECT 1 FROM main.${AC_UID_GRAVEYARD} LIMIT 1`).get() !== undefined
  ) {
    pending.push('graveyard');
  }
  const any = (table: string, where: string): boolean =>
    db.prepare(`SELECT 1 FROM main.${q(table)} WHERE ${where} LIMIT 1`).get() !== undefined;
  for (const spec of ROW_IDENTITY[scope]) {
    if (!hasTable(db, spec.table)) continue;
    if (any(spec.table, `${q(UID_COLUMN)} IS NULL`)) pending.push(`uid:${spec.table}`);
    if (spec.kind === 'minted' && any(spec.table, `${q(BIRTH_FP_COLUMN)} IS NULL`)) {
      pending.push(`birth_fp:${spec.table}`);
    }
    const row = `main.${q(spec.table)}`;
    for (const ref of spec.storedRefUids ?? []) {
      if (any(spec.table, `${q(ref.column)} IS NULL AND ${storedRefPresentSql(scope, ref, row)}`)) {
        pending.push(`ref:${spec.table}.${ref.column}`);
      }
    }
  }
  return pending;
}

/** The report of an open whose identity was already complete (nothing written). */
function steadyReport(): RowUidFillReport {
  return {
    filled: {},
    refsFilled: {},
    fingerprinted: {},
    relinked: 0,
    unfilled: {},
    findings: { unknownBirth: {}, danglingRefs: {}, mirrorEdges: {} },
    healed: [],
    refill: 'none',
  };
}

export function prepareRowIdentity(
  db: DatabaseSync,
  scope: TableScope,
  options: {
    readonly triggers?: boolean;
    readonly writers?: RowIdentityWriters;
    /** A pre-refill snapshot the caller took outside its transaction ({@link snapshotIfFullRefillDue}). */
    readonly refillSnapshot?: string | null;
    /** Share-state options: Cleo Nexus answered "none" (`cleo doctor row-identity --refill`). */
    readonly share?: RowIdentityShareOptions;
    /** The caller's {@link rowIdentityFillPending} result, to avoid probing twice. */
    readonly pending?: readonly string[];
  } = {},
): RowUidFillReport | null {
  if (ROW_IDENTITY[scope].length === 0) return null;
  if (!rowUidFillEnabled()) return null;
  const log = getLogger('row-identity');
  try {
    // T12341 C1: a store whose identity is already complete (and whose schema
    // is whole) gets only this connection's uid triggers. No table is scanned,
    // nothing is written, and the writers are never needed.
    registerRowUidFunction(db, scope);
    const pending = options.pending ?? rowIdentityFillPending(db, scope);
    if (pending.length === 0) {
      if (options.triggers !== false) installRowUidTriggers(db, scope);
      return steadyReport();
    }
    const healed = [
      ...(scope === 'project' ? ensureIdentityTables(db) : []),
      ...ensureRowIdentitySchema(db, scope),
      ...ensureFillIndexes(db, scope),
    ];
    const writers = options.writers ?? requireWriters();
    const refill = resetStaleIdentity(db, scope, writers, options.refillSnapshot, options.share);
    const filled = fillRowUids(db, scope, writers);
    if (refill !== 'refused') writeRecipeMarker(db, writers);
    const findings = rowIdentityFindings(db, scope);
    const report: RowUidFillReport = { ...filled, findings, healed, refill };
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
