/**
 * Tests for task completion.
 * @task T4461
 * @epic T4454
 */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestDb,
  seedTasks,
  type TestDbEnv,
} from '../../../store/__tests__/test-db-helper.js';
import type { DataAccessor } from '../../../store/data-accessor.js';
import { completeTask } from '../complete.js';

describe('completeTask', () => {
  let env: TestDbEnv;
  let accessor: DataAccessor;

  beforeEach(async () => {
    env = await createTestDb();
    accessor = env.accessor;
    await writeConfig({ verification: { enabled: false } });
  });

  const writeConfig = async (config: Record<string, unknown>): Promise<void> => {
    await writeFile(join(env.cleoDir, 'config.json'), JSON.stringify(config));
  };

  afterEach(async () => {
    await env.cleanup();
  });

  it('completes a pending task', async () => {
    await seedTasks(accessor, [
      {
        id: 'T001',
        title: 'Test task',
        status: 'pending',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      },
    ]);

    const result = await completeTask({ taskId: 'T001' }, env.tempDir, accessor);
    expect(result.task.status).toBe('done');
    expect(result.task.completedAt).toBeDefined();
  });

  it('throws if task not found', async () => {
    await seedTasks(accessor, []);

    await expect(completeTask({ taskId: 'T999' }, env.tempDir, accessor)).rejects.toThrow(
      'Task not found',
    );
  });

  it('throws if task already done', async () => {
    await seedTasks(accessor, [
      {
        id: 'T001',
        title: 'Done task',
        status: 'done',
        priority: 'medium',
        createdAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      },
    ]);

    await expect(completeTask({ taskId: 'T001' }, env.tempDir, accessor)).rejects.toThrow(
      'already completed',
    );
  });

  it('throws if dependencies are incomplete', async () => {
    await seedTasks(accessor, [
      {
        id: 'T001',
        title: 'Dep',
        status: 'pending',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      },
      {
        id: 'T002',
        title: 'Blocked',
        status: 'pending',
        priority: 'medium',
        depends: ['T001'],
        createdAt: new Date().toISOString(),
      },
    ]);

    await expect(completeTask({ taskId: 'T002' }, env.tempDir, accessor)).rejects.toThrow(
      'incomplete dependencies',
    );
  });

  it('allows completion when dependency is cancelled', async () => {
    await seedTasks(accessor, [
      {
        id: 'T001',
        title: 'Dep',
        status: 'cancelled',
        priority: 'medium',
        createdAt: new Date().toISOString(),
        cancelledAt: new Date().toISOString(),
      },
      {
        id: 'T002',
        title: 'Blocked',
        status: 'pending',
        priority: 'medium',
        depends: ['T001'],
        createdAt: new Date().toISOString(),
      },
    ]);

    const result = await completeTask({ taskId: 'T002' }, env.tempDir, accessor);
    expect(result.task.status).toBe('done');
  });

  it('blocks completion when acceptance is required and missing', async () => {
    await seedTasks(accessor, [
      {
        id: 'T001',
        title: 'High priority task',
        status: 'active',
        priority: 'high',
        createdAt: new Date().toISOString(),
      },
    ]);
    await writeConfig({
      enforcement: {
        acceptance: {
          mode: 'block',
          requiredForPriorities: ['high'],
        },
      },
    });

    await expect(completeTask({ taskId: 'T001' }, env.tempDir, accessor)).rejects.toThrow(
      'requires acceptance criteria',
    );
  });

  it('blocks completion when verification metadata is missing', async () => {
    await seedTasks(accessor, [
      {
        id: 'T001',
        title: 'Verified task',
        status: 'active',
        priority: 'medium',
        createdAt: new Date().toISOString(),
        type: 'task',
      },
    ]);
    await writeConfig({ verification: { enabled: true } });

    await expect(completeTask({ taskId: 'T001' }, env.tempDir, accessor)).rejects.toThrow(
      'missing verification metadata',
    );
  });

  it('defaults verification enforcement to enabled when unset', async () => {
    await seedTasks(accessor, [
      {
        id: 'T001',
        title: 'Default enforcement task',
        status: 'active',
        priority: 'medium',
        createdAt: new Date().toISOString(),
        type: 'task',
      },
    ]);
    // Remove config.json so verification defaults to enabled
    const { rm } = await import('node:fs/promises');
    await rm(join(env.cleoDir, 'config.json'), { force: true });

    await expect(completeTask({ taskId: 'T001' }, env.tempDir, accessor)).rejects.toThrow(
      'missing verification metadata',
    );
  });

  it('honors project config when verification enforcement is off', async () => {
    await seedTasks(accessor, [
      {
        id: 'T001',
        title: 'No verification task',
        status: 'active',
        priority: 'medium',
        createdAt: new Date().toISOString(),
        type: 'task',
      },
    ]);
    await writeConfig({ verification: { enabled: false } });

    const result = await completeTask({ taskId: 'T001' }, env.tempDir, accessor);
    expect(result.task.status).toBe('done');
  });

  it('blocks completion when required verification gates are incomplete', async () => {
    await seedTasks(accessor, [
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
    await writeConfig({
      verification: {
        enabled: true,
        requiredGates: ['implemented', 'testsPassed'],
      },
    });

    await expect(completeTask({ taskId: 'T001' }, env.tempDir, accessor)).rejects.toThrow(
      'failed verification gates',
    );
  });

  it('adds notes on completion', async () => {
    await seedTasks(accessor, [
      {
        id: 'T001',
        title: 'Test task',
        status: 'active',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      },
    ]);

    const result = await completeTask(
      { taskId: 'T001', notes: 'Done with tests' },
      env.tempDir,
      accessor,
    );
    expect(result.task.notes).toHaveLength(1);
    expect(result.task.notes![0]).toContain('Done with tests');
  });
});
