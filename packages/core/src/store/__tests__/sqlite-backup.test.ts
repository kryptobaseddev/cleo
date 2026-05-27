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
 * @task T10316 — eager-open openers mocked to keep the unit-layer guard
 *               passing under the new SnapshotTarget.openDb contract
 * @task T10317 — inventory-driven targets; mocks extended to telemetry +
 *               skills + signaldock so every chokepoint role is stubbed
 * @epic T4867
 */

import { mkdirSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Stub the chokepoint openers we don't care about for a given test case.
 *
 * After T10317 the snapshot pipeline imports `telemetry/sqlite.js`,
 * `skills-db.js`, `signaldock-sqlite.js`, and `nexus-sqlite.js` at module
 * top-level. Tests that mock only `sqlite.js` + `memory-sqlite.js` +
 * `conduit-sqlite.js` MUST also neutralise these so the real modules don't
 * leak file-system writes to the developer's $XDG_DATA_HOME.
 */
function stubOtherChokepointOpeners(): void {
  vi.doMock('../../telemetry/sqlite.js', () => ({
    getTelemetryDb: async () => null,
    getTelemetryNativeDb: () => null,
  }));
  vi.doMock('../skills-db.js', () => ({
    openSkillsDb: async () => null,
    getSkillsNativeDb: () => null,
  }));
  vi.doMock('../signaldock-sqlite.js', () => ({
    ensureGlobalSignaldockDb: async () => undefined,
    getGlobalSignaldockNativeDb: () => null,
  }));
  vi.doMock('../nexus-sqlite.js', () => ({
    getNexusDb: async () => null,
    getNexusNativeDb: () => null,
  }));
  vi.doMock('../global-salt.js', () => ({ getGlobalSaltPath: () => '' }));
}

describe('sqlite-backup', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('is non-fatal when getNativeDb() returns null', async () => {
    // T10316: stub the eager-open paths too so they don't throw when the
    // singleton lookup returns null. The unit-layer contract is preserved —
    // both fast-path and eager-open returning null is still a clean skip.
    vi.doMock('../sqlite.js', () => ({ getNativeDb: () => null, getDb: async () => null }));
    vi.doMock('../memory-sqlite.js', () => ({
      getBrainNativeDb: () => null,
      getBrainDb: async () => null,
    }));
    vi.doMock('../conduit-sqlite.js', () => ({
      getConduitNativeDb: () => null,
      ensureConduitDb: () => ({ action: 'exists', path: '' }),
    }));
    stubOtherChokepointOpeners();
    vi.doMock('../../paths.js', () => ({
      getCleoDir: () => tmpdir(),
      getCleoHome: () => tmpdir(),
      resolveOrCwd: (cwd?: string) => cwd ?? tmpdir(),
    }));

    const { vacuumIntoBackup } = await import('../sqlite-backup.js');
    await expect(vacuumIntoBackup({ force: true })).resolves.not.toThrow();
  });

  it('is non-fatal when getBrainNativeDb() returns null', async () => {
    vi.doMock('../sqlite.js', () => ({ getNativeDb: () => null, getDb: async () => null }));
    vi.doMock('../memory-sqlite.js', () => ({
      getBrainNativeDb: () => null,
      getBrainDb: async () => null,
    }));
    vi.doMock('../conduit-sqlite.js', () => ({
      getConduitNativeDb: () => null,
      ensureConduitDb: () => ({ action: 'exists', path: '' }),
    }));
    stubOtherChokepointOpeners();
    vi.doMock('../../paths.js', () => ({
      getCleoDir: () => tmpdir(),
      getCleoHome: () => tmpdir(),
      resolveOrCwd: (cwd?: string) => cwd ?? tmpdir(),
    }));

    const { vacuumIntoBackupAll } = await import('../sqlite-backup.js');
    await expect(vacuumIntoBackupAll({ force: true })).resolves.not.toThrow();
  });

  it('calls PRAGMA wal_checkpoint(TRUNCATE) before VACUUM INTO for tasks.db', async () => {
    const execMock = vi.fn();
    vi.doMock('../sqlite.js', () => ({
      getNativeDb: () => ({ exec: execMock }),
      getDb: async () => null,
    }));
    vi.doMock('../memory-sqlite.js', () => ({
      getBrainNativeDb: () => null,
      getBrainDb: async () => null,
    }));
    vi.doMock('../conduit-sqlite.js', () => ({
      getConduitNativeDb: () => null,
      ensureConduitDb: () => ({ action: 'exists', path: '' }),
    }));
    stubOtherChokepointOpeners();
    const tempDir = join(tmpdir(), `cleo-test-wal-${Date.now()}`);
    vi.doMock('../../paths.js', () => ({
      getCleoDir: () => tempDir,
      getCleoHome: () => tempDir,
      resolveOrCwd: (cwd?: string) => cwd ?? tempDir,
    }));

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
    vi.doMock('../sqlite.js', () => ({
      getNativeDb: () => ({ exec: execMock }),
      getDb: async () => null,
    }));
    vi.doMock('../memory-sqlite.js', () => ({
      getBrainNativeDb: () => null,
      getBrainDb: async () => null,
    }));
    vi.doMock('../conduit-sqlite.js', () => ({
      getConduitNativeDb: () => null,
      ensureConduitDb: () => ({ action: 'exists', path: '' }),
    }));
    stubOtherChokepointOpeners();
    const tempDir = join(tmpdir(), `cleo-test-rot-${Date.now()}`);
    const backupDir = join(tempDir, 'backups', 'sqlite');
    mkdirSync(backupDir, { recursive: true });
    vi.doMock('../../paths.js', () => ({
      getCleoDir: () => tempDir,
      getCleoHome: () => tempDir,
      resolveOrCwd: (cwd?: string) => cwd ?? tempDir,
    }));

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
    vi.doMock('../sqlite.js', () => ({
      getNativeDb: () => ({ exec: tasksExec }),
      getDb: async () => null,
    }));
    vi.doMock('../memory-sqlite.js', () => ({
      getBrainNativeDb: () => ({ exec: brainExec }),
      getBrainDb: async () => null,
    }));
    vi.doMock('../conduit-sqlite.js', () => ({
      getConduitNativeDb: () => null,
      ensureConduitDb: () => ({ action: 'exists', path: '' }),
    }));
    stubOtherChokepointOpeners();
    const tempDir = join(tmpdir(), `cleo-test-rot-prefix-${Date.now()}`);
    const backupDir = join(tempDir, 'backups', 'sqlite');
    mkdirSync(backupDir, { recursive: true });
    vi.doMock('../../paths.js', () => ({
      getCleoDir: () => tempDir,
      getCleoHome: () => tempDir,
      resolveOrCwd: (cwd?: string) => cwd ?? tempDir,
    }));

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
    vi.doMock('../sqlite.js', () => ({
      getNativeDb: () => ({ exec: tasksExec }),
      getDb: async () => null,
    }));
    vi.doMock('../memory-sqlite.js', () => ({
      getBrainNativeDb: () => ({ exec: brainExec }),
      getBrainDb: async () => null,
    }));
    vi.doMock('../conduit-sqlite.js', () => ({
      getConduitNativeDb: () => null,
      ensureConduitDb: () => ({ action: 'exists', path: '' }),
    }));
    stubOtherChokepointOpeners();
    const tempDir = join(tmpdir(), `cleo-test-both-${Date.now()}`);
    vi.doMock('../../paths.js', () => ({
      getCleoDir: () => tempDir,
      getCleoHome: () => tempDir,
      resolveOrCwd: (cwd?: string) => cwd ?? tempDir,
    }));

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
    vi.doMock('../sqlite.js', () => ({
      getNativeDb: () => ({ exec: execMock }),
      getDb: async () => null,
    }));
    vi.doMock('../memory-sqlite.js', () => ({
      getBrainNativeDb: () => null,
      getBrainDb: async () => null,
    }));
    vi.doMock('../conduit-sqlite.js', () => ({
      getConduitNativeDb: () => null,
      ensureConduitDb: () => ({ action: 'exists', path: '' }),
    }));
    stubOtherChokepointOpeners();
    const tempDir = join(tmpdir(), `cleo-test-debounce-${Date.now()}`);
    vi.doMock('../../paths.js', () => ({
      getCleoDir: () => tempDir,
      getCleoHome: () => tempDir,
      resolveOrCwd: (cwd?: string) => cwd ?? tempDir,
    }));

    const { vacuumIntoBackup } = await import('../sqlite-backup.js');
    // First call with force sets _lastBackupEpoch
    await vacuumIntoBackup({ force: true });
    const callCountAfterFirst = execMock.mock.calls.length;

    // Second call without force — should be debounced
    await vacuumIntoBackup({ force: false });
    expect(execMock.mock.calls.length).toBe(callCountAfterFirst);
  });

  // T10316 regression: when getBrainNativeDb() returns null (brain.db not
  // opened earlier in this process), vacuumIntoBackupAll MUST still produce
  // a brain.db snapshot by eagerly opening brain via the canonical opener.
  // The mock-based unit guard exercises the SnapshotTarget.openDb contract;
  // the real-process variant lives in sqlite-backup-real-process.test.ts.
  it('vacuumIntoBackupAll calls openDb for brain when getBrainNativeDb is null (T10316)', async () => {
    const tasksExec = vi.fn();
    const brainExec = vi.fn();
    const getBrainDbMock = vi.fn(async () => null); // resolves; native handle below
    vi.doMock('../sqlite.js', () => ({
      getNativeDb: () => ({ exec: tasksExec }),
      getDb: async () => null,
    }));
    // First call to getBrainNativeDb returns null (fast path miss). The
    // openDb fallback awaits getBrainDb then re-queries getBrainNativeDb,
    // which returns the live handle on the second call.
    let brainCallCount = 0;
    vi.doMock('../memory-sqlite.js', () => ({
      getBrainNativeDb: () => {
        brainCallCount += 1;
        return brainCallCount === 1 ? null : { exec: brainExec };
      },
      getBrainDb: getBrainDbMock,
    }));
    vi.doMock('../conduit-sqlite.js', () => ({
      getConduitNativeDb: () => null,
      ensureConduitDb: () => ({ action: 'exists', path: '' }),
    }));
    stubOtherChokepointOpeners();
    const tempDir = join(tmpdir(), `cleo-test-eager-${Date.now()}`);
    vi.doMock('../../paths.js', () => ({
      getCleoDir: () => tempDir,
      getCleoHome: () => tempDir,
      resolveOrCwd: (cwd?: string) => cwd ?? tempDir,
    }));

    const { vacuumIntoBackupAll } = await import('../sqlite-backup.js');
    await vacuumIntoBackupAll({ force: true });

    expect(getBrainDbMock).toHaveBeenCalledTimes(1);
    // After eager-open, the brain VACUUM INTO must have executed.
    const brainCalls = brainExec.mock.calls.map((c) => c[0] as string);
    expect(brainCalls.some((c) => c.includes('wal_checkpoint'))).toBe(true);
    expect(brainCalls.some((c) => c.includes('VACUUM INTO'))).toBe(true);
  });

  it('listSqliteBackups and listBrainBackups return prefix-specific entries newest-first', async () => {
    vi.doMock('../sqlite.js', () => ({ getNativeDb: () => null, getDb: async () => null }));
    vi.doMock('../memory-sqlite.js', () => ({
      getBrainNativeDb: () => null,
      getBrainDb: async () => null,
    }));
    vi.doMock('../conduit-sqlite.js', () => ({
      getConduitNativeDb: () => null,
      ensureConduitDb: () => ({ action: 'exists', path: '' }),
    }));
    stubOtherChokepointOpeners();
    const tempDir = join(tmpdir(), `cleo-test-list-${Date.now()}`);
    const backupDir = join(tempDir, 'backups', 'sqlite');
    mkdirSync(backupDir, { recursive: true });
    vi.doMock('../../paths.js', () => ({
      getCleoDir: () => tempDir,
      getCleoHome: () => tempDir,
      resolveOrCwd: (cwd?: string) => cwd ?? tempDir,
    }));

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
    // T10317: every project-tier + derived inventory row now contributes a
    // bucket to listSqliteBackupsAll(). Empty buckets surface as `[]`.
    expect(Object.keys(all).sort()).toEqual(
      ['brain', 'conduit', 'llmtxt', 'manifest', 'signaldock-project', 'tasks'].sort(),
    );
    expect(all['tasks']?.length).toBe(2);
    expect(all['brain']?.length).toBe(1);
    expect(all['conduit']?.length).toBe(0);
    // Derived (manifest) + reserved (llmtxt) + historical (signaldock-project)
    // surface as empty arrays — covered, not snapshotted in this fixture.
    expect(all['manifest']?.length).toBe(0);
    expect(all['llmtxt']?.length).toBe(0);
    expect(all['signaldock-project']?.length).toBe(0);
  });

  // ==========================================================================
  // T10317 — inventory coverage (Saga T10281 / Epic T10284 / E3)
  // ==========================================================================

  /**
   * describeSnapshotCoverage MUST return one row per DB_INVENTORY entry. Every
   * row carries a `strategy` that classifies how the snapshot pipeline handles
   * the role: chokepoint-opener / raw-file-vacuum-readonly / skip-derived.
   *
   * This is the regression guard against future inventory additions slipping
   * through without a corresponding snapshot strategy.
   */
  it('describeSnapshotCoverage covers every DB_INVENTORY entry exactly once', async () => {
    stubOtherChokepointOpeners();
    vi.doMock('../sqlite.js', () => ({ getNativeDb: () => null, getDb: async () => null }));
    vi.doMock('../memory-sqlite.js', () => ({
      getBrainNativeDb: () => null,
      getBrainDb: async () => null,
    }));
    vi.doMock('../conduit-sqlite.js', () => ({
      getConduitNativeDb: () => null,
      ensureConduitDb: () => ({ action: 'exists', path: '' }),
    }));
    vi.doMock('../../paths.js', () => ({
      getCleoDir: () => tmpdir(),
      getCleoHome: () => tmpdir(),
      resolveOrCwd: (cwd?: string) => cwd ?? tmpdir(),
    }));

    const { DB_INVENTORY } = await import('@cleocode/contracts');
    const { describeSnapshotCoverage } = await import('../sqlite-backup.js');
    const rows = describeSnapshotCoverage();

    // One row per inventory entry — no silent drop, no duplicate.
    const inventoryRoles = DB_INVENTORY.map((e) => e.role).sort();
    const coverageRoles = rows.map((r) => r.role).sort();
    expect(coverageRoles).toEqual(inventoryRoles);

    // Every project + global row resolves to a real strategy (never undefined).
    for (const r of rows) {
      expect(['chokepoint-opener', 'raw-file-vacuum-readonly', 'skip-derived']).toContain(
        r.strategy,
      );
    }

    // The 7 chokepoint roles MUST land on chokepoint-opener strategy.
    const chokepointRoles = new Set([
      'tasks',
      'brain',
      'conduit',
      'nexus',
      'signaldock-global',
      'telemetry',
      'skills',
    ]);
    for (const r of rows) {
      if (chokepointRoles.has(r.role)) {
        expect(r.strategy).toBe('chokepoint-opener');
      }
    }

    // Derived rows MUST be skip-derived.
    for (const r of rows) {
      if (r.tier === 'derived') {
        expect(r.strategy).toBe('skip-derived');
      }
    }
  });

  /**
   * vacuumIntoBackupAll iterates project + derived inventory rows. Targets
   * with chokepoint openers produce a snapshot when their handle is non-null.
   * Targets without a live opener AND no file on disk fall through cleanly.
   *
   * The fixture seeds the project + derived snapshot dir, then verifies that
   * every chokepoint role with a real native handle gets a VACUUM INTO call.
   */
  it('vacuumIntoBackupAll fires VACUUM INTO for every project chokepoint target with a live handle', async () => {
    const tasksExec = vi.fn();
    const brainExec = vi.fn();
    const conduitExec = vi.fn();
    vi.doMock('../sqlite.js', () => ({
      getNativeDb: () => ({ exec: tasksExec }),
      getDb: async () => null,
    }));
    vi.doMock('../memory-sqlite.js', () => ({
      getBrainNativeDb: () => ({ exec: brainExec }),
      getBrainDb: async () => null,
    }));
    vi.doMock('../conduit-sqlite.js', () => ({
      getConduitNativeDb: () => ({ exec: conduitExec }),
      ensureConduitDb: () => ({ action: 'exists', path: '' }),
    }));
    stubOtherChokepointOpeners();
    const tempDir = join(tmpdir(), `cleo-t10317-project-${Date.now()}`);
    vi.doMock('../../paths.js', () => ({
      getCleoDir: () => tempDir,
      getCleoHome: () => tempDir,
      resolveOrCwd: (cwd?: string) => cwd ?? tempDir,
    }));

    const { vacuumIntoBackupAll } = await import('../sqlite-backup.js');
    await vacuumIntoBackupAll({ force: true });

    // Every project chokepoint role with a live handle MUST have received
    // both a wal_checkpoint and a VACUUM INTO call.
    for (const mock of [tasksExec, brainExec, conduitExec]) {
      const calls = mock.mock.calls.map((c) => c[0] as string);
      expect(calls.some((c) => c.includes('wal_checkpoint'))).toBe(true);
      expect(calls.some((c) => c.includes('VACUUM INTO'))).toBe(true);
    }
  });

  /**
   * Manifest (derived row, `backupPath === 'rebuildable-from-blob-store'`)
   * MUST be skipped — the snapshot pipeline must NOT emit a VACUUM INTO or
   * even attempt to open the file. Otherwise we double-snapshot blob CAS
   * content.
   */
  it('manifest (derived) row is skipped — strategy is skip-derived', async () => {
    stubOtherChokepointOpeners();
    vi.doMock('../sqlite.js', () => ({ getNativeDb: () => null, getDb: async () => null }));
    vi.doMock('../memory-sqlite.js', () => ({
      getBrainNativeDb: () => null,
      getBrainDb: async () => null,
    }));
    vi.doMock('../conduit-sqlite.js', () => ({
      getConduitNativeDb: () => null,
      ensureConduitDb: () => ({ action: 'exists', path: '' }),
    }));
    vi.doMock('../../paths.js', () => ({
      getCleoDir: () => tmpdir(),
      getCleoHome: () => tmpdir(),
      resolveOrCwd: (cwd?: string) => cwd ?? tmpdir(),
    }));

    const { describeSnapshotCoverage } = await import('../sqlite-backup.js');
    const manifest = describeSnapshotCoverage().find((r) => r.role === 'manifest');
    expect(manifest).toBeDefined();
    expect(manifest?.strategy).toBe('skip-derived');
    expect(manifest?.tier).toBe('derived');
  });
});
