/**
 * Rebuild an unconvergeable legacy `drizzle-tasks` table family inside a
 * consolidated `cleo.db`.
 *
 * ## The failure (T12346)
 *
 * Post-E6 the project store is `cleo.db`, and the tasks domain still replays
 * the legacy `drizzle-tasks` lineage on it. That lineage creates the BARE table
 * family (`tasks`, `sessions`, `architecture_decisions`, `attachments`, …),
 * which is dead for task reads and writes (those use the prefixed
 * `tasks_tasks` family), apart from a few still-live tables such as `attachments`.
 * On a fresh project the lineage runs from scratch on empty tables.
 *
 * Some projects instead carry a `cleo.db` that began life as a copy of their
 * pre-consolidation `tasks.db` (claude-todo: every bare table row-identical to
 * `tasks.db`). Its journal was written by the old created_at HIGH-WATER
 * migrator, which treated every migration older than the newest applied one as
 * done — so 40 lineage migrations were never executed, and their tables and
 * columns never existed. Drizzle 1.x selects pending migrations BY NAME, so it
 * replays those gaps against a schema they were never written for:
 *
 * - `t033` rebuilds `architecture_decisions` with a self-FK, and a reference
 *   that was ALREADY dangling fails the copy (`FOREIGN KEY constraint failed`);
 * - with that out of the way, `t033` rebuilds `tasks` without `assignee`, which a
 *   later migration then SELECTs (`no such column: assignee`);
 * - stamping the gaps as applied (the high-water reading) instead leaves the
 *   later migrations reaching for tables the gaps create (`no such table:
 *   attachments`).
 *
 * No replay order converges, and every command in the project dies at open.
 *
 * ## The repair
 *
 * The lineage objects are rebuilt exactly as a fresh project gets them:
 *
 * 1. `VACUUM INTO` a full snapshot of the database (the bare rows are preserved
 *    there byte-for-byte; the repair refuses to proceed without it);
 * 2. in ONE transaction, drop every table, view, trigger and index the lineage
 *    creates — never an object any sibling lineage (consolidated schema, brain,
 *    nexus, …) also creates — and delete only the lineage's journal rows;
 * 3. in the same transaction, execute the whole lineage in order, journaling each
 *    migration as drizzle does.
 *
 * Any failure rolls the transaction back, leaving the database byte-identical
 * to before, and the caller rethrows the original migration error. The
 * prefixed tables, which hold the project's live data, are never touched.
 *
 * @module
 * @task T12346
 */

import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { getLogger } from '../logger.js';
import { sanitizeMigrationStatements, stripSqlComments } from './migration-manager.js';

const log = getLogger('legacy-tasks-lineage');

/** Kinds of schema object a lineage can create. */
type SchemaObjectKind = 'table' | 'view' | 'trigger' | 'index';

/** Schema objects a migration folder creates, by kind (final names after renames). */
function createdObjects(migrationsFolder: string): Map<string, SchemaObjectKind> {
  const created = new Map<string, SchemaObjectKind>();
  for (const migration of readMigrationFiles({ migrationsFolder })) {
    const sql = stripSqlComments(migration.sql.join('\n'));
    const renamed = new Map<string, string>();
    for (const m of sql.matchAll(
      /ALTER\s+TABLE\s+[`"]?(\w+)[`"]?\s+RENAME\s+TO\s+[`"]?(\w+)[`"]?/gi,
    )) {
      renamed.set(m[1] as string, m[2] as string);
    }
    const patterns: ReadonlyArray<[RegExp, SchemaObjectKind]> = [
      [/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"]?(\w+)[`"]?/gi, 'table'],
      [/CREATE\s+VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"]?(\w+)[`"]?/gi, 'view'],
      [/CREATE\s+TRIGGER\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"]?(\w+)[`"]?/gi, 'trigger'],
      [/CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"]?(\w+)[`"]?/gi, 'index'],
    ];
    for (const [pattern, kind] of patterns) {
      for (const m of sql.matchAll(pattern)) {
        const name = m[1] as string;
        created.set(kind === 'table' ? (renamed.get(name) ?? name) : name, kind);
      }
    }
  }
  return created;
}

/** Outcome of {@link rebuildLegacyTasksLineage}. */
export interface LegacyTasksLineageRebuild {
  /** Full pre-repair snapshot of the database (holds every dropped row). */
  readonly snapshotPath: string;
  /** Lineage objects that existed and were dropped, by name. */
  readonly dropped: readonly string[];
  /** Lineage migrations executed afresh. */
  readonly migrationsApplied: number;
}

/**
 * Rebuild the `drizzle-tasks` table family of a consolidated `cleo.db` from
 * scratch, after snapshotting the whole database. Atomic: on any failure the
 * transaction is rolled back and the error is rethrown.
 *
 * @param nativeDb - Connection on the consolidated `cleo.db`; must not be mid-transaction.
 * @param dbPath - Absolute path of that database (the snapshot goes beside it).
 * @param migrationsFolder - The `drizzle-tasks` migrations folder.
 * @param siblingFolders - Every other lineage sharing this database; objects
 *   they create are never dropped.
 * @returns What was snapshotted, dropped and applied.
 * @throws When the snapshot cannot be written, or when the rebuild fails (rolled back).
 * @task T12346
 */
export function rebuildLegacyTasksLineage(
  nativeDb: DatabaseSync,
  dbPath: string,
  migrationsFolder: string,
  siblingFolders: readonly string[],
): LegacyTasksLineageRebuild {
  if (nativeDb.isTransaction)
    throw new Error('legacy tasks lineage rebuild needs a connection outside a transaction');

  const migrations = sanitizeMigrationStatements(readMigrationFiles({ migrationsFolder }));
  // Never drop anything unless there is a lineage to rebuild it from.
  if (migrations.length === 0)
    throw new Error(
      `no drizzle-tasks migrations found in ${migrationsFolder}; refusing to rebuild`,
    );
  const lineage = createdObjects(migrationsFolder);
  const shared = new Set<string>();
  for (const folder of siblingFolders) {
    for (const name of createdObjects(folder).keys()) shared.add(name);
  }
  const existing = nativeDb
    .prepare("SELECT name, type FROM main.sqlite_master WHERE name NOT LIKE 'sqlite_%'")
    .all() as Array<{ name: string; type: string }>;
  const toDrop = existing.filter(
    (o) =>
      lineage.get(o.name) === o.type && !shared.has(o.name) && o.name !== '__drizzle_migrations',
  );

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = join(dirname(dbPath), 'backups');
  mkdirSync(backupDir, { recursive: true });
  const snapshotPath = join(backupDir, `cleo-pre-t12346-lineage-rebuild-${stamp}.db`);
  nativeDb.exec(`VACUUM INTO '${snapshotPath.replace(/'/g, "''")}'`);

  const lineageHashes = migrations.map((m) => m.hash);
  const order: readonly SchemaObjectKind[] = ['trigger', 'view', 'index', 'table'];

  const fkRow = nativeDb.prepare('PRAGMA foreign_keys').get() as
    | { foreign_keys: number }
    | undefined;
  const fkWasOn = fkRow?.foreign_keys === 1;
  // Dropping a parent that rows in a SIBLING table still reference (e.g. bare
  // `releases` ← `brain_release_links`) is an FK violation with enforcement on.
  // A fresh project has exactly this layout, so the pragma is lifted for the
  // rebuild — outside the transaction, the only place it takes effect.
  if (fkWasOn) nativeDb.exec('PRAGMA foreign_keys=OFF');
  try {
    nativeDb.exec('BEGIN');
    try {
      for (const kind of order) {
        for (const o of toDrop.filter((x) => x.type === kind)) {
          nativeDb.exec(`DROP ${kind.toUpperCase()} IF EXISTS main."${o.name}"`);
        }
      }
      const del = nativeDb.prepare('DELETE FROM "__drizzle_migrations" WHERE hash = ?');
      for (const hash of lineageHashes) del.run(hash);
      const journal = nativeDb.prepare(
        'INSERT INTO "__drizzle_migrations" ("hash", "created_at", "name", "applied_at") VALUES (?, ?, ?, ?)',
      );
      for (const migration of migrations) {
        for (const stmt of migration.sql) nativeDb.exec(stmt);
        journal.run(
          migration.hash,
          migration.folderMillis,
          migration.name ?? null,
          new Date().toISOString(),
        );
      }
      nativeDb.exec('COMMIT');
    } catch (error) {
      nativeDb.exec('ROLLBACK');
      throw error;
    }
  } finally {
    if (fkWasOn) nativeDb.exec('PRAGMA foreign_keys=ON');
  }

  const dropped = toDrop.map((o) => o.name);
  log.warn(
    { snapshotPath, dropped: dropped.length, migrationsApplied: migrations.length },
    'legacy drizzle-tasks family could not be migrated in place (high-water journal gaps); ' +
      `rebuilt it fresh — the previous bare tables are preserved in ${snapshotPath} (T12346)`,
  );
  return { snapshotPath, dropped, migrationsApplied: migrations.length };
}
