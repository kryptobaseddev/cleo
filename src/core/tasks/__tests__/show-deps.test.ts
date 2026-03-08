/**
 * Tests for showTask unresolvedDeps and dependents fields.
 * @task T5069
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestDb,
  seedTasks,
  type TestDbEnv,
} from '../../../store/__tests__/test-db-helper.js';
import type { DataAccessor } from '../../../store/data-accessor.js';
import { showTask } from '../show.js';

describe('showTask dependency enrichment', () => {
  let env: TestDbEnv;
  let accessor: DataAccessor;

  beforeEach(async () => {
    env = await createTestDb();
    accessor = env.accessor;
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it('surfaces unresolvedDeps for unresolved dependencies', async () => {
    await seedTasks(accessor, [
      {
        id: 'T001',
        title: 'Blocker',
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

    const result = await showTask('T002', env.tempDir, accessor);
    expect(result.unresolvedDeps).toHaveLength(1);
    expect(result.unresolvedDeps![0]).toEqual({
      id: 'T001',
      status: 'pending',
      title: 'Blocker',
    });
  });

  it('omits unresolvedDeps when all dependencies are done', async () => {
    await seedTasks(accessor, [
      {
        id: 'T001',
        title: 'Done dep',
        status: 'done',
        priority: 'medium',
        createdAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      },
      {
        id: 'T002',
        title: 'Unblocked',
        status: 'pending',
        priority: 'medium',
        depends: ['T001'],
        createdAt: new Date().toISOString(),
      },
    ]);

    const result = await showTask('T002', env.tempDir, accessor);
    expect(result.unresolvedDeps).toBeUndefined();
  });

  it('omits unresolvedDeps when dependencies are cancelled', async () => {
    await seedTasks(accessor, [
      {
        id: 'T001',
        title: 'Cancelled',
        status: 'cancelled',
        priority: 'medium',
        createdAt: new Date().toISOString(),
        cancelledAt: new Date().toISOString(),
      },
      {
        id: 'T002',
        title: 'Unblocked',
        status: 'pending',
        priority: 'medium',
        depends: ['T001'],
        createdAt: new Date().toISOString(),
      },
    ]);

    const result = await showTask('T002', env.tempDir, accessor);
    expect(result.unresolvedDeps).toBeUndefined();
  });

  it('shows only unresolved deps in unresolvedDeps when some are done', async () => {
    await seedTasks(accessor, [
      {
        id: 'T001',
        title: 'Done',
        status: 'done',
        priority: 'medium',
        createdAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      },
      {
        id: 'T002',
        title: 'Still pending',
        status: 'active',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      },
      {
        id: 'T003',
        title: 'Partially blocked',
        status: 'pending',
        priority: 'medium',
        depends: ['T001', 'T002'],
        createdAt: new Date().toISOString(),
      },
    ]);

    const result = await showTask('T003', env.tempDir, accessor);
    expect(result.unresolvedDeps).toHaveLength(1);
    expect(result.unresolvedDeps![0]!.id).toBe('T002');
  });

  it('surfaces dependents for a task that others depend on', async () => {
    await seedTasks(accessor, [
      {
        id: 'T001',
        title: 'Foundation',
        status: 'pending',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      },
      {
        id: 'T002',
        title: 'Depends on T001',
        status: 'pending',
        priority: 'medium',
        depends: ['T001'],
        createdAt: new Date().toISOString(),
      },
      {
        id: 'T003',
        title: 'Also depends on T001',
        status: 'pending',
        priority: 'medium',
        depends: ['T001'],
        createdAt: new Date().toISOString(),
      },
    ]);

    const result = await showTask('T001', env.tempDir, accessor);
    expect(result.dependents).toEqual(expect.arrayContaining(['T002', 'T003']));
    expect(result.dependents).toHaveLength(2);
  });

  it('omits dependents when no tasks depend on this one', async () => {
    await seedTasks(accessor, [
      {
        id: 'T001',
        title: 'Standalone',
        status: 'pending',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      },
      {
        id: 'T002',
        title: 'Other',
        status: 'pending',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      },
    ]);

    const result = await showTask('T001', env.tempDir, accessor);
    expect(result.dependents).toBeUndefined();
  });

  it('omits unresolvedDeps for tasks with no dependencies', async () => {
    await seedTasks(accessor, [
      {
        id: 'T001',
        title: 'No deps',
        status: 'pending',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      },
    ]);

    const result = await showTask('T001', env.tempDir, accessor);
    expect(result.unresolvedDeps).toBeUndefined();
  });
});
