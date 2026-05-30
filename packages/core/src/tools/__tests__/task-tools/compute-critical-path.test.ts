import type { CriticalPathEdge, CriticalPathNode } from '@cleocode/contracts';
import { describe, expect, it } from 'vitest';
import { computeCriticalPath } from '../../../task-tools/compute-critical-path.js';

describe('computeCriticalPath', () => {
  it('finds the longest path in a linear chain', () => {
    const nodes: CriticalPathNode[] = [
      { id: 'T1', title: 'Step 1', status: 'done', depends: [] },
      { id: 'T2', title: 'Step 2', status: 'pending', depends: ['T1'] },
      { id: 'T3', title: 'Step 3', status: 'pending', depends: ['T2'] },
    ];
    const edges: CriticalPathEdge[] = [
      { from: 'T1', to: 'T2' },
      { from: 'T2', to: 'T3' },
    ];

    const { path, length } = computeCriticalPath(nodes, edges, 'E1');
    expect(path).toEqual(['T1', 'T2', 'T3']);
    expect(length).toBe(3);
  });

  it('selects the longer branch in a forked graph', () => {
    // T1 → T2 (short branch)
    // T1 → T3 → T4 (long branch)
    const nodes: CriticalPathNode[] = [
      { id: 'T1', title: 'Root', status: 'done', depends: [] },
      { id: 'T2', title: 'Short', status: 'pending', depends: ['T1'] },
      { id: 'T3', title: 'Mid', status: 'pending', depends: ['T1'] },
      { id: 'T4', title: 'Long End', status: 'pending', depends: ['T3'] },
    ];
    const edges: CriticalPathEdge[] = [
      { from: 'T1', to: 'T2' },
      { from: 'T1', to: 'T3' },
      { from: 'T3', to: 'T4' },
    ];

    const { path, length } = computeCriticalPath(nodes, edges, 'E1');
    expect(path).toEqual(['T1', 'T3', 'T4']);
    expect(length).toBe(3);
  });

  it('returns empty path for a graph with a cycle', () => {
    // T1 → T2 → T1 (cycle)
    const nodes: CriticalPathNode[] = [
      { id: 'T1', title: 'A', status: 'pending', depends: ['T2'] },
      { id: 'T2', title: 'B', status: 'pending', depends: ['T1'] },
    ];
    const edges: CriticalPathEdge[] = [
      { from: 'T1', to: 'T2' },
      { from: 'T2', to: 'T1' },
    ];

    const { path, length } = computeCriticalPath(nodes, edges, 'E1');
    expect(path).toEqual([]);
    expect(length).toBe(0);
  });

  it('never selects epicId as the end-node — path always terminates at a leaf task', () => {
    // Linear chain E1 → T1 → T2 (scoped set)
    // Without exclusion, E1 has longest=1 — but T2 has longest=3.
    // With epicId exclusion, end node is T2. E1 may appear as the path start.
    const nodes: CriticalPathNode[] = [
      { id: 'E1', title: 'Epic', status: 'active', depends: [] },
      { id: 'T1', title: 'Task 1', status: 'pending', depends: ['E1'] },
      { id: 'T2', title: 'Task 2', status: 'pending', depends: ['T1'] },
    ];
    const edges: CriticalPathEdge[] = [
      { from: 'E1', to: 'T1' },
      { from: 'T1', to: 'T2' },
    ];

    const { path, length } = computeCriticalPath(nodes, edges, 'E1');
    // Path ends at T2, not E1
    expect(path[path.length - 1]).toBe('T2');
    // Full chain is traced: E1 → T1 → T2
    expect(length).toBe(3);
  });
});
