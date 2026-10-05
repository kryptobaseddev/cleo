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

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResourceSample } from '../../resources/backend.js';
import { _resetGovernorStateForTest, governor } from '../../resources/governor.js';
import { ResourceMonitor } from '../../resources/monitor.js';
import {
  _resetDualScopeDbCache,
  assertExodusWriteSafe,
  assertWriteDurable,
  ExodusAbortWriteUnsafeError,
  getDualScopeNativeDb,
  openDualScopeDb,
} from '../dual-scope-db.js';
import { clearExodusAborts } from '../exodus/abort-events.js';
import { EXODUS_DEFERRED_WRITE_CODE } from '../exodus/write-guard.js';
import {
  countRowsInFile,
  LEGACY_TASK_IDS,
  seedLegacyTasksStore,
} from './fixtures/legacy-tasks-store.js';

/**
 * Race injection for the publish-before-guard window (review HIGH-1a): when
 * set, the next exodus assessment first fires `raceHook.fire` (a concurrent
 * open + write) and yields a macrotask, as a cold module import does in a real
 * CLI process, before assessing.
 */
const { raceHook } = vi.hoisted(() => ({ raceHook: { fire: null as null | (() => void) } }));
vi.mock('../exodus/on-open.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../exodus/on-open.js')>();
  return {
    ...actual,
    prepareExodusOnOpen: async (
      ...args: Parameters<typeof actual.prepareExodusOnOpen>
    ): ReturnType<typeof actual.prepareExodusOnOpen> => {
      const fire = raceHook.fire;
      if (fire !== null) {
        raceHook.fire = null;
        fire();
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      return actual.prepareExodusOnOpen(...args);
    },
  };
});

/**
 * Fault injection for the pre-publication guard (#1836 review LOW-a): when set,
 * the next guard install, or the next abort broadcast, throws once.
 */
const { faults } = vi.hoisted(() => ({
  faults: { failInstall: false, failInstallCount: 0, failEmit: false },
}));
vi.mock('../exodus/write-guard.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../exodus/write-guard.js')>();
  return {
    ...actual,
    installExodusWriteGuard: (
      ...args: Parameters<typeof actual.installExodusWriteGuard>
    ): ReturnType<typeof actual.installExodusWriteGuard> => {
      if (faults.failInstall) {
        faults.failInstall = false;
        throw new Error('injected: guard install failed');
      }
      if (faults.failInstallCount > 0) {
        faults.failInstallCount--;
        throw new Error('injected: guard install failed');
      }
      return actual.installExodusWriteGuard(...args);
    },
  };
});
vi.mock('../exodus/abort-events.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../exodus/abort-events.js')>();
  return {
    ...actual,
    emitExodusAbort: (...args: Parameters<typeof actual.emitExodusAbort>): void => {
      if (faults.failEmit) {
        faults.failEmit = false;
        throw new Error('injected: abort listener failed');
      }
      actual.emitExodusAbort(...args);
    },
  };
});

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
  faults.failInstall = false;
  faults.failInstallCount = 0;
  faults.failEmit = false;
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

  /**
   * Fire an `openDualScopeDb` + raw INSERT on every turn of the event loop until
   * `stop.done`, from t=0, without waiting for earlier ones (review HIGH-1a /
   * HIGH-1b): opens issued after the handle is published get it at once, the
   * way a concurrent request does. Returns the ids that landed.
   */
  async function hammer(stop: { done: boolean }): Promise<string[]> {
    const landed: string[] = [];
    const inflight: Promise<void>[] = [];
    let n = 0;
    while (!stop.done) {
      const id = `X${n++}`;
      inflight.push(
        (async () => {
          try {
            const h = await openDualScopeDb('project', projectDir);
            insertTask(h, id);
            landed.push(id);
          } catch {
            // Refused (guarded) or a closed handle mid-migration.
          }
        })(),
      );
      await new Promise((resolve) => setImmediate(resolve));
    }
    await Promise.all(inflight);
    return landed;
  }

  /** Legacy ids present in the store, read on a fresh connection. */
  async function legacyIdsInStore(): Promise<string[]> {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      return db
        .prepare("SELECT id FROM tasks_tasks WHERE id IN ('T1','T2','T3') ORDER BY id")
        .all()
        .map((row) => String(row.id));
    } finally {
      db.close();
    }
  }

  it('an open arriving while the first open assesses cannot land a write (review HIGH-1a)', async () => {
    seedLegacyTasksStore(cleoDir);
    vi.stubEnv('CLEO_EXODUS_ADMISSION_WAIT_MS', '400');
    vi.spyOn(ResourceMonitor.prototype, 'sample').mockResolvedValue(calm);
    const holder = await governor.acquire('db-heavy', { blocking: false });
    expect(holder.deferred).toBe(false);
    let racer: Promise<'landed' | 'refused'> | undefined;
    raceHook.fire = () => {
      racer = (async () => {
        try {
          insertTask(await openDualScopeDb('project', projectDir), 'RACE');
          return 'landed';
        } catch {
          return 'refused';
        }
      })();
    };
    try {
      const opened = await openDualScopeDb('project', projectDir);
      expect(racer).toBeDefined();
      expect(await racer).toBe('refused');
      expect(opened.exodusAbort?.kind).toBe('deferred');
      expect(countRowsInFile(dbPath, 'tasks_tasks')).toBe(0);
    } finally {
      raceHook.fire = null;
      if (!holder.deferred) await holder.release();
    }
    _resetDualScopeDbCache();
    clearExodusAborts();
    await openDualScopeDb('project', projectDir);
    expect(await legacyIdsInStore()).toEqual(['T1', 'T2', 'T3']);
  });

  it('concurrent opens writing from t=0 never land before a deferred migration (review HIGH-1a)', async () => {
    seedLegacyTasksStore(cleoDir);
    vi.stubEnv('CLEO_EXODUS_ADMISSION_WAIT_MS', '400');
    vi.spyOn(ResourceMonitor.prototype, 'sample').mockResolvedValue(calm);
    const holder = await governor.acquire('db-heavy', { blocking: false });
    expect(holder.deferred).toBe(false);
    const stop = { done: false };
    try {
      const first = openDualScopeDb('project', projectDir);
      const writes = hammer(stop);
      const opened = await first;
      await new Promise((resolve) => setTimeout(resolve, 100));
      stop.done = true;
      expect(await writes).toEqual([]);
      expect(opened.exodusAbort?.kind).toBe('deferred');
      expect(countRowsInFile(dbPath, 'tasks_tasks')).toBe(0);
    } finally {
      stop.done = true;
      if (!holder.deferred) await holder.release();
    }
    _resetDualScopeDbCache();
    clearExodusAborts();
    await openDualScopeDb('project', projectDir);
    expect(await legacyIdsInStore()).toEqual(['T1', 'T2', 'T3']);
  });

  it('concurrent opens writing from t=0 never land before an admitted migration (review HIGH-1a/1b)', async () => {
    seedLegacyTasksStore(cleoDir);
    vi.spyOn(ResourceMonitor.prototype, 'sample').mockResolvedValue(calm);
    const stop = { done: false };
    try {
      const first = openDualScopeDb('project', projectDir);
      const writes = hammer(stop);
      await first;
      stop.done = true;
      await writes;
    } finally {
      stop.done = true;
    }
    // No write reached the store before the copy, so the migration ran in full.
    expect(await legacyIdsInStore()).toEqual(['T1', 'T2', 'T3']);
  });

  it('a long-lived process recovers once another connection migrates (review MED-1)', async () => {
    seedLegacyTasksStore(cleoDir);
    vi.spyOn(ResourceMonitor.prototype, 'sample').mockResolvedValue(memoryPressured);
    const handle = await openDualScopeDb('project', projectDir);
    const native = getDualScopeNativeDb(handle);
    expect(() => insertTask(handle, 'T999')).toThrow(EXODUS_DEFERRED_WRITE_CODE);
    await expect(assertExodusWriteSafe(native)).rejects.toBeInstanceOf(ExodusAbortWriteUnsafeError);

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
    await expect(assertExodusWriteSafe(native)).resolves.toBeUndefined();
    expect(handle.exodusAbort).toBeUndefined();
    expect(countRowsInFile(dbPath, 'tasks_tasks')).toBe(2);
  });

  it('lifts once the cutover is sealed even when the anchor stays empty (review LOW)', async () => {
    // The legacy held rows, but none for the anchor table: after another process
    // migrates, tasks_tasks is still empty. The completion marker ends the guard.
    seedLegacyTasksStore(cleoDir);
    vi.spyOn(ResourceMonitor.prototype, 'sample').mockResolvedValue(memoryPressured);
    const handle = await openDualScopeDb('project', projectDir);
    const native = getDualScopeNativeDb(handle);
    expect(() => insertTask(handle, 'T999')).toThrow(EXODUS_DEFERRED_WRITE_CODE);

    const { exodusMarkerPath } = await import('../exodus/archive.js');
    writeFileSync(exodusMarkerPath('project', projectDir, dbPath), '{}');

    await expect(assertExodusWriteSafe(native)).resolves.toBeUndefined();
    expect(handle.exodusAbort).toBeUndefined();
    insertTask(handle, 'T999');
    expect(countRowsInFile(dbPath, 'tasks_tasks')).toBe(1);
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

    await expect(assertExodusWriteSafe(getDualScopeNativeDb(deferred))).rejects.toBeInstanceOf(
      ExodusAbortWriteUnsafeError,
    );
    await expect(assertExodusWriteSafe(getDualScopeNativeDb(other))).resolves.toBeUndefined();
    expect(other.exodusAbort).toBeUndefined();
  });

  it('a guard that throws after installing still lets the migration run (review LOW-a)', async () => {
    seedLegacyTasksStore(cleoDir);
    vi.spyOn(ResourceMonitor.prototype, 'sample').mockResolvedValue(calm);
    faults.failEmit = true;

    const handle = await openDualScopeDb('project', projectDir);

    expect(faults.failEmit).toBe(false);
    expect(handle.exodusAbort).toBeUndefined();
    expect(countRowsInFile(dbPath, 'tasks_tasks')).toBe(LEGACY_TASK_IDS.length);
  });

  it('a guard that cannot install falls back to the anchor table, and the next open migrates (review LOW-a)', async () => {
    seedLegacyTasksStore(cleoDir);
    const sample = vi.spyOn(ResourceMonitor.prototype, 'sample').mockResolvedValue(memoryPressured);
    faults.failInstall = true;

    const deferred = await openDualScopeDb('project', projectDir);

    expect(faults.failInstall).toBe(false);
    expect(deferred.exodusAbort?.kind).toBe('deferred');
    expect(() => insertTask(deferred, 'T999')).toThrow(EXODUS_DEFERRED_WRITE_CODE);
    expect(countRowsInFile(dbPath, 'tasks_tasks')).toBe(0);

    _resetDualScopeDbCache();
    clearExodusAborts();
    sample.mockResolvedValue(calm);
    const migrated = await openDualScopeDb('project', projectDir);
    expect(migrated.exodusAbort).toBeUndefined();
    expect(countRowsInFile(dbPath, 'tasks_tasks')).toBe(LEGACY_TASK_IDS.length);
  });

  it('a store no trigger can guard refuses the open with a retryable typed error; the next open guards it (T13171)', async () => {
    seedLegacyTasksStore(cleoDir);
    vi.spyOn(ResourceMonitor.prototype, 'sample').mockResolvedValue(memoryPressured);
    // Both the full guard and the anchor-only fallback fail to install.
    faults.failInstallCount = 2;

    await expect(openDualScopeDb('project', projectDir)).rejects.toMatchObject({
      name: 'ExodusGuardFailedError',
      codeName: 'E_EXODUS_GUARD_FAILED',
    });
    expect(faults.failInstallCount).toBe(0);
    expect(countRowsInFile(dbPath, 'tasks_tasks')).toBe(0);

    // Retryable: the next open installs the guard and the store refuses writes.
    const deferred = await openDualScopeDb('project', projectDir);
    expect(deferred.exodusAbort?.kind).toBe('deferred');
    expect(() => insertTask(deferred, 'T999')).toThrow(EXODUS_DEFERRED_WRITE_CODE);
    expect(countRowsInFile(dbPath, 'tasks_tasks')).toBe(0);
  });

  it('never asks the governor when no migration is pending', async () => {
    const acquire = vi.spyOn(governor, 'acquire');
    const handle = await openDualScopeDb('project', projectDir);
    expect(handle.exodusAbort).toBeUndefined();
    expect(acquire).not.toHaveBeenCalled();
  });
});
