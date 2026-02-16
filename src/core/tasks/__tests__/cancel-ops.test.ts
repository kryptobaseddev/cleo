/**
 * Tests for task cancellation operations.
 * @task T4627
 * @epic T4454
 */

import { describe, it, expect } from 'vitest';
import { canCancel, cancelTask, cancelMultiple } from '../cancel-ops.js';
import type { Task } from '../../../types/task.js';

function makeTask(overrides: Partial<Task> & { id: string }): Task {
  return {
    title: `Task ${overrides.id}`,
    status: 'pending',
    priority: 'medium',
    createdAt: new Date().toISOString(),
    ...overrides,
  } as Task;
}

describe('canCancel', () => {
  it('allows cancelling pending tasks', () => {
    const result = canCancel(makeTask({ id: 'T001', status: 'pending' }));
    expect(result.allowed).toBe(true);
  });

  it('allows cancelling active tasks', () => {
    const result = canCancel(makeTask({ id: 'T001', status: 'active' }));
    expect(result.allowed).toBe(true);
  });

  it('allows cancelling blocked tasks', () => {
    const result = canCancel(makeTask({ id: 'T001', status: 'blocked' }));
    expect(result.allowed).toBe(true);
  });

  it('disallows cancelling completed tasks', () => {
    const result = canCancel(makeTask({ id: 'T001', status: 'done' }));
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('completed');
  });

  it('disallows cancelling already cancelled tasks', () => {
    const result = canCancel(makeTask({ id: 'T001', status: 'cancelled' }));
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('already cancelled');
  });
});

describe('cancelTask', () => {
  it('cancels a pending task', () => {
    const tasks = [makeTask({ id: 'T001', status: 'pending' })];
    const { tasks: updated, result } = cancelTask('T001', tasks, 'No longer needed');
    expect(result.success).toBe(true);
    expect(result.taskId).toBe('T001');
    expect(result.reason).toBe('No longer needed');
    expect(result.cancelledAt).toBeDefined();
    expect(updated[0].status).toBe('cancelled');
  });

  it('fails for nonexistent task', () => {
    const tasks = [makeTask({ id: 'T001' })];
    const { result } = cancelTask('T999', tasks);
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('E_NOT_FOUND');
  });

  it('fails for completed task', () => {
    const tasks = [makeTask({ id: 'T001', status: 'done' })];
    const { result } = cancelTask('T001', tasks);
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('E_CANNOT_CANCEL');
  });

  it('sets cancellationReason and timestamp', () => {
    const tasks = [makeTask({ id: 'T001', status: 'active' })];
    const { tasks: updated } = cancelTask('T001', tasks, 'Duplicate');
    const cancelled = updated.find(t => t.id === 'T001')!;
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.cancelledAt).toBeDefined();
    expect(cancelled.cancellationReason).toBe('Duplicate');
    expect(cancelled.updatedAt).toBeDefined();
  });

  it('does not modify other tasks', () => {
    const tasks = [
      makeTask({ id: 'T001', status: 'pending' }),
      makeTask({ id: 'T002', status: 'pending' }),
    ];
    const { tasks: updated } = cancelTask('T001', tasks);
    expect(updated.find(t => t.id === 'T002')!.status).toBe('pending');
  });

  it('cancels without reason', () => {
    const tasks = [makeTask({ id: 'T001', status: 'pending' })];
    const { tasks: updated, result } = cancelTask('T001', tasks);
    expect(result.success).toBe(true);
    expect(updated[0].cancellationReason).toBeUndefined();
  });
});

describe('cancelMultiple', () => {
  it('cancels multiple tasks', () => {
    const tasks = [
      makeTask({ id: 'T001', status: 'pending' }),
      makeTask({ id: 'T002', status: 'active' }),
      makeTask({ id: 'T003', status: 'pending' }),
    ];
    const { tasks: updated, results } = cancelMultiple(['T001', 'T002'], tasks, 'Batch cancel');
    expect(results).toHaveLength(2);
    expect(results.every(r => r.success)).toBe(true);
    expect(updated.filter(t => t.status === 'cancelled')).toHaveLength(2);
    expect(updated.find(t => t.id === 'T003')!.status).toBe('pending');
  });

  it('partially succeeds when some tasks cannot be cancelled', () => {
    const tasks = [
      makeTask({ id: 'T001', status: 'pending' }),
      makeTask({ id: 'T002', status: 'done' }),
    ];
    const { results } = cancelMultiple(['T001', 'T002'], tasks);
    expect(results[0].success).toBe(true);
    expect(results[1].success).toBe(false);
  });

  it('handles empty ID list', () => {
    const tasks = [makeTask({ id: 'T001' })];
    const { results } = cancelMultiple([], tasks);
    expect(results).toHaveLength(0);
  });
});
