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
 * T10315 additions:
 * - createBackup writes to the canonical `.cleo/backups/sqlite/` directory.
 * - Filename timestamp uses unified `YYYYMMDD-HHmmss` (matches sqlite-backup.ts).
 * - rotation only touches files owned by createBackup (NOT vacuum-snapshot files
 *   that may share the same dir).
 * - listSystemBackups enumerates both canonical + legacy dirs and tags legacy
 *   entries with `legacy: true`.
 * - restoreBackup falls through to legacy `.cleo/backups/snapshot/` and emits
 *   a one-time DeprecationWarning.
 *
 * These tests rely on filesystem-level state in a temporary directory —
 * they do NOT open a real CLEO database. SQLite handles are provided via
 * vi.doMock to exercise the VACUUM INTO code path.
 *
 * @task T5158
 * @task T10315
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

    // createBackup dynamically imports sqlite.js / memory-sqlite.js to
    // ensure the DBs are open before snapshotting; mocks must cover both
    // the `getDb`/`getBrainDb` open entry points AND the
    // `getNativeDb`/`getBrainNativeDb` handle accessors.
    vi.doMock('../../store/sqlite.js', () => ({
      getDb: vi.fn().mockResolvedValue({}),
      getNativeDb: () => ({ exec: tasksExec }),
    }));
    vi.doMock('../../store/memory-sqlite.js', () => ({
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

    // T10315: snapshot files now materialize in the canonical `sqlite/` dir.
    const canonicalDir = join(testDir, '.cleo', 'backups', 'sqlite');
    const files = readdirSync(canonicalDir);
    expect(files.some((f) => f.startsWith('tasks.db.'))).toBe(true);
    expect(files.some((f) => f.startsWith('brain.db.'))).toBe(true);
    expect(files.some((f) => f.startsWith('config.json.'))).toBe(true);
    expect(files.some((f) => f.startsWith('project-info.json.'))).toBe(true);

    // The deprecated `snapshot/` dir MUST NOT receive writes from createBackup.
    expect(existsSync(join(testDir, '.cleo', 'backups', 'snapshot'))).toBe(false);

    // T10315: backupId uses unified `YYYYMMDD-HHmmss` timestamp shape.
    expect(result.backupId).toMatch(/^snapshot-\d{8}-\d{6}$/);

    // Metadata sidecar.
    const metaFile = files.find((f) => f.endsWith('.meta.json'));
    expect(metaFile).toBeDefined();
    const meta = JSON.parse(readFileSync(join(canonicalDir, metaFile!), 'utf-8'));
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
    vi.doMock('../../store/memory-sqlite.js', () => ({
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

  it('listSystemBackups reads sidecars from the canonical sqlite/ directory', async () => {
    const canonicalDir = join(testDir, '.cleo', 'backups', 'sqlite');
    mkdirSync(canonicalDir, { recursive: true });

    writeFileSync(
      join(canonicalDir, 'snapshot-20260407-120000.meta.json'),
      JSON.stringify({
        backupId: 'snapshot-20260407-120000',
        type: 'snapshot',
        timestamp: '2026-04-07T12:00:00.000Z',
        files: ['config.json'],
      }),
    );
    writeFileSync(
      join(canonicalDir, 'safety-20260407-130000.meta.json'),
      JSON.stringify({
        backupId: 'safety-20260407-130000',
        type: 'safety',
        timestamp: '2026-04-07T13:00:00.000Z',
        files: ['tasks.db'],
      }),
    );

    const { listSystemBackups } = await import('../backup.js');
    const entries = listSystemBackups(testDir);

    expect(entries.length).toBe(2);
    // Newest first.
    expect(entries[0]?.backupId).toBe('safety-20260407-130000');
    expect(entries[1]?.backupId).toBe('snapshot-20260407-120000');
    // Canonical entries do NOT carry a legacy flag.
    expect(entries[0]?.legacy).toBeUndefined();
    expect(entries[1]?.legacy).toBeUndefined();
  });

  it('restoreBackup materializes captured files back into .cleo/', async () => {
    const canonicalDir = join(testDir, '.cleo', 'backups', 'sqlite');
    mkdirSync(canonicalDir, { recursive: true });
    const backupId = 'snapshot-20260407-140000';

    writeFileSync(join(canonicalDir, `tasks.db.${backupId}`), 'restored-tasks');
    writeFileSync(join(canonicalDir, `config.json.${backupId}`), '{"restored":true}');
    writeFileSync(
      join(canonicalDir, `${backupId}.meta.json`),
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

// T10315: legacy-dir read-side deprecation window — `cleo backup list` and
// `cleo backup recover` still see entries written by pre-T10315 builds.
describe('system/backup — legacy dir fallthrough (T10315 · ADR-013 §10)', () => {
  let testDir: string;
  beforeEach(async () => {
    vi.resetModules();
    testDir = await mkdtemp(join(tmpdir(), 'cleo-system-backup-legacy-'));
    mkdirSync(join(testDir, '.cleo'), { recursive: true });
  });
  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('listSystemBackups enumerates legacy `snapshot/` entries and tags them legacy=true', async () => {
    const legacyDir = join(testDir, '.cleo', 'backups', 'snapshot');
    mkdirSync(legacyDir, { recursive: true });

    const legacyBackupId = 'snapshot-2026-04-07T12-00-00-000Z';
    writeFileSync(
      join(legacyDir, `${legacyBackupId}.meta.json`),
      JSON.stringify({
        backupId: legacyBackupId,
        type: 'snapshot',
        timestamp: '2026-04-07T12:00:00.000Z',
        files: ['config.json'],
      }),
    );

    // Also a canonical entry so we exercise interleaving.
    const canonicalDir = join(testDir, '.cleo', 'backups', 'sqlite');
    mkdirSync(canonicalDir, { recursive: true });
    writeFileSync(
      join(canonicalDir, 'snapshot-20260507-120000.meta.json'),
      JSON.stringify({
        backupId: 'snapshot-20260507-120000',
        type: 'snapshot',
        timestamp: '2026-05-07T12:00:00.000Z',
        files: ['config.json'],
      }),
    );

    const mod = await import('../backup.js');
    mod._resetLegacyWarningOnce();
    const entries = mod.listSystemBackups(testDir);

    expect(entries).toHaveLength(2);
    // Newest first — canonical entry from May beats legacy entry from April.
    expect(entries[0]?.backupId).toBe('snapshot-20260507-120000');
    expect(entries[0]?.legacy).toBeUndefined();
    expect(entries[1]?.backupId).toBe(legacyBackupId);
    expect(entries[1]?.legacy).toBe(true);
  });

  it('listSystemBackups emits a one-time DeprecationWarning when legacy entries surface', async () => {
    const legacyDir = join(testDir, '.cleo', 'backups', 'snapshot');
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(
      join(legacyDir, 'snapshot-2026-04-07T12-00-00-000Z.meta.json'),
      JSON.stringify({
        backupId: 'snapshot-2026-04-07T12-00-00-000Z',
        type: 'snapshot',
        timestamp: '2026-04-07T12:00:00.000Z',
        files: [],
      }),
    );

    const mod = await import('../backup.js');
    mod._resetLegacyWarningOnce();

    const warnings: Array<{ name: string; code?: string; message: string }> = [];
    const onWarning = (warning: Error & { code?: string }): void => {
      warnings.push({ name: warning.name, code: warning.code, message: warning.message });
    };
    process.on('warning', onWarning);

    try {
      mod.listSystemBackups(testDir);
      mod.listSystemBackups(testDir); // second call MUST NOT re-warn
      // Allow the warning event to flush — `emitWarning` is async via setImmediate.
      await new Promise((resolve) => setImmediate(resolve));

      const matching = warnings.filter((w) => w.code === 'CLEO_BACKUP_LEGACY_SNAPSHOT_DIR');
      expect(matching.length).toBe(1);
      expect(matching[0]?.name).toBe('DeprecationWarning');
    } finally {
      process.off('warning', onWarning);
    }
  });

  it('restoreBackup falls through to legacy `snapshot/` when canonical sqlite/ is empty', async () => {
    const legacyDir = join(testDir, '.cleo', 'backups', 'snapshot');
    mkdirSync(legacyDir, { recursive: true });
    const backupId = 'snapshot-2026-04-07T15-00-00-000Z';

    writeFileSync(join(legacyDir, `config.json.${backupId}`), '{"legacy":true}');
    writeFileSync(
      join(legacyDir, `${backupId}.meta.json`),
      JSON.stringify({
        backupId,
        type: 'snapshot',
        timestamp: '2026-04-07T15:00:00.000Z',
        files: ['config.json'],
      }),
    );

    const mod = await import('../backup.js');
    mod._resetLegacyWarningOnce();

    const result = mod.restoreBackup(testDir, { backupId });
    expect(result.restored).toBe(true);
    expect(result.filesRestored).toContain('config.json');
    expect(readFileSync(join(testDir, '.cleo', 'config.json'), 'utf-8')).toBe('{"legacy":true}');
  });
});

// T9194: createBackup rotation — old snapshots are pruned when cap is exceeded.
describe('system/backup — rotation (T9194)', () => {
  let testDir: string;
  beforeEach(async () => {
    vi.resetModules();
    testDir = await mkdtemp(join(tmpdir(), 'cleo-system-backup-rotation-'));
    mkdirSync(join(testDir, '.cleo'), { recursive: true });
  });
  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('createBackup rotates oldest files when maxSnapshots is exceeded', async () => {
    vi.doMock('../../store/sqlite.js', () => ({
      getDb: vi.fn().mockResolvedValue({}),
      getNativeDb: () => null, // no-op snapshot — only JSON files get written
    }));
    vi.doMock('../../store/memory-sqlite.js', () => ({
      getBrainDb: vi.fn().mockResolvedValue({}),
      getBrainNativeDb: () => null,
    }));

    const { createBackup } = await import('../backup.js');
    const cleoDir = join(testDir, '.cleo');
    const configPath = join(cleoDir, 'config.json');
    writeFileSync(configPath, JSON.stringify({ test: true }));

    // Pre-populate 3 old backup files (simulating existing backups) under
    // the canonical sqlite/ dir using the createBackup filename convention.
    const canonicalDir = join(cleoDir, 'backups', 'sqlite');
    mkdirSync(canonicalDir, { recursive: true });
    for (let i = 1; i <= 3; i++) {
      writeFileSync(join(canonicalDir, `config.json.snapshot-old-${i}`), `old-${i}`);
    }

    // Create a new backup with maxSnapshots=3 — should rotate 1 old file out.
    await createBackup(testDir, { maxSnapshots: 3 });

    // The directory should have at most 3 non-meta files matching the scheme.
    const nonMetaFiles = readdirSync(canonicalDir).filter(
      (f) => !f.endsWith('.meta.json') && !f.endsWith('.tmp'),
    );
    expect(nonMetaFiles.length).toBeLessThanOrEqual(3);
  });

  it('createBackup does NOT rotate when count is within cap', async () => {
    vi.doMock('../../store/sqlite.js', () => ({
      getDb: vi.fn().mockResolvedValue({}),
      getNativeDb: () => null,
    }));
    vi.doMock('../../store/memory-sqlite.js', () => ({
      getBrainDb: vi.fn().mockResolvedValue({}),
      getBrainNativeDb: () => null,
    }));

    const { createBackup } = await import('../backup.js');
    const cleoDir = join(testDir, '.cleo');
    writeFileSync(join(cleoDir, 'config.json'), JSON.stringify({ test: true }));

    // Create backup with generous cap — no rotation should occur.
    const canonicalDir = join(cleoDir, 'backups', 'sqlite');
    await createBackup(testDir, { maxSnapshots: 50 });

    const nonMetaFiles = readdirSync(canonicalDir).filter(
      (f) => !f.endsWith('.meta.json') && !f.endsWith('.tmp'),
    );
    expect(nonMetaFiles.length).toBeGreaterThan(0);
    expect(nonMetaFiles.length).toBeLessThanOrEqual(50);
  });

  it('createBackup rotation does NOT touch coexisting vacuum-snapshot files (T10315)', async () => {
    vi.doMock('../../store/sqlite.js', () => ({
      getDb: vi.fn().mockResolvedValue({}),
      getNativeDb: () => null,
    }));
    vi.doMock('../../store/memory-sqlite.js', () => ({
      getBrainDb: vi.fn().mockResolvedValue({}),
      getBrainNativeDb: () => null,
    }));

    const { createBackup } = await import('../backup.js');
    const cleoDir = join(testDir, '.cleo');
    writeFileSync(join(cleoDir, 'config.json'), JSON.stringify({ test: true }));

    const canonicalDir = join(cleoDir, 'backups', 'sqlite');
    mkdirSync(canonicalDir, { recursive: true });

    // Pre-populate 5 createBackup-owned files + 5 vacuum-snapshot files
    // matching the `tasks-YYYYMMDD-HHmmss.db` shape that `vacuumIntoBackupAll`
    // produces. With maxSnapshots=1 the rotation MUST evict only the createBackup
    // entries — vacuum-snapshot files must stay.
    for (let i = 1; i <= 5; i++) {
      writeFileSync(join(canonicalDir, `config.json.snapshot-old-${i}`), `cb-${i}`);
      writeFileSync(join(canonicalDir, `tasks-2026040${i}-120000.db`), `vacuum-${i}`);
    }

    await createBackup(testDir, { type: 'snapshot', maxSnapshots: 1 });

    const remaining = readdirSync(canonicalDir);
    const vacuumStillThere = remaining.filter((f) => /^tasks-\d{8}-\d{6}\.db$/.test(f));
    expect(vacuumStillThere.length).toBe(5);
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
    const canonicalDir = join(testDir, '.cleo', 'backups', 'sqlite');
    mkdirSync(canonicalDir, { recursive: true });
    const backupId = 'snapshot-20260407-150000';
    const payload = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    writeFileSync(join(canonicalDir, `tasks.db.${backupId}`), payload);
    writeFileSync(
      join(canonicalDir, `${backupId}.meta.json`),
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
