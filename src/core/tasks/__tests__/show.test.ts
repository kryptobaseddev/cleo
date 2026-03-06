/**
 * Tests for task show.
 * @task T4460
 * @epic T4454
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { showTask } from '../show.js';
import { createTestDb, seedTasks, type TestDbEnv } from '../../../store/__tests__/test-db-helper.js';
import type { DataAccessor } from '../../../store/data-accessor.js';

describe('showTask', () => {
  let env: TestDbEnv;
  let accessor: DataAccessor;

  beforeEach(async () => {
    env = await createTestDb();
    accessor = env.accessor;
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it('shows a task by ID', async () => {
    await seedTasks(accessor, [
      { id: 'T001', title: 'Test task', status: 'pending', priority: 'high', description: 'Detailed info', createdAt: new Date().toISOString() },
    ]);

    const result = await showTask('T001', env.tempDir, accessor);
    expect(result.id).toBe('T001');
    expect(result.title).toBe('Test task');
    expect(result.description).toBe('Detailed info');
  });

  it('throws if task not found', async () => {
    await seedTasks(accessor, []);

    await expect(showTask('T999', env.tempDir, accessor)).rejects.toThrow('Task not found');
  });

  it('includes children list', async () => {
    await seedTasks(accessor, [
      { id: 'T001', title: 'Epic', status: 'active', priority: 'high', type: 'epic', createdAt: new Date().toISOString() },
      { id: 'T002', title: 'Child 1', status: 'pending', priority: 'medium', parentId: 'T001', createdAt: new Date().toISOString() },
      { id: 'T003', title: 'Child 2', status: 'pending', priority: 'medium', parentId: 'T001', createdAt: new Date().toISOString() },
    ]);

    const result = await showTask('T001', env.tempDir, accessor);
    expect(result.children).toEqual(['T002', 'T003']);
  });

  it('includes dependency status', async () => {
    await seedTasks(accessor, [
      { id: 'T001', title: 'Dependency', status: 'done', priority: 'medium', createdAt: new Date().toISOString() },
      { id: 'T002', title: 'Blocked task', status: 'pending', priority: 'medium', depends: ['T001'], createdAt: new Date().toISOString() },
    ]);

    const result = await showTask('T002', env.tempDir, accessor);
    expect(result.dependencyStatus).toHaveLength(1);
    expect(result.dependencyStatus![0]).toEqual({
      id: 'T001',
      status: 'done',
      title: 'Dependency',
    });
  });

  it('includes hierarchy path', async () => {
    await seedTasks(accessor, [
      { id: 'T001', title: 'Epic', status: 'active', priority: 'high', type: 'epic', createdAt: new Date().toISOString() },
      { id: 'T002', title: 'Task', status: 'pending', priority: 'medium', parentId: 'T001', createdAt: new Date().toISOString() },
      { id: 'T003', title: 'Subtask', status: 'pending', priority: 'medium', parentId: 'T002', createdAt: new Date().toISOString() },
    ]);

    const result = await showTask('T003', env.tempDir, accessor);
    expect(result.hierarchyPath).toEqual(['T001', 'T002', 'T003']);
  });
});
