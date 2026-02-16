/**
 * Tests for topological sort (import-sort.ts).
 * @task T4552
 * @epic T4545
 */

import { describe, it, expect } from 'vitest';
import { topologicalSortTasks, detectCycles } from '../import-sort.js';
import type { SortableTask } from '../import-sort.js';

describe('topologicalSortTasks', () => {
  it('should return empty array for empty input', () => {
    expect(topologicalSortTasks([])).toEqual([]);
  });

  it('should handle single task', () => {
    const tasks: SortableTask[] = [
      { id: 'T001', parentId: null, depends: [] },
    ];
    expect(topologicalSortTasks(tasks)).toEqual(['T001']);
  });

  it('should sort linear dependency chain correctly', () => {
    const tasks: SortableTask[] = [
      { id: 'T001', parentId: null, depends: [] },
      { id: 'T002', parentId: 'T001', depends: [] },
      { id: 'T003', parentId: 'T002', depends: ['T001'] },
    ];
    const order = topologicalSortTasks(tasks);

    // T001 must come before T002 and T003
    expect(order.indexOf('T001')).toBeLessThan(order.indexOf('T002'));
    expect(order.indexOf('T001')).toBeLessThan(order.indexOf('T003'));
    expect(order.indexOf('T002')).toBeLessThan(order.indexOf('T003'));
  });

  it('should handle diamond dependency correctly', () => {
    const tasks: SortableTask[] = [
      { id: 'T001', parentId: null, depends: [] },
      { id: 'T002', parentId: 'T001', depends: [] },
      { id: 'T003', parentId: 'T001', depends: [] },
      { id: 'T004', parentId: null, depends: ['T002', 'T003'] },
    ];
    const order = topologicalSortTasks(tasks);

    expect(order.indexOf('T001')).toBeLessThan(order.indexOf('T002'));
    expect(order.indexOf('T001')).toBeLessThan(order.indexOf('T003'));
    expect(order.indexOf('T002')).toBeLessThan(order.indexOf('T004'));
    expect(order.indexOf('T003')).toBeLessThan(order.indexOf('T004'));
  });

  it('should handle independent tasks (any order valid)', () => {
    const tasks: SortableTask[] = [
      { id: 'T001', parentId: null, depends: [] },
      { id: 'T002', parentId: null, depends: [] },
      { id: 'T003', parentId: null, depends: [] },
    ];
    const order = topologicalSortTasks(tasks);

    expect(order).toHaveLength(3);
    expect(order).toContain('T001');
    expect(order).toContain('T002');
    expect(order).toContain('T003');
  });

  it('should detect cycles and throw CleoError', () => {
    const tasks: SortableTask[] = [
      { id: 'T001', parentId: 'T002', depends: [] },
      { id: 'T002', parentId: 'T001', depends: [] },
    ];

    expect(() => topologicalSortTasks(tasks)).toThrow('Cycle detected');
  });

  it('should handle complex hierarchy with cross-dependencies', () => {
    const tasks: SortableTask[] = [
      { id: 'T001', parentId: null, depends: [] },
      { id: 'T002', parentId: 'T001', depends: [] },
      { id: 'T003', parentId: 'T001', depends: ['T002'] },
      { id: 'T004', parentId: 'T002', depends: [] },
      { id: 'T005', parentId: 'T003', depends: ['T004'] },
    ];
    const order = topologicalSortTasks(tasks);

    expect(order.indexOf('T001')).toBeLessThan(order.indexOf('T002'));
    expect(order.indexOf('T002')).toBeLessThan(order.indexOf('T003'));
    expect(order.indexOf('T002')).toBeLessThan(order.indexOf('T004'));
    expect(order.indexOf('T003')).toBeLessThan(order.indexOf('T005'));
    expect(order.indexOf('T004')).toBeLessThan(order.indexOf('T005'));
  });

  it('should ignore external dependencies (not in the set)', () => {
    const tasks: SortableTask[] = [
      { id: 'T001', parentId: null, depends: ['T999'] }, // T999 not in set
      { id: 'T002', parentId: 'T001', depends: [] },
    ];
    const order = topologicalSortTasks(tasks);

    expect(order).toHaveLength(2);
    expect(order.indexOf('T001')).toBeLessThan(order.indexOf('T002'));
  });

  it('should handle tasks with undefined parentId and depends', () => {
    const tasks: SortableTask[] = [
      { id: 'T001' },
      { id: 'T002' },
    ];
    const order = topologicalSortTasks(tasks);
    expect(order).toHaveLength(2);
  });
});

describe('detectCycles', () => {
  it('should return true for acyclic graph', () => {
    const tasks: SortableTask[] = [
      { id: 'T001', parentId: null, depends: [] },
      { id: 'T002', parentId: 'T001', depends: [] },
    ];
    expect(detectCycles(tasks)).toBe(true);
  });

  it('should return false for cyclic graph', () => {
    const tasks: SortableTask[] = [
      { id: 'T001', parentId: 'T002', depends: [] },
      { id: 'T002', parentId: 'T001', depends: [] },
    ];
    expect(detectCycles(tasks)).toBe(false);
  });

  it('should return true for empty input', () => {
    expect(detectCycles([])).toBe(true);
  });
});
