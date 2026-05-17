/**
 * Tests for relates mutations in updateTask.
 *
 * Two suites:
 *  1. Unit tests with mock accessor — verify in-memory relates array is updated.
 *  2. Integration tests with real SQLite — verify task_relations table is written
 *     (regression for T9514: --relates/--add-relates were a no-op before this fix).
 *
 * @task T9334
 * @task T9514
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Task } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DataAccessor } from '../../store/data-accessor.js';
import { createSqliteDataAccessor } from '../../store/sqlite-data-accessor.js';
import { updateTask } from '../update.js';

// ---------------------------------------------------------------------------
// Unit tests (mock accessor — validates in-memory task.relates mutations)
// ---------------------------------------------------------------------------

function makeMockAccessor(task: Task): DataAccessor {
  return {
    loadSingleTask: async () => task,
    upsertSingleTask: async () => {},
    transaction: async (fn) =>
      fn({
        upsertSingleTask: async () => {},
        appendLog: async () => {},
        addRelation: async () => {},
        removeRelation: async () => {},
        clearRelations: async () => {},
      } as unknown as Parameters<Parameters<DataAccessor['transaction']>[0]>[0]),
    getSubtree: async () => [],
    getAncestorChain: async () => [],
  } as unknown as DataAccessor;
}

function makeTask(overrides?: Partial<Task>): Task {
  return {
    id: 'T001',
    title: 'Test task',
    status: 'pending',
    priority: 'medium',
    type: 'task',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as Task;
}

describe('updateTask relates mutations (unit — mock accessor)', () => {
  it('sets relates replacing existing', async () => {
    const task = makeTask({ relates: [{ taskId: 'T002', type: 'related' }] });
    const accessor = makeMockAccessor(task);
    const result = await updateTask(
      {
        taskId: 'T001',
        relates: [{ taskId: 'T003', type: 'blocks' }],
      },
      undefined,
      accessor,
    );
    expect(result.changes).toContain('relates');
    expect(result.task.relates).toHaveLength(1);
    expect(result.task.relates![0]).toEqual({ taskId: 'T003', type: 'blocks' });
  });

  it('adds relates without overwriting', async () => {
    const task = makeTask({ relates: [{ taskId: 'T002', type: 'related' }] });
    const accessor = makeMockAccessor(task);
    const result = await updateTask(
      {
        taskId: 'T001',
        addRelates: [{ taskId: 'T003', type: 'blocks' }],
      },
      undefined,
      accessor,
    );
    expect(result.changes).toContain('relates');
    expect(result.task.relates).toHaveLength(2);
    expect(result.task.relates!.map((r) => r.taskId).sort()).toEqual(['T002', 'T003']);
  });

  it('removes relates by taskId', async () => {
    const task = makeTask({
      relates: [
        { taskId: 'T002', type: 'related' },
        { taskId: 'T003', type: 'blocks' },
      ],
    });
    const accessor = makeMockAccessor(task);
    const result = await updateTask(
      {
        taskId: 'T001',
        removeRelates: ['T002'],
      },
      undefined,
      accessor,
    );
    expect(result.changes).toContain('relates');
    expect(result.task.relates).toHaveLength(1);
    expect(result.task.relates![0].taskId).toBe('T003');
  });

  it('preserves reason field', async () => {
    const task = makeTask();
    const accessor = makeMockAccessor(task);
    const result = await updateTask(
      {
        taskId: 'T001',
        relates: [{ taskId: 'T003', type: 'blocks', reason: 'blocks execution' }],
      },
      undefined,
      accessor,
    );
    expect(result.task.relates![0].reason).toBe('blocks execution');
  });
});

// ---------------------------------------------------------------------------
// Integration tests (real SQLite — regression for T9514)
//
// These tests prove that task_relations rows are actually written to the DB,
// not just updated in memory. Pre-fix these would pass on changes[] but
// loadSingleTask after update would return relates: [].
// ---------------------------------------------------------------------------

describe('updateTask relates persistence (integration — real SQLite, T9514)', () => {
  let testDir: string;
  let accessor: Awaited<ReturnType<typeof createSqliteDataAccessor>>;

  const seedTask = async (id: string, title: string): Promise<void> => {
    const t: Task = {
      id,
      title,
      status: 'pending',
      priority: 'medium',
      type: 'task',
      createdAt: new Date().toISOString(),
    };
    await accessor.upsertSingleTask(t);
  };

  beforeEach(async () => {
    testDir = mkdtempSync(join(tmpdir(), 'cleo-update-relates-T9514-'));
    accessor = await createSqliteDataAccessor(testDir);
    // Seed three tasks so relates targets are valid
    await seedTask('T001', 'Source task');
    await seedTask('T002', 'Target task A');
    await seedTask('T003', 'Target task B');
  });

  afterEach(async () => {
    await accessor.close();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('--relates persists rows to task_relations (regression T9514)', async () => {
    // Pre-fix: this would succeed but loadSingleTask after would return relates:[]
    await updateTask(
      {
        taskId: 'T001',
        relates: [{ taskId: 'T002', type: 'blocks', reason: 'T001 blocks T002' }],
      },
      testDir,
      accessor,
    );

    const reloaded = await accessor.loadSingleTask('T001');
    expect(reloaded?.relates).toBeDefined();
    expect(reloaded!.relates).toHaveLength(1);
    expect(reloaded!.relates![0]).toEqual({
      taskId: 'T002',
      type: 'blocks',
      reason: 'T001 blocks T002',
    });
  });

  it('--add-relates appends without overwriting existing rows (regression T9514)', async () => {
    // First add one relation via --relates
    await updateTask(
      {
        taskId: 'T001',
        relates: [{ taskId: 'T002', type: 'related' }],
      },
      testDir,
      accessor,
    );

    // Now append a second via --add-relates
    await updateTask(
      {
        taskId: 'T001',
        addRelates: [{ taskId: 'T003', type: 'blocks' }],
      },
      testDir,
      accessor,
    );

    const reloaded = await accessor.loadSingleTask('T001');
    expect(reloaded!.relates).toHaveLength(2);
    expect(reloaded!.relates!.map((r) => r.taskId).sort()).toEqual(['T002', 'T003']);
  });

  it('--relates replaces all existing rows (set-replace semantics)', async () => {
    // Seed an existing relation
    await updateTask(
      {
        taskId: 'T001',
        relates: [{ taskId: 'T002', type: 'related' }],
      },
      testDir,
      accessor,
    );

    // Replace with a new set — T002 should be gone
    await updateTask(
      {
        taskId: 'T001',
        relates: [{ taskId: 'T003', type: 'blocks' }],
      },
      testDir,
      accessor,
    );

    const reloaded = await accessor.loadSingleTask('T001');
    expect(reloaded!.relates).toHaveLength(1);
    expect(reloaded!.relates![0].taskId).toBe('T003');
  });

  it('persists across accessor restart (DB survives session boundary)', async () => {
    await updateTask(
      {
        taskId: 'T001',
        relates: [{ taskId: 'T002', type: 'fixes', reason: 'fix reason' }],
      },
      testDir,
      accessor,
    );

    // Close and reopen — proves the row is in the DB, not just in memory
    await accessor.close();
    accessor = await createSqliteDataAccessor(testDir);

    const reloaded = await accessor.loadSingleTask('T001');
    expect(reloaded!.relates).toHaveLength(1);
    expect(reloaded!.relates![0]).toEqual({ taskId: 'T002', type: 'fixes', reason: 'fix reason' });
  });
});
