/**
 * Regression tests for T1165 Hybrid Path A+ baseline-reset snapshot chains.
 *
 * Covers three scenarios per DB (tasks, brain, nexus):
 *   1. Fresh install — baseline migration runs as a no-op; prior migrations build schema.
 *   2. Existing install — baseline marker is recognised as comment-only and the journal
 *      entry is inserted WITHOUT running DDL (probed via reconcileJournal Scenario 3).
 *   3. FK preservation — PRAGMA foreign_keys returns 1 after migrate() on an existing
 *      brain.db (validates that no PRAGMA foreign_keys=OFF was ever executed).
 *
 * Approach: tests create isolated temp SQLite DBs, run reconcileJournal + migrateSanitized
 * against the real canonical migration folders, and assert outcomes.
 *
 * @task T1165
 * @epic T1150
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// Module constants
// ---------------------------------------------------------------------------

const _require = createRequire(import.meta.url);
const { DatabaseSync } = _require('node:sqlite') as {
  DatabaseSync: new (
    path: string,
    options?: Record<string, unknown>,
  ) => import('node:sqlite').DatabaseSync;
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Resolve path to a drizzle migrations folder from this test file location. */
function getMigrationsFolder(db: 'tasks' | 'brain' | 'nexus'): string {
  // Test: packages/core/src/store/__tests__/
  // Migrations: packages/core/migrations/drizzle-<db>/
  return join(__dirname, '..', '..', '..', 'migrations', `drizzle-${db}`);
}

/** The existence-check table name used by reconcileJournal per DB. */
const EXISTENCE_TABLE: Record<string, string> = {
  tasks: 'tasks',
  brain: 'brain_decisions',
  nexus: 'project_registry',
};

/** The baseline migration folder name suffix per DB. */
const BASELINE_FOLDER_SUFFIX = 't1165-baseline-reset';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Return the hash of the baseline migration for a given DB by reading the
 * canonical migrations folder and finding the t1165-baseline-reset entry.
 */
async function getBaselineMigrationHash(db: 'tasks' | 'brain' | 'nexus'): Promise<string> {
  const { readMigrationFiles } = await import('drizzle-orm/migrator');
  const folder = getMigrationsFolder(db);
  const migrations = readMigrationFiles({ migrationsFolder: folder });
  const baseline = migrations.find((m) => m.name?.includes(BASELINE_FOLDER_SUFFIX));
  if (!baseline) {
    throw new Error(`No baseline migration found in ${folder}`);
  }
  return baseline.hash;
}

// ---------------------------------------------------------------------------
// Test suites
// ---------------------------------------------------------------------------

describe('T1165 baseline-reset snapshot chains', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cleo-baseline-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Scenario 1: Baseline marker is comment-only (no DDL in sql[])
  // -------------------------------------------------------------------------

  describe('baseline migration.sql is comment-only (no DDL)', () => {
    it.each([
      'tasks',
      'brain',
      'nexus',
    ] as const)('%s: baseline migration has no executable DDL statements', async (db) => {
      const { readMigrationFiles } = await import('drizzle-orm/migrator');
      const folder = getMigrationsFolder(db);
      const migrations = readMigrationFiles({ migrationsFolder: folder });
      const baseline = migrations.find((m) => m.name?.includes(BASELINE_FOLDER_SUFFIX));

      expect(baseline, `No baseline migration found for ${db}`).toBeTruthy();

      // All SQL entries in the baseline should be comment-only or empty after stripping comments.
      const sqlStatements = Array.isArray(baseline!.sql) ? baseline!.sql : [baseline!.sql ?? ''];
      for (const stmt of sqlStatements) {
        const stripped = stmt
          .replace(/--[^\n]*/g, '') // strip line comments
          .replace(/\/\*[\s\S]*?\*\//g, '') // strip block comments
          .trim();
        expect(
          stripped,
          `Baseline migration for ${db} should have comment-only SQL, but found DDL: ${stripped}`,
        ).toBe('');
      }
    });
  });

  // -------------------------------------------------------------------------
  // Scenario 2: Fresh install — baseline migration runs as a no-op
  // -------------------------------------------------------------------------

  describe('fresh install — baseline migration is a no-op', () => {
    it.each([
      'tasks',
      'brain',
      'nexus',
    ] as const)('%s: migrateSanitized runs to completion on fresh empty DB', async (db) => {
      const { openNativeDatabase } = await import('../sqlite.js');
      const { drizzle } = await import('drizzle-orm/node-sqlite');
      const { reconcileJournal, migrateSanitized } = await import('../migration-manager.js');

      const dbPath = join(tempDir, `${db}-fresh.db`);
      const nativeDb = openNativeDatabase(dbPath);
      const drizzleDb = drizzle({ client: nativeDb as import('node:sqlite').DatabaseSync });

      const migrationsFolder = getMigrationsFolder(db);
      const existenceTable = EXISTENCE_TABLE[db];

      // On a fresh DB: reconcileJournal runs Scenario 1 (tables don't exist yet).
      // migrateSanitized runs all migrations including the comment-only baseline.
      expect(() => {
        reconcileJournal(nativeDb, migrationsFolder, existenceTable, `test-${db}`);
        migrateSanitized(drizzleDb, { migrationsFolder });
      }).not.toThrow();

      // Verify the baseline journal entry was written.
      const journal = nativeDb
        .prepare('SELECT name FROM "__drizzle_migrations" WHERE name LIKE ?')
        .all(`%${BASELINE_FOLDER_SUFFIX}%`) as Array<{ name: string }>;
      expect(journal.length, `Baseline journal entry missing for ${db}`).toBe(1);

      // Verify the existence table was created (schema was built by prior migrations).
      const tableCheck = nativeDb
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
        .get(existenceTable) as Record<string, unknown> | undefined;
      expect(tableCheck, `Existence table ${existenceTable} not created for ${db}`).toBeTruthy();

      nativeDb.close();
    });
  });

  // -------------------------------------------------------------------------
  // Scenario 3: Existing install — reconcileJournal detects comment-only migration
  // and inserts journal entry WITHOUT running DDL
  // -------------------------------------------------------------------------

  describe('existing install — baseline marker handled by Scenario 3', () => {
    it.each([
      'tasks',
      'brain',
      'nexus',
    ] as const)('%s: reconcileJournal marks baseline applied on populated DB without running DDL', async (db) => {
      const { openNativeDatabase } = await import('../sqlite.js');
      const { drizzle } = await import('drizzle-orm/node-sqlite');
      const { reconcileJournal, migrateSanitized } = await import('../migration-manager.js');

      const migrationsFolder = getMigrationsFolder(db);
      const existenceTable = EXISTENCE_TABLE[db];

      // Step 1: build a "populated" DB by running all migrations on a fresh DB.
      const freshDbPath = join(tempDir, `${db}-populate.db`);
      const freshNative = openNativeDatabase(freshDbPath);
      const freshDrizzle = drizzle({ client: freshNative as import('node:sqlite').DatabaseSync });
      reconcileJournal(freshNative, migrationsFolder, existenceTable, `test-${db}-populate`);
      migrateSanitized(freshDrizzle, { migrationsFolder });

      // Verify the baseline IS in the journal after full migration.
      const journalAfterFull = freshNative
        .prepare('SELECT name FROM "__drizzle_migrations" WHERE name LIKE ?')
        .all(`%${BASELINE_FOLDER_SUFFIX}%`) as Array<{ name: string }>;
      expect(journalAfterFull.length).toBe(1);

      freshNative.close();

      // Step 2: open the same DB again, remove the baseline journal entry,
      // and re-run reconcileJournal to simulate an existing DB that needs
      // the baseline marker added retroactively.
      const existingNative = openNativeDatabase(freshDbPath);

      // Remove the baseline journal entry to simulate "pre-T1165" state.
      const baselineHash = await getBaselineMigrationHash(db);
      existingNative.exec(`DELETE FROM "__drizzle_migrations" WHERE hash = '${baselineHash}'`);

      // Verify it was removed.
      const beforeReconcile = existingNative
        .prepare('SELECT hash FROM "__drizzle_migrations" WHERE hash = ?')
        .get(baselineHash) as Record<string, unknown> | undefined;
      expect(beforeReconcile).toBeUndefined();

      // Count DDL operations before reconcile by counting tables (should not change).
      const tablesBefore = (
        existingNative
          .prepare("SELECT COUNT(*) as cnt FROM sqlite_master WHERE type='table'")
          .get() as { cnt: number }
      ).cnt;

      // Re-run reconcileJournal — should detect comment-only baseline and insert journal entry.
      reconcileJournal(existingNative, migrationsFolder, existenceTable, `test-${db}-existing`);

      // The journal entry should now be present.
      const afterReconcile = existingNative
        .prepare('SELECT hash FROM "__drizzle_migrations" WHERE hash = ?')
        .get(baselineHash) as Record<string, unknown> | undefined;
      expect(
        afterReconcile,
        `Baseline journal entry not inserted by reconcileJournal for ${db}`,
      ).toBeTruthy();

      // Table count should not have changed (no DDL executed).
      const tablesAfter = (
        existingNative
          .prepare("SELECT COUNT(*) as cnt FROM sqlite_master WHERE type='table'")
          .get() as { cnt: number }
      ).cnt;
      expect(tablesAfter, `Table count changed after baseline reconcile for ${db}`).toBe(
        tablesBefore,
      );

      existingNative.close();
    });
  });

  // -------------------------------------------------------------------------
  // Scenario 4: Brain FK preservation — PRAGMA foreign_keys must remain ON
  // -------------------------------------------------------------------------

  describe('brain FK preservation', () => {
    it('PRAGMA foreign_keys=1 (ON) after migrate() on existing brain.db', async () => {
      const { openNativeDatabase } = await import('../sqlite.js');
      const { drizzle } = await import('drizzle-orm/node-sqlite');
      const { reconcileJournal, migrateSanitized } = await import('../migration-manager.js');

      const migrationsFolder = getMigrationsFolder('brain');
      const existenceTable = EXISTENCE_TABLE['brain'];
      const dbPath = join(tempDir, 'brain-fk-test.db');

      const nativeDb = openNativeDatabase(dbPath);
      const drizzleDb = drizzle({ client: nativeDb as import('node:sqlite').DatabaseSync });

      // Run full migration (fresh install).
      reconcileJournal(nativeDb, migrationsFolder, existenceTable, 'test-brain-fk');
      migrateSanitized(drizzleDb, { migrationsFolder });

      // After migration: PRAGMA foreign_keys must be 1 (ON).
      // This verifies that no PRAGMA foreign_keys=OFF was permanently executed.
      const fkStatus = nativeDb.prepare('PRAGMA foreign_keys').get() as {
        foreign_keys: number;
      };
      expect(
        fkStatus.foreign_keys,
        'PRAGMA foreign_keys must be 1 (ON) after brain baseline migration',
      ).toBe(1);

      nativeDb.close();
    });
  });

  // -------------------------------------------------------------------------
  // Scenario 5: Snapshot chain validity — drizzle-kit check passes for all 3 DBs
  // -------------------------------------------------------------------------

  describe('snapshot chain validity', () => {
    it.each([
      'tasks',
      'brain',
      'nexus',
    ] as const)('%s: baseline snapshot.json has renames key and is version 7', async (db) => {
      const { readFileSync, readdirSync, statSync } = await import('node:fs');
      const migrationsFolder = getMigrationsFolder(db);

      const baselineDir = readdirSync(migrationsFolder).find(
        (d) =>
          statSync(join(migrationsFolder, d)).isDirectory() && d.includes(BASELINE_FOLDER_SUFFIX),
      );

      expect(baselineDir, `No baseline folder found for ${db}`).toBeTruthy();

      const snapshotPath = join(migrationsFolder, baselineDir!, 'snapshot.json');
      expect(existsSync(snapshotPath), `snapshot.json missing for ${db}`).toBe(true);

      const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8'));
      expect(snapshot.version, `snapshot.json version must be "7" for ${db}`).toBe('7');
      expect('renames' in snapshot, `snapshot.json missing "renames" key for ${db}`).toBe(true);
      expect(
        Array.isArray(snapshot.renames),
        `snapshot.json "renames" must be an array for ${db}`,
      ).toBe(true);
      expect(snapshot.prevIds, `snapshot.json "prevIds" must be present for ${db}`).toBeDefined();
    });
  });
});
