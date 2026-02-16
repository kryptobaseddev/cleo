/**
 * Tests for task graph operations (dependency waves, critical path, ordering).
 * @task T4627
 * @epic T4454
 */

import { describe, it, expect } from 'vitest';
import {
  computeDependencyWaves,
  getNextTask,
  getCriticalPath,
  getTaskOrder,
  getParallelTasks,
} from '../graph-ops.js';
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

describe('computeDependencyWaves', () => {
  it('computes waves for linear dependency chain', () => {
    const tasks = [
      makeTask({ id: 'T001' }),
      makeTask({ id: 'T002', depends: ['T001'] }),
      makeTask({ id: 'T003', depends: ['T002'] }),
    ];
    const waves = computeDependencyWaves(tasks);
    expect(waves).toHaveLength(3);
    expect(waves[0].taskIds).toEqual(['T001']);
    expect(waves[1].taskIds).toEqual(['T002']);
    expect(waves[2].taskIds).toEqual(['T003']);
  });

  it('groups parallel tasks in same wave', () => {
    const tasks = [
      makeTask({ id: 'T001' }),
      makeTask({ id: 'T002' }),
      makeTask({ id: 'T003', depends: ['T001', 'T002'] }),
    ];
    const waves = computeDependencyWaves(tasks);
    expect(waves).toHaveLength(2);
    expect(waves[0].taskIds.sort()).toEqual(['T001', 'T002']);
    expect(waves[1].taskIds).toEqual(['T003']);
  });

  it('excludes completed/cancelled tasks', () => {
    const tasks = [
      makeTask({ id: 'T001', status: 'done' }),
      makeTask({ id: 'T002', depends: ['T001'] }),
    ];
    const waves = computeDependencyWaves(tasks);
    expect(waves).toHaveLength(1);
    expect(waves[0].taskIds).toEqual(['T002']);
  });

  it('returns empty for all completed tasks', () => {
    const tasks = [
      makeTask({ id: 'T001', status: 'done' }),
      makeTask({ id: 'T002', status: 'cancelled' }),
    ];
    expect(computeDependencyWaves(tasks)).toHaveLength(0);
  });

  it('returns empty for no tasks', () => {
    expect(computeDependencyWaves([])).toHaveLength(0);
  });

  it('handles tasks with cycles by placing them in final wave', () => {
    const tasks = [
      makeTask({ id: 'T001', depends: ['T002'] }),
      makeTask({ id: 'T002', depends: ['T001'] }),
      makeTask({ id: 'T003' }),
    ];
    const waves = computeDependencyWaves(tasks);
    // T003 should be in first wave, cyclic ones in a later wave
    expect(waves.length).toBeGreaterThanOrEqual(1);
    const allIds = waves.flatMap(w => w.taskIds);
    expect(allIds.sort()).toEqual(['T001', 'T002', 'T003']);
  });
});

describe('getNextTask', () => {
  it('returns active task first', () => {
    const tasks = [
      makeTask({ id: 'T001', status: 'pending', priority: 'critical' }),
      makeTask({ id: 'T002', status: 'active', priority: 'low' }),
    ];
    const next = getNextTask(tasks);
    expect(next?.id).toBe('T002');
  });

  it('returns highest priority ready task', () => {
    const tasks = [
      makeTask({ id: 'T001', status: 'pending', priority: 'low' }),
      makeTask({ id: 'T002', status: 'pending', priority: 'critical' }),
      makeTask({ id: 'T003', status: 'pending', priority: 'medium' }),
    ];
    const next = getNextTask(tasks);
    expect(next?.id).toBe('T002');
  });

  it('skips tasks with unmet dependencies', () => {
    const tasks = [
      makeTask({ id: 'T001', status: 'pending', priority: 'critical' }),
      makeTask({ id: 'T002', status: 'pending', priority: 'low', depends: ['T001'] }),
    ];
    const next = getNextTask(tasks);
    expect(next?.id).toBe('T001');
  });

  it('considers completed deps as met', () => {
    const tasks = [
      makeTask({ id: 'T001', status: 'done' }),
      makeTask({ id: 'T002', status: 'pending', depends: ['T001'] }),
    ];
    const next = getNextTask(tasks);
    expect(next?.id).toBe('T002');
  });

  it('returns null when no tasks are ready', () => {
    const tasks = [
      makeTask({ id: 'T001', status: 'done' }),
    ];
    expect(getNextTask(tasks)).toBeNull();
  });

  it('returns null for empty list', () => {
    expect(getNextTask([])).toBeNull();
  });
});

describe('getCriticalPath', () => {
  it('finds longest dependency chain', () => {
    const tasks = [
      makeTask({ id: 'T001' }),
      makeTask({ id: 'T002', depends: ['T001'] }),
      makeTask({ id: 'T003', depends: ['T002'] }),
      makeTask({ id: 'T004' }),
    ];
    const path = getCriticalPath(tasks);
    expect(path).toEqual(['T001', 'T002', 'T003']);
  });

  it('returns empty for no active tasks', () => {
    const tasks = [
      makeTask({ id: 'T001', status: 'done' }),
    ];
    expect(getCriticalPath(tasks)).toEqual([]);
  });

  it('returns empty for empty list', () => {
    expect(getCriticalPath([])).toEqual([]);
  });

  it('returns single task path for independent tasks', () => {
    const tasks = [
      makeTask({ id: 'T001' }),
      makeTask({ id: 'T002' }),
    ];
    const path = getCriticalPath(tasks);
    expect(path).toHaveLength(1);
  });
});

describe('getTaskOrder', () => {
  it('returns topological order', () => {
    const tasks = [
      makeTask({ id: 'T003', depends: ['T002'] }),
      makeTask({ id: 'T001' }),
      makeTask({ id: 'T002', depends: ['T001'] }),
    ];
    const order = getTaskOrder(tasks);
    expect(order.indexOf('T001')).toBeLessThan(order.indexOf('T002'));
    expect(order.indexOf('T002')).toBeLessThan(order.indexOf('T003'));
  });

  it('falls back to priority order on cycles', () => {
    const tasks = [
      makeTask({ id: 'T001', depends: ['T002'], priority: 'low' }),
      makeTask({ id: 'T002', depends: ['T001'], priority: 'critical' }),
    ];
    const order = getTaskOrder(tasks);
    expect(order).toHaveLength(2);
    expect(order[0]).toBe('T002'); // critical first
  });
});

describe('getParallelTasks', () => {
  it('returns first wave of parallel tasks', () => {
    const tasks = [
      makeTask({ id: 'T001' }),
      makeTask({ id: 'T002' }),
      makeTask({ id: 'T003', depends: ['T001'] }),
    ];
    const parallel = getParallelTasks(tasks);
    expect(parallel.sort()).toEqual(['T001', 'T002']);
  });

  it('returns empty for no tasks', () => {
    expect(getParallelTasks([])).toEqual([]);
  });
});
