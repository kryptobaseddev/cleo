/**
 * An ABORTED exodus-on-open never lets a write strand the legacy data (T13167).
 *
 * An abort (parity failure, assessment failure, plan mismatch, a completion
 * marker contradicted by legacy rows) leaves the consolidated store empty while
 * the legacy rows wait, exactly like a deferral. These tests abort the
 * migration (an unreadable completion marker makes the assessment fail), then
 * drive the production write paths `cleo add`, `cleo update` and
 * `cleo session start` take, and prove each is refused with the typed code and
 * remedy while nothing lands.
 *
 * @task T13167
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResourceSample } from '../../resources/backend.js';
import { _resetGovernorStateForTest } from '../../resources/governor.js';
import { ResourceMonitor } from '../../resources/monitor.js';
import { sessionStart } from '../../session/engine-ops.js';
import { addTaskWithSessionScope } from '../../tasks/session-scope.js';
import { taskUpdate } from '../../tasks/update.js';
import {
  _resetDualScopeDbCache,
  assertExodusWriteSafe,
  assertWriteDurable,
  ExodusAbortWriteUnsafeError,
  getDualScopeNativeDb,
  openDualScopeDb,
} from '../dual-scope-db.js';
import { clearExodusAborts } from '../exodus/abort-events.js';
import { exodusMarkerPath } from '../exodus/archive.js';
import { EXODUS_ABORT_WRITE_CODE } from '../exodus/write-guard.js';
import { countRowsInFile, seedLegacyTasksStore } from './fixtures/legacy-tasks-store.js';

let root: string;
let projectDir: string;
let cleoDir: string;
let dbPath: string;

/** A calm host: nothing defers the migration, so its outcome is the abort. */
const calm: ResourceSample = {
  sampledAtMs: Date.now(),
  pressureAvailable: true,
  memAvailableBytes: 32 * 1024 * 1024 * 1024,
  globalPressure: {
    some: { avg10: 0, avg60: 0, avg300: 0, totalUs: 0 },
    full: { avg10: 0, avg60: 0, avg300: 0, totalUs: 0 },
  },
  slicePressure: null,
  cpuPressure: null,
  walObservations: [],
};

beforeEach(() => {
  root = join(tmpdir(), `exodus-aborted-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  projectDir = join(root, 'project');
  cleoDir = join(projectDir, '.cleo');
  mkdirSync(cleoDir, { recursive: true });
  mkdirSync(join(root, 'cleo'), { recursive: true });
  vi.stubEnv('CLEO_HOME', join(root, 'cleo'));
  vi.stubEnv('CLEO_DIR', cleoDir);
  vi.stubEnv('CLEO_ROOT', undefined);
  vi.stubEnv('CLEO_DISABLE_EXODUS_ON_OPEN', undefined);
  vi.stubEnv('CLEO_SESSION_ID', undefined);
  _resetGovernorStateForTest();
  vi.spyOn(ResourceMonitor.prototype, 'sample').mockResolvedValue(calm);
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

/** Seed legacy rows and an unreadable completion marker: the assessment aborts. */
function stageAbort(): void {
  seedLegacyTasksStore(cleoDir);
  writeFileSync(exodusMarkerPath('project', projectDir, dbPath), 'not json');
}

/** Raw INSERT into tasks_tasks on the handle's own connection. */
function insertTask(handle: Awaited<ReturnType<typeof openDualScopeDb>>, id: string): void {
  getDualScopeNativeDb(handle)
    .prepare(
      "INSERT INTO tasks_tasks (id, title, status, priority, type, created_at) VALUES (?, 'new', 'pending', 'medium', 'task', '2026-10-03T00:00:00Z')",
    )
    .run(id);
}

describe('aborted exodus-on-open (T13167)', () => {
  it('guards the store: the marker, the typed checks and the connection all refuse', async () => {
    stageAbort();
    const handle = await openDualScopeDb('project', projectDir);

    expect(handle.exodusAbort?.kind).toBe('aborted');
    expect(handle.exodusAbort?.reason).toContain('legacy tasks still hold rows');
    expect(() => assertWriteDurable(handle)).toThrow(ExodusAbortWriteUnsafeError);
    await expect(assertExodusWriteSafe(getDualScopeNativeDb(handle))).rejects.toMatchObject({
      codeName: EXODUS_ABORT_WRITE_CODE,
      fix: expect.stringContaining('cleo exodus migrate'),
    });
    expect(() => insertTask(handle, 'T999')).toThrow(EXODUS_ABORT_WRITE_CODE);
    expect(countRowsInFile(dbPath, 'tasks_tasks')).toBe(0);
    const { drainWarnings } = await import('../../output.js');
    expect(drainWarnings()?.map((w) => w.code)).toContain('W_EXODUS_ABORTED');
  });

  it('refuses cleo add, cleo update and cleo session start, and nothing lands', async () => {
    stageAbort();
    await openDualScopeDb('project', projectDir);

    const added = await addTaskWithSessionScope(projectDir, {
      title: 'Written after an aborted migration',
      description: 'must be refused',
      acceptance: ['first criterion', 'second criterion', 'third criterion'],
      type: 'saga',
    });
    expect(added.success).toBe(false);
    expect(added.error?.code).toBe(EXODUS_ABORT_WRITE_CODE);
    expect(added.error?.fix).toContain('cleo exodus migrate');

    const updated = await taskUpdate(projectDir, 'T1', { title: 'renamed' });
    expect(updated.success).toBe(false);

    const started = await sessionStart(projectDir, { scope: 'global', name: 'after abort' });
    expect(started.success).toBe(false);
    expect(started.error?.code).toBe(EXODUS_ABORT_WRITE_CODE);

    expect(countRowsInFile(dbPath, 'tasks_tasks')).toBe(0);
    expect(countRowsInFile(dbPath, 'sessions')).toBe(0);
  });

  it('session creation itself refuses with the typed error', async () => {
    stageAbort();
    await openDualScopeDb('project', projectDir);
    const { createSession } = await import('../session-store.js');
    await expect(
      createSession(
        {
          id: 'ses_20261003000000_abcdef',
          name: 'after abort',
          status: 'active',
          scope: { type: 'global' },
          taskWork: { taskId: null, setAt: '2026-10-03T00:00:00Z' },
          startedAt: '2026-10-03T00:00:00Z',
        },
        projectDir,
      ),
    ).rejects.toMatchObject({ codeName: EXODUS_ABORT_WRITE_CODE });
    expect(countRowsInFile(dbPath, 'sessions')).toBe(0);
  });

  it('a completion marker does not lift an abort guard; rows (a reconcile) do', async () => {
    stageAbort();
    const handle = await openDualScopeDb('project', projectDir);
    const native = getDualScopeNativeDb(handle);
    await expect(assertExodusWriteSafe(native)).rejects.toBeInstanceOf(ExodusAbortWriteUnsafeError);

    // The marker (here unreadable) is exactly what the abort contradicts.
    await expect(assertExodusWriteSafe(native)).rejects.toBeInstanceOf(ExodusAbortWriteUnsafeError);

    // A reconcile in another process copies the legacy rows in.
    const { DatabaseSync } = await import('node:sqlite');
    const other = new DatabaseSync(dbPath);
    other
      .prepare(
        "INSERT INTO tasks_tasks (id, title, status, priority, type, created_at) VALUES ('T1', 'reconciled', 'pending', 'medium', 'task', '2026-10-03T00:00:00Z')",
      )
      .run();
    other.close();

    await expect(assertExodusWriteSafe(native)).resolves.toBeUndefined();
    expect(handle.exodusAbort).toBeUndefined();
    insertTask(handle, 'T999');
    expect(countRowsInFile(dbPath, 'tasks_tasks')).toBe(2);
  });

  it('an abort with no legacy rows at risk installs no guard', async () => {
    stageAbort();
    const { DatabaseSync } = await import('node:sqlite');
    const legacy = new DatabaseSync(join(cleoDir, 'tasks.db'));
    legacy.exec('DELETE FROM tasks');
    legacy.close();

    const handle = await openDualScopeDb('project', projectDir);
    // Still an abort (the marker is unreadable), recorded and marked as before,
    // but nothing is stranded, so no table is guarded.
    expect(handle.exodusAbort?.kind).toBe('aborted');
    await expect(assertExodusWriteSafe(getDualScopeNativeDb(handle))).resolves.toBeUndefined();
    insertTask(handle, 'T999');
    expect(countRowsInFile(dbPath, 'tasks_tasks')).toBe(1);
  });
});
