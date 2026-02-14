/**
 * Tests for task show.
 * @task T4460
 * @epic T4454
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { showTask } from '../show.js';
import type { TodoFile } from '../../../types/task.js';

describe('showTask', () => {
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

  it('shows a task by ID', async () => {
    const data = makeTodoFile([
      { id: 'T001', title: 'Test task', status: 'pending', priority: 'high', description: 'Detailed info', createdAt: new Date().toISOString() },
    ]);
    await writeFile(join(cleoDir, 'todo.json'), JSON.stringify(data));

    const result = await showTask('T001', tempDir);
    expect(result.id).toBe('T001');
    expect(result.title).toBe('Test task');
    expect(result.description).toBe('Detailed info');
  });

  it('throws if task not found', async () => {
    const data = makeTodoFile([]);
    await writeFile(join(cleoDir, 'todo.json'), JSON.stringify(data));

    await expect(showTask('T999', tempDir)).rejects.toThrow('Task not found');
  });

  it('includes children list', async () => {
    const data = makeTodoFile([
      { id: 'T001', title: 'Epic', status: 'active', priority: 'high', type: 'epic', createdAt: new Date().toISOString() },
      { id: 'T002', title: 'Child 1', status: 'pending', priority: 'medium', parentId: 'T001', createdAt: new Date().toISOString() },
      { id: 'T003', title: 'Child 2', status: 'pending', priority: 'medium', parentId: 'T001', createdAt: new Date().toISOString() },
    ]);
    await writeFile(join(cleoDir, 'todo.json'), JSON.stringify(data));

    const result = await showTask('T001', tempDir);
    expect(result.children).toEqual(['T002', 'T003']);
  });

  it('includes dependency status', async () => {
    const data = makeTodoFile([
      { id: 'T001', title: 'Dependency', status: 'done', priority: 'medium', createdAt: new Date().toISOString() },
      { id: 'T002', title: 'Blocked task', status: 'pending', priority: 'medium', depends: ['T001'], createdAt: new Date().toISOString() },
    ]);
    await writeFile(join(cleoDir, 'todo.json'), JSON.stringify(data));

    const result = await showTask('T002', tempDir);
    expect(result.dependencyStatus).toHaveLength(1);
    expect(result.dependencyStatus![0]).toEqual({
      id: 'T001',
      status: 'done',
      title: 'Dependency',
    });
  });

  it('includes hierarchy path', async () => {
    const data = makeTodoFile([
      { id: 'T001', title: 'Epic', status: 'active', priority: 'high', type: 'epic', createdAt: new Date().toISOString() },
      { id: 'T002', title: 'Task', status: 'pending', priority: 'medium', parentId: 'T001', createdAt: new Date().toISOString() },
      { id: 'T003', title: 'Subtask', status: 'pending', priority: 'medium', parentId: 'T002', createdAt: new Date().toISOString() },
    ]);
    await writeFile(join(cleoDir, 'todo.json'), JSON.stringify(data));

    const result = await showTask('T003', tempDir);
    expect(result.hierarchyPath).toEqual(['T001', 'T002', 'T003']);
  });
});
