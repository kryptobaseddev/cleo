/**
 * The change journal's own schema, applied lazily.
 *
 * The DDL lives in `packages/core/migrations/sync-journal/<folder>/migration.sql`,
 * one folder per migration, like the drizzle lineages. It is NOT a drizzle
 * lineage: it runs only when a `sync.*` flag is first enabled on a store
 * ({@link ensureSyncSchema}), so a store with every flag off (the default)
 * never gains a table or a journal row. Applied folders are recorded in
 * `_sync_meta` under `schema:<folder>`, never in `__drizzle_migrations`.
 *
 * @task T12342
 * @module store/sync/schema
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { resolveCorePackageMigrationsFolder } from '../resolve-migrations-folder.js';

/** The migrations sub-directory that holds the sync schema. */
export const SYNC_SCHEMA_SET = 'sync-journal';

/** Key prefix under which `_sync_meta` records an applied schema folder. */
const APPLIED_PREFIX = 'schema:';

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
): Array<{
  name: string;
  sql: string;
}> {
  if (!existsSync(root)) {
    throw new Error(`sync schema folder not found: ${root}`);
  }
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(root, d.name, 'migration.sql')))
    .map((d) => d.name)
    .sort()
    .map((name) => ({ name, sql: readFileSync(join(root, name, 'migration.sql'), 'utf8') }));
}

/**
 * The schema folders already applied to this store. Read-only: a store with
 * no `_sync_meta` has none.
 */
export function appliedSyncSchema(db: DatabaseSync): string[] {
  if (!hasTable(db, '_sync_meta')) return [];
  const rows = db
    .prepare('SELECT key FROM _sync_meta WHERE key LIKE ? ORDER BY key')
    .all(`${APPLIED_PREFIX}%`) as Array<{ key: string }>;
  return rows.map((r) => r.key.slice(APPLIED_PREFIX.length));
}

/**
 * Apply every sync schema folder this store has not applied yet, in one
 * transaction (a savepoint when the caller already holds one).
 *
 * @param db - The store handle.
 * @param options - `root` overrides the schema folder (tests); `now` stamps
 *   the journal rows.
 * @returns The folders applied by this call.
 */
export function ensureSyncSchema(
  db: DatabaseSync,
  options: { root?: string; now?: Date } = {},
): string[] {
  const folders = syncSchemaFolders(options.root);
  const done = new Set(appliedSyncSchema(db));
  const todo = folders.filter((f) => !done.has(f.name));
  if (todo.length === 0) return [];
  const stamp = (options.now ?? new Date()).toISOString();
  const nested = db.isTransaction;
  db.exec(nested ? 'SAVEPOINT sync_schema' : 'BEGIN IMMEDIATE');
  try {
    for (const f of todo) {
      db.exec(f.sql);
      db.prepare(
        'INSERT INTO _sync_meta (key, value, updated_at) VALUES (?, ?, ?) ' +
          'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
      ).run(`${APPLIED_PREFIX}${f.name}`, stamp, stamp);
    }
    db.exec(nested ? 'RELEASE sync_schema' : 'COMMIT');
  } catch (err) {
    db.exec(nested ? 'ROLLBACK TO sync_schema; RELEASE sync_schema' : 'ROLLBACK');
    throw err;
  }
  return todo.map((f) => f.name);
}
