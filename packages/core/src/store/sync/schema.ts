/**
 * The change journal's own schema, applied lazily.
 *
 * The DDL lives in `packages/core/migrations/sync-journal/<folder>/migration.sql`,
 * one folder per migration, like the drizzle lineages. It is NOT a drizzle
 * lineage: it runs when a `sync.*` flag is first enabled on a store, or when
 * `cleo project link` binds the project store to a replica
 * (`ensureProjectReplica`, device contract §3.7) with every flag still off
 * ({@link ensureSyncSchema}). A store that is neither synced nor linked never
 * gains a table or a journal row. (Do not edit migration.sql comments: their
 * hash is recorded per store.) Applied folders are recorded in
 * `_sync_meta` under `schema:<folder>` with the sha256 of the folder's SQL,
 * never in `__drizzle_migrations`. A folder whose SQL changed after it was
 * applied is refused with {@link SyncSchemaHashDriftError}, never skipped.
 *
 * @task T12342
 * @module store/sync/schema
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { resolveCorePackageMigrationsFolder } from '../resolve-migrations-folder.js';

/** The migrations sub-directory that holds the sync schema. */
export const SYNC_SCHEMA_SET = 'sync-journal';

/**
 * `_sync_meta` key prefix of a stream's genesis cut (§2.11 §10): S4 records
 * `${GENESIS_CUT_KEY_PREFIX}<stream>` when it cuts genesis for that stream.
 * The repair diff reads it to know the stream has started (T13217), so both
 * sides name the key through this constant, never a hand-typed string.
 */
export const GENESIS_CUT_KEY_PREFIX = 'genesis_cut:';

/** Key prefix under which `_sync_meta` records an applied schema folder. */
const APPLIED_PREFIX = 'schema:';

/** One sync schema folder. */
export interface SyncSchemaFolder {
  readonly name: string;
  readonly sql: string;
  /** sha256 of `sql`, hex. */
  readonly hash: string;
}

/**
 * An applied sync schema folder whose SQL no longer matches what was applied
 * (in the spirit of `E_MIGRATION_HASH_DRIFT`). Editing an applied folder is
 * never correct: add a new folder instead.
 */
export class SyncSchemaHashDriftError extends Error {
  readonly code = 'E_SYNC_SCHEMA_HASH_DRIFT';

  constructor(
    readonly folder: string,
    readonly applied: string,
    readonly current: string,
  ) {
    super(
      `sync schema folder ${folder} was applied with sha256 ${applied}, but its SQL now hashes ` +
        `to ${current}. An applied folder must never change; add a new folder instead.`,
    );
    this.name = 'SyncSchemaHashDriftError';
  }
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

/** Whether a table exists in the `main` schema. Read-only. */
export function hasTable(db: DatabaseSync, table: string): boolean {
  return (
    db.prepare("SELECT 1 FROM main.sqlite_master WHERE type = 'table' AND name = ?").get(table) !==
    undefined
  );
}

/** The sync schema folders, oldest first. */
export function syncSchemaFolders(
  root: string = resolveCorePackageMigrationsFolder(SYNC_SCHEMA_SET),
): SyncSchemaFolder[] {
  if (!existsSync(root)) {
    // @sync-invariant none:local-only install-time packaging check for the journal schema folder
    throw new Error(`sync schema folder not found: ${root}`);
  }
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(root, d.name, 'migration.sql')))
    .map((d) => d.name)
    .sort()
    .map((name) => {
      const sql = readFileSync(join(root, name, 'migration.sql'), 'utf8');
      return { name, sql, hash: sha256(sql) };
    });
}

/**
 * The schema folders already applied to this store, with the sha256 each was
 * applied with. Read-only: a store with no `_sync_meta` has none.
 */
export function appliedSyncSchemaHashes(db: DatabaseSync): Map<string, string> {
  if (!hasTable(db, '_sync_meta')) return new Map();
  const rows = db
    .prepare('SELECT key, value FROM _sync_meta WHERE key LIKE ? ORDER BY key')
    .all(`${APPLIED_PREFIX}%`) as Array<{ key: string; value: string }>;
  return new Map(rows.map((r) => [r.key.slice(APPLIED_PREFIX.length), r.value]));
}

/** The names of the schema folders already applied to this store. Read-only. */
export function appliedSyncSchema(db: DatabaseSync): string[] {
  return [...appliedSyncSchemaHashes(db).keys()];
}

/**
 * The folders still to apply, after checking every applied one for drift.
 *
 * @throws {SyncSchemaHashDriftError} When an applied folder's SQL changed.
 */
function pending(folders: readonly SyncSchemaFolder[], applied: Map<string, string>) {
  for (const f of folders) {
    const was = applied.get(f.name);
    if (was !== undefined && was !== f.hash)
      // @sync-invariant none:local-only a released journal-schema file changed on disk; refuses the local journal migration
      throw new SyncSchemaHashDriftError(f.name, was, f.hash);
  }
  return folders.filter((f) => !applied.has(f.name));
}

/**
 * Apply every sync schema folder this store has not applied yet, in one
 * transaction (a savepoint when the caller already holds one).
 *
 * The applied set is read again INSIDE the transaction, under the write
 * lock, so two processes enabling a flag at once apply each folder once.
 *
 * @param db - The store handle.
 * @param options - `root` overrides the schema folder (tests); `now` stamps
 *   the journal rows; `beforeLock` runs between the unlocked pre-check and
 *   taking the lock (a test seam for the two-process race).
 * @returns The folders applied by this call.
 * @throws {SyncSchemaHashDriftError} When an applied folder's SQL changed.
 */
export function ensureSyncSchema(
  db: DatabaseSync,
  options: { root?: string; now?: Date; beforeLock?: () => void } = {},
): string[] {
  const folders = syncSchemaFolders(options.root);
  // Unlocked pre-check: the common case (all applied) takes no write lock.
  if (pending(folders, appliedSyncSchemaHashes(db)).length === 0) return [];
  options.beforeLock?.();
  const stamp = (options.now ?? new Date()).toISOString();
  const nested = db.isTransaction;
  db.exec(nested ? 'SAVEPOINT sync_schema' : 'BEGIN IMMEDIATE');
  try {
    const todo = pending(folders, appliedSyncSchemaHashes(db));
    for (const f of todo) {
      // A store that carries a folder's tables without its journal row (a
      // vault bundle restored without `_sync_meta`) re-runs it: its ADD COLUMNs
      // must not fail on the columns it already has.
      db.exec(rerunnableSql(db, f.sql));
      db.prepare(
        'INSERT INTO _sync_meta (key, value, updated_at) VALUES (?, ?, ?) ' +
          'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
      ).run(`${APPLIED_PREFIX}${f.name}`, f.hash, stamp);
    }
    db.exec(nested ? 'RELEASE sync_schema' : 'COMMIT');
    return todo.map((f) => f.name);
  } catch (err) {
    db.exec(nested ? 'ROLLBACK TO sync_schema; RELEASE sync_schema' : 'ROLLBACK');
    throw err;
  }
}

/** `ALTER TABLE <t> ADD [COLUMN] <c> …;`: the one non-idempotent statement a folder may hold. */
const ADD_COLUMN_RE =
  /ALTER\s+TABLE\s+["`]?(\w+)["`]?\s+ADD\s+(?:COLUMN\s+)?["`]?(\w+)["`]?[^;]*;/gi;

/**
 * A folder's SQL made safe to re-run: every `ADD COLUMN` whose column the
 * table already has is dropped (SQLite has no `ADD COLUMN IF NOT EXISTS`).
 * A column of a table the re-run recreates is added again, in folder order.
 */
function rerunnableSql(db: DatabaseSync, sql: string): string {
  return sql.replace(ADD_COLUMN_RE, (stmt, table: string, column: string) => {
    if (!hasTable(db, table)) return stmt;
    const cols = db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>;
    return cols.some((c) => c.name === column) ? '' : stmt;
  });
}

/**
 * Re-run every APPLIED sync schema folder's SQL (`CREATE … IF NOT EXISTS`,
 * and `ADD COLUMN` only where the column is missing) when one of the sync
 * tables is missing: a store whose `_sync_capture` was dropped with capture
 * triggers still present fails every captured write, and the journal
 * already says the folder ran (§2.3a rule 9). A store with every table
 * present is left untouched.
 *
 * @returns Whether anything was re-run.
 */
export function healSyncSchema(
  db: DatabaseSync,
  expected: readonly string[],
  options: { root?: string } = {},
): boolean {
  if (expected.every((t) => hasTable(db, t))) return false;
  const applied = appliedSyncSchemaHashes(db);
  for (const f of syncSchemaFolders(options.root)) {
    // Folder by folder: a later folder's ADD COLUMN sees what an earlier one recreated.
    if (applied.has(f.name)) db.exec(rerunnableSql(db, f.sql));
  }
  return true;
}
