/**
 * Tests for task completion.
 * @task T4461
 * @epic T4454
 */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, seedTasks, type TestDbEnv } from '../../store/__tests__/test-db-helper.js';
import type { DataAccessor, TransactionAccessor } from '../../store/data-accessor.js';
import { resetDbState } from '../../store/sqlite.js';
import { completeTask, withTaskWriteTransaction } from '../complete.js';

describe('completeTask', () => {
  let env: TestDbEnv;
  let accessor: DataAccessor;

  beforeEach(async () => {
    env = await createTestDb();
    accessor = env.accessor;
    // Pin CLEO_DIR so concurrent workers cannot contaminate path resolution
    process.env['CLEO_DIR'] = env.cleoDir;
    await writeConfig({
      enforcement: {
        session: { requiredForMutate: false },
        acceptance: { mode: 'off' },
      },
      lifecycle: { mode: 'off' },
      verification: { enabled: false },
    });
  });

  const writeConfig = async (config: Record<string, unknown>): Promise<void> => {
    await writeFile(join(env.cleoDir, 'config.json'), JSON.stringify(config));
  };

  afterEach(async () => {
    delete process.env['CLEO_DIR'];
    resetDbState();
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

  // T1954: archived deps must satisfy dependencies (equivalent to done)
  it('allows completion when dependency is archived', async () => {
    await seedTasks(accessor, [
      {
        id: 'T001',
        title: 'Archived dep',
        status: 'archived',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      },
      {
        id: 'T002',
        title: 'Blocked by archived',
        status: 'pending',
        priority: 'medium',
        depends: ['T001'],
        createdAt: new Date().toISOString(),
      },
    ]);

    const result = await completeTask({ taskId: 'T002' }, env.tempDir, accessor);
    expect(result.task.status).toBe('done');
  });

  // T1954: still block when dep is pending (regression guard)
  it('still blocks completion when dependency is pending', async () => {
    await seedTasks(accessor, [
      {
        id: 'T001',
        title: 'Pending dep',
        status: 'pending',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      },
      {
        id: 'T002',
        title: 'Blocked by pending',
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
      'acceptance criteria',
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
    await writeConfig({
      enforcement: { acceptance: { mode: 'off' } },
      verification: { enabled: true },
    });

    await expect(completeTask({ taskId: 'T001' }, env.tempDir, accessor)).rejects.toThrow(
      'missing verification metadata',
    );
  });

  it('defaults verification enforcement to disabled when unset (opt-in)', async () => {
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
    // Write a config that only disables acceptance enforcement but no verification
    // settings — verifying that verification defaults to disabled (opt-in behavior).
    await writeConfig({
      enforcement: { acceptance: { mode: 'off' } },
    });

    const result = await completeTask({ taskId: 'T001' }, env.tempDir, accessor);
    expect(result.task.status).toBe('done');
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
    await writeConfig({
      enforcement: { acceptance: { mode: 'off' } },
      verification: { enabled: false },
    });

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
      enforcement: { acceptance: { mode: 'off' } },
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

  // --------------------------------------------------------------------------
  // T871 — status ↔ pipelineStage sync on completion
  // --------------------------------------------------------------------------

  it('T871: sets pipelineStage to contribution when completing from research', async () => {
    await seedTasks(accessor, [
      {
        id: 'T870',
        title: 'Research task',
        status: 'pending',
        priority: 'medium',
        pipelineStage: 'research',
        createdAt: new Date().toISOString(),
      },
    ]);

    const result = await completeTask({ taskId: 'T870' }, env.tempDir, accessor);
    expect(result.task.status).toBe('done');
    expect(result.task.pipelineStage).toBe('contribution');
  });

  it('T871: sets pipelineStage to contribution when completing from implementation', async () => {
    await seedTasks(accessor, [
      {
        id: 'T871',
        title: 'Implementation task',
        status: 'pending',
        priority: 'medium',
        pipelineStage: 'implementation',
        createdAt: new Date().toISOString(),
      },
    ]);

    const result = await completeTask({ taskId: 'T871' }, env.tempDir, accessor);
    expect(result.task.status).toBe('done');
    expect(result.task.pipelineStage).toBe('contribution');
  });

  it('T871: sets pipelineStage to contribution when completing from release', async () => {
    await seedTasks(accessor, [
      {
        id: 'T872',
        title: 'Release task',
        status: 'pending',
        priority: 'medium',
        pipelineStage: 'release',
        createdAt: new Date().toISOString(),
      },
    ]);

    const result = await completeTask({ taskId: 'T872' }, env.tempDir, accessor);
    expect(result.task.status).toBe('done');
    expect(result.task.pipelineStage).toBe('contribution');
  });

  it('T871: leaves pipelineStage=contribution unchanged (idempotent)', async () => {
    await seedTasks(accessor, [
      {
        id: 'T873',
        title: 'Already at contribution',
        status: 'pending',
        priority: 'medium',
        pipelineStage: 'contribution',
        createdAt: new Date().toISOString(),
      },
    ]);

    const result = await completeTask({ taskId: 'T873' }, env.tempDir, accessor);
    expect(result.task.status).toBe('done');
    expect(result.task.pipelineStage).toBe('contribution');
  });

  it('T10595: runs AC completion gate inside the same write transaction as status update', async () => {
    await seedTasks(accessor, [
      {
        id: 'T10595-A',
        title: 'Atomic gate task',
        status: 'pending',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      },
    ]);
    await accessor.transaction(async (tx) => {
      await tx.insertAcRows([
        { id: 'ac-t10595-a', taskId: 'T10595-A', ordinal: 1, text: 'covered atomically' },
      ]);
    });

    const events: string[] = [];
    const instrumented: DataAccessor = {
      ...accessor,
      async transaction<T>(fn: (tx: TransactionAccessor) => Promise<T>): Promise<T> {
        events.push('begin-immediate');
        return accessor.transaction(async (tx) => {
          const instrumentedTx: TransactionAccessor = {
            ...tx,
            async getAcRows(taskId) {
              events.push(`gate:${taskId}`);
              return tx.getAcRows(taskId);
            },
            async upsertSingleTask(task) {
              events.push(`status:${task.id}:${task.status}`);
              return tx.upsertSingleTask(task);
            },
          };
          return fn(instrumentedTx);
        });
      },
    };

    await expect(completeTask({ taskId: 'T10595-A' }, env.tempDir, instrumented)).rejects.toThrow(
      'acceptance criterion/criteria have no evidence bindings',
    );

    expect(events).toEqual(['begin-immediate', 'gate:T10595-A']);
    const persisted = await accessor.loadSingleTask('T10595-A');
    expect(persisted?.status).toBe('pending');
    expect(persisted?.completedAt).toBeUndefined();
  });

  it('T10595: serializes concurrent task write helpers', async () => {
    let activeWriters = 0;
    let maxActiveWriters = 0;
    const releaseFirst = Promise.withResolvers<void>();
    const firstEntered = Promise.withResolvers<void>();
    const events: string[] = [];

    const serialQueue: Array<() => void> = [];
    const fakeAccessor = {
      async transaction<T>(fn: (tx: TransactionAccessor) => Promise<T>): Promise<T> {
        if (activeWriters > 0) {
          await new Promise<void>((resolve) => serialQueue.push(resolve));
        }
        activeWriters += 1;
        maxActiveWriters = Math.max(maxActiveWriters, activeWriters);
        try {
          return await fn({} as TransactionAccessor);
        } finally {
          activeWriters -= 1;
          serialQueue.shift()?.();
        }
      },
    } as DataAccessor;

    const first = withTaskWriteTransaction(fakeAccessor, async () => {
      events.push('first-enter');
      firstEntered.resolve();
      await releaseFirst.promise;
      events.push('first-exit');
      return 'first';
    });
    await firstEntered.promise;
    const second = withTaskWriteTransaction(fakeAccessor, async () => {
      events.push('second-enter');
      return 'second';
    });

    await Promise.resolve();
    expect(events).toEqual(['first-enter']);
    releaseFirst.resolve();

    await expect(Promise.all([first, second])).resolves.toEqual(['first', 'second']);
    expect(maxActiveWriters).toBe(1);
    expect(events).toEqual(['first-enter', 'first-exit', 'second-enter']);
  });
});
