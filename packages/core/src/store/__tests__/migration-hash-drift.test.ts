/**
 * Regression test for reconcileJournal orphan handling.
 *
 * History: an earlier release (v2026.5.128) introduced a "hash-drift" recovery
 * path that, when a journal entry's NAME matched a local migration but its hash
 * differed (because the migration file's SQL was edited in a release), UPDATEd
 * the journal entry's hash in place rather than deleting it.
 *
 * T11528 (E6-L8): that hash-drift sub-case was removed. All DDL is now owned by
 * immutable Drizzle forward migrations (v1.0.0-rc.3 contract, E6 L1-L7);
 * migration files are never edited post-release, so name-matched hash drift can
 * no longer occur. reconcileJournal now has exactly two Scenario-2 sub-cases:
 *
 *   A) DB AHEAD — all local hashes present plus extra orphans → skip (no mutation).
 *   B) TRUE ORPHANS — orphan hashes with no local match → delete + re-probe via DDL.
 *
 * These tests pin that two-sub-case contract.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function getTasksMigrationsFolder(): string {
  return join(__dirname, '..', '..', '..', 'migrations', 'drizzle-tasks');
}

describe('reconcileJournal — orphan reconciliation (post hash-drift removal)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cleo-orphan-reconcile-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('Sub-case A: skips reconciliation (no mutation) when the DB is ahead of this install', async () => {
    const { openNativeDatabase } = await import('../sqlite.js');
    const { reconcileJournal } = await import('../migration-manager.js');
    const { readMigrationFiles } = await import('drizzle-orm/migrator');

    const migrationsFolder = getTasksMigrationsFolder();
    const localMigrations = readMigrationFiles({ migrationsFolder });

    const dbPath = join(tempDir, 'db-ahead.db');
    const nativeDb = openNativeDatabase(dbPath);
    nativeDb.exec(`CREATE TABLE tasks (id text PRIMARY KEY, title text NOT NULL);`);
    nativeDb.exec(`
      CREATE TABLE "__drizzle_migrations" (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        hash text NOT NULL,
        created_at numeric,
        name text,
        applied_at TEXT
      )
    `);
    // Seed every local migration (all local hashes present in DB) PLUS one extra
    // entry for a future migration this install does not know about. This is the
    // "DB ahead" / forward-compatibility case → reconcileJournal must NOT touch it.
    for (const m of localMigrations) {
      nativeDb.exec(
        `INSERT INTO "__drizzle_migrations" ("hash", "created_at", "name") VALUES ('${m.hash}', ${m.folderMillis}, '${m.name ?? ''}')`,
      );
    }
    nativeDb.exec(
      `INSERT INTO "__drizzle_migrations" ("hash", "created_at", "name") VALUES ('feedface000000000000000000000000000000000000000000000000feedface', 99999999999999, '99999999999999_future-migration-from-newer-cleo')`,
    );

    const before = nativeDb.prepare('SELECT id, hash, name FROM "__drizzle_migrations"').all();

    reconcileJournal(nativeDb, migrationsFolder, 'tasks', 'tasks');

    const after = nativeDb.prepare('SELECT id, hash, name FROM "__drizzle_migrations"').all();
    expect(after, 'DB-ahead reconciliation must be a no-op (journal untouched)').toEqual(before);

    nativeDb.close();
  });

  it('Sub-case B: a name-matched stale hash is treated as a true orphan and deleted (NOT updated in place)', async () => {
    const { openNativeDatabase } = await import('../sqlite.js');
    const { reconcileJournal } = await import('../migration-manager.js');
    const { readMigrationFiles } = await import('drizzle-orm/migrator');

    const migrationsFolder = getTasksMigrationsFolder();
    const localMigrations = readMigrationFiles({ migrationsFolder });

    // Pick t033 — the migration that, historically, the hash-drift path targeted.
    const targetMig = localMigrations.find((m) => m.name?.includes('t033'));
    expect(targetMig, 'expected t033 migration to exist').toBeDefined();
    const newHash = targetMig!.hash;
    const staleHash = 'b928367a3ec05fcc0ef24e36af5dbca5323a0a806eaf33f8860f2cded54e2b74';
    expect(newHash).not.toBe(staleHash);

    const dbPath = join(tempDir, 'stale-hash.db');
    const nativeDb = openNativeDatabase(dbPath);
    // Minimal schema: t033's DDL targets are absent, so probeAndMarkApplied cannot
    // re-journal it. This makes the deletion observable.
    nativeDb.exec(
      `CREATE TABLE IF NOT EXISTS tasks (id text PRIMARY KEY, title text NOT NULL, status text DEFAULT 'pending' NOT NULL);`,
    );
    nativeDb.exec(`
      CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        hash text NOT NULL,
        created_at numeric,
        name text,
        applied_at TEXT
      )
    `);
    // Seed every local migration; give t033 a stale hash so it is name-matched
    // but hash-orphaned. Because t033's NEW hash is absent from the DB,
    // allLocalHashesPresentInDb is false → Sub-case B (true orphan) fires.
    for (const m of localMigrations) {
      const hash = m === targetMig ? staleHash : m.hash;
      nativeDb.exec(
        `INSERT INTO "__drizzle_migrations" ("hash", "created_at", "name") VALUES ('${hash}', ${m.folderMillis}, '${m.name ?? ''}')`,
      );
    }

    reconcileJournal(nativeDb, migrationsFolder, 'tasks', 'tasks');

    // The stale-hash entry must be DELETED (the removed hash-drift path would have
    // UPDATEd it to newHash in place). With the DDL targets absent, t033 cannot be
    // re-probed, so no row carries either the stale or the new hash.
    const hashesAfter = new Set(
      (
        nativeDb.prepare('SELECT hash FROM "__drizzle_migrations"').all() as Array<{ hash: string }>
      ).map((r) => r.hash),
    );
    expect(hashesAfter.has(staleHash), 'stale-hash orphan must be deleted, not retained').toBe(
      false,
    );
    expect(
      hashesAfter.has(newHash),
      'hash drift is no longer repaired in place — t033 is not re-journaled when its DDL is absent',
    ).toBe(false);

    nativeDb.close();
  });

  it('Sub-case B: deletes a true orphan (name with no local match) and preserves applied local migrations', async () => {
    const { openNativeDatabase } = await import('../sqlite.js');
    const { reconcileJournal } = await import('../migration-manager.js');
    const { readMigrationFiles } = await import('drizzle-orm/migrator');

    const migrationsFolder = getTasksMigrationsFolder();
    const localMigrations = readMigrationFiles({ migrationsFolder });

    const dbPath = join(tempDir, 'true-orphan.db');
    const nativeDb = openNativeDatabase(dbPath);
    nativeDb.exec(`CREATE TABLE tasks (id text PRIMARY KEY, title text NOT NULL);`);
    nativeDb.exec(`
      CREATE TABLE "__drizzle_migrations" (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        hash text NOT NULL,
        created_at numeric,
        name text,
        applied_at TEXT
      )
    `);
    // Seed every local migration EXCEPT the last one. This makes the DB look
    // like a slightly-older install where one new migration hasn't run yet.
    // Then add a true orphan whose hash has no local match. Because the last
    // local migration's hash is absent, allLocalHashesPresentInDb is false →
    // Sub-case B fires → the orphan is deleted.
    const seedMigrations = localMigrations.slice(0, -1);
    for (const m of seedMigrations) {
      nativeDb.exec(
        `INSERT INTO "__drizzle_migrations" ("hash", "created_at", "name") VALUES ('${m.hash}', ${m.folderMillis}, '${m.name ?? ''}')`,
      );
    }
    nativeDb.exec(
      `INSERT INTO "__drizzle_migrations" ("hash", "created_at", "name") VALUES ('deadbeef000000000000000000000000000000000000000000000000deadbeef', 0, '00000000000000_removed-from-disk-migration')`,
    );

    reconcileJournal(nativeDb, migrationsFolder, 'tasks', 'tasks');

    const remaining = nativeDb.prepare('SELECT name FROM "__drizzle_migrations"').all() as Array<{
      name: string | null;
    }>;

    // The true orphan must be gone.
    expect(remaining.some((r) => r.name === '00000000000000_removed-from-disk-migration')).toBe(
      false,
    );
    // Every seeded (i.e. previously-applied) local migration must remain.
    for (const m of seedMigrations) {
      expect(
        remaining.some((r) => r.name === m.name),
        `previously-applied local migration ${m.name} must remain journaled after true-orphan cleanup`,
      ).toBe(true);
    }

    nativeDb.close();
  });
});
