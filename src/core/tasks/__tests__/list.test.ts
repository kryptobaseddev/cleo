/**
 * Tests for task listing.
 * @task T4460
 * @epic T4454
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { listTasks } from '../list.js';
import { createTestDb, seedTasks, type TestDbEnv } from '../../../store/__tests__/test-db-helper.js';
import type { DataAccessor } from '../../../store/data-accessor.js';

describe('listTasks', () => {
  let env: TestDbEnv;
  let accessor: DataAccessor;

  beforeEach(async () => {
    env = await createTestDb();
    accessor = env.accessor;
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it('lists all tasks', async () => {
    await seedTasks(accessor, [
      { id: 'T001', title: 'Task 1', status: 'pending', priority: 'medium', createdAt: new Date().toISOString() },
      { id: 'T002', title: 'Task 2', status: 'done', priority: 'high', createdAt: new Date().toISOString() },
    ]);

    const result = await listTasks({}, env.tempDir, accessor);
    expect(result.tasks).toHaveLength(2);
    expect(result.total).toBe(2);
    expect(result.filtered).toBe(2);
  });

  it('filters by status', async () => {
    await seedTasks(accessor, [
      { id: 'T001', title: 'Task 1', status: 'pending', priority: 'medium', createdAt: new Date().toISOString() },
      { id: 'T002', title: 'Task 2', status: 'done', priority: 'high', createdAt: new Date().toISOString() },
    ]);

    const result = await listTasks({ status: 'pending' }, env.tempDir, accessor);
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]!.id).toBe('T001');
    expect(result.filtered).toBe(1);
  });

  it('filters by priority', async () => {
    await seedTasks(accessor, [
      { id: 'T001', title: 'Task 1', status: 'pending', priority: 'low', createdAt: new Date().toISOString() },
      { id: 'T002', title: 'Task 2', status: 'pending', priority: 'critical', createdAt: new Date().toISOString() },
    ]);

    const result = await listTasks({ priority: 'critical' }, env.tempDir, accessor);
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]!.id).toBe('T002');
  });

  it('filters by parent', async () => {
    await seedTasks(accessor, [
      { id: 'T001', title: 'Epic', status: 'active', priority: 'high', type: 'epic', createdAt: new Date().toISOString() },
      { id: 'T002', title: 'Child 1', status: 'pending', priority: 'medium', parentId: 'T001', createdAt: new Date().toISOString() },
      { id: 'T003', title: 'Child 2', status: 'pending', priority: 'medium', parentId: 'T001', createdAt: new Date().toISOString() },
      { id: 'T004', title: 'Other', status: 'pending', priority: 'medium', createdAt: new Date().toISOString() },
    ]);

    const result = await listTasks({ parentId: 'T001' }, env.tempDir, accessor);
    expect(result.tasks).toHaveLength(2);
  });

  it('filters by label', async () => {
    await seedTasks(accessor, [
      { id: 'T001', title: 'Bug fix', status: 'pending', priority: 'high', labels: ['bug', 'security'], createdAt: new Date().toISOString() },
      { id: 'T002', title: 'Feature', status: 'pending', priority: 'medium', labels: ['feature'], createdAt: new Date().toISOString() },
    ]);

    const result = await listTasks({ label: 'bug' }, env.tempDir, accessor);
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]!.id).toBe('T001');
  });

  it('paginates results', async () => {
    const tasks = Array.from({ length: 10 }, (_, i) => ({
      id: `T${String(i + 1).padStart(3, '0')}`,
      title: `Task ${i + 1}`,
      status: 'pending' as const,
      priority: 'medium' as const,
      position: i + 1,
      createdAt: new Date().toISOString(),
    }));
    await seedTasks(accessor, tasks);

    const page1 = await listTasks({ limit: 3, offset: 0 }, env.tempDir, accessor);
    expect(page1.tasks).toHaveLength(3);
    expect(page1.pagination?.hasMore).toBe(true);

    const page2 = await listTasks({ limit: 3, offset: 3 }, env.tempDir, accessor);
    expect(page2.tasks).toHaveLength(3);
    expect(page2.pagination?.hasMore).toBe(true);

    const lastPage = await listTasks({ limit: 3, offset: 9 }, env.tempDir, accessor);
    expect(lastPage.tasks).toHaveLength(1);
    expect(lastPage.pagination?.hasMore).toBe(false);
  });
});
