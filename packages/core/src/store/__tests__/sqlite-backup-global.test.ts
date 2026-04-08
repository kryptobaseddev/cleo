/**
 * Tests for global-tier SQLite VACUUM INTO backup (vacuumIntoGlobalBackup,
 * listGlobalSqliteBackups) and global-salt raw-file backup (backupGlobalSalt,
 * listGlobalSaltBackups).
 *
 * All tests use a tmp-dir override via `cleoHomeOverride` so they NEVER
 * touch the real user's $XDG_DATA_HOME/cleo/ directory or corrupt actual
 * nexus/signaldock backups.
 *
 * Coverage:
 * - vacuumIntoGlobalBackup creates a snapshot and increments file count
 * - listGlobalSqliteBackups returns entries sorted newest-first (mtime desc)
 * - Rotation keeps last 10 snapshots, deletes older ones
 * - Snapshot passes PRAGMA integrity_check
 * - Scope filter: listGlobalSqliteBackups with prefix excludes other prefixes
 * - Restore round-trip: snapshot then restore preserves DB content
 * - XDG path: snapshots land under cleoHomeOverride/backups/sqlite/, not hardcoded ~/.cleo/
 * - TC-100: vacuumIntoBackupAll includes conduit.db snapshot
 * - TC-101: vacuumIntoGlobalBackup('signaldock') writes snapshot to global backups dir
 * - TC-102: backupGlobalSalt writes binary file with 0o600 permissions
 * - TC-103: Rotation: 11th conduit snapshot deletes the oldest
 * - TC-104: listSqliteBackupsAll returns conduit key in result map
 * - TC-105: listGlobalSqliteBackups('signaldock') returns signaldock snapshots
 *
 * @task T306
 * @task T369
 * @epic T299
 * @epic T310
 */

import { existsSync, mkdirSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('sqlite-backup global tier', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  /**
   * Create a minimal, valid SQLite database at `dbPath` with a single table
   * and one row so VACUUM INTO and integrity_check have something to verify.
   */
  function seedSqliteDb(dbPath: string): void {
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE IF NOT EXISTS test_data (id INTEGER PRIMARY KEY, value TEXT);
      INSERT INTO test_data (value) VALUES ('hello');
    `);
    db.close();
  }

  it('vacuumIntoGlobalBackup creates a snapshot file under cleoHomeOverride/backups/sqlite/', async () => {
    vi.resetModules();
    const cleoHome = join(tmpdir(), `cleo-global-test-create-${Date.now()}`);
    const nexusDbPath = join(cleoHome, 'nexus.db');
    mkdirSync(cleoHome, { recursive: true });
    seedSqliteDb(nexusDbPath);

    // Mock getNexusNativeDb to return a real DatabaseSync handle
    const nexusDb = new DatabaseSync(nexusDbPath);
    vi.doMock('../nexus-sqlite.js', () => ({ getNexusNativeDb: () => nexusDb }));
    vi.doMock('../../paths.js', () => ({ getCleoHome: () => cleoHome }));

    const { vacuumIntoGlobalBackup } = await import('../sqlite-backup.js');
    const result = await vacuumIntoGlobalBackup('nexus', { cleoHomeOverride: cleoHome });

    nexusDb.close();

    expect(result.snapshotPath).toBeTruthy();
    expect(result.snapshotPath).toContain('nexus-');
    expect(result.snapshotPath).toContain(join(cleoHome, 'backups', 'sqlite'));
    expect(existsSync(result.snapshotPath)).toBe(true);
  });

  it('vacuumIntoGlobalBackup XDG path: uses cleoHomeOverride, not hardcoded ~/.cleo/', async () => {
    vi.resetModules();
    const cleoHome = join(tmpdir(), `cleo-global-xdg-${Date.now()}`);
    const nexusDbPath = join(cleoHome, 'nexus.db');
    mkdirSync(cleoHome, { recursive: true });
    seedSqliteDb(nexusDbPath);

    const nexusDb = new DatabaseSync(nexusDbPath);
    vi.doMock('../nexus-sqlite.js', () => ({ getNexusNativeDb: () => nexusDb }));
    vi.doMock('../../paths.js', () => ({ getCleoHome: () => cleoHome }));

    const { vacuumIntoGlobalBackup } = await import('../sqlite-backup.js');
    const result = await vacuumIntoGlobalBackup('nexus', { cleoHomeOverride: cleoHome });

    nexusDb.close();

    // Must be under the override dir, not the user's actual cleo home
    expect(result.snapshotPath).toContain(cleoHome);
    expect(result.snapshotPath).not.toContain(join(homedir(), '.local'));
    expect(result.snapshotPath).not.toContain('.cleo');
  });

  it('vacuumIntoGlobalBackup is non-fatal when getNexusNativeDb() returns null', async () => {
    vi.resetModules();
    vi.doMock('../nexus-sqlite.js', () => ({ getNexusNativeDb: () => null }));
    vi.doMock('../../paths.js', () => ({ getCleoHome: () => tmpdir() }));

    const { vacuumIntoGlobalBackup } = await import('../sqlite-backup.js');
    const result = await vacuumIntoGlobalBackup('nexus', {
      cleoHomeOverride: join(tmpdir(), `cleo-null-nexus-${Date.now()}`),
    });

    expect(result.snapshotPath).toBe('');
    expect(result.rotated).toEqual([]);
  });

  it('vacuumIntoGlobalBackup snapshot passes PRAGMA integrity_check', async () => {
    vi.resetModules();
    const cleoHome = join(tmpdir(), `cleo-global-integrity-${Date.now()}`);
    const nexusDbPath = join(cleoHome, 'nexus.db');
    mkdirSync(cleoHome, { recursive: true });
    seedSqliteDb(nexusDbPath);

    const nexusDb = new DatabaseSync(nexusDbPath);
    vi.doMock('../nexus-sqlite.js', () => ({ getNexusNativeDb: () => nexusDb }));
    vi.doMock('../../paths.js', () => ({ getCleoHome: () => cleoHome }));

    const { vacuumIntoGlobalBackup } = await import('../sqlite-backup.js');
    const result = await vacuumIntoGlobalBackup('nexus', { cleoHomeOverride: cleoHome });

    nexusDb.close();

    expect(existsSync(result.snapshotPath)).toBe(true);

    // Open snapshot and verify integrity
    const snapshot = new DatabaseSync(result.snapshotPath, { readonly: true });
    try {
      const row = snapshot.prepare('PRAGMA integrity_check').get() as Record<string, unknown>;
      const ok = row?.['integrity_check'] ?? row?.['integrity check'];
      expect(ok).toBe('ok');
    } finally {
      snapshot.close();
    }
  });

  it('rotation keeps last 10 snapshots and deletes older ones', async () => {
    vi.resetModules();
    const cleoHome = join(tmpdir(), `cleo-global-rotation-${Date.now()}`);
    const nexusDbPath = join(cleoHome, 'nexus.db');
    const backupDir = join(cleoHome, 'backups', 'sqlite');
    mkdirSync(backupDir, { recursive: true });
    seedSqliteDb(nexusDbPath);

    // Seed 11 stale snapshots with valid name pattern
    for (let i = 0; i < 11; i++) {
      const day = String(i + 1).padStart(2, '0');
      writeFileSync(join(backupDir, `nexus-202601${day}-120000.db`), 'fake');
    }

    const nexusDb = new DatabaseSync(nexusDbPath);
    vi.doMock('../nexus-sqlite.js', () => ({ getNexusNativeDb: () => nexusDb }));
    vi.doMock('../../paths.js', () => ({ getCleoHome: () => cleoHome }));

    const { vacuumIntoGlobalBackup } = await import('../sqlite-backup.js');
    const result = await vacuumIntoGlobalBackup('nexus', { cleoHomeOverride: cleoHome });

    nexusDb.close();

    const remaining = readdirSync(backupDir).filter(
      (f) => f.startsWith('nexus-') && f.endsWith('.db'),
    );
    // The new snapshot was written, meaning 11 stale + 1 new. After rotation,
    // MAX_SNAPSHOTS (10) must be respected.
    expect(remaining.length).toBeLessThanOrEqual(10);
    // The result snapshot should exist
    expect(existsSync(result.snapshotPath)).toBe(true);
    // At least 2 files were rotated out (11 + 1 new = 12, keep 10, remove 2)
    expect(result.rotated.length).toBeGreaterThanOrEqual(2);
  });

  it('listGlobalSqliteBackups returns entries sorted newest-first by mtime', async () => {
    vi.resetModules();
    const cleoHome = join(tmpdir(), `cleo-global-list-${Date.now()}`);
    const backupDir = join(cleoHome, 'backups', 'sqlite');
    mkdirSync(backupDir, { recursive: true });
    vi.doMock('../../paths.js', () => ({ getCleoHome: () => cleoHome }));

    const f1 = join(backupDir, 'nexus-20260101-120000.db');
    const f2 = join(backupDir, 'nexus-20260102-120000.db');
    const f3 = join(backupDir, 'nexus-20260103-120000.db');
    writeFileSync(f1, 'fake1');
    writeFileSync(f2, 'fake2');
    writeFileSync(f3, 'fake3');
    // Set deterministic mtimes: f1 oldest, f3 newest
    utimesSync(f1, 1_700_000_100, 1_700_000_100);
    utimesSync(f2, 1_700_000_200, 1_700_000_200);
    utimesSync(f3, 1_700_000_300, 1_700_000_300);

    const { listGlobalSqliteBackups } = await import('../sqlite-backup.js');
    const entries = listGlobalSqliteBackups(undefined, cleoHome);

    expect(entries.map((e) => e.name)).toEqual([
      'nexus-20260103-120000.db',
      'nexus-20260102-120000.db',
      'nexus-20260101-120000.db',
    ]);
    // Each entry has required fields
    for (const e of entries) {
      expect(e.path).toBeTruthy();
      expect(typeof e.size).toBe('number');
      expect(e.mtime).toBeInstanceOf(Date);
    }
  });

  it('listGlobalSqliteBackups prefix filter excludes other prefixes', async () => {
    vi.resetModules();
    const cleoHome = join(tmpdir(), `cleo-global-filter-${Date.now()}`);
    const backupDir = join(cleoHome, 'backups', 'sqlite');
    mkdirSync(backupDir, { recursive: true });
    vi.doMock('../../paths.js', () => ({ getCleoHome: () => cleoHome }));

    // Write files for two different prefixes
    writeFileSync(join(backupDir, 'nexus-20260101-120000.db'), 'nexus-data');
    writeFileSync(join(backupDir, 'nexus-20260102-120000.db'), 'nexus-data-2');
    writeFileSync(join(backupDir, 'signaldock-20260101-120000.db'), 'sd-data');

    const { listGlobalSqliteBackups } = await import('../sqlite-backup.js');

    const nexusOnly = listGlobalSqliteBackups('nexus', cleoHome);
    const sdOnly = listGlobalSqliteBackups('signaldock', cleoHome);
    const all = listGlobalSqliteBackups(undefined, cleoHome);

    expect(nexusOnly.every((e) => e.name.startsWith('nexus-'))).toBe(true);
    expect(nexusOnly.length).toBe(2);

    expect(sdOnly.every((e) => e.name.startsWith('signaldock-'))).toBe(true);
    expect(sdOnly.length).toBe(1);

    // Unfiltered returns both
    expect(all.length).toBe(3);
  });

  it('listGlobalSqliteBackups returns empty array when backup dir does not exist', async () => {
    vi.resetModules();
    vi.doMock('../../paths.js', () => ({ getCleoHome: () => tmpdir() }));

    const { listGlobalSqliteBackups } = await import('../sqlite-backup.js');
    const nonExistentHome = join(tmpdir(), `cleo-no-exist-${Date.now()}`);
    const entries = listGlobalSqliteBackups(undefined, nonExistentHome);

    expect(entries).toEqual([]);
  });

  it('restore round-trip: snapshot then restore preserves all rows', async () => {
    vi.resetModules();
    const cleoHome = join(tmpdir(), `cleo-global-roundtrip-${Date.now()}`);
    const nexusDbPath = join(cleoHome, 'nexus.db');
    mkdirSync(cleoHome, { recursive: true });

    // Seed with known data
    const db = new DatabaseSync(nexusDbPath);
    db.exec(`
      CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, name TEXT);
      INSERT INTO items (name) VALUES ('alpha');
      INSERT INTO items (name) VALUES ('beta');
    `);
    db.close();

    const nexusDb = new DatabaseSync(nexusDbPath);
    vi.doMock('../nexus-sqlite.js', () => ({ getNexusNativeDb: () => nexusDb }));
    vi.doMock('../../paths.js', () => ({ getCleoHome: () => cleoHome }));

    const { vacuumIntoGlobalBackup } = await import('../sqlite-backup.js');
    const { snapshotPath } = await vacuumIntoGlobalBackup('nexus', {
      cleoHomeOverride: cleoHome,
    });
    nexusDb.close();

    expect(existsSync(snapshotPath)).toBe(true);

    // Verify the snapshot contains all expected rows
    const snapDb = new DatabaseSync(snapshotPath, { readonly: true });
    try {
      const rows = snapDb.prepare('SELECT name FROM items ORDER BY id').all() as Array<{
        name: string;
      }>;
      expect(rows.map((r) => r.name)).toEqual(['alpha', 'beta']);
    } finally {
      snapDb.close();
    }
  });

  // ==========================================================================
  // TC-100 through TC-105: T369 — conduit, signaldock, global-salt backup
  // ==========================================================================

  /**
   * TC-100: vacuumIntoBackupAll includes conduit.db snapshot in
   * `.cleo/backups/sqlite/` alongside tasks and brain.
   *
   * @task T369
   * @epic T310
   */
  it('TC-100: vacuumIntoBackupAll includes conduit.db snapshot', async () => {
    vi.resetModules();
    const cwd = join(tmpdir(), `cleo-tc100-${Date.now()}`);
    const cleoDir = join(cwd, '.cleo');
    const tasksDbPath = join(cleoDir, 'tasks.db');
    const brainDbPath = join(cleoDir, 'brain.db');
    const conduitDbPath = join(cleoDir, 'conduit.db');
    mkdirSync(cleoDir, { recursive: true });

    // Seed all three databases
    for (const dbPath of [tasksDbPath, brainDbPath, conduitDbPath]) {
      const db = new DatabaseSync(dbPath);
      db.exec(
        "CREATE TABLE IF NOT EXISTS test_data (id INTEGER PRIMARY KEY, value TEXT); INSERT INTO test_data (value) VALUES ('hello');",
      );
      db.close();
    }

    const tasksDb = new DatabaseSync(tasksDbPath);
    const brainDb = new DatabaseSync(brainDbPath);
    const conduitDb = new DatabaseSync(conduitDbPath);

    vi.doMock('../sqlite.js', () => ({ getNativeDb: () => tasksDb, getDb: () => tasksDb }));
    vi.doMock('../brain-sqlite.js', () => ({ getBrainNativeDb: () => brainDb }));
    vi.doMock('../conduit-sqlite.js', () => ({ getConduitNativeDb: () => conduitDb }));
    vi.doMock('../nexus-sqlite.js', () => ({ getNexusNativeDb: () => null }));
    vi.doMock('../signaldock-sqlite.js', () => ({
      getGlobalSignaldockNativeDb: () => null,
      getGlobalSignaldockDbPath: () => '',
    }));
    vi.doMock('../global-salt.js', () => ({ getGlobalSaltPath: () => join(cwd, 'global-salt') }));
    vi.doMock('../../paths.js', () => ({
      getCleoDir: () => cleoDir,
      getCleoHome: () => cwd,
    }));

    const { vacuumIntoBackupAll, listSqliteBackupsAll } = await import('../sqlite-backup.js');
    await vacuumIntoBackupAll({ cwd, force: true });

    tasksDb.close();
    brainDb.close();
    conduitDb.close();

    const allBackups = listSqliteBackupsAll(cwd);

    // All three prefixes must be present
    expect(allBackups).toHaveProperty('tasks');
    expect(allBackups).toHaveProperty('brain');
    expect(allBackups).toHaveProperty('conduit');

    // Each must have at least one snapshot
    expect(allBackups['tasks']?.length).toBeGreaterThanOrEqual(1);
    expect(allBackups['brain']?.length).toBeGreaterThanOrEqual(1);
    expect(allBackups['conduit']?.length).toBeGreaterThanOrEqual(1);

    // Snapshot filenames must match the conduit- prefix
    const conduitSnap = allBackups['conduit']?.[0];
    expect(conduitSnap?.name).toMatch(/^conduit-\d{8}-\d{6}\.db$/);
  });

  /**
   * TC-101: vacuumIntoGlobalBackup('signaldock') writes a snapshot to the
   * global backups directory at `cleoHomeOverride/backups/sqlite/`.
   *
   * @task T369
   * @epic T310
   */
  it('TC-101: vacuumIntoGlobalBackup(signaldock) writes snapshot to global backups dir', async () => {
    vi.resetModules();
    const cleoHome = join(tmpdir(), `cleo-tc101-${Date.now()}`);
    const sdDbPath = join(cleoHome, 'signaldock.db');
    mkdirSync(cleoHome, { recursive: true });

    const db = new DatabaseSync(sdDbPath);
    db.exec(
      "CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY); INSERT INTO agents VALUES ('agent-1');",
    );
    db.close();

    const sdDb = new DatabaseSync(sdDbPath);
    vi.doMock('../signaldock-sqlite.js', () => ({
      getGlobalSignaldockNativeDb: () => sdDb,
      getGlobalSignaldockDbPath: () => sdDbPath,
    }));
    vi.doMock('../nexus-sqlite.js', () => ({ getNexusNativeDb: () => null }));
    vi.doMock('../../paths.js', () => ({ getCleoHome: () => cleoHome }));

    const { vacuumIntoGlobalBackup } = await import('../sqlite-backup.js');
    const result = await vacuumIntoGlobalBackup('signaldock', { cleoHomeOverride: cleoHome });

    sdDb.close();

    expect(result.snapshotPath).toBeTruthy();
    expect(result.snapshotPath).toContain('signaldock-');
    expect(result.snapshotPath).toContain(join(cleoHome, 'backups', 'sqlite'));
    expect(existsSync(result.snapshotPath)).toBe(true);

    // Snapshot must pass integrity_check
    const snap = new DatabaseSync(result.snapshotPath, { readonly: true });
    try {
      const row = snap.prepare('PRAGMA integrity_check').get() as Record<string, unknown>;
      const ok = row?.['integrity_check'] ?? row?.['integrity check'];
      expect(ok).toBe('ok');
    } finally {
      snap.close();
    }
  });

  /**
   * TC-102: backupGlobalSalt writes a 32-byte binary file to
   * `cleoHomeOverride/backups/global-salt-<ts>` with 0o600 permissions.
   *
   * @task T369
   * @epic T310
   */
  it('TC-102: backupGlobalSalt writes binary file with 0o600 permissions', async () => {
    vi.resetModules();
    const cleoHome = join(tmpdir(), `cleo-tc102-${Date.now()}`);
    mkdirSync(cleoHome, { recursive: true });

    // Write a fake 32-byte global-salt file at cleoHomeOverride/global-salt
    const saltPath = join(cleoHome, 'global-salt');
    const saltBytes = Buffer.alloc(32, 0xab);
    writeFileSync(saltPath, saltBytes, { mode: 0o600 });

    vi.doMock('../global-salt.js', () => ({ getGlobalSaltPath: () => saltPath }));
    vi.doMock('../../paths.js', () => ({ getCleoHome: () => cleoHome }));

    const { backupGlobalSalt } = await import('../sqlite-backup.js');
    const result = await backupGlobalSalt({ cleoHomeOverride: cleoHome });

    expect(result.snapshotPath).toBeTruthy();
    expect(result.snapshotPath).toContain('global-salt-');
    expect(existsSync(result.snapshotPath)).toBe(true);

    // Must be 32 bytes
    const s = statSync(result.snapshotPath);
    expect(s.size).toBe(32);

    // Must have 0o600 permissions (owner read/write only)
    const mode = s.mode & 0o777;
    expect(mode).toBe(0o600);
  });

  /**
   * TC-103: Rotation — 11th conduit snapshot deletes the oldest so no more
   * than 10 conduit snapshots remain in `.cleo/backups/sqlite/`.
   *
   * @task T369
   * @epic T310
   */
  it('TC-103: rotation keeps max 10 conduit snapshots, deletes the oldest', async () => {
    vi.resetModules();
    const cwd = join(tmpdir(), `cleo-tc103-${Date.now()}`);
    const cleoDir = join(cwd, '.cleo');
    const conduitDbPath = join(cleoDir, 'conduit.db');
    const backupDir = join(cleoDir, 'backups', 'sqlite');
    mkdirSync(backupDir, { recursive: true });

    // Seed the conduit DB
    const dbInit = new DatabaseSync(conduitDbPath);
    dbInit.exec('CREATE TABLE IF NOT EXISTS msgs (id INTEGER PRIMARY KEY);');
    dbInit.close();

    // Pre-create 11 fake conduit snapshot files with ascending mtimes
    const staleFiles: string[] = [];
    for (let i = 0; i < 11; i++) {
      const day = String(i + 1).padStart(2, '0');
      const name = `conduit-202601${day}-120000.db`;
      const p = join(backupDir, name);
      writeFileSync(p, 'fake-conduit-snapshot');
      utimesSync(p, 1_700_000_000 + i * 100, 1_700_000_000 + i * 100);
      staleFiles.push(p);
    }

    const conduitDb = new DatabaseSync(conduitDbPath);
    vi.doMock('../conduit-sqlite.js', () => ({ getConduitNativeDb: () => conduitDb }));
    vi.doMock('../sqlite.js', () => ({ getNativeDb: () => null, getDb: () => null }));
    vi.doMock('../brain-sqlite.js', () => ({ getBrainNativeDb: () => null }));
    vi.doMock('../nexus-sqlite.js', () => ({ getNexusNativeDb: () => null }));
    vi.doMock('../signaldock-sqlite.js', () => ({
      getGlobalSignaldockNativeDb: () => null,
      getGlobalSignaldockDbPath: () => '',
    }));
    vi.doMock('../global-salt.js', () => ({ getGlobalSaltPath: () => '' }));
    vi.doMock('../../paths.js', () => ({
      getCleoDir: () => cleoDir,
      getCleoHome: () => cwd,
    }));

    const { vacuumIntoBackupAll } = await import('../sqlite-backup.js');
    await vacuumIntoBackupAll({ cwd, force: true });

    conduitDb.close();

    const remaining = readdirSync(backupDir).filter((f) => /^conduit-\d{8}-\d{6}\.db$/.test(f));
    // After adding the 12th (11 stale + 1 new), rotation must trim to ≤10
    expect(remaining.length).toBeLessThanOrEqual(10);
  });

  /**
   * TC-104: listSqliteBackupsAll returns a `conduit` key in its result map.
   *
   * @task T369
   * @epic T310
   */
  it('TC-104: listSqliteBackupsAll returns conduit key in result map', async () => {
    vi.resetModules();
    const cwd = join(tmpdir(), `cleo-tc104-${Date.now()}`);
    const cleoDir = join(cwd, '.cleo');
    const backupDir = join(cleoDir, 'backups', 'sqlite');
    mkdirSync(backupDir, { recursive: true });

    // Write a fake conduit snapshot
    writeFileSync(join(backupDir, 'conduit-20260101-120000.db'), 'fake-conduit');

    vi.doMock('../sqlite.js', () => ({ getNativeDb: () => null, getDb: () => null }));
    vi.doMock('../brain-sqlite.js', () => ({ getBrainNativeDb: () => null }));
    vi.doMock('../conduit-sqlite.js', () => ({ getConduitNativeDb: () => null }));
    vi.doMock('../nexus-sqlite.js', () => ({ getNexusNativeDb: () => null }));
    vi.doMock('../signaldock-sqlite.js', () => ({
      getGlobalSignaldockNativeDb: () => null,
      getGlobalSignaldockDbPath: () => '',
    }));
    vi.doMock('../global-salt.js', () => ({ getGlobalSaltPath: () => '' }));
    vi.doMock('../../paths.js', () => ({
      getCleoDir: () => cleoDir,
      getCleoHome: () => cwd,
    }));

    const { listSqliteBackupsAll } = await import('../sqlite-backup.js');
    const all = listSqliteBackupsAll(cwd);

    // The result map must include all three registered prefixes
    expect(all).toHaveProperty('tasks');
    expect(all).toHaveProperty('brain');
    expect(all).toHaveProperty('conduit');

    // The conduit entry should include the seeded fake file
    expect(all['conduit']?.length).toBeGreaterThanOrEqual(1);
    expect(all['conduit']?.[0]?.name).toBe('conduit-20260101-120000.db');
  });

  /**
   * TC-105: listGlobalSqliteBackups('signaldock') returns only the global
   * signaldock snapshots, not nexus ones.
   *
   * @task T369
   * @epic T310
   */
  it('TC-105: listGlobalSqliteBackups(signaldock) returns only signaldock entries', async () => {
    vi.resetModules();
    const cleoHome = join(tmpdir(), `cleo-tc105-${Date.now()}`);
    const backupDir = join(cleoHome, 'backups', 'sqlite');
    mkdirSync(backupDir, { recursive: true });

    vi.doMock('../../paths.js', () => ({ getCleoHome: () => cleoHome }));

    // Write two signaldock and one nexus snapshot
    writeFileSync(join(backupDir, 'signaldock-20260101-120000.db'), 'sd-1');
    writeFileSync(join(backupDir, 'signaldock-20260102-120000.db'), 'sd-2');
    writeFileSync(join(backupDir, 'nexus-20260101-120000.db'), 'nexus-1');

    const { listGlobalSqliteBackups } = await import('../sqlite-backup.js');

    const sdEntries = listGlobalSqliteBackups('signaldock', cleoHome);
    const nexusEntries = listGlobalSqliteBackups('nexus', cleoHome);

    // signaldock filter must return exactly the two signaldock files
    expect(sdEntries.length).toBe(2);
    expect(sdEntries.every((e) => e.name.startsWith('signaldock-'))).toBe(true);

    // nexus filter must return exactly the one nexus file
    expect(nexusEntries.length).toBe(1);
    expect(nexusEntries[0]?.name).toBe('nexus-20260101-120000.db');

    // Each entry has required fields
    for (const e of sdEntries) {
      expect(e.path).toBeTruthy();
      expect(typeof e.size).toBe('number');
      expect(e.mtime).toBeInstanceOf(Date);
    }
  });
});
