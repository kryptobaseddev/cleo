/**
 * A deferred exodus-on-open never lets a write strand the legacy data (T13158).
 *
 * When the governor cannot admit the migration (memory pressure, or the single
 * machine-wide `db-heavy` slot held elsewhere), the open returns the EMPTY
 * consolidated store. Before T13158 the first write there made the store
 * "populated", and on-open never migrated it: the legacy rows were stranded.
 * These tests seed a legacy `tasks.db`, defer the migration both ways, and
 * prove that no row lands in a table the migration fills, that writes refuse
 * with the typed code and remedy, and that the next calm open migrates.
 *
 * @task T13158
 */

import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResourceSample } from '../../resources/backend.js';
import { _resetGovernorStateForTest, governor } from '../../resources/governor.js';
import { ResourceMonitor } from '../../resources/monitor.js';
import {
  _resetDualScopeDbCache,
  assertExodusNotDeferred,
  assertWriteDurable,
  ExodusAbortWriteUnsafeError,
  getDualScopeNativeDb,
  openDualScopeDb,
} from '../dual-scope-db.js';
import { clearExodusAborts } from '../exodus/abort-events.js';
import { EXODUS_DEFERRED_WRITE_CODE } from '../exodus/deferred-guard.js';
import {
  countRowsInFile,
  LEGACY_TASK_IDS,
  seedLegacyTasksStore,
} from './fixtures/legacy-tasks-store.js';

let root: string;
let projectDir: string;
let cleoDir: string;
let dbPath: string;

beforeEach(() => {
  root = join(tmpdir(), `exodus-deferred-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  projectDir = join(root, 'project');
  cleoDir = join(projectDir, '.cleo');
  mkdirSync(cleoDir, { recursive: true });
  mkdirSync(join(root, 'cleo'), { recursive: true });
  vi.stubEnv('CLEO_HOME', join(root, 'cleo'));
  vi.stubEnv('CLEO_DIR', cleoDir);
  vi.stubEnv('CLEO_ROOT', undefined);
  vi.stubEnv('CLEO_DISABLE_EXODUS_ON_OPEN', undefined);
  // Keep the capacity case fast: the open waits this long for the slot.
  vi.stubEnv('CLEO_EXODUS_ADMISSION_WAIT_MS', '50');
  _resetGovernorStateForTest();
  dbPath = join(cleoDir, 'cleo.db');
});

afterEach(async () => {
  const { drainWarnings } = await import('../../output.js');
  drainWarnings();
  vi.restoreAllMocks();
  _resetDualScopeDbCache();
  clearExodusAborts();
  _resetGovernorStateForTest();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

/** A host under memory pressure: `db-heavy`'s memory-only budget is 0. */
const memoryPressured: ResourceSample = {
  sampledAtMs: Date.now(),
  pressureAvailable: true,
  memAvailableBytes: 1024 * 1024 * 1024,
  globalPressure: {
    some: { avg10: 40, avg60: 40, avg300: 40, totalUs: 0 },
    full: { avg10: 0, avg60: 0, avg300: 0, totalUs: 0 },
  },
  slicePressure: null,
  cpuPressure: null,
  walObservations: [],
};

/** A calm host. */
const calm: ResourceSample = {
  ...memoryPressured,
  memAvailableBytes: 32 * 1024 * 1024 * 1024,
  globalPressure: {
    some: { avg10: 0, avg60: 0, avg300: 0, totalUs: 0 },
    full: { avg10: 0, avg60: 0, avg300: 0, totalUs: 0 },
  },
};

/** Try a raw INSERT into tasks_tasks on the handle's own connection. */
function insertTask(handle: Awaited<ReturnType<typeof openDualScopeDb>>, id: string): void {
  getDualScopeNativeDb(handle)
    .prepare(
      "INSERT INTO tasks_tasks (id, title, status, priority, type, created_at) VALUES (?, 'new', 'pending', 'medium', 'task', '2026-10-03T00:00:00Z')",
    )
    .run(id);
}

describe('deferred exodus-on-open (T13158)', () => {
  it('under memory pressure: the store stays empty, writes refuse with the code and remedy, reads work', async () => {
    seedLegacyTasksStore(cleoDir);
    vi.spyOn(ResourceMonitor.prototype, 'sample').mockResolvedValue(memoryPressured);

    const handle = await openDualScopeDb('project', projectDir);

    expect(handle.exodusAbort?.kind).toBe('deferred');
    expect(handle.exodusAbort?.reason).toContain('memory some avg10=40.0');
    expect(handle.exodusAbort?.reason).toContain('legacy tasks still hold rows');
    // Reads work on the empty store.
    expect(
      getDualScopeNativeDb(handle).prepare('SELECT COUNT(*) AS n FROM tasks_tasks').get()?.n,
    ).toBe(0);
    // Every write path refuses: the connection itself, and the typed guards.
    expect(() => insertTask(handle, 'T999')).toThrow(EXODUS_DEFERRED_WRITE_CODE);
    expect(() => insertTask(handle, 'T999')).toThrow(/cleo exodus migrate/);
    expect(() => assertWriteDurable(handle)).toThrow(ExodusAbortWriteUnsafeError);
    expect(() => assertWriteDurable(handle)).toThrow(/has not run yet/);
    // Nothing landed, on disk.
    expect(countRowsInFile(dbPath, 'tasks_tasks')).toBe(0);
    // Readers are told why their results omit the legacy data.
    const { drainWarnings } = await import('../../output.js');
    expect(drainWarnings()?.map((w) => w.code)).toContain('W_EXODUS_DEFERRED');
  });

  it('refuses the task store write path `cleo add` takes, and nothing lands', async () => {
    seedLegacyTasksStore(cleoDir);
    vi.spyOn(ResourceMonitor.prototype, 'sample').mockResolvedValue(memoryPressured);
    const { getTaskAccessor } = await import('../data-accessor.js');

    const accessor = await getTaskAccessor(projectDir);
    await expect(
      accessor.upsertSingleTask({
        id: 'T999',
        title: 'written while the migration is deferred',
        status: 'pending',
        priority: 'medium',
        type: 'task',
        createdAt: '2026-10-03T00:00:00Z',
      }),
    ).rejects.toMatchObject({
      name: 'ExodusAbortWriteUnsafeError',
      codeName: EXODUS_DEFERRED_WRITE_CODE,
      fix: expect.stringContaining('cleo exodus migrate'),
    });
    expect(countRowsInFile(dbPath, 'tasks_tasks')).toBe(0);
  });

  it('admits the migration when db-heavy frees up within the wait', async () => {
    seedLegacyTasksStore(cleoDir);
    vi.stubEnv('CLEO_EXODUS_ADMISSION_WAIT_MS', '10000');
    vi.spyOn(ResourceMonitor.prototype, 'sample').mockResolvedValue(calm);
    const holder = await governor.acquire('db-heavy', { blocking: false });
    expect(holder.deferred).toBe(false);
    const released = new Promise<void>((resolve) => {
      setTimeout(() => {
        if (!holder.deferred) void holder.release().then(resolve);
      }, 300);
    });

    const handle = await openDualScopeDb('project', projectDir);
    await released;

    expect(handle.exodusAbort).toBeUndefined();
    expect(countRowsInFile(dbPath, 'tasks_tasks')).toBe(LEGACY_TASK_IDS.length);
  });

  it('with db-heavy held elsewhere: the open waits its bound, then guards the store the same way', async () => {
    seedLegacyTasksStore(cleoDir);
    vi.spyOn(ResourceMonitor.prototype, 'sample').mockResolvedValue(calm);
    const holder = await governor.acquire('db-heavy', { blocking: false });
    expect(holder.deferred).toBe(false);
    try {
      const handle = await openDualScopeDb('project', projectDir);
      expect(handle.exodusAbort?.kind).toBe('deferred');
      expect(handle.exodusAbort?.reason).toContain('at capacity');
      expect(() => insertTask(handle, 'T999')).toThrow(EXODUS_DEFERRED_WRITE_CODE);
      expect(countRowsInFile(dbPath, 'tasks_tasks')).toBe(0);
    } finally {
      if (!holder.deferred) await holder.release();
    }
  });

  it('the next calm open migrates every legacy row, and writes work again', async () => {
    seedLegacyTasksStore(cleoDir);
    const sample = vi.spyOn(ResourceMonitor.prototype, 'sample').mockResolvedValue(memoryPressured);
    const deferred = await openDualScopeDb('project', projectDir);
    expect(() => insertTask(deferred, 'T999')).toThrow(EXODUS_DEFERRED_WRITE_CODE);

    // A later command: a fresh process (no cached handle), a calm machine.
    _resetDualScopeDbCache();
    clearExodusAborts();
    sample.mockResolvedValue(calm);
    const migrated = await openDualScopeDb('project', projectDir);

    expect(migrated.exodusAbort).toBeUndefined();
    expect(countRowsInFile(dbPath, 'tasks_tasks')).toBe(LEGACY_TASK_IDS.length);
    insertTask(migrated, 'T999');
    expect(countRowsInFile(dbPath, 'tasks_tasks')).toBe(LEGACY_TASK_IDS.length + 1);
  });

  it('legacy files with no rows: no wait, no guard, writable (review MED-2)', async () => {
    seedLegacyTasksStore(cleoDir);
    const { DatabaseSync } = await import('node:sqlite');
    const legacy = new DatabaseSync(join(cleoDir, 'tasks.db'));
    legacy.exec('DELETE FROM tasks');
    legacy.close();
    vi.stubEnv('CLEO_EXODUS_ADMISSION_WAIT_MS', '3000');
    vi.spyOn(ResourceMonitor.prototype, 'sample').mockResolvedValue(calm);
    const acquire = vi.spyOn(governor, 'acquire');
    const holder = await governor.acquire('db-heavy', { blocking: false });
    acquire.mockClear();
    try {
      const started = Date.now();
      const handle = await openDualScopeDb('project', projectDir);

      expect(Date.now() - started).toBeLessThan(2000);
      expect(acquire).not.toHaveBeenCalled();
      expect(handle.exodusAbort).toBeUndefined();
      insertTask(handle, 'T999');
      expect(countRowsInFile(dbPath, 'tasks_tasks')).toBe(1);
    } finally {
      if (!holder.deferred) await holder.release();
    }
  });

  it('a concurrent in-process open during the admission wait is guarded too (review HIGH-1)', async () => {
    seedLegacyTasksStore(cleoDir);
    vi.stubEnv('CLEO_EXODUS_ADMISSION_WAIT_MS', '1500');
    vi.spyOn(ResourceMonitor.prototype, 'sample').mockResolvedValue(calm);
    const holder = await governor.acquire('db-heavy', { blocking: false });
    expect(holder.deferred).toBe(false);
    try {
      const first = openDualScopeDb('project', projectDir);
      await new Promise((resolve) => setTimeout(resolve, 400));
      // The handle is published while the first open still waits for admission.
      const second = await openDualScopeDb('project', projectDir);
      expect(second.exodusAbort?.kind).toBe('deferred');
      expect(() => insertTask(second, 'T999')).toThrow(EXODUS_DEFERRED_WRITE_CODE);
      const opened = await first;
      expect(opened.exodusAbort?.reason).toContain('at capacity');
      expect(second.exodusAbort?.reason).toContain('at capacity');
      expect(countRowsInFile(dbPath, 'tasks_tasks')).toBe(0);
    } finally {
      if (!holder.deferred) await holder.release();
    }
    // Nothing reached disk, so a later calm open still migrates every legacy row.
    _resetDualScopeDbCache();
    clearExodusAborts();
    await openDualScopeDb('project', projectDir);
    expect(countRowsInFile(dbPath, 'tasks_tasks')).toBe(LEGACY_TASK_IDS.length);
  });

  it('a long-lived process recovers once another connection migrates (review MED-1)', async () => {
    seedLegacyTasksStore(cleoDir);
    vi.spyOn(ResourceMonitor.prototype, 'sample').mockResolvedValue(memoryPressured);
    const handle = await openDualScopeDb('project', projectDir);
    const native = getDualScopeNativeDb(handle);
    expect(() => insertTask(handle, 'T999')).toThrow(EXODUS_DEFERRED_WRITE_CODE);
    await expect(assertExodusNotDeferred(native)).rejects.toBeInstanceOf(
      ExodusAbortWriteUnsafeError,
    );

    // Another process fills the store (here: a second connection writes the anchor).
    const { DatabaseSync } = await import('node:sqlite');
    const other = new DatabaseSync(dbPath);
    other
      .prepare(
        "INSERT INTO tasks_tasks (id, title, status, priority, type, created_at) VALUES ('T1', 'migrated', 'pending', 'medium', 'task', '2026-10-03T00:00:00Z')",
      )
      .run();
    other.close();

    // The cached connection writes again, and the typed guard lifts with the marker.
    insertTask(handle, 'T999');
    await expect(assertExodusNotDeferred(native)).resolves.toBeUndefined();
    expect(handle.exodusAbort).toBeUndefined();
    expect(countRowsInFile(dbPath, 'tasks_tasks')).toBe(2);
  });

  it('guards per connection: another store stays writable (review LOW-1)', async () => {
    seedLegacyTasksStore(cleoDir);
    vi.spyOn(ResourceMonitor.prototype, 'sample').mockResolvedValue(memoryPressured);
    const deferred = await openDualScopeDb('project', projectDir);
    const otherProject = join(root, 'other');
    mkdirSync(join(otherProject, '.cleo'), { recursive: true });
    vi.stubEnv('CLEO_DIR', join(otherProject, '.cleo'));
    const other = await openDualScopeDb('project', otherProject);
    expect(other.dbPath).not.toBe(deferred.dbPath);

    await expect(assertExodusNotDeferred(getDualScopeNativeDb(deferred))).rejects.toBeInstanceOf(
      ExodusAbortWriteUnsafeError,
    );
    await expect(assertExodusNotDeferred(getDualScopeNativeDb(other))).resolves.toBeUndefined();
    expect(other.exodusAbort).toBeUndefined();
  });

  it('never asks the governor when no migration is pending', async () => {
    const acquire = vi.spyOn(governor, 'acquire');
    const handle = await openDualScopeDb('project', projectDir);
    expect(handle.exodusAbort).toBeUndefined();
    expect(acquire).not.toHaveBeenCalled();
  });
});
