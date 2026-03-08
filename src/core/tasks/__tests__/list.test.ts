/**
 * Tests for task listing.
 * @task T4460
 * @epic T4454
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestDb,
  seedTasks,
  type TestDbEnv,
} from '../../../store/__tests__/test-db-helper.js';
import type { DataAccessor } from '../../../store/data-accessor.js';
import { listTasks } from '../list.js';

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

  it('applies the default safe page size when no limit is specified', async () => {
    await seedTasks(accessor, [
      {
        id: 'T001',
        title: 'Task 1',
        status: 'pending',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      },
      {
        id: 'T002',
        title: 'Task 2',
        status: 'done',
        priority: 'high',
        createdAt: new Date().toISOString(),
      },
    ]);

    const result = await listTasks({}, env.tempDir, accessor);
    expect(result.tasks).toHaveLength(2);
    expect(result.total).toBe(2);
    expect(result.filtered).toBe(2);
    expect(result.page.mode).toBe('offset');
    if (result.page.mode === 'offset') {
      expect(result.page.limit).toBe(10);
      expect(result.page.offset).toBe(0);
      expect(result.page.hasMore).toBe(false);
    }
  });

  it('filters by status', async () => {
    await seedTasks(accessor, [
      {
        id: 'T001',
        title: 'Task 1',
        status: 'pending',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      },
      {
        id: 'T002',
        title: 'Task 2',
        status: 'done',
        priority: 'high',
        createdAt: new Date().toISOString(),
      },
    ]);

    const result = await listTasks({ status: 'pending' }, env.tempDir, accessor);
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]!.id).toBe('T001');
    expect(result.filtered).toBe(1);
  });

  it('filters by priority', async () => {
    await seedTasks(accessor, [
      {
        id: 'T001',
        title: 'Task 1',
        status: 'pending',
        priority: 'low',
        createdAt: new Date().toISOString(),
      },
      {
        id: 'T002',
        title: 'Task 2',
        status: 'pending',
        priority: 'critical',
        createdAt: new Date().toISOString(),
      },
    ]);

    const result = await listTasks({ priority: 'critical' }, env.tempDir, accessor);
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]!.id).toBe('T002');
  });

  it('filters by parent', async () => {
    await seedTasks(accessor, [
      {
        id: 'T001',
        title: 'Epic',
        status: 'active',
        priority: 'high',
        type: 'epic',
        createdAt: new Date().toISOString(),
      },
      {
        id: 'T002',
        title: 'Child 1',
        status: 'pending',
        priority: 'medium',
        parentId: 'T001',
        createdAt: new Date().toISOString(),
      },
      {
        id: 'T003',
        title: 'Child 2',
        status: 'pending',
        priority: 'medium',
        parentId: 'T001',
        createdAt: new Date().toISOString(),
      },
      {
        id: 'T004',
        title: 'Other',
        status: 'pending',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      },
    ]);

    const result = await listTasks({ parentId: 'T001' }, env.tempDir, accessor);
    expect(result.tasks).toHaveLength(2);
  });

  it('filters by label', async () => {
    await seedTasks(accessor, [
      {
        id: 'T001',
        title: 'Bug fix',
        status: 'pending',
        priority: 'high',
        labels: ['bug', 'security'],
        createdAt: new Date().toISOString(),
      },
      {
        id: 'T002',
        title: 'Feature',
        status: 'pending',
        priority: 'medium',
        labels: ['feature'],
        createdAt: new Date().toISOString(),
      },
    ]);

    const result = await listTasks({ label: 'bug' }, env.tempDir, accessor);
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]!.id).toBe('T001');
  });

  it('applies all supported non-pagination filters together', async () => {
    await seedTasks(accessor, [
      {
        id: 'T001',
        title: 'Epic',
        status: 'active',
        priority: 'high',
        type: 'epic',
        phase: 'build',
        labels: ['platform'],
        createdAt: new Date().toISOString(),
      },
      {
        id: 'T002',
        title: 'Matching child',
        status: 'pending',
        priority: 'critical',
        type: 'task',
        phase: 'build',
        parentId: 'T001',
        labels: ['bug'],
        createdAt: new Date().toISOString(),
      },
      {
        id: 'T003',
        title: 'Wrong phase',
        status: 'pending',
        priority: 'critical',
        type: 'task',
        phase: 'design',
        parentId: 'T001',
        labels: ['bug'],
        createdAt: new Date().toISOString(),
      },
    ]);

    const result = await listTasks(
      {
        status: 'pending',
        priority: 'critical',
        type: 'task',
        parentId: 'T001',
        phase: 'build',
        label: 'bug',
        children: true,
      },
      env.tempDir,
      accessor,
    );

    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]!.id).toBe('T002');
    expect(result.total).toBe(3);
    expect(result.filtered).toBe(1);
    expect(result.page.mode).toBe('offset');
    if (result.page.mode === 'offset') {
      expect(result.page.limit).toBe(10);
      expect(result.page.offset).toBe(0);
      expect(result.page.hasMore).toBe(false);
    }
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
    expect(page1.page.mode).toBe('offset');
    if (page1.page.mode === 'offset') {
      expect(page1.page.total).toBe(10);
      expect(page1.page.hasMore).toBe(true);
    }

    const page2 = await listTasks({ limit: 3, offset: 3 }, env.tempDir, accessor);
    expect(page2.tasks).toHaveLength(3);
    expect(page2.page.mode).toBe('offset');
    if (page2.page.mode === 'offset') {
      expect(page2.page.offset).toBe(3);
      expect(page2.page.hasMore).toBe(true);
    }

    const lastPage = await listTasks({ limit: 3, offset: 9 }, env.tempDir, accessor);
    expect(lastPage.tasks).toHaveLength(1);
    expect(lastPage.page.mode).toBe('offset');
    if (lastPage.page.mode === 'offset') {
      expect(lastPage.page.hasMore).toBe(false);
    }
  });

  it('applies the default safe page size when offset is provided without limit', async () => {
    const tasks = Array.from({ length: 80 }, (_, i) => ({
      id: `T${String(i + 1).padStart(3, '0')}`,
      title: `Task ${i + 1}`,
      status: 'pending' as const,
      priority: 'medium' as const,
      position: i + 1,
      createdAt: new Date().toISOString(),
    }));
    await seedTasks(accessor, tasks);

    const result = await listTasks({ offset: 10 }, env.tempDir, accessor);

    expect(result.tasks).toHaveLength(10);
    expect(result.tasks[0]!.id).toBe('T011');
    expect(result.page.mode).toBe('offset');
    if (result.page.mode === 'offset') {
      expect(result.page.limit).toBe(10);
      expect(result.page.offset).toBe(10);
      expect(result.page.total).toBe(80);
      expect(result.page.hasMore).toBe(true);
    }
  });

  it('returns the full dataset only when limit=0 is explicitly requested', async () => {
    const tasks = Array.from({ length: 12 }, (_, i) => ({
      id: `T${String(i + 1).padStart(3, '0')}`,
      title: `Task ${i + 1}`,
      status: 'pending' as const,
      priority: 'medium' as const,
      position: i + 1,
      createdAt: new Date().toISOString(),
    }));
    await seedTasks(accessor, tasks);

    const result = await listTasks({ limit: 0 }, env.tempDir, accessor);

    expect(result.tasks).toHaveLength(12);
    expect(result.page.mode).toBe('none');
  });
});
