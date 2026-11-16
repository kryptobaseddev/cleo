/**
 * Tests for startTask dependency enforcement.
 * @task T5069
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bindTestSession,
  createTestDb,
  seedTasks,
  type TestDbEnv,
} from '../../store/__tests__/test-db-helper.js';
import type { DataAccessor } from '../../store/data-accessor.js';
import { archiveTasks } from '../../tasks/archive.js';
import { assertTaskStartable, currentTask, startTask } from '../index.js';

describe('startTask dependency enforcement', () => {
  let env: TestDbEnv;
  let accessor: DataAccessor;

  beforeEach(async () => {
    env = await createTestDb();
    // T12501: focus writes need a bound session.
    await bindTestSession(env);
    accessor = env.accessor;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await env.cleanup();
  });

  it('refuses to start a task with unresolved dependencies', async () => {
    await seedTasks(accessor, [
      {
        id: 'T001',
        title: 'Blocker',
        status: 'pending',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      },
      {
        id: 'T002',
        title: 'Blocked task',
        status: 'pending',
        priority: 'medium',
        depends: ['T001'],
        createdAt: new Date().toISOString(),
      },
    ]);

    await expect(startTask('T002', env.tempDir, accessor)).rejects.toThrow(
      'blocked by unresolved dependencies',
    );
  });

  it('includes blocker IDs in error message', async () => {
    await seedTasks(accessor, [
      {
        id: 'T001',
        title: 'Blocker A',
        status: 'pending',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      },
      {
        id: 'T002',
        title: 'Blocker B',
        status: 'active',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      },
      {
        id: 'T003',
        title: 'Blocked',
        status: 'pending',
        priority: 'medium',
        depends: ['T001', 'T002'],
        createdAt: new Date().toISOString(),
      },
    ]);

    await expect(startTask('T003', env.tempDir, accessor)).rejects.toThrow('T001, T002');
    await expect(assertTaskStartable(accessor, 'T003')).rejects.toMatchObject({
      fix: expect.stringContaining('cleo complete T001'),
    });
  });

  it('allows starting a task when all dependencies are done', async () => {
    await seedTasks(accessor, [
      {
        id: 'T001',
        title: 'Done dep',
        status: 'done',
        priority: 'medium',
        createdAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      },
      {
        id: 'T002',
        title: 'Ready task',
        status: 'pending',
        priority: 'medium',
        depends: ['T001'],
        createdAt: new Date().toISOString(),
      },
    ]);

    const result = await startTask('T002', env.tempDir, accessor);
    expect(result.taskId).toBe('T002');
    expect(result.taskTitle).toBe('Ready task');
  });

  it('refuses cancelled prerequisites under the shared execution policy', async () => {
    await seedTasks(accessor, [
      {
        id: 'T001',
        title: 'Cancelled dep',
        status: 'cancelled',
        priority: 'medium',
        createdAt: new Date().toISOString(),
        cancelledAt: new Date().toISOString(),
      },
      {
        id: 'T002',
        title: 'Ready task',
        status: 'pending',
        priority: 'medium',
        depends: ['T001'],
        createdAt: new Date().toISOString(),
      },
    ]);

    await expect(startTask('T002', env.tempDir, accessor)).rejects.toThrow('T001');
    await expect(assertTaskStartable(accessor, 'T002')).rejects.toMatchObject({
      fix: expect.stringContaining('cleo restore task T001'),
    });
  });

  it('diagnoses a missing dependency without recommending completion of a nonexistent task', async () => {
    await seedTasks(accessor, [{ id: 'T001' }, { id: 'T002', depends: ['T001'] }]);
    vi.spyOn(accessor, 'loadTasks').mockResolvedValueOnce([]);
    await expect(assertTaskStartable(accessor, 'T002')).rejects.toMatchObject({
      fix: expect.stringContaining('cleo find "T001" --include-archive'),
    });
  });

  it('requires review of a proposed prerequisite before its work can be accepted', async () => {
    await seedTasks(accessor, [
      { id: 'T001', status: 'proposed' },
      { id: 'T002', depends: ['T001'] },
    ]);
    await expect(assertTaskStartable(accessor, 'T002')).rejects.toMatchObject({
      fix: expect.stringContaining('Review proposed dependency T001'),
    });
  });

  it('allows canonically archived prerequisites omitted by the active listing', async () => {
    await seedTasks(accessor, [
      { id: 'T001', status: 'done' },
      { id: 'T002', depends: ['T001'] },
    ]);
    expect(await archiveTasks({ taskIds: ['T001'] }, env.tempDir, accessor)).toMatchObject({
      archived: ['T001'],
    });
    expect((await accessor.queryTasks({})).tasks.map((task) => task.id)).not.toContain('T001');
    expect(await startTask('T002', env.tempDir, accessor)).toMatchObject({ taskId: 'T002' });
  });

  it('propagates a required dependency read failure before changing focus', async () => {
    await seedTasks(accessor, [
      { id: 'T000' },
      { id: 'T001', status: 'done' },
      { id: 'T002', depends: ['T001'] },
    ]);
    await archiveTasks({ taskIds: ['T001'] }, env.tempDir, accessor);
    await startTask('T000', env.tempDir, accessor);
    const before = await currentTask(env.tempDir, accessor);
    const read = vi.spyOn(accessor, 'loadTasks').mockRejectedValueOnce(new Error('read failed'));
    await expect(startTask('T002', env.tempDir, accessor)).rejects.toThrow('read failed');
    expect(await currentTask(env.tempDir, accessor)).toEqual(before);
    read.mockRestore();
  });

  it('allows starting a task with no dependencies', async () => {
    await seedTasks(accessor, [
      {
        id: 'T001',
        title: 'No deps',
        status: 'pending',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      },
    ]);

    const result = await startTask('T001', env.tempDir, accessor);
    expect(result.taskId).toBe('T001');
  });

  it('blocks when only some dependencies are resolved', async () => {
    await seedTasks(accessor, [
      {
        id: 'T001',
        title: 'Done',
        status: 'done',
        priority: 'medium',
        createdAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      },
      {
        id: 'T002',
        title: 'Pending',
        status: 'pending',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      },
      {
        id: 'T003',
        title: 'Partially blocked',
        status: 'pending',
        priority: 'medium',
        depends: ['T001', 'T002'],
        createdAt: new Date().toISOString(),
      },
    ]);

    await expect(startTask('T003', env.tempDir, accessor)).rejects.toThrow('T002');
  });
});
