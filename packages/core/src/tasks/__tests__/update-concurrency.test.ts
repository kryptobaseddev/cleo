/**
 * Optimistic concurrency on task mutation (T12503).
 *
 * `cleo update` reads a task, computes the new row, then writes it. Before
 * T12503 the write was computed entirely from that earlier read, so two
 * processes that both ran `cleo update <id> --add-labels …` could each read
 * the same labels and the second commit would overwrite the first. The
 * SQLITE_BUSY retry (gh#391) made both writes COMMIT; it could not stop one of
 * them from being lost.
 *
 * Two processes are simulated by interleaving: the accessor handed to writer A
 * runs a complete, independent `updateTask` (writer B) between A's read and
 * A's write transaction. That is exactly the window a second process occupies,
 * and B goes through the same code path a second `cleo update` would.
 *
 * @task T12503
 * @epic T12497
 */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ExitCode, type Task, type TaskConflictDetails } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CleoError } from '../../errors.js';
import { createTestDb, seedTasks, type TestDbEnv } from '../../store/__tests__/test-db-helper.js';
import type { DataAccessor } from '../../store/data-accessor.js';
import { resetDbState } from '../../store/sqlite.js';
import { nextTaskVersion, taskConflictError, taskVersion } from '../../store/task-version.js';
import { type CompleteTaskOptions, completeTask, taskComplete } from '../complete.js';
import { taskUpdate, type UpdateTaskOptions, updateTask } from '../update.js';

/**
 * Wrap `inner` so the FIRST `loadSingleTask(taskId)` returns its snapshot only
 * after `interleave()` has committed — the stale read of a racing process.
 */
function withInterleavedWriter(
  inner: DataAccessor,
  taskId: string,
  interleave: () => Promise<unknown>,
): DataAccessor {
  let fired = false;
  return new Proxy(inner, {
    get(target, prop) {
      if (prop === 'loadSingleTask') {
        return async (id: string) => {
          const snapshot = await target.loadSingleTask(id);
          if (!fired && id === taskId) {
            fired = true;
            await interleave();
          }
          return snapshot;
        };
      }
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

describe('updateTask optimistic concurrency (T12503)', () => {
  let env: TestDbEnv;
  let accessor: DataAccessor;

  beforeEach(async () => {
    env = await createTestDb();
    accessor = env.accessor;
    process.env['CLEO_DIR'] = env.cleoDir;
    await writeFile(
      join(env.cleoDir, 'config.json'),
      JSON.stringify({
        enforcement: {
          session: { requiredForMutate: false },
          acceptance: { mode: 'off' },
        },
        lifecycle: { mode: 'off' },
        verification: { enabled: false },
      }),
    );
    const createdAt = new Date().toISOString();
    await seedTasks(accessor, [
      { id: 'T001', title: 'Target', status: 'pending', priority: 'medium', createdAt },
      { id: 'T002', title: 'Dep A', status: 'pending', priority: 'medium', createdAt },
      { id: 'T003', title: 'Dep B', status: 'pending', priority: 'medium', createdAt },
    ]);
  });

  afterEach(async () => {
    delete process.env['CLEO_DIR'];
    resetDbState();
    await env.cleanup();
  });

  /** Run writer A with writer B committed between A's read and A's write. */
  async function raceTwoWriters(a: UpdateTaskOptions, b: UpdateTaskOptions): Promise<void> {
    const racing = withInterleavedWriter(accessor, a.taskId, () =>
      updateTask(b, env.tempDir, accessor),
    );
    await updateTask(a, env.tempDir, racing);
  }

  it('two interleaved --add-labels writers both survive', async () => {
    await raceTwoWriters(
      { taskId: 'T001', addLabels: ['from-a'] },
      { taskId: 'T001', addLabels: ['from-b'] },
    );
    const task = await accessor.loadSingleTask('T001');
    expect([...(task?.labels ?? [])].sort()).toEqual(['from-a', 'from-b']);
  });

  it('--remove-labels applies to the current labels, not the stale read', async () => {
    await updateTask({ taskId: 'T001', addLabels: ['keep', 'drop'] }, env.tempDir, accessor);
    await raceTwoWriters(
      { taskId: 'T001', removeLabels: ['drop'] },
      { taskId: 'T001', addLabels: ['late'] },
    );
    const task = await accessor.loadSingleTask('T001');
    expect([...(task?.labels ?? [])].sort()).toEqual(['keep', 'late']);
  });

  it('interleaved --add-depends and --add-files writers both survive', async () => {
    await raceTwoWriters(
      { taskId: 'T001', addDepends: ['T002'], addFiles: ['a.ts'] },
      { taskId: 'T001', addDepends: ['T003'], addFiles: ['b.ts'] },
    );
    const task = await accessor.loadSingleTask('T001');
    expect([...(task?.depends ?? [])].sort()).toEqual(['T002', 'T003']);
    expect([...(task?.files ?? [])].sort()).toEqual(['a.ts', 'b.ts']);
  });

  it('an unguarded scalar update no longer reverts fields a concurrent writer changed', async () => {
    await raceTwoWriters(
      { taskId: 'T001', addLabels: ['from-a'] },
      { taskId: 'T001', title: 'Retitled by B' },
    );
    const task = await accessor.loadSingleTask('T001');
    expect(task?.title).toBe('Retitled by B');
    expect(task?.labels).toEqual(['from-a']);
  });

  it('20 concurrent --add-labels calls lose nothing', async () => {
    const labels = Array.from({ length: 20 }, (_, i) => `label-${i}`);
    const settled = await Promise.allSettled(
      labels.map((label) => updateTask({ taskId: 'T001', addLabels: [label] }, env.tempDir)),
    );
    expect(settled.filter((r) => r.status === 'rejected')).toEqual([]);
    const task = await accessor.loadSingleTask('T001');
    expect([...(task?.labels ?? [])].sort()).toEqual([...labels].sort());
  });

  it('a stale expectedUpdatedAt fails with E_CONFLICT carrying the current version', async () => {
    const read = await accessor.loadSingleTask('T001');
    const staleVersion = taskVersion(read);
    await updateTask({ taskId: 'T001', title: 'Newer write' }, env.tempDir, accessor);
    const current = await accessor.loadSingleTask('T001');
    const currentVersion = taskVersion(current);
    expect(currentVersion).not.toBe(staleVersion);

    const error = await updateTask(
      { taskId: 'T001', title: 'Stale write', expectedUpdatedAt: staleVersion },
      env.tempDir,
      accessor,
    ).catch((err: Error) => err);
    expect(error).toBeInstanceOf(CleoError);
    const conflict = error as CleoError;
    expect(conflict.code).toBe(ExitCode.VERSION_CONFLICT);
    expect(conflict.toLAFSError().code).toBe('E_CONFLICT');
    expect(conflict.details).toMatchObject({
      field: 'updatedAt',
      expected: staleVersion,
      actual: currentVersion,
      currentVersion,
    });
    expect((await accessor.loadSingleTask('T001'))?.title).toBe('Newer write');
  });

  it('a stale version read before the race is rejected inside the write transaction', async () => {
    const staleVersion = taskVersion(await accessor.loadSingleTask('T001'));
    const error = await raceTwoWriters(
      { taskId: 'T001', addLabels: ['from-a'], expectedUpdatedAt: staleVersion },
      { taskId: 'T001', addLabels: ['from-b'] },
    ).catch((err: Error) => err);
    expect((error as CleoError).code).toBe(ExitCode.VERSION_CONFLICT);
    expect((await accessor.loadSingleTask('T001'))?.labels).toEqual(['from-b']);
  });

  it('a matching expectedUpdatedAt succeeds and advances the version', async () => {
    const version = taskVersion(await accessor.loadSingleTask('T001'));
    const result = await updateTask(
      { taskId: 'T001', addLabels: ['guarded'], expectedUpdatedAt: version },
      env.tempDir,
      accessor,
    );
    expect(result.task.labels).toEqual(['guarded']);
    expect(taskVersion(result.task) > version).toBe(true);
    expect(taskVersion(await accessor.loadSingleTask('T001'))).toBe(taskVersion(result.task));
  });

  it('the engine wrapper surfaces E_CONFLICT with exit code and current version', async () => {
    const staleVersion = taskVersion(await accessor.loadSingleTask('T001'));
    await updateTask({ taskId: 'T001', title: 'Newer write' }, env.tempDir, accessor);
    const result = await taskUpdate(env.tempDir, 'T001', {
      title: 'Stale write',
      expectedUpdatedAt: staleVersion,
    });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('E_CONFLICT');
    expect(result.error?.exitCode).toBe(ExitCode.VERSION_CONFLICT);
    expect(result.error?.details).toMatchObject({ expected: staleVersion });
  });

  it('two writers read version v; A commits; B is refused with E_CONFLICT naming the changed fields', async () => {
    const v = taskVersion(await accessor.loadSingleTask('T001'));
    // Writer B (the guarded one) read v; writer A commits between B's read and
    // B's write transaction.
    const error = await raceTwoWriters(
      { taskId: 'T001', title: 'From B', expectedUpdatedAt: v },
      { taskId: 'T001', title: 'From A', addLabels: ['a-label'], expectedUpdatedAt: v },
    ).catch((err: Error) => err);
    expect(error).toBeInstanceOf(CleoError);
    const conflict = error as CleoError;
    expect(conflict.code).toBe(ExitCode.VERSION_CONFLICT);
    expect(conflict.toLAFSError().code).toBe('E_CONFLICT');
    expect(conflict.fix).toContain('--if-match');
    const stored = await accessor.loadSingleTask('T001');
    const details = conflict.details;
    expect(details?.['currentVersion']).toBe(taskVersion(stored));
    expect(details?.['changedFields']).toEqual(expect.arrayContaining(['labels', 'title']));
    expect(details?.['changes']).toEqual(
      expect.arrayContaining([{ field: 'title', was: '"Target"', now: '"From A"' }]),
    );
    expect(details?.['current']).toMatchObject({ title: 'From A', labels: ['a-label'] });
    // No lost update: A's commit is intact and B wrote nothing.
    expect(stored?.title).toBe('From A');
    expect(stored?.labels).toEqual(['a-label']);

    // Retrying with the reported version succeeds.
    const retried = await updateTask(
      { taskId: 'T001', title: 'From B', expectedUpdatedAt: String(details?.['currentVersion']) },
      env.tempDir,
      accessor,
    );
    expect(retried.task.title).toBe('From B');
    expect(retried.task.labels).toEqual(['a-label']);
  });

  it('complete --if-match with a stale version is refused and the task stays open', async () => {
    const stale = taskVersion(await accessor.loadSingleTask('T002'));
    await updateTask({ taskId: 'T002', addLabels: ['late'] }, env.tempDir, accessor);
    const error = await completeTask(
      { taskId: 'T002', expectedUpdatedAt: stale },
      env.tempDir,
      accessor,
    ).catch((err: Error) => err);
    expect((error as CleoError).code).toBe(ExitCode.VERSION_CONFLICT);
    expect((error as CleoError).details?.['changedFields']).toEqual([]);
    const stored = await accessor.loadSingleTask('T002');
    expect(stored?.status).toBe('pending');
    expect(stored?.labels).toEqual(['late']);
  });

  it('an unguarded complete never overwrites an edit committed after its read', async () => {
    const racing = withInterleavedWriter(accessor, 'T002', () =>
      updateTask({ taskId: 'T002', addLabels: ['concurrent'] }, env.tempDir, accessor),
    );
    const error = await completeTask({ taskId: 'T002' }, env.tempDir, racing).catch(
      (err: Error) => err,
    );
    expect((error as CleoError).code).toBe(ExitCode.VERSION_CONFLICT);
    expect((error as CleoError).details?.['changedFields']).toEqual(['labels']);
    const stored = await accessor.loadSingleTask('T002');
    expect(stored?.labels).toEqual(['concurrent']);
    expect(stored?.status).toBe('pending');

    // A plain retry completes on top of the concurrent edit.
    await completeTask({ taskId: 'T002' }, env.tempDir, accessor);
    const done = await accessor.loadSingleTask('T002');
    expect(done?.status).toBe('done');
    expect(done?.labels).toEqual(['concurrent']);
  });

  it('complete read V0, another writer commits V1, --if-match V1 still cannot clobber the V1 edit', async () => {
    const options: CompleteTaskOptions = { taskId: 'T002' };
    // complete's own first read returns V0; V1 commits in between, and the
    // caller (who saw V1) passes --if-match V1.
    const racing = withInterleavedWriter(accessor, 'T002', async () => {
      await updateTask({ taskId: 'T002', addLabels: ['v1-edit'] }, env.tempDir, accessor);
      options.expectedUpdatedAt = taskVersion(await accessor.loadSingleTask('T002'));
    });
    const error = await completeTask(options, env.tempDir, racing).catch((err: Error) => err);
    expect((error as CleoError).code).toBe(ExitCode.VERSION_CONFLICT);
    const stored = await accessor.loadSingleTask('T002');
    expect(stored?.labels).toEqual(['v1-edit']);
    expect(stored?.status).toBe('pending');
  });

  it('taskComplete returns the final version: feeding it to update --if-match succeeds', async () => {
    const result = await taskComplete(env.tempDir, 'T002');
    expect(result.success, JSON.stringify(result)).toBe(true);
    const returned = result.success ? taskVersion(result.data.task) : '';
    expect(returned).toBe(taskVersion(await accessor.loadSingleTask('T002')));
    const updated = await updateTask(
      { taskId: 'T002', addLabels: ['after-complete'], expectedUpdatedAt: returned },
      env.tempDir,
      accessor,
    );
    expect(updated.task.labels).toEqual(['after-complete']);
  });

  it('complete with the current --if-match version succeeds', async () => {
    const version = taskVersion(await accessor.loadSingleTask('T002'));
    const result = await completeTask(
      { taskId: 'T002', expectedUpdatedAt: version },
      env.tempDir,
      accessor,
    );
    expect(result.task.status).toBe('done');
    expect(taskVersion(result.task) > version).toBe(true);
  });
});

describe('updateTaskFields version guard (T12503)', () => {
  let env: TestDbEnv;

  beforeEach(async () => {
    env = await createTestDb();
    await seedTasks(env.accessor, [
      {
        id: 'T001',
        title: 'Target',
        status: 'pending',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      },
    ]);
  });

  afterEach(async () => {
    resetDbState();
    await env.cleanup();
  });

  it('rejects a stale expected version and accepts the current one', async () => {
    const stale = taskVersion(await env.accessor.loadSingleTask('T001'));
    await env.accessor.updateTaskFields('T001', { title: 'First' });
    const current = taskVersion(await env.accessor.loadSingleTask('T001'));

    const error = await env.accessor
      .updateTaskFields('T001', { title: 'Stale' }, { expectedUpdatedAt: stale })
      .catch((err: Error) => err);
    expect((error as CleoError).code).toBe(ExitCode.VERSION_CONFLICT);
    expect((error as CleoError).details?.['currentVersion']).toBe(current);

    await env.accessor.updateTaskFields(
      'T001',
      { title: 'Guarded' },
      { expectedUpdatedAt: current },
    );
    expect((await env.accessor.loadSingleTask('T001'))?.title).toBe('Guarded');
  });

  it('a guard with a baseline reports the changed fields and the stored values', async () => {
    const baseline = await env.accessor.loadSingleTask('T001');
    if (!baseline) throw new Error('seed missing');
    await env.accessor.updateTaskFields('T001', { title: 'Concurrent', priority: 'high' });

    const error = await env.accessor
      .updateTaskFields(
        'T001',
        { title: 'Mine' },
        { expectedUpdatedAt: taskVersion(baseline), baseline },
      )
      .catch((err: Error) => err);
    const conflict = error as CleoError;
    expect(conflict.code).toBe(ExitCode.VERSION_CONFLICT);
    expect(conflict.details?.['changedFields']).toEqual(['priority', 'title']);
    expect(conflict.details?.['current']).toMatchObject({
      title: 'Concurrent',
      priority: 'high',
    });
    expect(conflict.message).toContain('Changed: priority, title');
    expect((await env.accessor.loadSingleTask('T001'))?.title).toBe('Concurrent');
  });

  it('back-to-back writes always produce a strictly newer version', async () => {
    const versions: string[] = [];
    for (let i = 0; i < 5; i++) {
      await env.accessor.updateTaskFields('T001', { title: `Write ${i}` });
      versions.push(taskVersion(await env.accessor.loadSingleTask('T001')));
    }
    expect(new Set(versions).size).toBe(versions.length);
  });
});

describe('taskConflictError details are bounded (T12503)', () => {
  it('truncates the title and caps labels/depends with full counts', () => {
    const labels = Array.from({ length: 60 }, (_, i) => `l${i}`);
    const depends = Array.from({ length: 55 }, (_, i) => `T${i + 100}`);
    const current: Task = {
      id: 'T001',
      title: 'x'.repeat(500),
      status: 'pending',
      priority: 'medium',
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-02T00:00:00.000Z',
      labels,
      depends,
    };
    const details = taskConflictError('T001', '2026-09-01T00:00:00.000Z', current).details;
    const summary = details?.['current'] as TaskConflictDetails['current'];
    expect(summary?.title.length).toBe(200);
    expect(summary?.labels).toHaveLength(50);
    expect(summary?.labelsTotal).toBe(60);
    expect(summary?.depends).toHaveLength(50);
    expect(summary?.dependsTotal).toBe(55);
  });
});

describe('nextTaskVersion (T12503)', () => {
  it('moves 1 ms past the stored version when the clock has not advanced', () => {
    const stored = '2026-09-27T12:00:00.000Z';
    expect(nextTaskVersion({ updatedAt: stored }, stored)).toBe('2026-09-27T12:00:00.001Z');
    expect(nextTaskVersion({ updatedAt: stored }, '2026-09-27T11:00:00.000Z')).toBe(
      '2026-09-27T12:00:00.001Z',
    );
  });

  it('uses the candidate when it is newer, and falls back to createdAt', () => {
    expect(
      nextTaskVersion(
        { updatedAt: null, createdAt: '2026-01-01T00:00:00.000Z' },
        '2026-02-01T00:00:00.000Z',
      ),
    ).toBe('2026-02-01T00:00:00.000Z');
  });
});
