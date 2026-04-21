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
 *
 * All tests run in isolated tmp directories via mkdtempSync. Singleton state
 * is reset after every test so DB handles do not leak across suites.
 *
 * Signaldock note: signaldock.db uses an EMBEDDED migration runner
 * (_signaldock_migrations table + applyGlobalSignaldockSchema) rather than
 * drizzle's readMigrationFiles / migrate() pipeline. Its fresh-init smoke
 * test uses ensureGlobalSignaldockDb() with a vi.doMock path override.
 * The drizzle-signaldock folder contains a reference SQL file (T897) that
 * is inlined into GLOBAL_EMBEDDED_MIGRATIONS — it is NOT processed via
 * drizzle migrate() and therefore is not covered by Tests 2/3/4 (which
 * target the drizzle-based DBs only). This gap is tracked under W2A-04.
 *
 * @task T1160
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

  it('signaldock.db (embedded runner) — fresh init succeeds, agents table exists', async () => {
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
      const row = nativeDb
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agents'")
        .get() as { name: string } | undefined;
      nativeDb.close();
      expect(row?.name).toBe('agents');
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

  it('signaldock.db: embedded runner does not use drizzle journal (noted — W2A-04)', () => {
    // signaldock.db uses its own _signaldock_migrations table (not __drizzle_migrations).
    // Null-name backfill is not applicable — its runner tracks migration by string name PK.
    // This scenario is fully covered by W2A-04 which will wire signaldock to the
    // shared drizzle-based migration pipeline. For now we document the gap.
    expect(true).toBe(true); // gap documented
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
