/**
 * Tests for startTask dependency enforcement.
 * @task T5069
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startTask } from '../index.js';
import type { TaskFile } from '../../../types/task.js';

describe('startTask dependency enforcement', () => {
  let tempDir: string;
  let cleoDir: string;

  const makeTodoFile = (tasks: TaskFile['tasks']): TaskFile => ({
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

  it('refuses to start a task with unresolved dependencies', async () => {
    const data = makeTodoFile([
      { id: 'T001', title: 'Blocker', status: 'pending', priority: 'medium', createdAt: new Date().toISOString() },
      { id: 'T002', title: 'Blocked task', status: 'pending', priority: 'medium', depends: ['T001'], createdAt: new Date().toISOString() },
    ]);
    await writeFile(join(cleoDir, 'tasks.json'), JSON.stringify(data));

    await expect(
      startTask('T002', tempDir),
    ).rejects.toThrow('blocked by unresolved dependencies');
  });

  it('includes blocker IDs in error message', async () => {
    const data = makeTodoFile([
      { id: 'T001', title: 'Blocker A', status: 'pending', priority: 'medium', createdAt: new Date().toISOString() },
      { id: 'T002', title: 'Blocker B', status: 'active', priority: 'medium', createdAt: new Date().toISOString() },
      { id: 'T003', title: 'Blocked', status: 'pending', priority: 'medium', depends: ['T001', 'T002'], createdAt: new Date().toISOString() },
    ]);
    await writeFile(join(cleoDir, 'tasks.json'), JSON.stringify(data));

    await expect(
      startTask('T003', tempDir),
    ).rejects.toThrow('T001, T002');
  });

  it('allows starting a task when all dependencies are done', async () => {
    const data = makeTodoFile([
      { id: 'T001', title: 'Done dep', status: 'done', priority: 'medium', createdAt: new Date().toISOString(), completedAt: new Date().toISOString() },
      { id: 'T002', title: 'Ready task', status: 'pending', priority: 'medium', depends: ['T001'], createdAt: new Date().toISOString() },
    ]);
    await writeFile(join(cleoDir, 'tasks.json'), JSON.stringify(data));

    const result = await startTask('T002', tempDir);
    expect(result.taskId).toBe('T002');
    expect(result.taskTitle).toBe('Ready task');
  });

  it('allows starting a task when dependencies are cancelled', async () => {
    const data = makeTodoFile([
      { id: 'T001', title: 'Cancelled dep', status: 'cancelled', priority: 'medium', createdAt: new Date().toISOString(), cancelledAt: new Date().toISOString() },
      { id: 'T002', title: 'Ready task', status: 'pending', priority: 'medium', depends: ['T001'], createdAt: new Date().toISOString() },
    ]);
    await writeFile(join(cleoDir, 'tasks.json'), JSON.stringify(data));

    const result = await startTask('T002', tempDir);
    expect(result.taskId).toBe('T002');
  });

  it('allows starting a task with no dependencies', async () => {
    const data = makeTodoFile([
      { id: 'T001', title: 'No deps', status: 'pending', priority: 'medium', createdAt: new Date().toISOString() },
    ]);
    await writeFile(join(cleoDir, 'tasks.json'), JSON.stringify(data));

    const result = await startTask('T001', tempDir);
    expect(result.taskId).toBe('T001');
  });

  it('blocks when only some dependencies are resolved', async () => {
    const data = makeTodoFile([
      { id: 'T001', title: 'Done', status: 'done', priority: 'medium', createdAt: new Date().toISOString(), completedAt: new Date().toISOString() },
      { id: 'T002', title: 'Pending', status: 'pending', priority: 'medium', createdAt: new Date().toISOString() },
      { id: 'T003', title: 'Partially blocked', status: 'pending', priority: 'medium', depends: ['T001', 'T002'], createdAt: new Date().toISOString() },
    ]);
    await writeFile(join(cleoDir, 'tasks.json'), JSON.stringify(data));

    await expect(
      startTask('T003', tempDir),
    ).rejects.toThrow('T002');
  });
});
