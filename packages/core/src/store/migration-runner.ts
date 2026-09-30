/**
 * The bracketed migration runner (journal spec §2.3a rules 1–3; T12774,
 * T12781, T12785, T12786, T12795, T12796, T12797, T12809).
 *
 * Drizzle's `migrateSync` runs every pending migration in ONE transaction of
 * its own, with `PRAGMA foreign_keys` left ON (the PRAGMA is a no-op inside a
 * transaction). A table rebuild's `DROP TABLE` therefore cascade-deletes
 * child rows, and nothing can run inside its transaction. This runner keeps
 * drizzle's journal byte-for-byte and replaces the transaction discipline:
 *
 * - **Journal-identical (R5-3).** Pending migrations are selected by NAME
 *   (drizzle's `getMigrationsToRun`), each row is written with the RAW file's
 *   sha256, `created_at = folderMillis`, `name` and `applied_at`, exactly as
 *   `migrateSync` writes it. `reconcileJournal` and drizzle's own
 *   `upgradeSyncIfNeeded` run inside the leading bracket, in today's order.
 *   Statements run one per `prepare()`, as drizzle's session does.
 * - **One bracket per migration FILE (R6-6).** Each file gets its own
 *   `BEGIN IMMEDIATE … COMMIT` and its own journal row.
 * - **FK discipline (A, NEW-1, R5-2, R5-4, NEW-6).** `foreign_keys` is turned
 *   OFF before `BEGIN` only for a file that rebuilds a table. For such a file
 *   the runner snapshots the FK violations of its scope (rebuilt and
 *   DML-touched tables plus their FK children) as a rowid-free multiset,
 *   re-checks after the statements, and rolls back on any NEW violation.
 *   Pre-existing orphans never block a migration. `finally` restores
 *   `foreign_keys`, reads it back and asserts no transaction is open.
 * - **Recovery kept.** A duplicate-column or table-exists error re-runs
 *   `reconcileJournal` once and retries, as `migrateWithRetry` does; a BUSY
 *   error retries the whole bracket with backoff, never mid-bracket.
 * - **Hooks (D4, NEW-8).** `beforeMigrations` runs before the first bracket
 *   (the sealer's pending work and the repair diff for suspect tables, S3);
 *   `suspendCapture` / `reinstallCapture` run inside each bracket around the
 *   statements (the capture triggers, S2); `afterMigration` runs after each
 *   commit (the `chash` re-baseline, S3). All are optional.
 *
 * Drizzle is pinned to {@link PINNED_DRIZZLE_VERSION}; a test fails when the
 * installed version differs, so an upgrade must re-run the parity suite.
 *
 * @task T12796
 * @task T12809
 * @module store/migration-runner
 */

import type { DatabaseSync } from 'node:sqlite';
import type { MigrationMeta } from 'drizzle-orm/migrator';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { getMigrationsToRun } from 'drizzle-orm/migrator.utils';
import type { NodeSQLiteDatabase } from 'drizzle-orm/node-sqlite';
import { sql } from 'drizzle-orm/sql';
import { upgradeSyncIfNeeded } from 'drizzle-orm/up-migrations/sqlite';
import { getLogger } from '../logger.js';
import {
  isDuplicateColumnError,
  isTableAlreadyExistsError,
  reconcileJournal,
  sanitizeMigrationStatements,
} from './migration-manager.js';
import { isSqliteBusy } from './with-retry.js';
import { assertNoPendingMigrationsForWorktreeBuild } from './worktree-build-guard.js';

/** The drizzle-orm version the runner's journal parity was proven against. */
export const PINNED_DRIZZLE_VERSION = '1.0.0-rc.4';

/** The journal table drizzle uses by default. */
export const MIGRATIONS_TABLE = '__drizzle_migrations';

const MAX_BUSY_RETRIES = 5;
const BUSY_BASE_DELAY_MS = 100;
const BUSY_MAX_DELAY_MS = 2000;

/** Optional work around the brackets (D4 ordering). */
export interface MigrationBracketHooks {
  /** Before the first bracket: seal pending captures, repair suspect tables (S3). */
  beforeMigrations?(db: DatabaseSync): void;
  /** Inside each bracket, before the statements: drop the capture triggers (S2). */
  suspendCapture?(db: DatabaseSync): void;
  /** Inside each bracket, after the statements: reinstall the capture triggers (S2). */
  reinstallCapture?(db: DatabaseSync): void;
  /** After each committed bracket: re-baseline `chash` for the file's tables (S3). */
  afterMigration?(db: DatabaseSync, migration: { name: string; hash: string }): void;
}

/** One migration lineage sharing the store's journal. */
export interface MigrationLineage {
  readonly folder: string;
  /** Run `reconcileJournal` for this lineage first (as the callers do today). */
  readonly reconcile?: {
    readonly existenceTable: string;
    readonly logSubsystem: string;
    readonly siblings?: readonly string[];
  };
}

/** What {@link runBracketedMigrations} did. */
export interface MigrationRunReport {
  /** Names of the migrations applied, in order. */
  readonly applied: string[];
  /** Names of the files that ran with `foreign_keys = OFF` (rebuilds). */
  readonly rebuilds: string[];
}

/** A migration file that introduced a foreign-key violation (rolled back). */
export class MigrationForeignKeyError extends Error {
  readonly code = 'E_MIGRATION_FK_VIOLATION';

  constructor(
    readonly migration: string,
    readonly violations: readonly string[],
  ) {
    super(
      `Migration ${migration} would leave ${violations.length} new foreign-key violation(s); ` +
        `rolled back. First: ${violations.slice(0, 3).join('; ')}`,
    );
    this.name = 'MigrationForeignKeyError';
  }
}

/** `foreign_keys` could not be restored on a handle after a bracket. */
export class ForeignKeysNotRestoredError extends Error {
  readonly code = 'E_STORE_FK_OFF';

  constructor(expected: number, actual: number) {
    super(`PRAGMA foreign_keys is ${actual} after a migration bracket; expected ${expected}`);
    this.name = 'ForeignKeysNotRestoredError';
  }
}

const IDENT = String.raw`[\`"[]?(\w+)[\`"\]]?`;

/** Strip `--` comments so prose never looks like DDL. */
function code(stmt: string): string {
  return stmt.replace(/--[^\n]*/g, '');
}

/**
 * The tables a migration file rebuilds or drops: `CREATE TABLE __new_x`
 * (→ `x`), `DROP TABLE x`, `ALTER TABLE x RENAME TO y` (→ `x`, `y`).
 * Empty for a file that rebuilds nothing.
 */
export function rebuiltTables(statements: readonly string[]): string[] {
  const out = new Set<string>();
  const final = (t: string) => t.replace(/^__new_/, '');
  for (const s of statements.map(code)) {
    for (const m of s.matchAll(
      new RegExp(String.raw`\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?${IDENT}`, 'gi'),
    )) {
      if ((m[1] as string).startsWith('__new_')) out.add(final(m[1] as string));
    }
    for (const m of s.matchAll(
      new RegExp(String.raw`\bDROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?${IDENT}`, 'gi'),
    )) {
      out.add(final(m[1] as string));
    }
    for (const m of s.matchAll(
      new RegExp(String.raw`\bALTER\s+TABLE\s+${IDENT}\s+RENAME\s+TO\s+${IDENT}`, 'gi'),
    )) {
      out.add(final(m[1] as string));
      out.add(final(m[2] as string));
    }
  }
  return [...out].sort();
}

/** The tables a migration's DML writes (INSERT / UPDATE / DELETE / REPLACE). */
export function dmlTables(statements: readonly string[]): string[] {
  const out = new Set<string>();
  for (const s of statements.map(code)) {
    for (const m of s.matchAll(
      new RegExp(
        String.raw`\b(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|REPLACE\s+INTO|UPDATE(?:\s+OR\s+\w+)?|DELETE\s+FROM)\s+${IDENT}`,
        'gi',
      ),
    )) {
      out.add((m[1] as string).replace(/^__new_/, ''));
    }
  }
  return [...out].sort();
}

function listTables(db: DatabaseSync): string[] {
  return (
    db
      .prepare(
        "SELECT name FROM main.sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as Array<{ name: string }>
  ).map((r) => r.name);
}

interface FkRow {
  id: number;
  seq: number;
  table: string;
  from: string;
  to: string | null;
}

function foreignKeys(db: DatabaseSync, table: string): FkRow[] {
  return db.prepare(`PRAGMA main.foreign_key_list("${table}")`).all() as unknown as FkRow[];
}

/**
 * The FK scope of a rebuild file: the given tables plus every table with a
 * foreign key to one of them (children), restricted to tables that exist.
 */
export function foreignKeyScope(db: DatabaseSync, tables: readonly string[]): string[] {
  const all = listTables(db);
  const existing = new Set(all);
  const scope = new Set(tables.filter((t) => existing.has(t)));
  const parents = new Set(tables);
  for (const t of all) {
    if (foreignKeys(db, t).some((fk) => parents.has(fk.table))) scope.add(t);
  }
  return [...scope].sort();
}

/** SQLite's affinity for a declared column type (§3.1 of the datatype doc). */
function affinity(declared: string): 'INTEGER' | 'TEXT' | 'BLOB' | 'REAL' | 'NUMERIC' {
  const t = declared.toUpperCase();
  if (t.includes('INT')) return 'INTEGER';
  if (/CHAR|CLOB|TEXT/.test(t)) return 'TEXT';
  if (t === '' || t.includes('BLOB')) return 'BLOB';
  if (/REAL|FLOA|DOUB/.test(t)) return 'REAL';
  return 'NUMERIC';
}

interface ColInfo {
  name: string;
  type: string;
  pk: number;
}

/**
 * The foreign-key violations of `tables`, as a multiset keyed by rowid-free
 * identity (R5-2): (table, the child's primary-key values normalized by
 * column affinity — or the whole row for a table without a declared PK,
 * parent table, the child's FK columns and their values). Duplicates count.
 */
export function foreignKeyViolations(
  db: DatabaseSync,
  tables: readonly string[],
): Map<string, number> {
  const out = new Map<string, number>();
  for (const table of tables) {
    const rows = db.prepare(`PRAGMA main.foreign_key_check("${table}")`).all() as Array<{
      table: string;
      rowid: number | bigint | null;
      parent: string;
      fkid: number;
    }>;
    if (rows.length === 0) continue;
    const cols = db.prepare(`PRAGMA main.table_info("${table}")`).all() as unknown as ColInfo[];
    const pkCols = cols.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk);
    const keyCols = pkCols.length > 0 ? pkCols : cols;
    const fks = foreignKeys(db, table);
    const seenNoRowid = new Set<number>();
    const enc = (c: ColInfo, alias: string) => {
      const a = affinity(c.type);
      const ref = `${alias}"${c.name}"`;
      return a === 'BLOB' ? `quote(${ref})` : `quote(CAST(${ref} AS ${a}))`;
    };
    const keySql = (alias: string) => `json_array(${keyCols.map((c) => enc(c, alias)).join(', ')})`;
    for (const v of rows) {
      const fkCols = fks.filter((f) => f.id === v.fkid).sort((a, b) => a.seq - b.seq);
      const fkSql = (alias: string) =>
        `json_array(${fkCols.map((f) => `quote(${alias}"${f.from}")`).join(', ')})`;
      let identities: Array<{ k: string; f: string }>;
      if (v.rowid !== null && v.rowid !== undefined) {
        identities = db
          .prepare(
            `SELECT ${keySql('')} AS k, ${fkSql('')} AS f FROM main."${table}" WHERE rowid = ?`,
          )
          .all(v.rowid) as Array<{ k: string; f: string }>;
      } else {
        // WITHOUT ROWID: no rowid to point at; list this FK's violating rows.
        const parentPk = (
          db.prepare(`PRAGMA main.table_info("${v.parent}")`).all() as unknown as ColInfo[]
        )
          .filter((c) => c.pk > 0)
          .sort((a, b) => a.pk - b.pk)
          .map((c) => c.name);
        const match = fkCols
          .map((f, i) => `p."${f.to ?? parentPk[i] ?? f.from}" = c."${f.from}"`)
          .join(' AND ');
        identities = db
          .prepare(
            `SELECT ${keySql('c.')} AS k, ${fkSql('c.')} AS f FROM main."${table}" c ` +
              `WHERE ${fkCols.map((f) => `c."${f.from}" IS NOT NULL`).join(' AND ')} ` +
              `AND NOT EXISTS (SELECT 1 FROM main."${v.parent}" p WHERE ${match})`,
          )
          .all() as Array<{ k: string; f: string }>;
        // foreign_key_check lists one row per violation; this query lists them
        // all at once, so take it for the first report of this FK only.
        if (seenNoRowid.has(v.fkid)) identities = [];
        seenNoRowid.add(v.fkid);
      }
      for (const id of identities) {
        const key = JSON.stringify([table, id.k, v.parent, fkCols.map((f) => f.from), id.f]);
        out.set(key, (out.get(key) ?? 0) + 1);
      }
    }
  }
  return out;
}

/** Keys whose count in `after` exceeds their count in `before`. */
export function newViolations(before: Map<string, number>, after: Map<string, number>): string[] {
  const out: string[] = [];
  for (const [k, n] of after) {
    const extra = n - (before.get(k) ?? 0);
    for (let i = 0; i < extra; i++) out.push(k);
  }
  return out;
}

function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.round(ms));
}

/** Run `fn`, retrying the whole thing on SQLITE_BUSY with backoff. */
function withBusyRetry<T>(fn: () => T): T {
  for (let attempt = 1; ; attempt++) {
    try {
      return fn();
    } catch (err) {
      if (!isSqliteBusy(err) || attempt >= MAX_BUSY_RETRIES) throw err;
      sleepMs(
        Math.min(
          BUSY_BASE_DELAY_MS * 2 ** (attempt - 1) * (1 + Math.random() * 0.5),
          BUSY_MAX_DELAY_MS,
        ),
      );
    }
  }
}

function readForeignKeys(db: DatabaseSync): number {
  return Number((db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys);
}

/**
 * The leading bracket of a lineage: reconcile (when configured), then
 * drizzle's journal-format upgrade, then create the journal table on a new
 * store. Returns the names already journaled.
 */
function leadingBracket(
  nativeDb: DatabaseSync,
  // biome-ignore lint/suspicious/noExplicitAny: drizzle's session type is generic over the schema
  db: NodeSQLiteDatabase<any>,
  lineage: MigrationLineage,
  migrations: MigrationMeta[],
): void {
  withBusyRetry(() => {
    nativeDb.exec('BEGIN IMMEDIATE');
    try {
      if (lineage.reconcile) {
        reconcileJournal(
          nativeDb,
          lineage.folder,
          lineage.reconcile.existenceTable,
          lineage.reconcile.logSubsystem,
          lineage.reconcile.siblings ?? [],
        );
      }
      // Drizzle's own upgrade, with its inner transaction folded into ours.
      const session = db._.session;
      const inBracket = new Proxy(session, {
        get(target, prop, receiver) {
          if (prop === 'transaction') return (fn: (tx: unknown) => unknown) => fn(receiver);
          return Reflect.get(target, prop, receiver);
        },
      });
      const { newDb } = upgradeSyncIfNeeded(MIGRATIONS_TABLE, inBracket, migrations);
      if (newDb) {
        session.run(sql`
			CREATE TABLE IF NOT EXISTS ${sql.identifier(MIGRATIONS_TABLE)} (
				id INTEGER PRIMARY KEY,
				hash text NOT NULL,
				created_at numeric,
				name text,
				applied_at TEXT
			)`);
      }
      nativeDb.exec('COMMIT');
    } catch (err) {
      if (nativeDb.isTransaction) nativeDb.exec('ROLLBACK');
      throw err;
    }
  });
}

/** A journal row as drizzle's `getMigrationsToRun` reads it. */
interface JournalRow {
  id: number;
  hash: string;
  created_at: string;
  name: string | null;
}

function journalRows(nativeDb: DatabaseSync): JournalRow[] {
  return nativeDb
    .prepare(`SELECT id, hash, created_at, name FROM main."${MIGRATIONS_TABLE}"`)
    .all() as unknown as JournalRow[];
}

/**
 * Apply one migration file in its own bracket. Returns whether it ran with
 * foreign keys off.
 */
function migrationBracket(
  nativeDb: DatabaseSync,
  migration: MigrationMeta,
  hooks: MigrationBracketHooks,
): boolean {
  const statements = migration.sql;
  const rebuilt = rebuiltTables(statements);
  const rebuild = rebuilt.length > 0;
  const prev = readForeignKeys(nativeDb);
  let failure: unknown;
  let committed = false;
  try {
    if (rebuild) nativeDb.exec('PRAGMA foreign_keys = OFF');
    nativeDb.exec('BEGIN IMMEDIATE');
    const scopeTables = [...rebuilt, ...dmlTables(statements)];
    const before = rebuild
      ? foreignKeyViolations(nativeDb, foreignKeyScope(nativeDb, scopeTables))
      : new Map<string, number>();
    hooks.suspendCapture?.(nativeDb);
    for (const stmt of statements) nativeDb.prepare(stmt).run();
    nativeDb
      .prepare(
        `INSERT INTO main."${MIGRATIONS_TABLE}" ("hash", "created_at", "name", "applied_at") values(?, ?, ?, ?)`,
      )
      .run(
        migration.hash,
        migration.folderMillis,
        migration.name ?? null,
        new Date().toISOString(),
      );
    if (rebuild) {
      // Re-scope after the statements: the rebuild may have created tables.
      const after = foreignKeyViolations(nativeDb, foreignKeyScope(nativeDb, scopeTables));
      const added = newViolations(before, after);
      if (added.length > 0) throw new MigrationForeignKeyError(migration.name ?? '', added);
    }
    hooks.reinstallCapture?.(nativeDb);
    nativeDb.exec('COMMIT');
    committed = true;
  } catch (err) {
    failure = err;
  }
  // NEW-6: never leave a pooled handle inside a transaction or with FK off.
  if (nativeDb.isTransaction) nativeDb.exec('ROLLBACK');
  nativeDb.exec(`PRAGMA foreign_keys = ${prev}`);
  const now = readForeignKeys(nativeDb);
  if (now !== prev || nativeDb.isTransaction) {
    throw Object.assign(new ForeignKeysNotRestoredError(prev, now), { cause: failure });
  }
  if (!committed) throw failure;
  return rebuild;
}

/**
 * Apply every pending migration of each lineage, in order, with the journal
 * `migrateSync` would leave, one bracket per file.
 *
 * @param nativeDb - The store handle.
 * @param db - The drizzle wrapper of `nativeDb` (for drizzle's journal upgrade).
 * @param lineages - The lineages sharing the journal, in apply order.
 * @param hooks - Optional D4 hooks.
 */
export function runBracketedMigrations(
  nativeDb: DatabaseSync,
  // biome-ignore lint/suspicious/noExplicitAny: drizzle's session type is generic over the schema
  db: NodeSQLiteDatabase<any>,
  lineages: readonly MigrationLineage[],
  hooks: MigrationBracketHooks = {},
): MigrationRunReport {
  const applied: string[] = [];
  const rebuilds: string[] = [];
  let hooked = false;
  for (const lineage of lineages) {
    const raw = readMigrationFiles({ migrationsFolder: lineage.folder });
    // T12687: a worktree build never applies its migrations to a foreign store.
    assertNoPendingMigrationsForWorktreeBuild(nativeDb, raw);
    const migrations = sanitizeMigrationStatements(raw);
    let reconciledDuplicate = false;
    let reconciledExists = false;
    leadingBracket(nativeDb, db, lineage, migrations);
    for (;;) {
      const pending = getMigrationsToRun({
        localMigrations: migrations,
        dbMigrations: journalRows(nativeDb),
      });
      if (pending.length === 0) break;
      if (!hooked) {
        hooks.beforeMigrations?.(nativeDb);
        hooked = true;
      }
      const next = pending[0] as MigrationMeta;
      try {
        const rebuild = withBusyRetry(() => migrationBracket(nativeDb, next, hooks));
        applied.push(next.name ?? '');
        if (rebuild) rebuilds.push(next.name ?? '');
        hooks.afterMigration?.(nativeDb, { name: next.name ?? '', hash: next.hash });
      } catch (err) {
        const dup = isDuplicateColumnError(err) && !reconciledDuplicate;
        const exists = isTableAlreadyExistsError(err) && !reconciledExists;
        if (lineage.reconcile && (dup || exists)) {
          if (dup) reconciledDuplicate = true;
          if (exists) reconciledExists = true;
          getLogger(lineage.reconcile.logSubsystem).warn(
            { migration: next.name, message: (err as Error).message },
            'Migration hit an already-applied DDL target; reconciling the journal and retrying',
          );
          leadingBracket(nativeDb, db, lineage, migrations);
          continue;
        }
        throw err;
      }
    }
  }
  return { applied, rebuilds };
}

/**
 * Same as {@link runBracketedMigrations} for one lineage, in the shape the
 * callers of `reconcileJournal` + `migrateWithRetry` use today.
 */
export function migrateBracketed(
  // biome-ignore lint/suspicious/noExplicitAny: drizzle's session type is generic over the schema
  db: NodeSQLiteDatabase<any>,
  nativeDb: DatabaseSync,
  migrationsFolder: string,
  existenceTable: string,
  logSubsystem: string,
  siblings: readonly string[] = [],
  hooks: MigrationBracketHooks = {},
): MigrationRunReport {
  return runBracketedMigrations(
    nativeDb,
    db,
    [{ folder: migrationsFolder, reconcile: { existenceTable, logSubsystem, siblings } }],
    hooks,
  );
}
