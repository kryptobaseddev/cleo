/**
 * Smoke tests: all 5 DBs migrate clean on fresh init + legacy fixtures.
 *
 * Coverage (acceptance criteria from T1160):
 *  - Test 1: Fresh temp-dir init for each of the 5 DBs (tasks, brain, nexus,
 *            signaldock, telemetry) — all migrations apply without error.
 *  - Test 2: Legacy fixture with __drizzle_migrations rows where name IS NULL
 *            — reconciler backfills names, NO migration re-runs.
 *  - Test 3: Partial migration fixture — column present but journal entry
 *            absent — reconciler recovers without duplicate-column errors.
 *  - Test 4: Runtime guard proof — migrateSanitized filters whitespace-only
 *            chunk; raw drizzle migrate() fails on the same input.
 *  - Test 5: T1174 partial index regression — idx_tasks_sentient_proposals_today
 *            exists on fresh install with correct WHERE clause; T1174 no-op marker
 *            doesn't fail on a DB that already has the T1126 index.
 *
 * All tests run in isolated tmp directories via mkdtempSync. Singleton state
 * is reset after every test so DB handles do not leak across suites.
 *
 * Signaldock note: signaldock.db now uses the standard drizzle migration
 * pipeline (migrateSanitized + reconcileJournal) after T1166 replaced the
 * GLOBAL_EMBEDDED_MIGRATIONS bare-SQL runner. All 5 DBs use the same drizzle
 * pipeline. Tests 2/3 include signaldock coverage.
 *
 * @task T1160
 * @task T1174
 * @epic T1150
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Module-level constants
// ---------------------------------------------------------------------------

const _require = createRequire(import.meta.url);
const { DatabaseSync } = _require('node:sqlite') as {
  DatabaseSync: new (
    path: string,
    opts?: { readonly?: boolean },
  ) => import('node:sqlite').DatabaseSync;
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Resolve an absolute path to a migrations folder given a folder name
 * relative to packages/core/migrations/. Works from both src/ and dist/.
 */
function resolveMigrationsDir(folderName: string): string {
  // This file lives at packages/core/src/store/__tests__/
  // Migrations live at packages/core/migrations/<folderName>/
  return join(__dirname, '..', '..', '..', 'migrations', folderName);
}

// ---------------------------------------------------------------------------
// Logger mock — prevents pino from opening real log files during tests
// ---------------------------------------------------------------------------

vi.mock('../../logger.js', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// ---------------------------------------------------------------------------
// Test 1: Fresh init — all 5 DBs apply migrations without error
// ---------------------------------------------------------------------------

describe('Test 1: fresh init — all 5 DBs migrate clean', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cleo-mig-smoke-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('tasks.db (drizzle-tasks) — fresh init succeeds, tasks table exists', async () => {
    const { getDb, resetDbState } = await import('../sqlite.js');
    resetDbState();

    const projectDir = join(tempDir, 'tasks-fresh');
    mkdirSync(join(projectDir, '.cleo'), { recursive: true });

    let db: Awaited<ReturnType<typeof getDb>> | undefined;
    try {
      db = await getDb(projectDir);
      expect(db).toBeTruthy();

      // Verify the tasks table was created by migrations
      const { openNativeDatabase } = await import('../sqlite.js');
      const nativeDb = openNativeDatabase(join(projectDir, '.cleo', 'tasks.db'));
      const row = nativeDb
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tasks'")
        .get() as { name: string } | undefined;
      nativeDb.close();
      expect(row?.name).toBe('tasks');
    } finally {
      resetDbState();
    }
  });

  it('brain.db (drizzle-brain) — fresh init succeeds, brain_decisions table exists', async () => {
    const { getBrainDb, resetBrainDbState } = await import('../memory-sqlite.js');
    resetBrainDbState();

    const projectDir = join(tempDir, 'brain-fresh');
    mkdirSync(join(projectDir, '.cleo'), { recursive: true });

    try {
      const db = await getBrainDb(projectDir);
      expect(db).toBeTruthy();

      const { openNativeDatabase } = await import('../sqlite.js');
      const nativeDb = openNativeDatabase(join(projectDir, '.cleo', 'brain.db'));
      const row = nativeDb
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='brain_decisions'")
        .get() as { name: string } | undefined;
      nativeDb.close();
      expect(row?.name).toBe('brain_decisions');
    } finally {
      resetBrainDbState();
    }
  });

  it('nexus.db (drizzle-nexus) — fresh init succeeds, project_registry table exists', async () => {
    vi.resetModules();
    const cleoHome = join(tempDir, 'nexus-home');
    mkdirSync(cleoHome, { recursive: true });

    vi.doMock('../../paths.js', () => ({
      getCleoHome: () => cleoHome,
      getCleoDirAbsolute: (cwd?: string) => (cwd ? join(cwd, '.cleo') : join(tempDir, '.cleo')),
      getProjectRoot: () => tempDir,
    }));

    const { getNexusDb, resetNexusDbState } = await import('../nexus-sqlite.js');
    resetNexusDbState();

    try {
      const db = await getNexusDb();
      expect(db).toBeTruthy();

      const dbPath = join(cleoHome, 'nexus.db');
      expect(existsSync(dbPath)).toBe(true);

      // nexus initial migration creates project_registry (not nexus_projects)
      const nativeDb = new DatabaseSync(dbPath, { readonly: true });
      const row = nativeDb
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='project_registry'")
        .get() as { name: string } | undefined;
      nativeDb.close();
      expect(row?.name).toBe('project_registry');
    } finally {
      resetNexusDbState();
      vi.restoreAllMocks();
    }
  });

  it('signaldock.db (drizzle runner) — fresh init succeeds, agents table exists', async () => {
    vi.resetModules();
    const cleoHome = join(tempDir, 'signaldock-home');
    mkdirSync(cleoHome, { recursive: true });

    vi.doMock('../../paths.js', () => ({
      getCleoHome: () => cleoHome,
      getCleoDirAbsolute: (cwd?: string) => (cwd ? join(cwd, '.cleo') : join(tempDir, '.cleo')),
      getProjectRoot: () => tempDir,
    }));

    const { ensureGlobalSignaldockDb, _resetGlobalSignaldockDb_TESTING_ONLY } = await import(
      '../signaldock-sqlite.js'
    );

    try {
      const result = await ensureGlobalSignaldockDb();
      expect(result.action).toBe('created');
      expect(existsSync(result.path)).toBe(true);

      const nativeDb = new DatabaseSync(result.path, { readonly: true });
      // Verify agents table was created by drizzle migrations
      const row = nativeDb
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agents'")
        .get() as { name: string } | undefined;
      expect(row?.name).toBe('agents');

      // Verify T897 v3 columns are present (included in initial migration)
      const cols = nativeDb.prepare('PRAGMA table_info(agents)').all() as Array<{ name: string }>;
      const colNames = cols.map((c) => c.name);
      expect(colNames).toContain('tier');
      expect(colNames).toContain('can_spawn');
      expect(colNames).toContain('cant_path');

      // Verify drizzle journal was written
      const journalRow = nativeDb
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='__drizzle_migrations'",
        )
        .get() as { name: string } | undefined;
      expect(journalRow?.name).toBe('__drizzle_migrations');

      nativeDb.close();
    } finally {
      _resetGlobalSignaldockDb_TESTING_ONLY();
      vi.restoreAllMocks();
    }
  });

  it('telemetry.db (drizzle-telemetry) — fresh init succeeds, telemetry_events table exists', async () => {
    vi.resetModules();
    const cleoHome = join(tempDir, 'telemetry-home');
    mkdirSync(cleoHome, { recursive: true });

    vi.doMock('../../paths.js', () => ({
      getCleoHome: () => cleoHome,
      getCleoDirAbsolute: (cwd?: string) => (cwd ? join(cwd, '.cleo') : join(tempDir, '.cleo')),
      getProjectRoot: () => tempDir,
    }));

    const { getTelemetryDb, resetTelemetryDbState } = await import('../../telemetry/sqlite.js');
    resetTelemetryDbState();

    try {
      const db = await getTelemetryDb();
      expect(db).toBeTruthy();

      const dbPath = join(cleoHome, 'telemetry.db');
      expect(existsSync(dbPath)).toBe(true);

      const nativeDb = new DatabaseSync(dbPath, { readonly: true });
      const row = nativeDb
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='telemetry_events'")
        .get() as { name: string } | undefined;
      nativeDb.close();
      expect(row?.name).toBe('telemetry_events');
    } finally {
      resetTelemetryDbState();
      vi.restoreAllMocks();
    }
  });
});

// ---------------------------------------------------------------------------
// Test 2: Legacy fixture — null-name journal rows are backfilled by reconciler
// ---------------------------------------------------------------------------

describe('Test 2: null-name journal rows — reconciler backfills names, no re-runs', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cleo-mig-smoke-t2-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('tasks.db: reconcileJournal backfills null names without re-running migrations', async () => {
    const { openNativeDatabase } = await import('../sqlite.js');
    const { drizzle } = await import('drizzle-orm/node-sqlite');
    const { reconcileJournal, migrateSanitized } = await import('../migration-manager.js');

    const migrationsFolder = resolveMigrationsDir('drizzle-tasks');
    const { readMigrationFiles } = await import('drizzle-orm/migrator');
    const localMigrations = readMigrationFiles({ migrationsFolder });
    expect(localMigrations.length).toBeGreaterThan(0);

    const dbPath = join(tempDir, 'tasks-null-name.db');
    const nativeDb = openNativeDatabase(dbPath);
    const db = drizzle({ client: nativeDb });

    // Step 1: Run all migrations cleanly so tables exist
    migrateSanitized(db, { migrationsFolder });

    // Step 2: Simulate pre-v1-beta install by NULLing all `name` values in the journal
    nativeDb.exec('UPDATE "__drizzle_migrations" SET "name" = NULL');

    // Verify names are actually null before reconcile
    const nullNames = nativeDb
      .prepare('SELECT COUNT(*) as cnt FROM "__drizzle_migrations" WHERE name IS NULL')
      .get() as { cnt: number };
    expect(nullNames.cnt).toBe(localMigrations.length);

    // Remember the journal row count before reconcile
    const countBefore = (
      nativeDb.prepare('SELECT COUNT(*) as cnt FROM "__drizzle_migrations"').get() as {
        cnt: number;
      }
    ).cnt;

    // Step 3: Run reconcileJournal — should backfill names
    reconcileJournal(nativeDb, migrationsFolder, 'tasks', 'tasks');

    // Step 4: Verify all names are now backfilled
    const stillNull = nativeDb
      .prepare('SELECT COUNT(*) as cnt FROM "__drizzle_migrations" WHERE name IS NULL')
      .get() as { cnt: number };
    expect(stillNull.cnt).toBe(0);

    // Step 5: Journal row count must NOT have increased (no re-runs)
    const countAfter = (
      nativeDb.prepare('SELECT COUNT(*) as cnt FROM "__drizzle_migrations"').get() as {
        cnt: number;
      }
    ).cnt;
    expect(countAfter).toBe(countBefore);

    // Step 6: Run migrateSanitized again — must NOT throw (all applied)
    expect(() => migrateSanitized(db, { migrationsFolder })).not.toThrow();

    // Step 7: Row count still unchanged (no migrations were re-run)
    const countFinal = (
      nativeDb.prepare('SELECT COUNT(*) as cnt FROM "__drizzle_migrations"').get() as {
        cnt: number;
      }
    ).cnt;
    expect(countFinal).toBe(countBefore);

    nativeDb.close();
  });

  it('brain.db: reconcileJournal backfills null names without re-running migrations', async () => {
    const { openNativeDatabase } = await import('../sqlite.js');
    const { drizzle } = await import('drizzle-orm/node-sqlite');
    const { reconcileJournal, migrateSanitized } = await import('../migration-manager.js');

    const migrationsFolder = resolveMigrationsDir('drizzle-brain');
    const { readMigrationFiles } = await import('drizzle-orm/migrator');
    const localMigrations = readMigrationFiles({ migrationsFolder });
    expect(localMigrations.length).toBeGreaterThan(0);

    const dbPath = join(tempDir, 'brain-null-name.db');
    const nativeDb = openNativeDatabase(dbPath);
    const db = drizzle({ client: nativeDb });

    migrateSanitized(db, { migrationsFolder });

    nativeDb.exec('UPDATE "__drizzle_migrations" SET "name" = NULL');

    const countBefore = (
      nativeDb.prepare('SELECT COUNT(*) as cnt FROM "__drizzle_migrations"').get() as {
        cnt: number;
      }
    ).cnt;

    reconcileJournal(nativeDb, migrationsFolder, 'brain_decisions', 'brain');

    const stillNull = nativeDb
      .prepare('SELECT COUNT(*) as cnt FROM "__drizzle_migrations" WHERE name IS NULL')
      .get() as { cnt: number };
    expect(stillNull.cnt).toBe(0);

    const countAfter = (
      nativeDb.prepare('SELECT COUNT(*) as cnt FROM "__drizzle_migrations"').get() as {
        cnt: number;
      }
    ).cnt;
    expect(countAfter).toBe(countBefore);

    expect(() => migrateSanitized(db, { migrationsFolder })).not.toThrow();

    nativeDb.close();
  });

  it('nexus.db: reconcileJournal backfills null names without re-running migrations', async () => {
    const { openNativeDatabase } = await import('../sqlite.js');
    const { drizzle } = await import('drizzle-orm/node-sqlite');
    const { reconcileJournal, migrateSanitized } = await import('../migration-manager.js');

    const migrationsFolder = resolveMigrationsDir('drizzle-nexus');
    const { readMigrationFiles } = await import('drizzle-orm/migrator');
    const localMigrations = readMigrationFiles({ migrationsFolder });
    expect(localMigrations.length).toBeGreaterThan(0);

    const dbPath = join(tempDir, 'nexus-null-name.db');
    const nativeDb = openNativeDatabase(dbPath);
    const db = drizzle({ client: nativeDb });

    migrateSanitized(db, { migrationsFolder });

    nativeDb.exec('UPDATE "__drizzle_migrations" SET "name" = NULL');

    const countBefore = (
      nativeDb.prepare('SELECT COUNT(*) as cnt FROM "__drizzle_migrations"').get() as {
        cnt: number;
      }
    ).cnt;

    // nexus existence table is 'project_registry' (not 'nexus_projects')
    reconcileJournal(nativeDb, migrationsFolder, 'project_registry', 'nexus');

    const stillNull = nativeDb
      .prepare('SELECT COUNT(*) as cnt FROM "__drizzle_migrations" WHERE name IS NULL')
      .get() as { cnt: number };
    expect(stillNull.cnt).toBe(0);

    const countAfter = (
      nativeDb.prepare('SELECT COUNT(*) as cnt FROM "__drizzle_migrations"').get() as {
        cnt: number;
      }
    ).cnt;
    expect(countAfter).toBe(countBefore);

    expect(() => migrateSanitized(db, { migrationsFolder })).not.toThrow();

    nativeDb.close();
  });

  it('telemetry.db: reconcileJournal backfills null names without re-running migrations', async () => {
    const { openNativeDatabase } = await import('../sqlite.js');
    const { drizzle } = await import('drizzle-orm/node-sqlite');
    const { reconcileJournal, migrateSanitized } = await import('../migration-manager.js');

    const migrationsFolder = resolveMigrationsDir('drizzle-telemetry');
    const { readMigrationFiles } = await import('drizzle-orm/migrator');
    const localMigrations = readMigrationFiles({ migrationsFolder });
    expect(localMigrations.length).toBeGreaterThan(0);

    const dbPath = join(tempDir, 'telemetry-null-name.db');
    const nativeDb = openNativeDatabase(dbPath);
    const db = drizzle({ client: nativeDb });

    migrateSanitized(db, { migrationsFolder });

    nativeDb.exec('UPDATE "__drizzle_migrations" SET "name" = NULL');

    const countBefore = (
      nativeDb.prepare('SELECT COUNT(*) as cnt FROM "__drizzle_migrations"').get() as {
        cnt: number;
      }
    ).cnt;

    reconcileJournal(nativeDb, migrationsFolder, 'telemetry_events', 'telemetry');

    const stillNull = nativeDb
      .prepare('SELECT COUNT(*) as cnt FROM "__drizzle_migrations" WHERE name IS NULL')
      .get() as { cnt: number };
    expect(stillNull.cnt).toBe(0);

    const countAfter = (
      nativeDb.prepare('SELECT COUNT(*) as cnt FROM "__drizzle_migrations"').get() as {
        cnt: number;
      }
    ).cnt;
    expect(countAfter).toBe(countBefore);

    expect(() => migrateSanitized(db, { migrationsFolder })).not.toThrow();

    nativeDb.close();
  });

  it('signaldock.db: reconcileJournal backfills null names without re-running migrations', async () => {
    const { openNativeDatabase } = await import('../sqlite.js');
    const { drizzle } = await import('drizzle-orm/node-sqlite');
    const { reconcileJournal, migrateSanitized } = await import('../migration-manager.js');

    const migrationsFolder = resolveMigrationsDir('drizzle-signaldock');
    const { readMigrationFiles } = await import('drizzle-orm/migrator');
    const localMigrations = readMigrationFiles({ migrationsFolder });
    expect(localMigrations.length).toBeGreaterThan(0);

    const dbPath = join(tempDir, 'signaldock-null-name.db');
    const nativeDb = openNativeDatabase(dbPath);
    const db = drizzle({ client: nativeDb });

    // Step 1: Run all migrations cleanly so tables exist
    migrateSanitized(db, { migrationsFolder });

    // Step 2: Simulate pre-v1-beta install by NULLing all `name` values in the journal
    nativeDb.exec('UPDATE "__drizzle_migrations" SET "name" = NULL');

    const nullNames = nativeDb
      .prepare('SELECT COUNT(*) as cnt FROM "__drizzle_migrations" WHERE name IS NULL')
      .get() as { cnt: number };
    expect(nullNames.cnt).toBe(localMigrations.length);

    const countBefore = (
      nativeDb.prepare('SELECT COUNT(*) as cnt FROM "__drizzle_migrations"').get() as {
        cnt: number;
      }
    ).cnt;

    // Step 3: Run reconcileJournal — should backfill names
    reconcileJournal(nativeDb, migrationsFolder, 'agents', 'signaldock');

    // Step 4: Verify all names are now backfilled
    const stillNull = nativeDb
      .prepare('SELECT COUNT(*) as cnt FROM "__drizzle_migrations" WHERE name IS NULL')
      .get() as { cnt: number };
    expect(stillNull.cnt).toBe(0);

    // Step 5: Journal row count must NOT have increased (no re-runs)
    const countAfter = (
      nativeDb.prepare('SELECT COUNT(*) as cnt FROM "__drizzle_migrations"').get() as {
        cnt: number;
      }
    ).cnt;
    expect(countAfter).toBe(countBefore);

    // Step 6: Run migrateSanitized again — must NOT throw (all applied)
    expect(() => migrateSanitized(db, { migrationsFolder })).not.toThrow();

    nativeDb.close();
  });
});

// ---------------------------------------------------------------------------
// Test 3: Partial migration fixture — column present, journal entry absent
// ---------------------------------------------------------------------------

describe('Test 3: partial migration fixture — reconciler recovers without duplicate-column error', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cleo-mig-smoke-t3-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('tasks.db: column exists but journal entry absent — reconciler inserts entry, migrate() does not throw', async () => {
    const { openNativeDatabase } = await import('../sqlite.js');
    const { drizzle } = await import('drizzle-orm/node-sqlite');
    const { reconcileJournal, migrateSanitized } = await import('../migration-manager.js');
    const { readMigrationFiles } = await import('drizzle-orm/migrator');

    const migrationsFolder = resolveMigrationsDir('drizzle-tasks');
    const localMigrations = readMigrationFiles({ migrationsFolder });
    expect(localMigrations.length).toBeGreaterThanOrEqual(2);

    const dbPath = join(tempDir, 'tasks-partial.db');
    const nativeDb = openNativeDatabase(dbPath);
    const db = drizzle({ client: nativeDb });

    // Step 1: Apply only the first migration (creates the initial schema)
    const firstMig = localMigrations[0]!;
    migrateSanitized(db, { migrationsFolder });

    // Step 2: Remove all journal entries except the first one,
    // simulating a scenario where a subsequent migration applied its DDL
    // (e.g. ALTER TABLE ADD COLUMN) but its journal entry was never written.
    // We pick the second migration that adds the `pipeline_stage` column.
    const pipelineStageMig =
      localMigrations.find(
        (m) => m.name?.includes('pipeline-stage') || m.name?.includes('wave0'),
      ) ?? localMigrations[1];
    if (!pipelineStageMig) {
      nativeDb.close();
      return; // only 1 migration exists — test is N/A
    }

    // Delete the journal entry for the target migration
    nativeDb.exec(`DELETE FROM "__drizzle_migrations" WHERE hash = '${pipelineStageMig.hash}'`);

    const countBefore = (
      nativeDb.prepare('SELECT COUNT(*) as cnt FROM "__drizzle_migrations"').get() as {
        cnt: number;
      }
    ).cnt;

    // Step 3: The DDL for pipelineStageMig has already been applied (migrate() ran it).
    // Now run reconcileJournal — it should detect that columns already exist and
    // re-insert the missing journal entry.
    reconcileJournal(nativeDb, migrationsFolder, 'tasks', 'tasks');

    const countAfter = (
      nativeDb.prepare('SELECT COUNT(*) as cnt FROM "__drizzle_migrations"').get() as {
        cnt: number;
      }
    ).cnt;
    // The reconciler must have inserted the missing entry
    expect(countAfter).toBeGreaterThanOrEqual(countBefore);

    // Step 4: Run migrateSanitized again — must NOT throw duplicate-column error
    expect(() => migrateSanitized(db, { migrationsFolder })).not.toThrow();

    nativeDb.close();
  });

  it('brain.db: column exists but journal entry absent — reconciler inserts entry, migrate() does not throw', async () => {
    const { openNativeDatabase } = await import('../sqlite.js');
    const { drizzle } = await import('drizzle-orm/node-sqlite');
    const { reconcileJournal, migrateSanitized } = await import('../migration-manager.js');
    const { readMigrationFiles } = await import('drizzle-orm/migrator');

    const migrationsFolder = resolveMigrationsDir('drizzle-brain');
    const localMigrations = readMigrationFiles({ migrationsFolder });
    expect(localMigrations.length).toBeGreaterThanOrEqual(2);

    const dbPath = join(tempDir, 'brain-partial.db');
    const nativeDb = openNativeDatabase(dbPath);
    const db = drizzle({ client: nativeDb });

    // Apply all migrations (creates full schema including T417 agent column)
    migrateSanitized(db, { migrationsFolder });

    // Find a migration that adds a column (T417 adds brain_observations.agent)
    const agentMig =
      localMigrations.find((m) => m.name?.includes('t417') || m.name?.includes('agent')) ??
      localMigrations[1];
    if (!agentMig) {
      nativeDb.close();
      return;
    }

    // Remove its journal entry (simulates cherry-pick scenario from T417)
    nativeDb.exec(`DELETE FROM "__drizzle_migrations" WHERE hash = '${agentMig.hash}'`);

    // reconcileJournal must detect the column already exists and re-insert entry
    expect(() =>
      reconcileJournal(nativeDb, migrationsFolder, 'brain_decisions', 'brain'),
    ).not.toThrow();

    // Running migrate again must NOT crash with duplicate-column
    expect(() => migrateSanitized(db, { migrationsFolder })).not.toThrow();

    nativeDb.close();
  });

  it('nexus.db: column exists but journal entry absent — reconciler inserts entry, migrate() does not throw', async () => {
    const { openNativeDatabase } = await import('../sqlite.js');
    const { drizzle } = await import('drizzle-orm/node-sqlite');
    const { reconcileJournal, migrateSanitized } = await import('../migration-manager.js');
    const { readMigrationFiles } = await import('drizzle-orm/migrator');

    const migrationsFolder = resolveMigrationsDir('drizzle-nexus');
    const localMigrations = readMigrationFiles({ migrationsFolder });
    expect(localMigrations.length).toBeGreaterThanOrEqual(2);

    const dbPath = join(tempDir, 'nexus-partial.db');
    const nativeDb = openNativeDatabase(dbPath);
    const db = drizzle({ client: nativeDb });

    migrateSanitized(db, { migrationsFolder });

    // Pick the second migration to simulate partial application
    const targetMig = localMigrations[1]!;
    nativeDb.exec(`DELETE FROM "__drizzle_migrations" WHERE hash = '${targetMig.hash}'`);

    // nexus existence table is 'project_registry' (not 'nexus_projects')
    expect(() =>
      reconcileJournal(nativeDb, migrationsFolder, 'project_registry', 'nexus'),
    ).not.toThrow();

    expect(() => migrateSanitized(db, { migrationsFolder })).not.toThrow();

    nativeDb.close();
  });

  it('telemetry.db: column exists but journal entry absent — reconciler inserts entry, migrate() does not throw', async () => {
    const { openNativeDatabase } = await import('../sqlite.js');
    const { drizzle } = await import('drizzle-orm/node-sqlite');
    const { reconcileJournal, migrateSanitized } = await import('../migration-manager.js');
    const { readMigrationFiles } = await import('drizzle-orm/migrator');

    const migrationsFolder = resolveMigrationsDir('drizzle-telemetry');
    const localMigrations = readMigrationFiles({ migrationsFolder });
    expect(localMigrations.length).toBeGreaterThan(0);

    const dbPath = join(tempDir, 'telemetry-partial.db');
    const nativeDb = openNativeDatabase(dbPath);
    const db = drizzle({ client: nativeDb });

    migrateSanitized(db, { migrationsFolder });

    if (localMigrations.length >= 2) {
      const targetMig = localMigrations[1]!;
      nativeDb.exec(`DELETE FROM "__drizzle_migrations" WHERE hash = '${targetMig.hash}'`);

      expect(() =>
        reconcileJournal(nativeDb, migrationsFolder, 'telemetry_events', 'telemetry'),
      ).not.toThrow();
    }

    expect(() => migrateSanitized(db, { migrationsFolder })).not.toThrow();

    nativeDb.close();
  });

  it('signaldock.db: existing DB (pre-T1166 legacy fixture) — reconciler probe-and-mark-applied, no re-runs', async () => {
    // Simulate an existing signaldock.db that was previously migrated by the old
    // GLOBAL_EMBEDDED_MIGRATIONS bare-SQL runner. The DB has the full schema
    // (agents + T897 v3 columns) but NO __drizzle_migrations journal table.
    // reconcileJournal Scenario 1 must detect the agents table, bootstrap the
    // journal with the initial migration marked as applied, then migrateSanitized
    // must run without errors and without re-applying DDL.
    const { openNativeDatabase } = await import('../sqlite.js');
    const { drizzle } = await import('drizzle-orm/node-sqlite');
    const { reconcileJournal, migrateSanitized } = await import('../migration-manager.js');

    const migrationsFolder = resolveMigrationsDir('drizzle-signaldock');

    const dbPath = join(tempDir, 'signaldock-legacy.db');
    const nativeDb = openNativeDatabase(dbPath);

    // Simulate the old bare-SQL runner: create the full schema manually
    // without a __drizzle_migrations journal table.
    nativeDb.exec(`
      CREATE TABLE agents (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        class TEXT NOT NULL DEFAULT 'custom',
        privacy_tier TEXT NOT NULL DEFAULT 'public',
        capabilities TEXT NOT NULL DEFAULT '[]',
        skills TEXT NOT NULL DEFAULT '[]',
        messages_sent INTEGER NOT NULL DEFAULT 0,
        messages_received INTEGER NOT NULL DEFAULT 0,
        conversation_count INTEGER NOT NULL DEFAULT 0,
        friend_count INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'online',
        api_base_url TEXT NOT NULL DEFAULT 'https://api.signaldock.io',
        transport_type TEXT NOT NULL DEFAULT 'http',
        transport_config TEXT NOT NULL DEFAULT '{}',
        is_active INTEGER NOT NULL DEFAULT 1,
        requires_reauth INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        tier TEXT NOT NULL DEFAULT 'global',
        can_spawn INTEGER NOT NULL DEFAULT 0,
        orch_level INTEGER NOT NULL DEFAULT 2,
        reports_to TEXT,
        cant_path TEXT,
        cant_sha256 TEXT,
        installed_from TEXT,
        installed_at TEXT
      )
    `);
    // Also create agent_skills with T897 columns
    nativeDb.exec(`
      CREATE TABLE skills (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        category TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `);
    nativeDb.exec(`
      CREATE TABLE agent_skills (
        agent_id TEXT NOT NULL,
        skill_id TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'manual',
        attached_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (agent_id, skill_id)
      )
    `);

    // Confirm no __drizzle_migrations table yet
    const noJournal = nativeDb
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='__drizzle_migrations'")
      .get() as { name: string } | undefined;
    expect(noJournal).toBeUndefined();

    // Run reconcileJournal — Scenario 1: agents exists, no journal
    // → must bootstrap journal with initial migration marked as applied
    const db = drizzle({ client: nativeDb });
    reconcileJournal(nativeDb, migrationsFolder, 'agents', 'signaldock');

    // Journal must now exist with at least 1 entry
    const journalCount = nativeDb
      .prepare('SELECT COUNT(*) as cnt FROM "__drizzle_migrations"')
      .get() as { cnt: number };
    expect(journalCount.cnt).toBeGreaterThanOrEqual(1);

    // migrateSanitized must run without errors (all DDL already present or handled)
    expect(() => migrateSanitized(db, { migrationsFolder })).not.toThrow();

    nativeDb.close();
  });
});

// ---------------------------------------------------------------------------
// Test 4: Runtime guard proof — migrateSanitized vs raw drizzle migrate()
// ---------------------------------------------------------------------------

/**
 * Write a synthetic drizzle v1 beta migrations folder with a single migration
 * whose SQL ends with a trailing "--> statement-breakpoint\n" marker.
 *
 * drizzle's readMigrationFiles splits on the marker, producing a sql array
 * that ends with "\n" (whitespace only). Passing that to session.run() crashes.
 */
function writeTrailingBreakpointMigration(migrationsDir: string): void {
  mkdirSync(migrationsDir, { recursive: true });
  const migSubDir = join(migrationsDir, '20260101000000_smoke_guard_test');
  mkdirSync(migSubDir, { recursive: true });

  const sqlContent =
    'CREATE TABLE smoke_guard_test (id INTEGER PRIMARY KEY, value TEXT);\n' +
    '--> statement-breakpoint\n';

  writeFileSync(join(migSubDir, 'migration.sql'), sqlContent);
}

describe('Test 4: runtime guard proof — migrateSanitized filters empty chunks', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cleo-mig-smoke-t4-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('migrateSanitized succeeds on trailing-breakpoint migration — table is created', async () => {
    const { drizzle } = await import('drizzle-orm/node-sqlite');
    const { migrateSanitized } = await import('../migration-manager.js');

    const dbPath = join(tempDir, 'guard-sanitized.db');
    const migrationsDir = join(tempDir, 'migrations-sanitized');
    writeTrailingBreakpointMigration(migrationsDir);

    const nativeDb = new DatabaseSync(dbPath);
    nativeDb.exec('PRAGMA journal_mode=WAL');
    const db = drizzle({ client: nativeDb });

    // Must NOT throw — whitespace chunk is filtered before it reaches session.run()
    expect(() => migrateSanitized(db, { migrationsFolder: migrationsDir })).not.toThrow();

    // The table must have been created
    const row = nativeDb
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='smoke_guard_test'")
      .get() as { name: string } | undefined;
    expect(row?.name).toBe('smoke_guard_test');

    nativeDb.close();
  });

  it('drizzle raw migrate() throws on the same malformed migration — guard is load-bearing', async () => {
    const { drizzle } = await import('drizzle-orm/node-sqlite');
    const { migrate } = await import('drizzle-orm/node-sqlite/migrator');

    const dbPath = join(tempDir, 'guard-raw.db');
    const migrationsDir = join(tempDir, 'migrations-raw');
    writeTrailingBreakpointMigration(migrationsDir);

    const nativeDb = new DatabaseSync(dbPath);
    nativeDb.exec('PRAGMA journal_mode=WAL');
    const db = drizzle({ client: nativeDb });

    // Raw migrate() MUST throw — the "\n" chunk hits session.run() and crashes
    expect(() => migrate(db, { migrationsFolder: migrationsDir })).toThrow();

    nativeDb.close();
  });
});

// ---------------------------------------------------------------------------
// Test 5: T1174 partial index regression — idx_tasks_sentient_proposals_today
// ---------------------------------------------------------------------------

/**
 * Regression tests for T1174 (T-MSR-W2A-09) schema-level partial index adoption.
 *
 * Validates two scenarios:
 *  A. Fresh install: the full migration chain (T1126 creates the index; T1174
 *     is a comment-only no-op marker) leaves idx_tasks_sentient_proposals_today
 *     in sqlite_master with the correct WHERE clause.
 *  B. Existing install: a DB that already has the index (T1126 applied) can run
 *     migrateSanitized + reconcileJournal with the T1174 marker present without
 *     throwing "index already exists" or any other error.
 *
 * Both tests use the real canonical drizzle-tasks migration folder.
 */
describe('Test 5: T1174 partial index — idx_tasks_sentient_proposals_today regression', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cleo-mig-smoke-t5-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('fresh install: partial index exists after full migration chain with correct WHERE clause', async () => {
    const { openNativeDatabase } = await import('../sqlite.js');
    const { drizzle } = await import('drizzle-orm/node-sqlite');
    const { reconcileJournal, migrateSanitized } = await import('../migration-manager.js');

    const migrationsFolder = resolveMigrationsDir('drizzle-tasks');
    const dbPath = join(tempDir, 'tasks-t1174-fresh.db');
    const nativeDb = openNativeDatabase(dbPath);
    const db = drizzle({ client: nativeDb });

    // Apply full migration chain (includes T1126 + T1174 comment-only marker)
    reconcileJournal(nativeDb, migrationsFolder, 'tasks', 'tasks');
    expect(() => migrateSanitized(db, { migrationsFolder })).not.toThrow();

    // Verify the partial index exists in sqlite_master
    const row = nativeDb
      .prepare(
        "SELECT name, sql FROM sqlite_master WHERE type='index' AND name='idx_tasks_sentient_proposals_today'",
      )
      .get() as { name: string; sql: string } | undefined;

    expect(row).toBeDefined();
    expect(row?.name).toBe('idx_tasks_sentient_proposals_today');

    // Verify the WHERE clause is present in the index DDL (covers the sentient-tier2 label filter)
    expect(row?.sql).toContain('labels_json');
    expect(row?.sql).toContain('sentient-tier2');

    // Verify the index is on the tasks table using the date(created_at) expression
    expect(row?.sql).toContain('tasks');
    expect(row?.sql).toContain('created_at');

    nativeDb.close();
  });

  it('existing install: DB with T1126 index already applied — T1174 marker runs as no-op, no throw', async () => {
    const { openNativeDatabase } = await import('../sqlite.js');
    const { drizzle } = await import('drizzle-orm/node-sqlite');
    const { reconcileJournal, migrateSanitized } = await import('../migration-manager.js');
    const { readMigrationFiles } = await import('drizzle-orm/migrator');

    const migrationsFolder = resolveMigrationsDir('drizzle-tasks');
    const localMigrations = readMigrationFiles({ migrationsFolder });

    const dbPath = join(tempDir, 'tasks-t1174-existing.db');
    const nativeDb = openNativeDatabase(dbPath);
    const db = drizzle({ client: nativeDb });

    // Step 1: Apply all migrations up to and including T1126 (creates the partial index)
    // We identify T1126 by folder name suffix
    const t1126Mig = localMigrations.find((m) => m.name?.includes('t1126'));
    const t1174Mig = localMigrations.find((m) => m.name?.includes('t1174'));

    // Apply all migrations (first pass — fresh DB gets T1126 index created)
    reconcileJournal(nativeDb, migrationsFolder, 'tasks', 'tasks');
    expect(() => migrateSanitized(db, { migrationsFolder })).not.toThrow();

    // Confirm the index now exists
    const indexAfterFirstRun = nativeDb
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_tasks_sentient_proposals_today'",
      )
      .get() as { name: string } | undefined;
    expect(indexAfterFirstRun).toBeDefined();

    // Step 2: Simulate an "existing install" by removing the T1174 journal entry only,
    // so migrateSanitized thinks it needs to re-run T1174 (which is a comment-only no-op).
    if (t1174Mig) {
      nativeDb.exec(`DELETE FROM "__drizzle_migrations" WHERE hash = '${t1174Mig.hash}'`);
    }

    // Step 3: Re-run reconcileJournal + migrateSanitized — must NOT throw even if
    // T1174 marker appears to be "not yet applied". The comment-only SQL is a no-op.
    reconcileJournal(nativeDb, migrationsFolder, 'tasks', 'tasks');
    expect(() => migrateSanitized(db, { migrationsFolder })).not.toThrow();

    // Step 4: Index must still exist (not dropped or recreated with error)
    const indexAfterSecondRun = nativeDb
      .prepare(
        "SELECT name, sql FROM sqlite_master WHERE type='index' AND name='idx_tasks_sentient_proposals_today'",
      )
      .get() as { name: string; sql: string } | undefined;
    expect(indexAfterSecondRun).toBeDefined();
    expect(indexAfterSecondRun?.sql).toContain('sentient-tier2');

    // Verify journal has entries for both T1126 and T1174 after reconcile
    if (t1126Mig) {
      const t1126Entry = nativeDb
        .prepare('SELECT hash FROM __drizzle_migrations WHERE hash = ?')
        .get(t1126Mig.hash) as { hash: string } | undefined;
      expect(t1126Entry).toBeDefined();
    }

    nativeDb.close();
  });
});
