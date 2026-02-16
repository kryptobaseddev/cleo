/**
 * Tests for task deletion (soft delete to archive).
 * @task T4627
 * @epic T4454
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { deleteTask } from '../delete.js';
import type { TodoFile } from '../../../types/task.js';

describe('deleteTask', () => {
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

  it('deletes a leaf task (moves to archive)', async () => {
    const data = makeTodoFile([
      { id: 'T001', title: 'Task to delete', status: 'pending', priority: 'medium', createdAt: new Date().toISOString() },
      { id: 'T002', title: 'Other task', status: 'pending', priority: 'medium', createdAt: new Date().toISOString() },
    ]);
    await writeFile(join(cleoDir, 'todo.json'), JSON.stringify(data));
    await writeFile(join(cleoDir, 'todo-log.jsonl'), JSON.stringify({ _meta: { version: '2.1.0' }, entries: [] }));

    const result = await deleteTask({ taskId: 'T001' }, tempDir);
    expect(result.deletedTask.id).toBe('T001');

    // Verify task removed from todo.json
    const updated = JSON.parse(await readFile(join(cleoDir, 'todo.json'), 'utf8'));
    expect(updated.tasks).toHaveLength(1);
    expect(updated.tasks[0].id).toBe('T002');

    // Verify task added to archive
    const archive = JSON.parse(await readFile(join(cleoDir, 'todo-archive.json'), 'utf8'));
    expect(archive.archivedTasks).toHaveLength(1);
    expect(archive.archivedTasks[0].id).toBe('T001');
    expect(archive.archivedTasks[0].archivedAt).toBeDefined();
  });

  it('throws for nonexistent task', async () => {
    const data = makeTodoFile([]);
    await writeFile(join(cleoDir, 'todo.json'), JSON.stringify(data));

    await expect(
      deleteTask({ taskId: 'T999' }, tempDir),
    ).rejects.toThrow('Task not found');
  });

  it('throws when task has children without cascade/force', async () => {
    const data = makeTodoFile([
      { id: 'T001', title: 'Parent', status: 'pending', priority: 'medium', type: 'epic', createdAt: new Date().toISOString() },
      { id: 'T002', title: 'Child', status: 'pending', priority: 'medium', parentId: 'T001', createdAt: new Date().toISOString() },
    ]);
    await writeFile(join(cleoDir, 'todo.json'), JSON.stringify(data));

    await expect(
      deleteTask({ taskId: 'T001' }, tempDir),
    ).rejects.toThrow(/children/i);
  });

  it('cascade deletes children', async () => {
    const data = makeTodoFile([
      { id: 'T001', title: 'Parent', status: 'pending', priority: 'medium', type: 'epic', createdAt: new Date().toISOString() },
      { id: 'T002', title: 'Child', status: 'pending', priority: 'medium', parentId: 'T001', createdAt: new Date().toISOString() },
      { id: 'T003', title: 'Grandchild', status: 'pending', priority: 'medium', parentId: 'T002', createdAt: new Date().toISOString() },
    ]);
    await writeFile(join(cleoDir, 'todo.json'), JSON.stringify(data));
    await writeFile(join(cleoDir, 'todo-log.jsonl'), JSON.stringify({ _meta: { version: '2.1.0' }, entries: [] }));

    const result = await deleteTask({ taskId: 'T001', cascade: true }, tempDir);
    expect(result.deletedTask.id).toBe('T001');
    expect(result.cascadeDeleted).toEqual(expect.arrayContaining(['T002', 'T003']));

    const updated = JSON.parse(await readFile(join(cleoDir, 'todo.json'), 'utf8'));
    expect(updated.tasks).toHaveLength(0);
  });

  it('force deletes by orphaning children', async () => {
    const data = makeTodoFile([
      { id: 'T001', title: 'Parent', status: 'pending', priority: 'medium', type: 'epic', createdAt: new Date().toISOString() },
      { id: 'T002', title: 'Child', status: 'pending', priority: 'medium', parentId: 'T001', type: 'subtask', createdAt: new Date().toISOString() },
    ]);
    await writeFile(join(cleoDir, 'todo.json'), JSON.stringify(data));
    await writeFile(join(cleoDir, 'todo-log.jsonl'), JSON.stringify({ _meta: { version: '2.1.0' }, entries: [] }));

    const result = await deleteTask({ taskId: 'T001', force: true }, tempDir);
    expect(result.deletedTask.id).toBe('T001');

    const updated = JSON.parse(await readFile(join(cleoDir, 'todo.json'), 'utf8'));
    expect(updated.tasks).toHaveLength(1);
    expect(updated.tasks[0].id).toBe('T002');
    expect(updated.tasks[0].parentId).toBeNull();
  });

  it('throws when task has dependents without force', async () => {
    const data = makeTodoFile([
      { id: 'T001', title: 'Dep target', status: 'pending', priority: 'medium', createdAt: new Date().toISOString() },
      { id: 'T002', title: 'Dependent', status: 'pending', priority: 'medium', depends: ['T001'], createdAt: new Date().toISOString() },
    ]);
    await writeFile(join(cleoDir, 'todo.json'), JSON.stringify(data));

    await expect(
      deleteTask({ taskId: 'T001' }, tempDir),
    ).rejects.toThrow(/dependency/i);
  });

  it('cleans up dependency references after deletion', async () => {
    const data = makeTodoFile([
      { id: 'T001', title: 'Target', status: 'pending', priority: 'medium', createdAt: new Date().toISOString() },
      { id: 'T002', title: 'Other', status: 'pending', priority: 'medium', depends: ['T001', 'T003'], createdAt: new Date().toISOString() },
      { id: 'T003', title: 'Third', status: 'pending', priority: 'medium', createdAt: new Date().toISOString() },
    ]);
    await writeFile(join(cleoDir, 'todo.json'), JSON.stringify(data));
    await writeFile(join(cleoDir, 'todo-log.jsonl'), JSON.stringify({ _meta: { version: '2.1.0' }, entries: [] }));

    await deleteTask({ taskId: 'T001', force: true }, tempDir);

    const updated = JSON.parse(await readFile(join(cleoDir, 'todo.json'), 'utf8'));
    const t002 = updated.tasks.find((t: { id: string }) => t.id === 'T002');
    expect(t002.depends).toEqual(['T003']);
  });
});
