/**
 * Tests for the system backup module.
 *
 * Focus areas (T5158):
 * - createBackup uses VACUUM INTO via the live SQLite handle and falls back
 *   gracefully when the handle is unavailable (non-fatal).
 * - createBackup uses atomic tmp-then-rename for JSON files.
 * - createBackup writes a .meta.json sidecar enumerating captured files.
 * - listSystemBackups reads back the sidecars.
 * - restoreBackup materializes files back into .cleo/.
 *
 * These tests rely on filesystem-level state in a temporary directory —
 * they do NOT open a real CLEO database. SQLite handles are provided via
 * vi.doMock to exercise the VACUUM INTO code path.
 *
 * @task T5158
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('system/backup', () => {
  let testDir: string;

  beforeEach(async () => {
    vi.resetModules();
    testDir = await mkdtemp(join(tmpdir(), 'cleo-system-backup-'));
    mkdirSync(join(testDir, '.cleo'), { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('createBackup snapshots SQLite files via VACUUM INTO and JSON via atomic write', async () => {
    const tasksExec = vi.fn((sql: string) => {
      // Simulate VACUUM INTO by creating the destination file.
      const match = sql.match(/VACUUM INTO '(.+)'/);
      if (match) writeFileSync(match[1]!, 'vacuumed-tasks');
    });
    const brainExec = vi.fn((sql: string) => {
      const match = sql.match(/VACUUM INTO '(.+)'/);
      if (match) writeFileSync(match[1]!, 'vacuumed-brain');
    });

    // createBackup dynamically imports sqlite.js / brain-sqlite.js to
    // ensure the DBs are open before snapshotting; mocks must cover both
    // the `getDb`/`getBrainDb` open entry points AND the
    // `getNativeDb`/`getBrainNativeDb` handle accessors.
    vi.doMock('../../store/sqlite.js', () => ({
      getDb: vi.fn().mockResolvedValue({}),
      getNativeDb: () => ({ exec: tasksExec }),
    }));
    vi.doMock('../../store/brain-sqlite.js', () => ({
      getBrainDb: vi.fn().mockResolvedValue({}),
      getBrainNativeDb: () => ({ exec: brainExec }),
    }));

    // Seed source files so existsSync checks pass in createBackup.
    writeFileSync(join(testDir, '.cleo', 'tasks.db'), 'live-tasks');
    writeFileSync(join(testDir, '.cleo', 'brain.db'), 'live-brain');
    writeFileSync(join(testDir, '.cleo', 'config.json'), '{"version":"test"}');
    writeFileSync(join(testDir, '.cleo', 'project-info.json'), '{"projectId":"test"}');

    const { createBackup } = await import('../backup.js');
    const result = await createBackup(testDir, { type: 'snapshot', note: 't5158-test' });

    expect(result.files).toEqual(
      expect.arrayContaining(['tasks.db', 'brain.db', 'config.json', 'project-info.json']),
    );

    // VACUUM INTO was invoked with wal_checkpoint preceding it.
    const tasksCalls = tasksExec.mock.calls.map((c) => c[0]);
    const brainCalls = brainExec.mock.calls.map((c) => c[0]);
    const tasksWal = tasksCalls.findIndex((c) => c.includes('wal_checkpoint'));
    const tasksVacuum = tasksCalls.findIndex((c) => c.includes('VACUUM INTO'));
    expect(tasksWal).toBeGreaterThanOrEqual(0);
    expect(tasksVacuum).toBeGreaterThan(tasksWal);
    const brainWal = brainCalls.findIndex((c) => c.includes('wal_checkpoint'));
    const brainVacuum = brainCalls.findIndex((c) => c.includes('VACUUM INTO'));
    expect(brainWal).toBeGreaterThanOrEqual(0);
    expect(brainVacuum).toBeGreaterThan(brainWal);

    // Snapshot files materialized in the backup dir.
    const snapshotDir = join(testDir, '.cleo', 'backups', 'snapshot');
    const files = readdirSync(snapshotDir);
    expect(files.some((f) => f.startsWith('tasks.db.'))).toBe(true);
    expect(files.some((f) => f.startsWith('brain.db.'))).toBe(true);
    expect(files.some((f) => f.startsWith('config.json.'))).toBe(true);
    expect(files.some((f) => f.startsWith('project-info.json.'))).toBe(true);

    // Metadata sidecar.
    const metaFile = files.find((f) => f.endsWith('.meta.json'));
    expect(metaFile).toBeDefined();
    const meta = JSON.parse(readFileSync(join(snapshotDir, metaFile!), 'utf-8'));
    expect(meta.note).toBe('t5158-test');
    expect(meta.files).toEqual(
      expect.arrayContaining(['tasks.db', 'brain.db', 'config.json', 'project-info.json']),
    );
  });

  it('createBackup skips SQLite files when the native handle is null (non-fatal)', async () => {
    vi.doMock('../../store/sqlite.js', () => ({
      getDb: vi.fn().mockResolvedValue({}),
      getNativeDb: () => null,
    }));
    vi.doMock('../../store/brain-sqlite.js', () => ({
      getBrainDb: vi.fn().mockResolvedValue({}),
      getBrainNativeDb: () => null,
    }));

    writeFileSync(join(testDir, '.cleo', 'tasks.db'), 'live-tasks');
    writeFileSync(join(testDir, '.cleo', 'brain.db'), 'live-brain');
    writeFileSync(join(testDir, '.cleo', 'config.json'), '{"v":1}');

    const { createBackup } = await import('../backup.js');
    const result = await createBackup(testDir);

    // JSON file captured, SQLite files skipped because no handle available.
    expect(result.files).toContain('config.json');
    expect(result.files).not.toContain('tasks.db');
    expect(result.files).not.toContain('brain.db');
  });

  it('listSystemBackups reads sidecars from all known backup type dirs', async () => {
    const snapshotDir = join(testDir, '.cleo', 'backups', 'snapshot');
    const safetyDir = join(testDir, '.cleo', 'backups', 'safety');
    mkdirSync(snapshotDir, { recursive: true });
    mkdirSync(safetyDir, { recursive: true });

    writeFileSync(
      join(snapshotDir, 'snapshot-A.meta.json'),
      JSON.stringify({
        backupId: 'snapshot-A',
        type: 'snapshot',
        timestamp: '2026-04-07T12:00:00.000Z',
        files: ['config.json'],
      }),
    );
    writeFileSync(
      join(safetyDir, 'safety-B.meta.json'),
      JSON.stringify({
        backupId: 'safety-B',
        type: 'safety',
        timestamp: '2026-04-07T13:00:00.000Z',
        files: ['tasks.db'],
      }),
    );

    const { listSystemBackups } = await import('../backup.js');
    const entries = listSystemBackups(testDir);

    expect(entries.length).toBe(2);
    // Newest first.
    expect(entries[0]?.backupId).toBe('safety-B');
    expect(entries[1]?.backupId).toBe('snapshot-A');
  });

  it('restoreBackup materializes captured files back into .cleo/', async () => {
    const snapshotDir = join(testDir, '.cleo', 'backups', 'snapshot');
    mkdirSync(snapshotDir, { recursive: true });
    const backupId = 'snapshot-restore-test';

    writeFileSync(join(snapshotDir, `tasks.db.${backupId}`), 'restored-tasks');
    writeFileSync(join(snapshotDir, `config.json.${backupId}`), '{"restored":true}');
    writeFileSync(
      join(snapshotDir, `${backupId}.meta.json`),
      JSON.stringify({
        backupId,
        type: 'snapshot',
        timestamp: '2026-04-07T14:00:00.000Z',
        files: ['tasks.db', 'config.json'],
      }),
    );

    // Pre-existing live copies the restore will overwrite.
    writeFileSync(join(testDir, '.cleo', 'tasks.db'), 'stale-tasks');
    writeFileSync(join(testDir, '.cleo', 'config.json'), '{"stale":true}');

    const { restoreBackup } = await import('../backup.js');
    const result = restoreBackup(testDir, { backupId });

    expect(result.restored).toBe(true);
    expect(result.filesRestored).toEqual(expect.arrayContaining(['tasks.db', 'config.json']));
    expect(readFileSync(join(testDir, '.cleo', 'tasks.db'), 'utf-8')).toBe('restored-tasks');
    expect(readFileSync(join(testDir, '.cleo', 'config.json'), 'utf-8')).toBe('{"restored":true}');
  });

  it('restoreBackup throws NOT_FOUND for a missing backupId', async () => {
    const { restoreBackup } = await import('../backup.js');
    expect(() => restoreBackup(testDir, { backupId: 'nonexistent' })).toThrowError(
      /Backup not found/,
    );
  });
});

// Sanity: ensure the safety snapshot produced by the vacuumed blob is readable
// as a normal file (we treat .db files as opaque blobs during restore).
describe('system/backup — restored .db files are byte-identical', () => {
  let testDir: string;
  beforeEach(async () => {
    vi.resetModules();
    testDir = await mkdtemp(join(tmpdir(), 'cleo-system-backup-restore-'));
    mkdirSync(join(testDir, '.cleo'), { recursive: true });
  });
  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('restoreBackup copies .db files without re-vacuuming', async () => {
    const snapshotDir = join(testDir, '.cleo', 'backups', 'snapshot');
    mkdirSync(snapshotDir, { recursive: true });
    const backupId = 'snapshot-byte-identity';
    const payload = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    writeFileSync(join(snapshotDir, `tasks.db.${backupId}`), payload);
    writeFileSync(
      join(snapshotDir, `${backupId}.meta.json`),
      JSON.stringify({
        backupId,
        type: 'snapshot',
        timestamp: '2026-04-07T15:00:00.000Z',
        files: ['tasks.db'],
      }),
    );

    const { restoreBackup } = await import('../backup.js');
    const result = restoreBackup(testDir, { backupId });
    expect(result.restored).toBe(true);

    const liveBytes = readFileSync(join(testDir, '.cleo', 'tasks.db'));
    expect(Buffer.compare(liveBytes, payload)).toBe(0);
    expect(existsSync(join(testDir, '.cleo', 'tasks.db'))).toBe(true);
  });
});
