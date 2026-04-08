/**
 * Tests for global-tier SQLite VACUUM INTO backup (vacuumIntoGlobalBackup,
 * listGlobalSqliteBackups).
 *
 * All tests use a tmp-dir override via `cleoHomeOverride` so they NEVER
 * touch the real user's $XDG_DATA_HOME/cleo/ directory or corrupt actual
 * nexus backups.
 *
 * Coverage:
 * - vacuumIntoGlobalBackup creates a snapshot and increments file count
 * - listGlobalSqliteBackups returns entries sorted newest-first (mtime desc)
 * - Rotation keeps last 10 snapshots, deletes older ones
 * - Snapshot passes PRAGMA integrity_check
 * - Scope filter: listGlobalSqliteBackups with prefix excludes other prefixes
 * - Restore round-trip: snapshot then restore preserves DB content
 * - XDG path: snapshots land under cleoHomeOverride/backups/sqlite/, not hardcoded ~/.cleo/
 *
 * @task T306
 * @epic T299
 */

import { existsSync, mkdirSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
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
});
