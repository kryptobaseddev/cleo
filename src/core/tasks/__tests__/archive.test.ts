/**
 * Tests for batch task archiving.
 * @task T4627
 * @epic T4454
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { archiveTasks } from '../archive.js';
import type { TodoFile } from '../../../types/task.js';

describe('archiveTasks', () => {
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

  it('archives completed tasks', async () => {
    const data = makeTodoFile([
      { id: 'T001', title: 'Done task', status: 'done', priority: 'medium', createdAt: '2025-01-01T00:00:00Z', completedAt: '2025-01-02T00:00:00Z' },
      { id: 'T002', title: 'Pending task', status: 'pending', priority: 'medium', createdAt: new Date().toISOString() },
    ]);
    await writeFile(join(cleoDir, 'todo.json'), JSON.stringify(data));
    await writeFile(join(cleoDir, 'todo-log.json'), JSON.stringify({ _meta: { version: '2.1.0' }, entries: [] }));

    const result = await archiveTasks({}, tempDir);
    expect(result.archived).toContain('T001');
    expect(result.archived).not.toContain('T002');

    const updated = JSON.parse(await readFile(join(cleoDir, 'todo.json'), 'utf8'));
    expect(updated.tasks).toHaveLength(1);
    expect(updated.tasks[0].id).toBe('T002');

    const archive = JSON.parse(await readFile(join(cleoDir, 'todo-archive.json'), 'utf8'));
    expect(archive.archivedTasks).toHaveLength(1);
    expect(archive.archivedTasks[0].id).toBe('T001');
  });

  it('includes cancelled tasks by default', async () => {
    const data = makeTodoFile([
      { id: 'T001', title: 'Cancelled', status: 'cancelled', priority: 'medium', createdAt: '2025-01-01T00:00:00Z', cancelledAt: '2025-01-02T00:00:00Z' },
    ]);
    await writeFile(join(cleoDir, 'todo.json'), JSON.stringify(data));
    await writeFile(join(cleoDir, 'todo-log.json'), JSON.stringify({ _meta: { version: '2.1.0' }, entries: [] }));

    const result = await archiveTasks({}, tempDir);
    expect(result.archived).toContain('T001');
  });

  it('excludes cancelled tasks when includeCancelled is false', async () => {
    const data = makeTodoFile([
      { id: 'T001', title: 'Cancelled', status: 'cancelled', priority: 'medium', createdAt: '2025-01-01T00:00:00Z' },
    ]);
    await writeFile(join(cleoDir, 'todo.json'), JSON.stringify(data));

    const result = await archiveTasks({ includeCancelled: false }, tempDir);
    expect(result.archived).toHaveLength(0);
  });

  it('filters by date with before option', async () => {
    const data = makeTodoFile([
      { id: 'T001', title: 'Old', status: 'done', priority: 'medium', createdAt: '2024-01-01T00:00:00Z', completedAt: '2024-06-01T00:00:00Z' },
      { id: 'T002', title: 'Recent', status: 'done', priority: 'medium', createdAt: '2025-12-01T00:00:00Z', completedAt: '2025-12-15T00:00:00Z' },
    ]);
    await writeFile(join(cleoDir, 'todo.json'), JSON.stringify(data));
    await writeFile(join(cleoDir, 'todo-log.json'), JSON.stringify({ _meta: { version: '2.1.0' }, entries: [] }));

    const result = await archiveTasks({ before: '2025-01-01T00:00:00Z' }, tempDir);
    expect(result.archived).toContain('T001');
    expect(result.archived).not.toContain('T002');
  });

  it('archives specific tasks by ID', async () => {
    const data = makeTodoFile([
      { id: 'T001', title: 'Done 1', status: 'done', priority: 'medium', createdAt: '2025-01-01T00:00:00Z' },
      { id: 'T002', title: 'Done 2', status: 'done', priority: 'medium', createdAt: '2025-01-01T00:00:00Z' },
    ]);
    await writeFile(join(cleoDir, 'todo.json'), JSON.stringify(data));
    await writeFile(join(cleoDir, 'todo-log.json'), JSON.stringify({ _meta: { version: '2.1.0' }, entries: [] }));

    const result = await archiveTasks({ taskIds: ['T001'] }, tempDir);
    expect(result.archived).toEqual(['T001']);
  });

  it('supports dry run mode', async () => {
    const data = makeTodoFile([
      { id: 'T001', title: 'Done', status: 'done', priority: 'medium', createdAt: '2025-01-01T00:00:00Z' },
    ]);
    await writeFile(join(cleoDir, 'todo.json'), JSON.stringify(data));

    const result = await archiveTasks({ dryRun: true }, tempDir);
    expect(result.dryRun).toBe(true);
    expect(result.archived).toContain('T001');

    // Verify no changes were made
    const updated = JSON.parse(await readFile(join(cleoDir, 'todo.json'), 'utf8'));
    expect(updated.tasks).toHaveLength(1);
  });

  it('skips epics with active children', async () => {
    const data = makeTodoFile([
      { id: 'T001', title: 'Epic', status: 'done', priority: 'medium', type: 'epic', createdAt: '2025-01-01T00:00:00Z' },
      { id: 'T002', title: 'Active child', status: 'active', priority: 'medium', parentId: 'T001', createdAt: '2025-01-01T00:00:00Z' },
    ]);
    await writeFile(join(cleoDir, 'todo.json'), JSON.stringify(data));

    const result = await archiveTasks({}, tempDir);
    expect(result.skipped).toContain('T001');
    expect(result.archived).not.toContain('T001');
  });

  it('returns empty when nothing to archive', async () => {
    const data = makeTodoFile([
      { id: 'T001', title: 'Active', status: 'active', priority: 'medium', createdAt: new Date().toISOString() },
    ]);
    await writeFile(join(cleoDir, 'todo.json'), JSON.stringify(data));

    const result = await archiveTasks({}, tempDir);
    expect(result.archived).toHaveLength(0);
  });

  it('appends to existing archive', async () => {
    const data = makeTodoFile([
      { id: 'T002', title: 'New done', status: 'done', priority: 'medium', createdAt: '2025-01-01T00:00:00Z' },
    ]);
    await writeFile(join(cleoDir, 'todo.json'), JSON.stringify(data));
    await writeFile(join(cleoDir, 'todo-archive.json'), JSON.stringify({
      archivedTasks: [{ id: 'T001', title: 'Already archived', status: 'done', priority: 'medium', createdAt: '2024-01-01T00:00:00Z' }],
      version: '1.0.0',
    }));
    await writeFile(join(cleoDir, 'todo-log.json'), JSON.stringify({ _meta: { version: '2.1.0' }, entries: [] }));

    await archiveTasks({}, tempDir);

    const archive = JSON.parse(await readFile(join(cleoDir, 'todo-archive.json'), 'utf8'));
    expect(archive.archivedTasks).toHaveLength(2);
  });
});
