/**
 * Tests for epic auto-complete behavior (T585).
 *
 * Verifies that an epic only auto-completes when ALL its direct subtasks
 * are in terminal states (done or cancelled), not when only some are done.
 *
 * @task T585
 */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, seedTasks, type TestDbEnv } from '../../store/__tests__/test-db-helper.js';
import type { DataAccessor } from '../../store/data-accessor.js';
import { resetDbState } from '../../store/sqlite.js';
import { completeTask } from '../complete.js';

describe('epic auto-complete', () => {
  let env: TestDbEnv;
  let accessor: DataAccessor;

  const writeConfig = async (config: Record<string, unknown>): Promise<void> => {
    await writeFile(join(env.cleoDir, 'config.json'), JSON.stringify(config));
  };

  beforeEach(async () => {
    env = await createTestDb();
    accessor = env.accessor;
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

  afterEach(async () => {
    delete process.env['CLEO_DIR'];
    resetDbState();
    await env.cleanup();
  });

  it('does NOT auto-complete epic when only one of two subtasks is completed (bug T585)', async () => {
    await seedTasks(accessor, [
      {
        id: 'T001',
        title: 'Test Epic',
        type: 'epic',
        status: 'active',
        priority: 'medium',
        acceptance: ['AC1'],
      },
      {
        id: 'T002',
        title: 'Sub 1',
        type: 'task',
        status: 'active',
        priority: 'medium',
        parentId: 'T001',
        acceptance: ['AC1'],
      },
      {
        id: 'T003',
        title: 'Sub 2',
        type: 'task',
        status: 'pending',
        priority: 'medium',
        parentId: 'T001',
        acceptance: ['AC1'],
      },
    ]);

    const result = await completeTask({ taskId: 'T002' }, env.tempDir, accessor);

    expect(result.task.status).toBe('done');
    expect(result.autoCompleted).toBeUndefined();

    // Verify the epic is still not done
    const epic = await accessor.loadSingleTask('T001');
    expect(epic?.status).not.toBe('done');

    // Verify T003 is still pending
    const sub2 = await accessor.loadSingleTask('T003');
    expect(sub2?.status).toBe('pending');
  });

  it('auto-completes epic when the LAST pending subtask is completed', async () => {
    await seedTasks(accessor, [
      {
        id: 'T001',
        title: 'Test Epic',
        type: 'epic',
        status: 'active',
        priority: 'medium',
        acceptance: ['AC1'],
      },
      {
        id: 'T002',
        title: 'Sub 1',
        type: 'task',
        status: 'done',
        priority: 'medium',
        parentId: 'T001',
        acceptance: ['AC1'],
        completedAt: new Date().toISOString(),
      },
      {
        id: 'T003',
        title: 'Sub 2',
        type: 'task',
        status: 'active',
        priority: 'medium',
        parentId: 'T001',
        acceptance: ['AC1'],
      },
    ]);

    const result = await completeTask({ taskId: 'T003' }, env.tempDir, accessor);

    expect(result.task.status).toBe('done');
    expect(result.autoCompleted).toContain('T001');

    const epic = await accessor.loadSingleTask('T001');
    expect(epic?.status).toBe('done');
  });

  it('does NOT auto-complete epic when remaining subtask is blocked (not terminal)', async () => {
    await seedTasks(accessor, [
      {
        id: 'T001',
        title: 'Test Epic',
        type: 'epic',
        status: 'active',
        priority: 'medium',
        acceptance: ['AC1'],
      },
      {
        id: 'T002',
        title: 'Sub 1',
        type: 'task',
        status: 'active',
        priority: 'medium',
        parentId: 'T001',
        acceptance: ['AC1'],
      },
      {
        id: 'T003',
        title: 'Sub 2',
        type: 'task',
        status: 'blocked',
        priority: 'medium',
        parentId: 'T001',
        acceptance: ['AC1'],
      },
    ]);

    const result = await completeTask({ taskId: 'T002' }, env.tempDir, accessor);

    expect(result.task.status).toBe('done');
    expect(result.autoCompleted).toBeUndefined();

    const epic = await accessor.loadSingleTask('T001');
    expect(epic?.status).not.toBe('done');
  });

  it('auto-completes epic when all remaining subtasks are cancelled', async () => {
    await seedTasks(accessor, [
      {
        id: 'T001',
        title: 'Test Epic',
        type: 'epic',
        status: 'active',
        priority: 'medium',
        acceptance: ['AC1'],
      },
      {
        id: 'T002',
        title: 'Sub 1',
        type: 'task',
        status: 'active',
        priority: 'medium',
        parentId: 'T001',
        acceptance: ['AC1'],
      },
      {
        id: 'T003',
        title: 'Sub 2',
        type: 'task',
        status: 'cancelled',
        priority: 'medium',
        parentId: 'T001',
        acceptance: ['AC1'],
        cancelledAt: new Date().toISOString(),
      },
    ]);

    const result = await completeTask({ taskId: 'T002' }, env.tempDir, accessor);

    expect(result.task.status).toBe('done');
    expect(result.autoCompleted).toContain('T001');

    const epic = await accessor.loadSingleTask('T001');
    expect(epic?.status).toBe('done');
  });

  it('does NOT auto-complete epic when getChildren returns an empty list (vacuous truth guard, T585)', async () => {
    // Defensive guard against [].every() === true (vacuous truth).
    // If getChildren(epic) returns [] — e.g. because all children have
    // parent_id=null due to a data-integrity issue — completing any task
    // with task.parentId set to that epic must NOT auto-complete it.
    //
    // We simulate this by: seeding T001 (epic) and T002 (task with parentId=T001),
    // then manually clearing T002's parent_id in the DB so getChildren(T001) returns [].
    // But loadSingleTask(T002) still returns parentId:'T001' ... wait, no. If parent_id
    // is NULL in DB then rowToTask returns parentId: undefined. So task.parentId is falsy
    // and the auto-complete block is skipped entirely.
    //
    // The vacuous truth guard `siblings.length > 0` is still correct defensive code for
    // the scenario where getChildren returns [] for any reason (e.g., future filter changes).
    // The primary bug fix (partial completion doesn't close epic) is proven by test 1 above.
    //
    // This test creates a mock accessor that returns [] for getChildren to verify the guard.
    await seedTasks(accessor, [
      {
        id: 'T001',
        title: 'Test Epic',
        type: 'epic',
        status: 'active',
        priority: 'medium',
        acceptance: ['AC1'],
      },
      {
        id: 'T002',
        title: 'Sub 1',
        type: 'task',
        status: 'active',
        priority: 'medium',
        parentId: 'T001',
        acceptance: ['AC1'],
      },
    ]);

    // Create a wrapper accessor that overrides getChildren to return []
    // to simulate the vacuous truth scenario.
    const wrappedAccessor = {
      ...accessor,
      getChildren: async (parentId: string) => {
        if (parentId === 'T001') return []; // Simulate no registered children
        return accessor.getChildren(parentId);
      },
    } as typeof accessor;

    const result = await completeTask({ taskId: 'T002' }, env.tempDir, wrappedAccessor);

    expect(result.task.status).toBe('done');
    // With vacuous truth guard: empty siblings → allDone = false → epic does NOT auto-complete
    expect(result.autoCompleted).toBeUndefined();

    const epic = await accessor.loadSingleTask('T001');
    expect(epic?.status).not.toBe('done');
  });

  it('does NOT auto-complete epic when it has 5 subtasks and only 1 is being completed', async () => {
    await seedTasks(accessor, [
      {
        id: 'T001',
        title: 'Big Epic',
        type: 'epic',
        status: 'active',
        priority: 'medium',
        acceptance: ['AC1'],
      },
      {
        id: 'T002',
        title: 'Sub 1',
        type: 'task',
        status: 'active',
        priority: 'medium',
        parentId: 'T001',
        acceptance: ['AC1'],
      },
      {
        id: 'T003',
        title: 'Sub 2',
        type: 'task',
        status: 'pending',
        priority: 'medium',
        parentId: 'T001',
        acceptance: ['AC1'],
      },
      {
        id: 'T004',
        title: 'Sub 3',
        type: 'task',
        status: 'pending',
        priority: 'medium',
        parentId: 'T001',
        acceptance: ['AC1'],
      },
      {
        id: 'T005',
        title: 'Sub 4',
        type: 'task',
        status: 'pending',
        priority: 'medium',
        parentId: 'T001',
        acceptance: ['AC1'],
      },
      {
        id: 'T006',
        title: 'Sub 5',
        type: 'task',
        status: 'pending',
        priority: 'medium',
        parentId: 'T001',
        acceptance: ['AC1'],
      },
    ]);

    const result = await completeTask({ taskId: 'T002' }, env.tempDir, accessor);

    expect(result.task.status).toBe('done');
    expect(result.autoCompleted).toBeUndefined();

    const epic = await accessor.loadSingleTask('T001');
    expect(epic?.status).not.toBe('done');
  });
});
