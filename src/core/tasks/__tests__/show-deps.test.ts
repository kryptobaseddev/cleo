/**
 * Tests for showTask unresolvedDeps and dependents fields.
 * @task T5069
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { showTask } from '../show.js';
import type { TaskFile } from '../../../types/task.js';

describe('showTask dependency enrichment', () => {
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
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('surfaces unresolvedDeps for unresolved dependencies', async () => {
    const data = makeTodoFile([
      { id: 'T001', title: 'Blocker', status: 'pending', priority: 'medium', createdAt: new Date().toISOString() },
      { id: 'T002', title: 'Blocked', status: 'pending', priority: 'medium', depends: ['T001'], createdAt: new Date().toISOString() },
    ]);
    await writeFile(join(cleoDir, 'tasks.json'), JSON.stringify(data));

    const result = await showTask('T002', tempDir);
    expect(result.unresolvedDeps).toHaveLength(1);
    expect(result.unresolvedDeps![0]).toEqual({
      id: 'T001',
      status: 'pending',
      title: 'Blocker',
    });
  });

  it('omits unresolvedDeps when all dependencies are done', async () => {
    const data = makeTodoFile([
      { id: 'T001', title: 'Done dep', status: 'done', priority: 'medium', createdAt: new Date().toISOString(), completedAt: new Date().toISOString() },
      { id: 'T002', title: 'Unblocked', status: 'pending', priority: 'medium', depends: ['T001'], createdAt: new Date().toISOString() },
    ]);
    await writeFile(join(cleoDir, 'tasks.json'), JSON.stringify(data));

    const result = await showTask('T002', tempDir);
    expect(result.unresolvedDeps).toBeUndefined();
  });

  it('omits unresolvedDeps when dependencies are cancelled', async () => {
    const data = makeTodoFile([
      { id: 'T001', title: 'Cancelled', status: 'cancelled', priority: 'medium', createdAt: new Date().toISOString(), cancelledAt: new Date().toISOString() },
      { id: 'T002', title: 'Unblocked', status: 'pending', priority: 'medium', depends: ['T001'], createdAt: new Date().toISOString() },
    ]);
    await writeFile(join(cleoDir, 'tasks.json'), JSON.stringify(data));

    const result = await showTask('T002', tempDir);
    expect(result.unresolvedDeps).toBeUndefined();
  });

  it('shows only unresolved deps in unresolvedDeps when some are done', async () => {
    const data = makeTodoFile([
      { id: 'T001', title: 'Done', status: 'done', priority: 'medium', createdAt: new Date().toISOString(), completedAt: new Date().toISOString() },
      { id: 'T002', title: 'Still pending', status: 'active', priority: 'medium', createdAt: new Date().toISOString() },
      { id: 'T003', title: 'Partially blocked', status: 'pending', priority: 'medium', depends: ['T001', 'T002'], createdAt: new Date().toISOString() },
    ]);
    await writeFile(join(cleoDir, 'tasks.json'), JSON.stringify(data));

    const result = await showTask('T003', tempDir);
    expect(result.unresolvedDeps).toHaveLength(1);
    expect(result.unresolvedDeps![0]!.id).toBe('T002');
  });

  it('surfaces dependents for a task that others depend on', async () => {
    const data = makeTodoFile([
      { id: 'T001', title: 'Foundation', status: 'pending', priority: 'medium', createdAt: new Date().toISOString() },
      { id: 'T002', title: 'Depends on T001', status: 'pending', priority: 'medium', depends: ['T001'], createdAt: new Date().toISOString() },
      { id: 'T003', title: 'Also depends on T001', status: 'pending', priority: 'medium', depends: ['T001'], createdAt: new Date().toISOString() },
    ]);
    await writeFile(join(cleoDir, 'tasks.json'), JSON.stringify(data));

    const result = await showTask('T001', tempDir);
    expect(result.dependents).toEqual(expect.arrayContaining(['T002', 'T003']));
    expect(result.dependents).toHaveLength(2);
  });

  it('omits dependents when no tasks depend on this one', async () => {
    const data = makeTodoFile([
      { id: 'T001', title: 'Standalone', status: 'pending', priority: 'medium', createdAt: new Date().toISOString() },
      { id: 'T002', title: 'Other', status: 'pending', priority: 'medium', createdAt: new Date().toISOString() },
    ]);
    await writeFile(join(cleoDir, 'tasks.json'), JSON.stringify(data));

    const result = await showTask('T001', tempDir);
    expect(result.dependents).toBeUndefined();
  });

  it('omits unresolvedDeps for tasks with no dependencies', async () => {
    const data = makeTodoFile([
      { id: 'T001', title: 'No deps', status: 'pending', priority: 'medium', createdAt: new Date().toISOString() },
    ]);
    await writeFile(join(cleoDir, 'tasks.json'), JSON.stringify(data));

    const result = await showTask('T001', tempDir);
    expect(result.unresolvedDeps).toBeUndefined();
  });
});
