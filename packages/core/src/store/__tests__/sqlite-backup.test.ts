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

import { chmodSync, mkdirSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * In-memory stand-in for the project `cleo.db` `schema_meta` table, where the
 * T12508 snapshot gate persists its debounce state. Recreated per test.
 */
let gateStateDb: DatabaseSync;

/**
 * Build a mocked tasks native handle: `exec` is the test's spy (so VACUUM INTO
 * never touches disk) and `prepare` reaches the in-memory gate state.
 */
function withGateState(exec: (sql: string) => void): {
  exec: (sql: string) => void;
  prepare: DatabaseSync['prepare'];
} {
  return { exec, prepare: (sql: string) => gateStateDb.prepare(sql) };
}

/**
 * Stub the chokepoint openers we don't care about for a given test case.
 *
 * After T10317 the snapshot pipeline imports `telemetry/sqlite.js`,
 * `skills-db.js`, `agent-registry-store.js`, and `nexus-sqlite.js` at module
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
  vi.doMock('../agent-registry-store.js', () => ({
    ensureGlobalAgentRegistryDb: async () => undefined,
    getGlobalAgentRegistryNativeDb: () => null,
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
    gateStateDb = new DatabaseSync(':memory:');
    gateStateDb.exec('CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
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
    await expect(vacuumIntoBackup()).resolves.not.toThrow();
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
    await expect(vacuumIntoBackupAll()).resolves.not.toThrow();
  });

  it('calls PRAGMA wal_checkpoint(TRUNCATE) before VACUUM INTO for tasks.db', async () => {
    const execMock = vi.fn();
    vi.doMock('../sqlite.js', () => ({
      getNativeDb: () => withGateState(execMock),
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
    await vacuumIntoBackup();

    expect(execMock).toHaveBeenCalledWith('PRAGMA wal_checkpoint(TRUNCATE)');
    const calls = execMock.mock.calls.map((c: string[][]) => c[0] as unknown as string);
    const walIdx = calls.findIndex((c: string) => c.includes('wal_checkpoint'));
    const vacuumIdx = calls.findIndex((c: string) => c.includes('VACUUM INTO'));
    expect(walIdx).toBeLessThan(vacuumIdx);
  });

  it('enforces maximum 10 tasks.db snapshots via rotation', async () => {
    const execMock = vi.fn();
    vi.doMock('../sqlite.js', () => ({
      getNativeDb: () => withGateState(execMock),
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
    await vacuumIntoBackup();

    const remaining = readdirSync(backupDir).filter(
      (f) => f.startsWith('tasks-') && f.endsWith('.db'),
    );
    expect(remaining.length).toBeLessThanOrEqual(10);
  });

  it('enforces rotation independently per prefix (tasks + brain)', async () => {
    const tasksExec = vi.fn();
    const brainExec = vi.fn();
    vi.doMock('../sqlite.js', () => ({
      getNativeDb: () => withGateState(tasksExec),
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
    await vacuumIntoBackupAll();

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
      getNativeDb: () => withGateState(tasksExec),
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
    await vacuumIntoBackupAll();

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
      getNativeDb: () => withGateState(execMock),
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
    // First call snapshots and persists the start time in schema_meta.
    await vacuumIntoBackup();
    const callCountAfterFirst = execMock.mock.calls.length;
    expect(callCountAfterFirst).toBeGreaterThan(0);

    // Second call — debounced by the persisted state (T12508: no force path).
    await vacuumIntoBackup();
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
      getNativeDb: () => withGateState(tasksExec),
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
    await vacuumIntoBackupAll();

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
      getNativeDb: () => withGateState(tasksExec),
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
    await vacuumIntoBackupAll();

    // Every project chokepoint role with a live handle MUST have received
    // both a wal_checkpoint and a VACUUM INTO call.
    for (const mock of [tasksExec, brainExec, conduitExec]) {
      const calls = mock.mock.calls.map((c) => c[0] as string);
      expect(calls.some((c) => c.includes('wal_checkpoint'))).toBe(true);
      expect(calls.some((c) => c.includes('VACUUM INTO'))).toBe(true);
    }
  });

  /**
   * T12508 NEW-1: two snapshots of one prefix inside the same wall-clock
   * second (a routine checkpoint, then a pre-destructive `required` one) must
   * BOTH land. The filename has second resolution and `VACUUM INTO` refuses an
   * existing file, so the second one must move to a free name, not fail.
   */
  it('a routine and a required snapshot in the same second both produce files (T12508)', async () => {
    const tempDir = join(tmpdir(), `cleo-t12508-same-second-${Date.now()}`);
    const backupDir = join(tempDir, 'backups', 'sqlite');
    mkdirSync(tempDir, { recursive: true });
    const tasksDb = new DatabaseSync(join(tempDir, 'tasks-live.db'));
    tasksDb.exec('CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    tasksDb.exec('CREATE TABLE t (x INTEGER); INSERT INTO t VALUES (1)');
    vi.doMock('../sqlite.js', () => ({ getNativeDb: () => tasksDb, getDb: async () => null }));
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
      getCleoDir: () => tempDir,
      getCleoHome: () => tempDir,
      resolveOrCwd: (cwd?: string) => cwd ?? tempDir,
    }));
    const { vacuumIntoBackup } = await import('../sqlite-backup.js');

    // Start just after a second boundary so both calls share one second.
    await new Promise((r) => setTimeout(r, 1000 - (Date.now() % 1000) + 10));
    const listTasks = (): string[] =>
      readdirSync(backupDir).filter((f) => /^tasks-\d{8}-\d{6}\.db$/.test(f));
    const t0 = Math.floor(Date.now() / 1000);
    const routine = await vacuumIntoBackup();
    const afterRoutine = listTasks();
    const required = await vacuumIntoBackup({ mode: 'required' });
    const afterRequired = listTasks();
    const t1 = Math.floor(Date.now() / 1000);
    tasksDb.close();

    expect(routine?.snapshotted).toEqual(['tasks']);
    expect(required?.snapshotted).toEqual(['tasks']);
    expect(required?.failed).toEqual([]);
    expect(afterRoutine).toHaveLength(1);
    // The required snapshot wrote a DIFFERENT file (retention may then prune
    // the older one: both sit in the same quarter-hour bucket).
    const written = afterRequired.filter((f) => !afterRoutine.includes(f));
    expect(written).toHaveLength(1);
    // The free name was found by waiting for the next second (one step).
    expect(t1 - t0).toBeLessThanOrEqual(2);
  });

  /**
   * T12508 #2: tasks, brain and conduit share ONE cleo.db handle. A run must
   * VACUUM it once and hard-link the same file under the other prefixes, so
   * every `<prefix>-*.db` reader still finds a file at no extra disk cost.
   */
  it('one VACUUM per physical database file; other prefixes are hard links (T12508)', async () => {
    const tempDir = join(tmpdir(), `cleo-t12508-dedupe-${Date.now()}`);
    const backupDir = join(tempDir, 'backups', 'sqlite');
    mkdirSync(tempDir, { recursive: true });
    const shared = new DatabaseSync(join(tempDir, 'cleo.db'));
    shared.exec('CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    const realExec = shared.exec.bind(shared);
    let vacuums = 0;
    shared.exec = (sql: string): void => {
      if (sql.startsWith('VACUUM INTO')) vacuums += 1;
      realExec(sql);
    };
    vi.doMock('../sqlite.js', () => ({ getNativeDb: () => shared, getDb: async () => null }));
    vi.doMock('../memory-sqlite.js', () => ({
      getBrainNativeDb: () => shared,
      getBrainDb: async () => null,
    }));
    vi.doMock('../conduit-sqlite.js', () => ({
      getConduitNativeDb: () => shared,
      ensureConduitDb: () => ({ action: 'exists', path: '' }),
    }));
    stubOtherChokepointOpeners();
    vi.doMock('../../paths.js', () => ({
      getCleoDir: () => tempDir,
      getCleoHome: () => tempDir,
      resolveOrCwd: (cwd?: string) => cwd ?? tempDir,
    }));

    const { vacuumIntoBackupAll } = await import('../sqlite-backup.js');
    const r = await vacuumIntoBackupAll();
    shared.close();

    expect(vacuums).toBe(1);
    expect(r?.snapshotted).toEqual(['tasks', 'brain', 'conduit']);
    expect(r?.linked).toEqual(['brain', 'conduit']);
    const files = readdirSync(backupDir).filter((f) => /^(tasks|brain|conduit)-/.test(f));
    expect(files).toHaveLength(3);
    const inodes = new Set(files.map((f) => statSync(join(backupDir, f)).ino));
    expect(inodes.size).toBe(1);
  });

  /**
   * T12508 #3: with project A already open in the process, snapshotting
   * project B must read B's database, never the ambient A handle.
   */
  it('two projects: B is snapshotted from B, not from the ambient A handle (T12508)', async () => {
    const root = join(tmpdir(), `cleo-t12508-two-${Date.now()}`);
    const cleoA = join(root, 'a', '.cleo');
    const cleoB = join(root, 'b', '.cleo');
    mkdirSync(cleoA, { recursive: true });
    mkdirSync(cleoB, { recursive: true });
    const dbA = new DatabaseSync(join(cleoA, 'cleo.db'));
    const dbB = new DatabaseSync(join(cleoB, 'cleo.db'));
    for (const [db, who] of [
      [dbA, 'A'],
      [dbB, 'B'],
    ] as const) {
      db.exec('CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
      db.exec(`CREATE TABLE marker (who TEXT); INSERT INTO marker VALUES ('${who}')`);
    }
    const projectOf = (cwd?: string): 'a' | 'b' => (cwd === join(root, 'b') ? 'b' : 'a');
    // No cwd → the ambient project (A), exactly like the real bound registry.
    vi.doMock('../sqlite.js', () => ({
      getNativeDb: (cwd?: string) => (projectOf(cwd) === 'b' ? dbB : dbA),
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
    vi.doMock('../../paths.js', () => ({
      getCleoDir: (cwd?: string) => (projectOf(cwd) === 'b' ? cleoB : cleoA),
      getCleoHome: () => root,
      resolveOrCwd: (cwd?: string) => cwd ?? join(root, 'a'),
    }));

    const { vacuumIntoBackup } = await import('../sqlite-backup.js');
    const r = await vacuumIntoBackup({ cwd: join(root, 'b') });
    dbA.close();
    dbB.close();

    expect(r?.snapshotted).toEqual(['tasks']);
    const [snap] = readdirSync(join(cleoB, 'backups', 'sqlite')).filter((f) =>
      /^tasks-\d{8}-\d{6}\.db$/.test(f),
    );
    expect(snap).toBeDefined();
    const copy = new DatabaseSync(join(cleoB, 'backups', 'sqlite', snap ?? ''), { readOnly: true });
    const who = copy.prepare('SELECT who FROM marker').get() as { who: string } | undefined;
    copy.close();
    expect(who?.who).toBe('B');
  });

  it('refuses a project-tier handle whose file is outside the project (T12508)', async () => {
    const root = join(tmpdir(), `cleo-t12508-foreign-${Date.now()}`);
    const cleoB = join(root, 'b', '.cleo');
    mkdirSync(cleoB, { recursive: true });
    mkdirSync(join(root, 'a', '.cleo'), { recursive: true });
    const foreign = new DatabaseSync(join(root, 'a', '.cleo', 'cleo.db'));
    foreign.exec('CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    vi.doMock('../sqlite.js', () => ({ getNativeDb: () => foreign, getDb: async () => null }));
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
      getCleoDir: () => cleoB,
      getCleoHome: () => root,
      resolveOrCwd: (cwd?: string) => cwd ?? join(root, 'b'),
    }));

    const { vacuumIntoBackup } = await import('../sqlite-backup.js');
    const r = await vacuumIntoBackup({ cwd: join(root, 'b'), mode: 'required' });
    foreign.close();

    expect(r?.failed).toEqual(['tasks']);
    expect(r?.snapshotted).toEqual([]);
  });

  /**
   * T12508 #5: an existing database the process cannot stat (EACCES) is a
   * FAILURE. `existsSync` would have answered false and classed it absent.
   */
  it('an unreadable raw-file database is failed, not absent (T12508)', async () => {
    const projectRoot = join(tmpdir(), `cleo-t12508-eacces-${Date.now()}`);
    const cleoDir = join(projectRoot, '.cleo');
    const llmtxtDir = join(cleoDir, 'llmtxt');
    mkdirSync(llmtxtDir, { recursive: true });
    const seed = new DatabaseSync(join(llmtxtDir, 'llmtxt.db'));
    seed.exec('CREATE TABLE t (x INTEGER)');
    seed.close();
    const tasksDb = new DatabaseSync(join(cleoDir, 'cleo.db'));
    tasksDb.exec('CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    vi.doMock('../sqlite.js', () => ({ getNativeDb: () => tasksDb, getDb: async () => null }));
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
      getCleoDir: () => cleoDir,
      getCleoHome: () => projectRoot,
      resolveOrCwd: (cwd?: string) => cwd ?? projectRoot,
    }));

    chmodSync(llmtxtDir, 0o000);
    try {
      const { vacuumIntoBackupAll } = await import('../sqlite-backup.js');
      const r = await vacuumIntoBackupAll({ cwd: projectRoot, mode: 'required' });
      expect(r?.failed).toContain('llmtxt');
      expect(r?.absent).not.toContain('llmtxt');
    } finally {
      chmodSync(llmtxtDir, 0o755);
      tasksDb.close();
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
