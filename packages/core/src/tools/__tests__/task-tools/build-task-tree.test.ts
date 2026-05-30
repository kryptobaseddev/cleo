import type { BuildTaskTreeInput } from '@cleocode/contracts';
import { describe, expect, it } from 'vitest';
import { buildTaskTree } from '../../../task-tools/build-task-tree.js';

const BASE_TASKS: BuildTaskTreeInput[] = [
  {
    id: 'E1',
    title: 'Epic',
    status: 'active',
    priority: 'high',
    parentId: null,
  },
  {
    id: 'T1',
    title: 'Task A',
    status: 'done',
    priority: 'medium',
    parentId: 'E1',
    position: 1,
    depends: [],
  },
  {
    id: 'T2',
    title: 'Task B',
    status: 'pending',
    priority: 'high',
    parentId: 'E1',
    position: 2,
    depends: ['T1'],
  },
  {
    id: 'T3',
    title: 'Subtask B1',
    status: 'pending',
    priority: 'low',
    parentId: 'T2',
    position: 1,
    depends: [],
  },
];

describe('buildTaskTree', () => {
  it('builds a full tree from flat tasks with correct parent-child relationships', () => {
    const { tree, totalNodes } = buildTaskTree(BASE_TASKS);

    expect(tree).toHaveLength(1); // E1 is the only root
    const epic = tree[0];
    expect(epic.id).toBe('E1');
    expect(epic.children).toHaveLength(2); // T1 and T2
    expect(epic.children[0].id).toBe('T1');
    expect(epic.children[1].id).toBe('T2');
    expect(epic.children[1].children[0].id).toBe('T3');
    expect(totalNodes).toBe(4);
  });

  it('computes blockedBy and ready fields correctly', () => {
    const { tree } = buildTaskTree(BASE_TASKS);
    const epic = tree[0];
    const t1 = epic.children[0]; // done — not blocked
    const t2 = epic.children[1]; // pending, depends on done T1 — should be ready

    expect(t1.blockedBy).toEqual([]);
    expect(t1.ready).toBe(false); // status is 'done', not actionable

    expect(t2.depends).toEqual(['T1']);
    expect(t2.blockedBy).toEqual([]); // T1 is done
    expect(t2.ready).toBe(true);
  });

  it('scopes to a subtree when rootId is provided', () => {
    const { tree, totalNodes } = buildTaskTree(BASE_TASKS, 'T2');

    expect(tree).toHaveLength(1);
    expect(tree[0].id).toBe('T2');
    expect(tree[0].children).toHaveLength(1);
    expect(totalNodes).toBe(2); // T2 + T3
  });

  it('annotates nodes with blockerChain when withBlockers=true', () => {
    const tasks: BuildTaskTreeInput[] = [
      { id: 'A', title: 'A', status: 'pending', priority: 'medium', depends: ['B'] },
      { id: 'B', title: 'B', status: 'pending', priority: 'medium', depends: [] },
    ];
    const { tree } = buildTaskTree(tasks, undefined, { withBlockers: true });
    const nodeA = tree.find((n) => n.id === 'A')!;

    expect(nodeA.blockerChain).toBeDefined();
    expect(nodeA.blockerChain).toContain('B');
    expect(nodeA.leafBlockers).toBeDefined();
    expect(nodeA.leafBlockers).toContain('B');
  });

  it('sorts children by position ascending', () => {
    const tasks: BuildTaskTreeInput[] = [
      { id: 'P', title: 'Parent', status: 'active', priority: 'high' },
      { id: 'C3', title: 'C3', status: 'pending', priority: 'low', parentId: 'P', position: 3 },
      { id: 'C1', title: 'C1', status: 'pending', priority: 'low', parentId: 'P', position: 1 },
      { id: 'C2', title: 'C2', status: 'pending', priority: 'low', parentId: 'P', position: 2 },
    ];
    const { tree } = buildTaskTree(tasks);
    const childIds = tree[0].children.map((c) => c.id);
    expect(childIds).toEqual(['C1', 'C2', 'C3']);
  });
});
