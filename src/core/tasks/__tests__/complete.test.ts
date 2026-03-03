/**
 * Tests for task completion.
 * @task T4461
 * @epic T4454
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { completeTask } from '../complete.js';
import type { TaskFile } from '../../../types/task.js';

describe('completeTask', () => {
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
    await writeConfig({ verification: { enabled: false } });
  });

  const writeConfig = async (config: Record<string, unknown>): Promise<void> => {
    await writeFile(join(cleoDir, 'config.json'), JSON.stringify(config));
  };

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('completes a pending task', async () => {
    const data = makeTodoFile([
      { id: 'T001', title: 'Test task', status: 'pending', priority: 'medium', createdAt: new Date().toISOString() },
    ]);
    await writeFile(join(cleoDir, 'tasks.json'), JSON.stringify(data));

    const result = await completeTask({ taskId: 'T001' }, tempDir);
    expect(result.task.status).toBe('done');
    expect(result.task.completedAt).toBeDefined();
  });

  it('throws if task not found', async () => {
    const data = makeTodoFile([]);
    await writeFile(join(cleoDir, 'tasks.json'), JSON.stringify(data));

    await expect(
      completeTask({ taskId: 'T999' }, tempDir),
    ).rejects.toThrow('Task not found');
  });

  it('throws if task already done', async () => {
    const data = makeTodoFile([
      { id: 'T001', title: 'Done task', status: 'done', priority: 'medium', createdAt: new Date().toISOString(), completedAt: new Date().toISOString() },
    ]);
    await writeFile(join(cleoDir, 'tasks.json'), JSON.stringify(data));

    await expect(
      completeTask({ taskId: 'T001' }, tempDir),
    ).rejects.toThrow('already completed');
  });

  it('throws if dependencies are incomplete', async () => {
    const data = makeTodoFile([
      { id: 'T001', title: 'Dep', status: 'pending', priority: 'medium', createdAt: new Date().toISOString() },
      { id: 'T002', title: 'Blocked', status: 'pending', priority: 'medium', depends: ['T001'], createdAt: new Date().toISOString() },
    ]);
    await writeFile(join(cleoDir, 'tasks.json'), JSON.stringify(data));

    await expect(
      completeTask({ taskId: 'T002' }, tempDir),
    ).rejects.toThrow('incomplete dependencies');
  });

  it('allows completion when dependency is cancelled', async () => {
    const data = makeTodoFile([
      { id: 'T001', title: 'Dep', status: 'cancelled', priority: 'medium', createdAt: new Date().toISOString(), cancelledAt: new Date().toISOString() },
      { id: 'T002', title: 'Blocked', status: 'pending', priority: 'medium', depends: ['T001'], createdAt: new Date().toISOString() },
    ]);
    await writeFile(join(cleoDir, 'tasks.json'), JSON.stringify(data));

    const result = await completeTask({ taskId: 'T002' }, tempDir);
    expect(result.task.status).toBe('done');
  });

  it('blocks completion when acceptance is required and missing', async () => {
    const data = makeTodoFile([
      { id: 'T001', title: 'High priority task', status: 'active', priority: 'high', createdAt: new Date().toISOString() },
    ]);
    await writeFile(join(cleoDir, 'tasks.json'), JSON.stringify(data));
    await writeConfig({
      enforcement: {
        acceptance: {
          mode: 'block',
          requiredForPriorities: ['high'],
        },
      },
    });

    await expect(
      completeTask({ taskId: 'T001' }, tempDir),
    ).rejects.toThrow('requires acceptance criteria');
  });

  it('blocks completion when verification metadata is missing', async () => {
    const data = makeTodoFile([
      { id: 'T001', title: 'Verified task', status: 'active', priority: 'medium', createdAt: new Date().toISOString(), type: 'task' },
    ]);
    await writeFile(join(cleoDir, 'tasks.json'), JSON.stringify(data));
    await writeConfig({ verification: { enabled: true } });

    await expect(
      completeTask({ taskId: 'T001' }, tempDir),
    ).rejects.toThrow('missing verification metadata');
  });

  it('defaults verification enforcement to enabled when unset', async () => {
    const data = makeTodoFile([
      { id: 'T001', title: 'Default enforcement task', status: 'active', priority: 'medium', createdAt: new Date().toISOString(), type: 'task' },
    ]);
    await writeFile(join(cleoDir, 'tasks.json'), JSON.stringify(data));
    await rm(join(cleoDir, 'config.json'), { force: true });

    await expect(
      completeTask({ taskId: 'T001' }, tempDir),
    ).rejects.toThrow('missing verification metadata');
  });

  it('honors project config when verification enforcement is off', async () => {
    const data = makeTodoFile([
      { id: 'T001', title: 'No verification task', status: 'active', priority: 'medium', createdAt: new Date().toISOString(), type: 'task' },
    ]);
    await writeFile(join(cleoDir, 'tasks.json'), JSON.stringify(data));
    await writeConfig({ verification: { enabled: false } });

    const result = await completeTask({ taskId: 'T001' }, tempDir);
    expect(result.task.status).toBe('done');
  });

  it('blocks completion when required verification gates are incomplete', async () => {
    const data = makeTodoFile([
      {
        id: 'T001',
        title: 'Gate incomplete task',
        status: 'active',
        priority: 'medium',
        createdAt: new Date().toISOString(),
        type: 'task',
        verification: {
          passed: false,
          round: 1,
          gates: {
            implemented: true,
            testsPassed: false,
          },
          lastAgent: 'testing',
          lastUpdated: new Date().toISOString(),
          failureLog: [],
        },
      },
    ]);
    await writeFile(join(cleoDir, 'tasks.json'), JSON.stringify(data));
    await writeConfig({
      verification: {
        enabled: true,
        requiredGates: ['implemented', 'testsPassed'],
      },
    });

    await expect(
      completeTask({ taskId: 'T001' }, tempDir),
    ).rejects.toThrow('failed verification gates');
  });

  it('adds notes on completion', async () => {
    const data = makeTodoFile([
      { id: 'T001', title: 'Test task', status: 'active', priority: 'medium', createdAt: new Date().toISOString() },
    ]);
    await writeFile(join(cleoDir, 'tasks.json'), JSON.stringify(data));

    const result = await completeTask({ taskId: 'T001', notes: 'Done with tests' }, tempDir);
    expect(result.task.notes).toHaveLength(1);
    expect(result.task.notes![0]).toContain('Done with tests');
  });
});
