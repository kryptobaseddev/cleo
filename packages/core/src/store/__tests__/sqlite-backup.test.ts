/**
 * Tests for SQLite VACUUM INTO backup module.
 *
 * Verifies:
 * - Non-fatal when getNativeDb() / getBrainNativeDb() return null
 * - WAL checkpoint runs before VACUUM INTO for each target
 * - Snapshot rotation enforces MAX_SNAPSHOTS limit per prefix
 * - Debounce prevents rapid successive backups per prefix
 * - vacuumIntoBackupAll snapshots both tasks.db and brain.db
 * - listSqliteBackups / listBrainBackups / listSqliteBackupsAll read back
 *   the rotated files sorted newest-first
 *
 * @task T4874
 * @task T5158 — extended to cover brain.db + vacuumIntoBackupAll
 * @epic T4867
 */

import { mkdirSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('sqlite-backup', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('is non-fatal when getNativeDb() returns null', async () => {
    vi.doMock('../sqlite.js', () => ({ getNativeDb: () => null }));
    vi.doMock('../memory-sqlite.js', () => ({ getBrainNativeDb: () => null }));
    vi.doMock('../../paths.js', () => ({ getCleoDir: () => tmpdir() }));

    const { vacuumIntoBackup } = await import('../sqlite-backup.js');
    await expect(vacuumIntoBackup({ force: true })).resolves.not.toThrow();
  });

  it('is non-fatal when getBrainNativeDb() returns null', async () => {
    vi.doMock('../sqlite.js', () => ({ getNativeDb: () => null }));
    vi.doMock('../memory-sqlite.js', () => ({ getBrainNativeDb: () => null }));
    vi.doMock('../../paths.js', () => ({ getCleoDir: () => tmpdir() }));

    const { vacuumIntoBackupAll } = await import('../sqlite-backup.js');
    await expect(vacuumIntoBackupAll({ force: true })).resolves.not.toThrow();
  });

  it('calls PRAGMA wal_checkpoint(TRUNCATE) before VACUUM INTO for tasks.db', async () => {
    const execMock = vi.fn();
    vi.doMock('../sqlite.js', () => ({ getNativeDb: () => ({ exec: execMock }) }));
    vi.doMock('../memory-sqlite.js', () => ({ getBrainNativeDb: () => null }));
    const tempDir = join(tmpdir(), `cleo-test-wal-${Date.now()}`);
    vi.doMock('../../paths.js', () => ({ getCleoDir: () => tempDir }));

    const { vacuumIntoBackup } = await import('../sqlite-backup.js');
    await vacuumIntoBackup({ force: true });

    expect(execMock).toHaveBeenCalledWith('PRAGMA wal_checkpoint(TRUNCATE)');
    const calls = execMock.mock.calls.map((c: string[][]) => c[0] as unknown as string);
    const walIdx = calls.findIndex((c: string) => c.includes('wal_checkpoint'));
    const vacuumIdx = calls.findIndex((c: string) => c.includes('VACUUM INTO'));
    expect(walIdx).toBeLessThan(vacuumIdx);
  });

  it('enforces maximum 10 tasks.db snapshots via rotation', async () => {
    const execMock = vi.fn();
    vi.doMock('../sqlite.js', () => ({ getNativeDb: () => ({ exec: execMock }) }));
    vi.doMock('../memory-sqlite.js', () => ({ getBrainNativeDb: () => null }));
    const tempDir = join(tmpdir(), `cleo-test-rot-${Date.now()}`);
    const backupDir = join(tempDir, 'backups', 'sqlite');
    mkdirSync(backupDir, { recursive: true });
    vi.doMock('../../paths.js', () => ({ getCleoDir: () => tempDir }));

    // Seed 11 fake snapshot files with valid YYYYMMDD-HHMMSS format
    for (let i = 0; i < 11; i++) {
      const day = String(i + 1).padStart(2, '0'); // 01..11
      writeFileSync(join(backupDir, `tasks-202601${day}-120000.db`), 'fake');
    }

    const { vacuumIntoBackup } = await import('../sqlite-backup.js');
    await vacuumIntoBackup({ force: true });

    const remaining = readdirSync(backupDir).filter(
      (f) => f.startsWith('tasks-') && f.endsWith('.db'),
    );
    expect(remaining.length).toBeLessThanOrEqual(10);
  });

  it('enforces rotation independently per prefix (tasks + brain)', async () => {
    const tasksExec = vi.fn();
    const brainExec = vi.fn();
    vi.doMock('../sqlite.js', () => ({ getNativeDb: () => ({ exec: tasksExec }) }));
    vi.doMock('../memory-sqlite.js', () => ({ getBrainNativeDb: () => ({ exec: brainExec }) }));
    const tempDir = join(tmpdir(), `cleo-test-rot-prefix-${Date.now()}`);
    const backupDir = join(tempDir, 'backups', 'sqlite');
    mkdirSync(backupDir, { recursive: true });
    vi.doMock('../../paths.js', () => ({ getCleoDir: () => tempDir }));

    // Seed 11 tasks.db and 11 brain.db stale snapshots.
    for (let i = 0; i < 11; i++) {
      const day = String(i + 1).padStart(2, '0');
      writeFileSync(join(backupDir, `tasks-202601${day}-120000.db`), 'fake');
      writeFileSync(join(backupDir, `brain-202601${day}-120000.db`), 'fake');
    }

    const { vacuumIntoBackupAll } = await import('../sqlite-backup.js');
    await vacuumIntoBackupAll({ force: true });

    const files = readdirSync(backupDir);
    const tasksFiles = files.filter((f) => f.startsWith('tasks-') && f.endsWith('.db'));
    const brainFiles = files.filter((f) => f.startsWith('brain-') && f.endsWith('.db'));
    expect(tasksFiles.length).toBeLessThanOrEqual(10);
    expect(brainFiles.length).toBeLessThanOrEqual(10);
  });

  it('vacuumIntoBackupAll snapshots both tasks.db and brain.db', async () => {
    const tasksExec = vi.fn();
    const brainExec = vi.fn();
    vi.doMock('../sqlite.js', () => ({ getNativeDb: () => ({ exec: tasksExec }) }));
    vi.doMock('../memory-sqlite.js', () => ({ getBrainNativeDb: () => ({ exec: brainExec }) }));
    const tempDir = join(tmpdir(), `cleo-test-both-${Date.now()}`);
    vi.doMock('../../paths.js', () => ({ getCleoDir: () => tempDir }));

    const { vacuumIntoBackupAll } = await import('../sqlite-backup.js');
    await vacuumIntoBackupAll({ force: true });

    // Each DB should have received a wal_checkpoint and a VACUUM INTO call.
    const assertExec = (mock: ReturnType<typeof vi.fn>) => {
      const calls = mock.mock.calls.map((c) => c[0] as string);
      expect(calls.some((c) => c.includes('wal_checkpoint'))).toBe(true);
      expect(calls.some((c) => c.includes('VACUUM INTO'))).toBe(true);
    };
    assertExec(tasksExec);
    assertExec(brainExec);
  });

  it('debounce skips second call within debounce window (tasks prefix)', async () => {
    const execMock = vi.fn();
    vi.doMock('../sqlite.js', () => ({ getNativeDb: () => ({ exec: execMock }) }));
    vi.doMock('../memory-sqlite.js', () => ({ getBrainNativeDb: () => null }));
    const tempDir = join(tmpdir(), `cleo-test-debounce-${Date.now()}`);
    vi.doMock('../../paths.js', () => ({ getCleoDir: () => tempDir }));

    const { vacuumIntoBackup } = await import('../sqlite-backup.js');
    // First call with force sets _lastBackupEpoch
    await vacuumIntoBackup({ force: true });
    const callCountAfterFirst = execMock.mock.calls.length;

    // Second call without force — should be debounced
    await vacuumIntoBackup({ force: false });
    expect(execMock.mock.calls.length).toBe(callCountAfterFirst);
  });

  it('listSqliteBackups and listBrainBackups return prefix-specific entries newest-first', async () => {
    vi.doMock('../sqlite.js', () => ({ getNativeDb: () => null }));
    vi.doMock('../memory-sqlite.js', () => ({ getBrainNativeDb: () => null }));
    vi.doMock('../conduit-sqlite.js', () => ({ getConduitNativeDb: () => null }));
    const tempDir = join(tmpdir(), `cleo-test-list-${Date.now()}`);
    const backupDir = join(tempDir, 'backups', 'sqlite');
    mkdirSync(backupDir, { recursive: true });
    vi.doMock('../../paths.js', () => ({ getCleoDir: () => tempDir }));

    // Write files then explicitly set mtimes so the listing sort (by mtime
    // descending) is deterministic regardless of filesystem timestamp
    // resolution. Without utimesSync, two files written in the same tight
    // loop can share the same mtime and fall back to insertion order.
    const f1 = join(backupDir, 'tasks-20260101-120000.db');
    const f2 = join(backupDir, 'tasks-20260102-120000.db');
    const f3 = join(backupDir, 'brain-20260103-120000.db');
    writeFileSync(f1, 'fake');
    writeFileSync(f2, 'fake');
    writeFileSync(f3, 'fake');
    // Use distinct epoch seconds, increasing with the date in the filename
    // so that tasks-20260102 is strictly newer than tasks-20260101.
    utimesSync(f1, 1_700_000_100, 1_700_000_100);
    utimesSync(f2, 1_700_000_200, 1_700_000_200);
    utimesSync(f3, 1_700_000_300, 1_700_000_300);

    const { listSqliteBackups, listBrainBackups, listSqliteBackupsAll } = await import(
      '../sqlite-backup.js'
    );
    const tasksList = listSqliteBackups();
    const brainList = listBrainBackups();
    const all = listSqliteBackupsAll();

    expect(tasksList.map((e) => e.name)).toEqual([
      'tasks-20260102-120000.db',
      'tasks-20260101-120000.db',
    ]);
    expect(brainList.map((e) => e.name)).toEqual(['brain-20260103-120000.db']);
    // conduit is now a registered prefix (T369); no conduit files exist in
    // this temp dir so its bucket is empty but still present in the map.
    expect(Object.keys(all).sort()).toEqual(['brain', 'conduit', 'tasks']);
    expect(all['tasks']?.length).toBe(2);
    expect(all['brain']?.length).toBe(1);
    expect(all['conduit']?.length).toBe(0);
  });
});
