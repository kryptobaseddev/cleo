/**
 * Tests for startTask dependency enforcement.
 * @task T5069
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { startTask } from '../index.js';
import { createTestDb, seedTasks, type TestDbEnv } from '../../../store/__tests__/test-db-helper.js';
import type { DataAccessor } from '../../../store/data-accessor.js';

describe('startTask dependency enforcement', () => {
  let env: TestDbEnv;
  let accessor: DataAccessor;

  beforeEach(async () => {
    env = await createTestDb();
    accessor = env.accessor;
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it('refuses to start a task with unresolved dependencies', async () => {
    await seedTasks(accessor, [
      { id: 'T001', title: 'Blocker', status: 'pending', priority: 'medium', createdAt: new Date().toISOString() },
      { id: 'T002', title: 'Blocked task', status: 'pending', priority: 'medium', depends: ['T001'], createdAt: new Date().toISOString() },
    ]);

    await expect(
      startTask('T002', env.tempDir, accessor),
    ).rejects.toThrow('blocked by unresolved dependencies');
  });

  it('includes blocker IDs in error message', async () => {
    await seedTasks(accessor, [
      { id: 'T001', title: 'Blocker A', status: 'pending', priority: 'medium', createdAt: new Date().toISOString() },
      { id: 'T002', title: 'Blocker B', status: 'active', priority: 'medium', createdAt: new Date().toISOString() },
      { id: 'T003', title: 'Blocked', status: 'pending', priority: 'medium', depends: ['T001', 'T002'], createdAt: new Date().toISOString() },
    ]);

    await expect(
      startTask('T003', env.tempDir, accessor),
    ).rejects.toThrow('T001, T002');
  });

  it('allows starting a task when all dependencies are done', async () => {
    await seedTasks(accessor, [
      { id: 'T001', title: 'Done dep', status: 'done', priority: 'medium', createdAt: new Date().toISOString(), completedAt: new Date().toISOString() },
      { id: 'T002', title: 'Ready task', status: 'pending', priority: 'medium', depends: ['T001'], createdAt: new Date().toISOString() },
    ]);

    const result = await startTask('T002', env.tempDir, accessor);
    expect(result.taskId).toBe('T002');
    expect(result.taskTitle).toBe('Ready task');
  });

  it('allows starting a task when dependencies are cancelled', async () => {
    await seedTasks(accessor, [
      { id: 'T001', title: 'Cancelled dep', status: 'cancelled', priority: 'medium', createdAt: new Date().toISOString(), cancelledAt: new Date().toISOString() },
      { id: 'T002', title: 'Ready task', status: 'pending', priority: 'medium', depends: ['T001'], createdAt: new Date().toISOString() },
    ]);

    const result = await startTask('T002', env.tempDir, accessor);
    expect(result.taskId).toBe('T002');
  });

  it('allows starting a task with no dependencies', async () => {
    await seedTasks(accessor, [
      { id: 'T001', title: 'No deps', status: 'pending', priority: 'medium', createdAt: new Date().toISOString() },
    ]);

    const result = await startTask('T001', env.tempDir, accessor);
    expect(result.taskId).toBe('T001');
  });

  it('blocks when only some dependencies are resolved', async () => {
    await seedTasks(accessor, [
      { id: 'T001', title: 'Done', status: 'done', priority: 'medium', createdAt: new Date().toISOString(), completedAt: new Date().toISOString() },
      { id: 'T002', title: 'Pending', status: 'pending', priority: 'medium', createdAt: new Date().toISOString() },
      { id: 'T003', title: 'Partially blocked', status: 'pending', priority: 'medium', depends: ['T001', 'T002'], createdAt: new Date().toISOString() },
    ]);

    await expect(
      startTask('T003', env.tempDir, accessor),
    ).rejects.toThrow('T002');
  });
});
