/**
 * Tests for task listing.
 * @task T4460
 * @epic T4454
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { listTasks } from '../list.js';
import type { TodoFile } from '../../../types/task.js';

describe('listTasks', () => {
  let tempDir: string;
  let cleoDir: string;

  const makeTodoFile = (tasks: TodoFile['tasks']): TodoFile => ({
    version: '2.10.0',
    project: { name: 'test', phases: {} },
    lastUpdated: new Date().toISOString(),
    _meta: {
      schemaVersion: '2.10.0',
      checksum: '0000000000000000',
      configVersion: '1.0.0',
    },
    tasks,
  });

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-test-'));
    cleoDir = join(tempDir, '.cleo');
    await mkdir(cleoDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('lists all tasks', async () => {
    const data = makeTodoFile([
      { id: 'T001', title: 'Task 1', status: 'pending', priority: 'medium', createdAt: new Date().toISOString() },
      { id: 'T002', title: 'Task 2', status: 'done', priority: 'high', createdAt: new Date().toISOString() },
    ]);
    await writeFile(join(cleoDir, 'tasks.json'), JSON.stringify(data));

    const result = await listTasks({}, tempDir);
    expect(result.tasks).toHaveLength(2);
    expect(result.total).toBe(2);
    expect(result.filtered).toBe(2);
  });

  it('filters by status', async () => {
    const data = makeTodoFile([
      { id: 'T001', title: 'Task 1', status: 'pending', priority: 'medium', createdAt: new Date().toISOString() },
      { id: 'T002', title: 'Task 2', status: 'done', priority: 'high', createdAt: new Date().toISOString() },
    ]);
    await writeFile(join(cleoDir, 'tasks.json'), JSON.stringify(data));

    const result = await listTasks({ status: 'pending' }, tempDir);
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]!.id).toBe('T001');
    expect(result.filtered).toBe(1);
  });

  it('filters by priority', async () => {
    const data = makeTodoFile([
      { id: 'T001', title: 'Task 1', status: 'pending', priority: 'low', createdAt: new Date().toISOString() },
      { id: 'T002', title: 'Task 2', status: 'pending', priority: 'critical', createdAt: new Date().toISOString() },
    ]);
    await writeFile(join(cleoDir, 'tasks.json'), JSON.stringify(data));

    const result = await listTasks({ priority: 'critical' }, tempDir);
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]!.id).toBe('T002');
  });

  it('filters by parent', async () => {
    const data = makeTodoFile([
      { id: 'T001', title: 'Epic', status: 'active', priority: 'high', type: 'epic', createdAt: new Date().toISOString() },
      { id: 'T002', title: 'Child 1', status: 'pending', priority: 'medium', parentId: 'T001', createdAt: new Date().toISOString() },
      { id: 'T003', title: 'Child 2', status: 'pending', priority: 'medium', parentId: 'T001', createdAt: new Date().toISOString() },
      { id: 'T004', title: 'Other', status: 'pending', priority: 'medium', createdAt: new Date().toISOString() },
    ]);
    await writeFile(join(cleoDir, 'tasks.json'), JSON.stringify(data));

    const result = await listTasks({ parentId: 'T001' }, tempDir);
    expect(result.tasks).toHaveLength(2);
  });

  it('filters by label', async () => {
    const data = makeTodoFile([
      { id: 'T001', title: 'Bug fix', status: 'pending', priority: 'high', labels: ['bug', 'security'], createdAt: new Date().toISOString() },
      { id: 'T002', title: 'Feature', status: 'pending', priority: 'medium', labels: ['feature'], createdAt: new Date().toISOString() },
    ]);
    await writeFile(join(cleoDir, 'tasks.json'), JSON.stringify(data));

    const result = await listTasks({ label: 'bug' }, tempDir);
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
    const data = makeTodoFile(tasks);
    await writeFile(join(cleoDir, 'tasks.json'), JSON.stringify(data));

    const page1 = await listTasks({ limit: 3, offset: 0 }, tempDir);
    expect(page1.tasks).toHaveLength(3);
    expect(page1.pagination?.hasMore).toBe(true);

    const page2 = await listTasks({ limit: 3, offset: 3 }, tempDir);
    expect(page2.tasks).toHaveLength(3);
    expect(page2.pagination?.hasMore).toBe(true);

    const lastPage = await listTasks({ limit: 3, offset: 9 }, tempDir);
    expect(lastPage.tasks).toHaveLength(1);
    expect(lastPage.pagination?.hasMore).toBe(false);
  });
});
