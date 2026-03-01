/**
 * Tests for completeTask unblockedTasks reporting.
 * @task T5069
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { completeTask } from '../complete.js';
import type { TaskFile } from '../../../types/task.js';

describe('completeTask unblocked tasks', () => {
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

  it('reports newly unblocked tasks when completing a blocker', async () => {
    const data = makeTodoFile([
      { id: 'T001', title: 'Blocker', status: 'pending', priority: 'medium', createdAt: new Date().toISOString() },
      { id: 'T002', title: 'Was blocked', status: 'pending', priority: 'medium', depends: ['T001'], createdAt: new Date().toISOString() },
    ]);
    await writeFile(join(cleoDir, 'tasks.json'), JSON.stringify(data));

    const result = await completeTask({ taskId: 'T001' }, tempDir);
    expect(result.unblockedTasks).toHaveLength(1);
    expect(result.unblockedTasks![0]).toEqual({ id: 'T002', title: 'Was blocked' });
  });

  it('does not report tasks that still have other unresolved deps', async () => {
    const data = makeTodoFile([
      { id: 'T001', title: 'Blocker A', status: 'pending', priority: 'medium', createdAt: new Date().toISOString() },
      { id: 'T002', title: 'Blocker B', status: 'pending', priority: 'medium', createdAt: new Date().toISOString() },
      { id: 'T003', title: 'Still blocked', status: 'pending', priority: 'medium', depends: ['T001', 'T002'], createdAt: new Date().toISOString() },
    ]);
    await writeFile(join(cleoDir, 'tasks.json'), JSON.stringify(data));

    const result = await completeTask({ taskId: 'T001' }, tempDir);
    expect(result.unblockedTasks).toBeUndefined();
  });

  it('omits unblockedTasks when no downstream tasks exist', async () => {
    const data = makeTodoFile([
      { id: 'T001', title: 'Standalone', status: 'pending', priority: 'medium', createdAt: new Date().toISOString() },
    ]);
    await writeFile(join(cleoDir, 'tasks.json'), JSON.stringify(data));

    const result = await completeTask({ taskId: 'T001' }, tempDir);
    expect(result.unblockedTasks).toBeUndefined();
  });

  it('reports multiple unblocked tasks', async () => {
    const data = makeTodoFile([
      { id: 'T001', title: 'Shared blocker', status: 'pending', priority: 'medium', createdAt: new Date().toISOString() },
      { id: 'T002', title: 'Unblocked A', status: 'pending', priority: 'medium', depends: ['T001'], createdAt: new Date().toISOString() },
      { id: 'T003', title: 'Unblocked B', status: 'pending', priority: 'medium', depends: ['T001'], createdAt: new Date().toISOString() },
    ]);
    await writeFile(join(cleoDir, 'tasks.json'), JSON.stringify(data));

    const result = await completeTask({ taskId: 'T001' }, tempDir);
    expect(result.unblockedTasks).toHaveLength(2);
    const ids = result.unblockedTasks!.map(t => t.id);
    expect(ids).toContain('T002');
    expect(ids).toContain('T003');
  });

  it('does not report already-completed dependents', async () => {
    const data = makeTodoFile([
      { id: 'T001', title: 'Blocker', status: 'pending', priority: 'medium', createdAt: new Date().toISOString() },
      { id: 'T002', title: 'Already done', status: 'done', priority: 'medium', depends: ['T001'], createdAt: new Date().toISOString(), completedAt: new Date().toISOString() },
    ]);
    await writeFile(join(cleoDir, 'tasks.json'), JSON.stringify(data));

    const result = await completeTask({ taskId: 'T001' }, tempDir);
    expect(result.unblockedTasks).toBeUndefined();
  });
});
