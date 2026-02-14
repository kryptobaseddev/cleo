/**
 * Tests for task update.
 * @task T4461
 * @epic T4454
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { updateTask } from '../update.js';
import type { TodoFile } from '../../../types/task.js';

describe('updateTask', () => {
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
    await mkdir(join(cleoDir, 'backups', 'operational'), { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('updates task title', async () => {
    const data = makeTodoFile([
      { id: 'T001', title: 'Old title', status: 'pending', priority: 'medium', createdAt: new Date().toISOString() },
    ]);
    await writeFile(join(cleoDir, 'todo.json'), JSON.stringify(data));

    const result = await updateTask({ taskId: 'T001', title: 'New title' }, tempDir);
    expect(result.task.title).toBe('New title');
    expect(result.changes).toContain('title');
  });

  it('updates task status', async () => {
    const data = makeTodoFile([
      { id: 'T001', title: 'Task', status: 'pending', priority: 'medium', createdAt: new Date().toISOString() },
    ]);
    await writeFile(join(cleoDir, 'todo.json'), JSON.stringify(data));

    const result = await updateTask({ taskId: 'T001', status: 'active' }, tempDir);
    expect(result.task.status).toBe('active');
  });

  it('adds labels', async () => {
    const data = makeTodoFile([
      { id: 'T001', title: 'Task', status: 'pending', priority: 'medium', labels: ['bug'], createdAt: new Date().toISOString() },
    ]);
    await writeFile(join(cleoDir, 'todo.json'), JSON.stringify(data));

    const result = await updateTask({ taskId: 'T001', addLabels: ['security'] }, tempDir);
    expect(result.task.labels).toContain('bug');
    expect(result.task.labels).toContain('security');
  });

  it('removes labels', async () => {
    const data = makeTodoFile([
      { id: 'T001', title: 'Task', status: 'pending', priority: 'medium', labels: ['bug', 'security'], createdAt: new Date().toISOString() },
    ]);
    await writeFile(join(cleoDir, 'todo.json'), JSON.stringify(data));

    const result = await updateTask({ taskId: 'T001', removeLabels: ['bug'] }, tempDir);
    expect(result.task.labels).toEqual(['security']);
  });

  it('adds notes', async () => {
    const data = makeTodoFile([
      { id: 'T001', title: 'Task', status: 'pending', priority: 'medium', createdAt: new Date().toISOString() },
    ]);
    await writeFile(join(cleoDir, 'todo.json'), JSON.stringify(data));

    const result = await updateTask({ taskId: 'T001', notes: 'Progress update' }, tempDir);
    expect(result.task.notes).toHaveLength(1);
    expect(result.task.notes![0]).toContain('Progress update');
  });

  it('throws if no changes specified', async () => {
    const data = makeTodoFile([
      { id: 'T001', title: 'Task', status: 'pending', priority: 'medium', createdAt: new Date().toISOString() },
    ]);
    await writeFile(join(cleoDir, 'todo.json'), JSON.stringify(data));

    await expect(
      updateTask({ taskId: 'T001' }, tempDir),
    ).rejects.toThrow('No changes');
  });

  it('throws if task not found', async () => {
    const data = makeTodoFile([]);
    await writeFile(join(cleoDir, 'todo.json'), JSON.stringify(data));

    await expect(
      updateTask({ taskId: 'T999', title: 'New' }, tempDir),
    ).rejects.toThrow('Task not found');
  });

  it('sets completedAt when marking done', async () => {
    const data = makeTodoFile([
      { id: 'T001', title: 'Task', status: 'pending', priority: 'medium', createdAt: new Date().toISOString() },
    ]);
    await writeFile(join(cleoDir, 'todo.json'), JSON.stringify(data));

    const result = await updateTask({ taskId: 'T001', status: 'done' }, tempDir);
    expect(result.task.completedAt).toBeDefined();
  });
});
