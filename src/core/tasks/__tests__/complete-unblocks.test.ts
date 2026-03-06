/**
 * Tests for completeTask unblockedTasks reporting.
 * @task T5069
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { completeTask } from '../complete.js';
import { createTestDb, seedTasks, type TestDbEnv } from '../../../store/__tests__/test-db-helper.js';
import type { DataAccessor } from '../../../store/data-accessor.js';

describe('completeTask unblocked tasks', () => {
  let env: TestDbEnv;
  let accessor: DataAccessor;

  beforeEach(async () => {
    env = await createTestDb();
    accessor = env.accessor;
    await writeFile(join(env.cleoDir, 'config.json'), JSON.stringify({ verification: { enabled: false } }));
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it('reports newly unblocked tasks when completing a blocker', async () => {
    await seedTasks(accessor, [
      { id: 'T001', title: 'Blocker', status: 'pending', priority: 'medium', createdAt: new Date().toISOString() },
      { id: 'T002', title: 'Was blocked', status: 'pending', priority: 'medium', depends: ['T001'], createdAt: new Date().toISOString() },
    ]);

    const result = await completeTask({ taskId: 'T001' }, env.tempDir, accessor);
    expect(result.unblockedTasks).toHaveLength(1);
    expect(result.unblockedTasks![0]).toEqual({ id: 'T002', title: 'Was blocked' });
  });

  it('does not report tasks that still have other unresolved deps', async () => {
    await seedTasks(accessor, [
      { id: 'T001', title: 'Blocker A', status: 'pending', priority: 'medium', createdAt: new Date().toISOString() },
      { id: 'T002', title: 'Blocker B', status: 'pending', priority: 'medium', createdAt: new Date().toISOString() },
      { id: 'T003', title: 'Still blocked', status: 'pending', priority: 'medium', depends: ['T001', 'T002'], createdAt: new Date().toISOString() },
    ]);

    const result = await completeTask({ taskId: 'T001' }, env.tempDir, accessor);
    expect(result.unblockedTasks).toBeUndefined();
  });

  it('omits unblockedTasks when no downstream tasks exist', async () => {
    await seedTasks(accessor, [
      { id: 'T001', title: 'Standalone', status: 'pending', priority: 'medium', createdAt: new Date().toISOString() },
    ]);

    const result = await completeTask({ taskId: 'T001' }, env.tempDir, accessor);
    expect(result.unblockedTasks).toBeUndefined();
  });

  it('reports multiple unblocked tasks', async () => {
    await seedTasks(accessor, [
      { id: 'T001', title: 'Shared blocker', status: 'pending', priority: 'medium', createdAt: new Date().toISOString() },
      { id: 'T002', title: 'Unblocked A', status: 'pending', priority: 'medium', depends: ['T001'], createdAt: new Date().toISOString() },
      { id: 'T003', title: 'Unblocked B', status: 'pending', priority: 'medium', depends: ['T001'], createdAt: new Date().toISOString() },
    ]);

    const result = await completeTask({ taskId: 'T001' }, env.tempDir, accessor);
    expect(result.unblockedTasks).toHaveLength(2);
    const ids = result.unblockedTasks!.map(t => t.id);
    expect(ids).toContain('T002');
    expect(ids).toContain('T003');
  });

  it('does not report already-completed dependents', async () => {
    await seedTasks(accessor, [
      { id: 'T001', title: 'Blocker', status: 'pending', priority: 'medium', createdAt: new Date().toISOString() },
      { id: 'T002', title: 'Already done', status: 'done', priority: 'medium', depends: ['T001'], createdAt: new Date().toISOString(), completedAt: new Date().toISOString() },
    ]);

    const result = await completeTask({ taskId: 'T001' }, env.tempDir, accessor);
    expect(result.unblockedTasks).toBeUndefined();
  });
});
