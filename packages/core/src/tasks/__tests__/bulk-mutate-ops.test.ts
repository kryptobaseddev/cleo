/**
 * Unit tests for the T11786 bulk task mutate ops Studio's Kanban binds to:
 * `coreTaskReorderRank`, `coreTaskBulkMove`, `coreTaskAssignee`.
 *
 * Exercises each core op against a mocked {@link getTaskAccessor} (no real DB)
 * so the tests stay fast + deterministic and cover the contract surface:
 *   - reorder-rank: full-order re-rank, position = 1-based index, skips unknown IDs
 *   - bulk-move: atomic transaction, valid-status guard, missing-ID abort
 *   - assignee: set vs clear (null / empty), not-found error
 *
 * @task T11786
 * @epic T11556
 */

import type { Task } from '@cleocode/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../store/data-accessor.js', () => ({
  getAccessor: vi.fn(),
  getTaskAccessor: vi.fn(),
}));

import { getTaskAccessor } from '../../store/data-accessor.js';
import { coreTaskAssignee, coreTaskBulkMove, coreTaskReorderRank } from '../task-reparent.js';

function makeTask(overrides: Partial<Task> & { id: string; title: string }): Task {
  return {
    description: `Description for ${overrides.id}`,
    status: 'pending',
    priority: 'medium',
    createdAt: new Date().toISOString(),
    updatedAt: null,
    depends: [],
    ...overrides,
  } as Task;
}

/**
 * Install a mock task accessor whose `transaction(fn)` invokes `fn` with a tx
 * accessor sharing the same `updateTaskFields` / `appendLog` spies, so a test
 * can assert what the transaction wrote.
 */
function setupAccessor(
  tasks: Task[],
  spies: {
    updateTaskFields?: ReturnType<typeof vi.fn>;
    appendLog?: ReturnType<typeof vi.fn>;
  } = {},
): { updateTaskFields: ReturnType<typeof vi.fn>; appendLog: ReturnType<typeof vi.fn> } {
  const updateTaskFields = spies.updateTaskFields ?? vi.fn().mockResolvedValue(undefined);
  const appendLog = spies.appendLog ?? vi.fn().mockResolvedValue(undefined);
  const tx = { updateTaskFields, appendLog };
  const mockImpl = {
    loadSingleTask: vi
      .fn()
      .mockImplementation(async (id: string) => tasks.find((t) => t.id === id) ?? null),
    updateTaskFields,
    appendLog,
    transaction: vi
      .fn()
      .mockImplementation(async (fn: (txArg: typeof tx) => Promise<unknown>) => fn(tx)),
  };
  (getTaskAccessor as ReturnType<typeof vi.fn>).mockResolvedValue(mockImpl);
  return { updateTaskFields, appendLog };
}

describe('coreTaskReorderRank (T11786)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('writes position = 1-based index for the full requested order', async () => {
    const { updateTaskFields } = setupAccessor([
      makeTask({ id: 'T1', title: 'one', position: 1 }),
      makeTask({ id: 'T2', title: 'two', position: 2 }),
      makeTask({ id: 'T3', title: 'three', position: 3 }),
    ]);

    const result = await coreTaskReorderRank('/mock', ['T3', 'T1', 'T2']);

    expect(result.ranked).toEqual(['T3', 'T1', 'T2']);
    expect(result.skipped).toEqual([]);
    expect(result.count).toBe(3);
    expect(updateTaskFields).toHaveBeenCalledWith('T3', expect.objectContaining({ position: 1 }));
    expect(updateTaskFields).toHaveBeenCalledWith('T1', expect.objectContaining({ position: 2 }));
    expect(updateTaskFields).toHaveBeenCalledWith('T2', expect.objectContaining({ position: 3 }));
  });

  it('bumps positionVersion for optimistic concurrency', async () => {
    const { updateTaskFields } = setupAccessor([
      makeTask({ id: 'T1', title: 'one', position: 1, positionVersion: 4 }),
    ]);
    await coreTaskReorderRank('/mock', ['T1']);
    expect(updateTaskFields).toHaveBeenCalledWith(
      'T1',
      expect.objectContaining({ positionVersion: 5 }),
    );
  });

  it('collects unknown IDs in skipped without failing the batch', async () => {
    setupAccessor([makeTask({ id: 'T1', title: 'one' })]);
    const result = await coreTaskReorderRank('/mock', ['T1', 'T-missing']);
    expect(result.ranked).toEqual(['T1']);
    expect(result.skipped).toEqual(['T-missing']);
    expect(result.count).toBe(1);
  });
});

describe('coreTaskBulkMove (T11786)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('atomically applies the status to every task in one transaction', async () => {
    const { updateTaskFields, appendLog } = setupAccessor([
      makeTask({ id: 'T1', title: 'one' }),
      makeTask({ id: 'T2', title: 'two' }),
    ]);

    const result = await coreTaskBulkMove('/mock', ['T1', 'T2'], { status: 'active' });

    expect(result.moved).toEqual(['T1', 'T2']);
    expect(result.status).toBe('active');
    expect(result.count).toBe(2);
    expect(updateTaskFields).toHaveBeenCalledWith(
      'T1',
      expect.objectContaining({ status: 'active' }),
    );
    expect(updateTaskFields).toHaveBeenCalledWith(
      'T2',
      expect.objectContaining({ status: 'active' }),
    );
    expect(appendLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'task_bulk_moved' }));
  });

  it('applies pipelineStage when supplied', async () => {
    const { updateTaskFields } = setupAccessor([makeTask({ id: 'T1', title: 'one' })]);
    const result = await coreTaskBulkMove('/mock', ['T1'], { pipelineStage: 'testing' });
    expect(result.pipelineStage).toBe('testing');
    expect(updateTaskFields).toHaveBeenCalledWith(
      'T1',
      expect.objectContaining({ pipelineStage: 'testing' }),
    );
  });

  it('rejects an empty target (no status and no stage)', async () => {
    setupAccessor([makeTask({ id: 'T1', title: 'one' })]);
    await expect(coreTaskBulkMove('/mock', ['T1'], {})).rejects.toThrow(
      /status and\/or pipelineStage/,
    );
  });

  it('rejects an invalid status', async () => {
    setupAccessor([makeTask({ id: 'T1', title: 'one' })]);
    await expect(coreTaskBulkMove('/mock', ['T1'], { status: 'nope' })).rejects.toThrow(
      /Invalid status/,
    );
  });

  it('aborts the whole move when any task ID is missing', async () => {
    const { updateTaskFields } = setupAccessor([makeTask({ id: 'T1', title: 'one' })]);
    await expect(
      coreTaskBulkMove('/mock', ['T1', 'T-missing'], { status: 'done' }),
    ).rejects.toThrow(/not found/);
    // No write happened — the missing ID is caught BEFORE the transaction opens.
    expect(updateTaskFields).not.toHaveBeenCalled();
  });

  it('rejects an empty task list', async () => {
    setupAccessor([]);
    await expect(coreTaskBulkMove('/mock', [], { status: 'done' })).rejects.toThrow(
      /at least one task ID/,
    );
  });
});

describe('coreTaskAssignee (T11786)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sets a non-empty assignee', async () => {
    const { updateTaskFields } = setupAccessor([makeTask({ id: 'T1', title: 'one' })]);
    const result = await coreTaskAssignee('/mock', 'T1', 'alice');
    expect(result).toEqual({ taskId: 'T1', assignee: 'alice', assigned: true });
    expect(updateTaskFields).toHaveBeenCalledWith(
      'T1',
      expect.objectContaining({ assignee: 'alice' }),
    );
  });

  it('clears the assignee when passed null', async () => {
    const { updateTaskFields } = setupAccessor([
      makeTask({ id: 'T1', title: 'one', assignee: 'bob' }),
    ]);
    const result = await coreTaskAssignee('/mock', 'T1', null);
    expect(result).toEqual({ taskId: 'T1', assignee: null, assigned: false });
    expect(updateTaskFields).toHaveBeenCalledWith(
      'T1',
      expect.objectContaining({ assignee: null }),
    );
  });

  it('treats an empty string as clear', async () => {
    setupAccessor([makeTask({ id: 'T1', title: 'one', assignee: 'bob' })]);
    const result = await coreTaskAssignee('/mock', 'T1', '');
    expect(result.assignee).toBeNull();
    expect(result.assigned).toBe(false);
  });

  it('throws when the task does not exist', async () => {
    setupAccessor([]);
    await expect(coreTaskAssignee('/mock', 'T-missing', 'alice')).rejects.toThrow(/not found/);
  });
});
