/**
 * Tests for SQLite VACUUM INTO backup module.
 *
 * Verifies:
 * - Non-fatal when getNativeDb() returns null
 * - WAL checkpoint runs before VACUUM INTO
 * - Snapshot rotation enforces MAX_SNAPSHOTS limit
 * - Debounce prevents rapid successive backups
 *
 * @task T4874
 * @epic T4867
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('sqlite-backup', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('is non-fatal when getNativeDb() returns null', async () => {
    vi.doMock('../../store/sqlite.js', () => ({ getNativeDb: () => null }));
    vi.doMock('../../core/paths.js', () => ({ getCleoDir: () => tmpdir() }));

    const { vacuumIntoBackup } = await import('../sqlite-backup.js');
    await expect(vacuumIntoBackup({ force: true })).resolves.not.toThrow();
  });

  it('calls PRAGMA wal_checkpoint(TRUNCATE) before VACUUM INTO', async () => {
    const execMock = vi.fn();
    vi.doMock('../../store/sqlite.js', () => ({ getNativeDb: () => ({ exec: execMock }) }));
    const tempDir = join(tmpdir(), `cleo-test-wal-${Date.now()}`);
    vi.doMock('../../core/paths.js', () => ({ getCleoDir: () => tempDir }));

    const { vacuumIntoBackup } = await import('../sqlite-backup.js');
    await vacuumIntoBackup({ force: true });

    expect(execMock).toHaveBeenCalledWith('PRAGMA wal_checkpoint(TRUNCATE)');
    const calls = execMock.mock.calls.map((c: string[][]) => c[0] as string);
    const walIdx = calls.findIndex((c: string) => c.includes('wal_checkpoint'));
    const vacuumIdx = calls.findIndex((c: string) => c.includes('VACUUM INTO'));
    expect(walIdx).toBeLessThan(vacuumIdx);
  });

  it('enforces maximum 10 snapshots via rotation', async () => {
    const execMock = vi.fn();
    vi.doMock('../../store/sqlite.js', () => ({ getNativeDb: () => ({ exec: execMock }) }));
    const tempDir = join(tmpdir(), `cleo-test-rot-${Date.now()}`);
    const backupDir = join(tempDir, 'backups', 'sqlite');
    mkdirSync(backupDir, { recursive: true });
    vi.doMock('../../core/paths.js', () => ({ getCleoDir: () => tempDir }));

    // Seed 11 fake snapshot files with valid YYYYMMDD-HHMMSS format
    for (let i = 0; i < 11; i++) {
      const day = String(i + 1).padStart(2, '0'); // 01..11
      writeFileSync(join(backupDir, `tasks-202601${day}-120000.db`), 'fake');
    }

    const { vacuumIntoBackup } = await import('../sqlite-backup.js');
    await vacuumIntoBackup({ force: true });

    const remaining = readdirSync(backupDir).filter(f => f.endsWith('.db'));
    expect(remaining.length).toBeLessThanOrEqual(10);
  });

  it('debounce skips second call within debounce window', async () => {
    const execMock = vi.fn();
    vi.doMock('../../store/sqlite.js', () => ({ getNativeDb: () => ({ exec: execMock }) }));
    const tempDir = join(tmpdir(), `cleo-test-debounce-${Date.now()}`);
    vi.doMock('../../core/paths.js', () => ({ getCleoDir: () => tempDir }));

    const { vacuumIntoBackup } = await import('../sqlite-backup.js');
    // First call with force sets _lastBackupEpoch
    await vacuumIntoBackup({ force: true });
    const callCountAfterFirst = execMock.mock.calls.length;

    // Second call without force -- should be debounced
    await vacuumIntoBackup({ force: false });
    expect(execMock.mock.calls.length).toBe(callCountAfterFirst);
  });
});
