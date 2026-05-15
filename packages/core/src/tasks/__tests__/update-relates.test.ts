/**
 * Unit tests for relates mutations in updateTask.
 * @task T9334
 */
import { describe, expect, it } from 'vitest';
import { updateTask } from '../update.js';
import type { DataAccessor } from '../../store/data-accessor.js';
import type { Task } from '@cleocode/contracts';

function makeMockAccessor(task: Task): DataAccessor {
  return {
    loadSingleTask: async () => task,
    upsertSingleTask: async () => {},
    transaction: async (fn) => fn({
      upsertSingleTask: async () => {},
      appendLog: async () => {},
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

describe('updateTask relates mutations', () => {
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
