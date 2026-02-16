/**
 * Tests for dependency checking and graph validation.
 * @task T4627
 * @epic T4454
 */

import { describe, it, expect } from 'vitest';
import {
  detectCircularDeps,
  wouldCreateCycle,
  getBlockedTasks,
  getReadyTasks,
  getDependents,
  getDependentIds,
  getUnresolvedDeps,
  validateDependencyRefs,
  validateDependencies,
  topologicalSort,
} from '../dependency-check.js';
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

describe('detectCircularDeps', () => {
  it('returns empty for no cycle', () => {
    const tasks = [
      makeTask({ id: 'T001' }),
      makeTask({ id: 'T002', depends: ['T001'] }),
    ];
    expect(detectCircularDeps('T001', tasks)).toEqual([]);
  });

  it('detects direct circular dependency', () => {
    const tasks = [
      makeTask({ id: 'T001', depends: ['T002'] }),
      makeTask({ id: 'T002', depends: ['T001'] }),
    ];
    const cycle = detectCircularDeps('T001', tasks);
    expect(cycle.length).toBeGreaterThan(0);
  });

  it('detects indirect circular dependency', () => {
    const tasks = [
      makeTask({ id: 'T001', depends: ['T002'] }),
      makeTask({ id: 'T002', depends: ['T003'] }),
      makeTask({ id: 'T003', depends: ['T001'] }),
    ];
    const cycle = detectCircularDeps('T001', tasks);
    expect(cycle.length).toBeGreaterThan(0);
  });

  it('returns empty for task with no deps', () => {
    const tasks = [makeTask({ id: 'T001' })];
    expect(detectCircularDeps('T001', tasks)).toEqual([]);
  });
});

describe('wouldCreateCycle', () => {
  it('detects would-be cycle', () => {
    const tasks = [
      makeTask({ id: 'T001', depends: ['T002'] }),
      makeTask({ id: 'T002' }),
    ];
    expect(wouldCreateCycle('T002', 'T001', tasks)).toBe(true);
  });

  it('allows non-cyclic dependency', () => {
    const tasks = [
      makeTask({ id: 'T001' }),
      makeTask({ id: 'T002' }),
    ];
    expect(wouldCreateCycle('T002', 'T001', tasks)).toBe(false);
  });
});

describe('getBlockedTasks', () => {
  it('returns tasks with unmet dependencies', () => {
    const tasks = [
      makeTask({ id: 'T001', status: 'pending' }),
      makeTask({ id: 'T002', status: 'pending', depends: ['T001'] }),
      makeTask({ id: 'T003', status: 'pending' }),
    ];
    const blocked = getBlockedTasks(tasks);
    expect(blocked).toHaveLength(1);
    expect(blocked[0].id).toBe('T002');
  });

  it('excludes tasks whose deps are completed', () => {
    const tasks = [
      makeTask({ id: 'T001', status: 'done' }),
      makeTask({ id: 'T002', status: 'pending', depends: ['T001'] }),
    ];
    const blocked = getBlockedTasks(tasks);
    expect(blocked).toHaveLength(0);
  });

  it('excludes completed/cancelled tasks from blocked list', () => {
    const tasks = [
      makeTask({ id: 'T001', status: 'pending' }),
      makeTask({ id: 'T002', status: 'done', depends: ['T001'] }),
      makeTask({ id: 'T003', status: 'cancelled', depends: ['T001'] }),
    ];
    const blocked = getBlockedTasks(tasks);
    expect(blocked).toHaveLength(0);
  });

  it('returns empty for no blocked tasks', () => {
    const tasks = [
      makeTask({ id: 'T001', status: 'pending' }),
      makeTask({ id: 'T002', status: 'pending' }),
    ];
    expect(getBlockedTasks(tasks)).toHaveLength(0);
  });
});

describe('getReadyTasks', () => {
  it('returns tasks with all deps met', () => {
    const tasks = [
      makeTask({ id: 'T001', status: 'done' }),
      makeTask({ id: 'T002', status: 'pending', depends: ['T001'] }),
      makeTask({ id: 'T003', status: 'pending' }),
    ];
    const ready = getReadyTasks(tasks);
    expect(ready).toHaveLength(2);
    expect(ready.map(t => t.id).sort()).toEqual(['T002', 'T003']);
  });

  it('excludes done/cancelled tasks', () => {
    const tasks = [
      makeTask({ id: 'T001', status: 'done' }),
      makeTask({ id: 'T002', status: 'cancelled' }),
    ];
    expect(getReadyTasks(tasks)).toHaveLength(0);
  });

  it('excludes tasks with unmet deps', () => {
    const tasks = [
      makeTask({ id: 'T001', status: 'pending' }),
      makeTask({ id: 'T002', status: 'pending', depends: ['T001'] }),
    ];
    const ready = getReadyTasks(tasks);
    expect(ready).toHaveLength(1);
    expect(ready[0].id).toBe('T001');
  });
});

describe('getDependents / getDependentIds', () => {
  const tasks = [
    makeTask({ id: 'T001' }),
    makeTask({ id: 'T002', depends: ['T001'] }),
    makeTask({ id: 'T003', depends: ['T001'] }),
    makeTask({ id: 'T004', depends: ['T002'] }),
  ];

  it('returns tasks that depend on a given task', () => {
    const deps = getDependents('T001', tasks);
    expect(deps).toHaveLength(2);
    expect(deps.map(t => t.id).sort()).toEqual(['T002', 'T003']);
  });

  it('returns dependent IDs', () => {
    expect(getDependentIds('T001', tasks).sort()).toEqual(['T002', 'T003']);
  });

  it('returns empty for tasks with no dependents', () => {
    expect(getDependents('T004', tasks)).toHaveLength(0);
  });
});

describe('getUnresolvedDeps', () => {
  it('returns unresolved deps', () => {
    const tasks = [
      makeTask({ id: 'T001', status: 'pending' }),
      makeTask({ id: 'T002', status: 'done' }),
      makeTask({ id: 'T003', status: 'pending', depends: ['T001', 'T002'] }),
    ];
    expect(getUnresolvedDeps('T003', tasks)).toEqual(['T001']);
  });

  it('returns empty when all deps resolved', () => {
    const tasks = [
      makeTask({ id: 'T001', status: 'done' }),
      makeTask({ id: 'T002', status: 'pending', depends: ['T001'] }),
    ];
    expect(getUnresolvedDeps('T002', tasks)).toEqual([]);
  });

  it('returns empty for tasks with no deps', () => {
    const tasks = [makeTask({ id: 'T001', status: 'pending' })];
    expect(getUnresolvedDeps('T001', tasks)).toEqual([]);
  });
});

describe('validateDependencyRefs', () => {
  it('detects missing dependency references', () => {
    const tasks = [
      makeTask({ id: 'T001', depends: ['T999'] }),
    ];
    const errors = validateDependencyRefs(tasks);
    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe('E_DEP_NOT_FOUND');
  });

  it('passes when all refs exist', () => {
    const tasks = [
      makeTask({ id: 'T001' }),
      makeTask({ id: 'T002', depends: ['T001'] }),
    ];
    expect(validateDependencyRefs(tasks)).toHaveLength(0);
  });
});

describe('validateDependencies', () => {
  it('validates clean dependency graph', () => {
    const tasks = [
      makeTask({ id: 'T001' }),
      makeTask({ id: 'T002', depends: ['T001'] }),
    ];
    const result = validateDependencies(tasks);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('detects self-dependency', () => {
    const tasks = [
      makeTask({ id: 'T001', depends: ['T001'] }),
    ];
    const result = validateDependencies(tasks);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.code === 'E_SELF_DEP')).toBe(true);
  });

  it('detects circular dependencies', () => {
    const tasks = [
      makeTask({ id: 'T001', depends: ['T002'] }),
      makeTask({ id: 'T002', depends: ['T001'] }),
    ];
    const result = validateDependencies(tasks);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.code === 'E_CIRCULAR_DEP')).toBe(true);
  });

  it('warns about completed tasks with unmet deps', () => {
    const tasks = [
      makeTask({ id: 'T001', status: 'pending' }),
      makeTask({ id: 'T002', status: 'done', depends: ['T001'] }),
    ];
    const result = validateDependencies(tasks);
    expect(result.valid).toBe(true);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0].code).toBe('W_COMPLETED_WITH_UNMET_DEPS');
  });
});

describe('topologicalSort', () => {
  it('sorts tasks in dependency order', () => {
    const tasks = [
      makeTask({ id: 'T003', depends: ['T002'] }),
      makeTask({ id: 'T001' }),
      makeTask({ id: 'T002', depends: ['T001'] }),
    ];
    const sorted = topologicalSort(tasks);
    expect(sorted).not.toBeNull();
    expect(sorted!.indexOf('T001')).toBeLessThan(sorted!.indexOf('T002'));
    expect(sorted!.indexOf('T002')).toBeLessThan(sorted!.indexOf('T003'));
  });

  it('returns null for cyclic graph', () => {
    const tasks = [
      makeTask({ id: 'T001', depends: ['T002'] }),
      makeTask({ id: 'T002', depends: ['T001'] }),
    ];
    expect(topologicalSort(tasks)).toBeNull();
  });

  it('handles tasks with no dependencies', () => {
    const tasks = [
      makeTask({ id: 'T001' }),
      makeTask({ id: 'T002' }),
    ];
    const sorted = topologicalSort(tasks);
    expect(sorted).not.toBeNull();
    expect(sorted).toHaveLength(2);
  });

  it('handles empty list', () => {
    expect(topologicalSort([])).toEqual([]);
  });
});
