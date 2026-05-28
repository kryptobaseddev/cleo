/**
 * Regression test for the migration journal hash-drift recovery.
 *
 * Pre-fix bug (v2026.5.128): when a release modifies an existing migration's
 * SQL, drizzle's content-hash changes. reconcileJournal saw the DB's old hash
 * as "orphaned" (not in local) and the local's new hash as "missing in DB",
 * matched both conditions, and triggered Sub-case B which DELETEd the entire
 * journal and re-probed every migration via DDL. Data-only migrations (UPDATEs,
 * INSERTs) that couldn't be probed were left unjournaled and re-run by drizzle,
 * crashing the migrate() call.
 *
 * Fix (v2026.5.129): partition orphans by NAME match. Entries whose name
 * matches a local migration but whose hash differs are HASH DRIFT — UPDATE the
 * entry's hash in place. Only entries with no name match are true orphans and
 * fall through to the delete+probe path.
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

describe('reconcileJournal — hash-drift recovery', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cleo-hash-drift-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('updates hash in place when a known migration name has a stale hash', async () => {
    const { openNativeDatabase } = await import('../sqlite.js');
    const { reconcileJournal } = await import('../migration-manager.js');
    const { readMigrationFiles } = await import('drizzle-orm/migrator');

    const migrationsFolder = getTasksMigrationsFolder();
    const localMigrations = readMigrationFiles({ migrationsFolder });

    // Pick t033 — modified by v2026.5.128, so it's the canonical drift case.
    const targetMig = localMigrations.find((m) => m.name?.includes('t033'));
    expect(targetMig, 'expected t033 migration to exist').toBeDefined();
    const newHash = targetMig!.hash;
    const staleHash = 'b928367a3ec05fcc0ef24e36af5dbca5323a0a806eaf33f8860f2cded54e2b74';
    expect(newHash).not.toBe(staleHash);

    const dbPath = join(tempDir, 'drift.db');
    const nativeDb = openNativeDatabase(dbPath);

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
    for (const m of localMigrations) {
      const hash = m === targetMig ? staleHash : m.hash;
      nativeDb.exec(
        `INSERT INTO "__drizzle_migrations" ("hash", "created_at", "name") VALUES ('${hash}', ${m.folderMillis}, '${m.name ?? ''}')`,
      );
    }

    const journalSizeBefore = (
      nativeDb.prepare('SELECT COUNT(*) AS n FROM "__drizzle_migrations"').get() as { n: number }
    ).n;
    expect(journalSizeBefore).toBe(localMigrations.length);

    reconcileJournal(nativeDb, migrationsFolder, 'tasks', 'tasks');

    const journalSizeAfter = (
      nativeDb.prepare('SELECT COUNT(*) AS n FROM "__drizzle_migrations"').get() as { n: number }
    ).n;
    expect(
      journalSizeAfter,
      'reconcileJournal must NOT delete entries — drift entries should be updated in place',
    ).toBe(journalSizeBefore);

    const t033Row = nativeDb
      .prepare('SELECT hash FROM "__drizzle_migrations" WHERE name = ?')
      .get(targetMig!.name) as { hash: string } | undefined;
    expect(t033Row?.hash, 'drifted entry must be updated to new hash').toBe(newHash);

    nativeDb.close();
  });

  it('does NOT wipe the journal when SQL edits change one hash', async () => {
    const { openNativeDatabase } = await import('../sqlite.js');
    const { reconcileJournal } = await import('../migration-manager.js');
    const { readMigrationFiles } = await import('drizzle-orm/migrator');

    const migrationsFolder = getTasksMigrationsFolder();
    const localMigrations = readMigrationFiles({ migrationsFolder });
    const targetMig = localMigrations.find((m) => m.name?.includes('t033'));

    const dbPath = join(tempDir, 'no-wipe.db');
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
    for (const m of localMigrations) {
      const hash =
        m === targetMig
          ? 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
          : m.hash;
      nativeDb.exec(
        `INSERT INTO "__drizzle_migrations" ("hash", "created_at", "name") VALUES ('${hash}', ${m.folderMillis}, '${m.name ?? ''}')`,
      );
    }

    reconcileJournal(nativeDb, migrationsFolder, 'tasks', 'tasks');

    // Every name-matched local migration's hash must end up in the journal.
    const remainingHashes = new Set(
      (
        nativeDb.prepare('SELECT hash FROM "__drizzle_migrations"').all() as Array<{ hash: string }>
      ).map((r) => r.hash),
    );
    for (const m of localMigrations) {
      expect(
        remainingHashes.has(m.hash),
        `migration ${m.name} (hash ${m.hash.slice(0, 12)}) must remain journaled after reconcile`,
      ).toBe(true);
    }

    nativeDb.close();
  });

  it('deletes true orphans (entry whose name has no local match) when some local hashes are missing too', async () => {
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
    // Then add a true orphan with no name match. Because the last local
    // migration's hash is absent, allLocalHashesPresentInDb is false → Sub-case
    // B fires → true-orphan branch processes the orphan.
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
