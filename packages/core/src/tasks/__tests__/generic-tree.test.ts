/**
 * Tests for `buildGenericTaskTree` — the parent + groups edge walker
 * powering `cleo tree <id>` (T10134).
 *
 * Covers the eleven acceptance criteria spelled out for B9 / Epic T10114:
 *
 *   AC1 — walks BOTH parent_id and `task_relations.relation_type='groups'`
 *          edges to full depth from any root, no flag required.
 *   AC2 — `cleo tree T9855` shows every saga member + its subtree.
 *   AC4 — leaf rooted-tree exposes the upward ancestor chain.
 *   AC5 — node-kind discrimination via the typed `TreeNodeKind` enum.
 *   AC6 — edge-type metadata identifies groups-edge rows (`⊂` prefix is
 *          the renderer's job — the data layer surfaces `edgeType`).
 *   AC9 — derives from the typed `TreeResponse<T>` contract.
 *
 * @epic T10114
 * @task T10134
 * @see ADR-077-human-render-contract.md
 */

import type { TreeResponse } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SAGA_GROUPS_RELATION } from '../../sagas/constants.js';
import { createTestDb, seedTasks, type TestDbEnv } from '../../store/__tests__/test-db-helper.js';
import { buildGenericTaskTree, type GenericTreeMetadata } from '../generic-tree.js';

let env: TestDbEnv;

beforeEach(async () => {
  env = await createTestDb();
});

afterEach(async () => {
  await env.cleanup();
});

/**
 * Materialise the canonical SG-TEMPLATE-CONFIG-SSOT-shaped fixture: one saga
 * grouping twelve member Epics, with two of the Epics carrying parent-edge
 * children so we exercise the full mixed-edge walk.
 *
 * The shape mirrors the production T9855 / SG-TEMPLATE-CONFIG-SSOT saga used
 * by the regression smoke (AC2 + AC10).
 */
async function seedSagaFixture(): Promise<void> {
  const baseEpic = (id: string, title: string) => ({
    id,
    title,
    type: 'epic' as const,
    status: 'pending' as const,
    priority: 'high' as const,
  });

  await seedTasks(env.accessor, [
    {
      id: 'SG-TPL',
      title: 'SG-TEMPLATE-CONFIG-SSOT',
      // PM-Core V2: 'saga' is the canonical TaskType; isSagaShape now keys on
      // type==='saga', not the legacy labels:['saga'] marker.
      type: 'saga',
      status: 'pending',
      priority: 'high',
    },
    baseEpic('E-MEM-01', 'Member Epic 01'),
    baseEpic('E-MEM-02', 'Member Epic 02'),
    baseEpic('E-MEM-03', 'Member Epic 03'),
    baseEpic('E-MEM-04', 'Member Epic 04'),
    baseEpic('E-MEM-05', 'Member Epic 05'),
    baseEpic('E-MEM-06', 'Member Epic 06'),
    baseEpic('E-MEM-07', 'Member Epic 07'),
    baseEpic('E-MEM-08', 'Member Epic 08'),
    baseEpic('E-MEM-09', 'Member Epic 09'),
    baseEpic('E-MEM-10', 'Member Epic 10'),
    baseEpic('E-MEM-11', 'Member Epic 11'),
    baseEpic('E-MEM-12', 'Member Epic 12'),
    // Two of the member Epics have parent-edge children.
    {
      id: 'T-CHILD-01',
      title: 'Child task A',
      type: 'task',
      status: 'pending',
      priority: 'medium',
      parentId: 'E-MEM-01',
      position: 0,
    },
    {
      id: 'T-CHILD-02',
      title: 'Child task B',
      type: 'task',
      status: 'active',
      priority: 'medium',
      parentId: 'E-MEM-01',
      position: 1,
    },
    {
      id: 'T-CHILD-03',
      title: 'Child task C',
      type: 'task',
      status: 'done',
      priority: 'medium',
      parentId: 'E-MEM-07',
      position: 0,
    },
  ]);

  // Wire the saga's `groups` edges in stable insertion order.
  for (let i = 1; i <= 12; i++) {
    const id = `E-MEM-${i.toString().padStart(2, '0')}`;
    await env.accessor.addRelation('SG-TPL', id, SAGA_GROUPS_RELATION);
  }
}

describe('buildGenericTaskTree (T10134)', () => {
  it('walks groups edges from a saga and emits all 12 member Epics + parent-edge children', async () => {
    await seedSagaFixture();

    const result = await buildGenericTaskTree(env.tempDir, 'SG-TPL');

    // Root row first.
    expect(result.tree.root).toBe('SG-TPL');
    const rootRow = result.tree.tree[0];
    expect(rootRow?.id).toBe('SG-TPL');
    expect(rootRow?.kind).toBe('saga');
    expect(rootRow?.metadata.edgeType).toBe('root');

    // Twelve member Epics emitted under the saga via groups edges.
    const memberRows = result.tree.tree.filter(
      (n) => n.parentId === 'SG-TPL' && n.metadata.edgeType === 'groups',
    );
    expect(memberRows).toHaveLength(12);
    for (const row of memberRows) {
      expect(row.kind).toBe('epic');
      expect(row.depth).toBe(1);
    }

    // Three parent-edge children carried under their member Epics.
    const parentChildren = result.tree.tree.filter((n) => n.metadata.edgeType === 'parent');
    expect(parentChildren.map((n) => n.id).sort()).toEqual([
      'T-CHILD-01',
      'T-CHILD-02',
      'T-CHILD-03',
    ]);
    for (const child of parentChildren) {
      expect(child.kind).toBe('task');
      expect(child.depth).toBe(2);
    }

    // Total = 1 saga + 12 epics + 3 child tasks.
    expect(result.tree.totalNodes).toBe(16);
    expect(result.tree.maxDepth).toBe(2);

    // No ancestors above a top-level saga.
    expect(result.ancestors).toHaveLength(0);
  });

  it('preserves the insertion order of groups edges in the emitted tree', async () => {
    await seedSagaFixture();

    const result = await buildGenericTaskTree(env.tempDir, 'SG-TPL');
    const memberIds = result.tree.tree.filter((n) => n.parentId === 'SG-TPL').map((n) => n.id);
    expect(memberIds).toEqual([
      'E-MEM-01',
      'E-MEM-02',
      'E-MEM-03',
      'E-MEM-04',
      'E-MEM-05',
      'E-MEM-06',
      'E-MEM-07',
      'E-MEM-08',
      'E-MEM-09',
      'E-MEM-10',
      'E-MEM-11',
      'E-MEM-12',
    ]);
  });

  it('walks parent_id edges from an Epic root and emits every descendant', async () => {
    await seedTasks(env.accessor, [
      { id: 'E-PARENT', title: 'Epic root', type: 'epic', status: 'pending', priority: 'high' },
      ...Array.from({ length: 5 }, (_, i) => ({
        id: `T-CH-${i}`,
        title: `Child ${i}`,
        type: 'task' as const,
        status: 'pending' as const,
        priority: 'medium' as const,
        parentId: 'E-PARENT',
        position: i,
      })),
    ]);

    const result = await buildGenericTaskTree(env.tempDir, 'E-PARENT');
    expect(result.tree.totalNodes).toBe(6); // 1 epic + 5 children
    expect(result.tree.tree[0]?.kind).toBe('epic');
    for (const row of result.tree.tree.slice(1)) {
      expect(row.metadata.edgeType).toBe('parent');
      expect(row.depth).toBe(1);
    }
  });

  it('exposes the upward ancestor chain when rooted at a leaf task', async () => {
    await seedTasks(env.accessor, [
      {
        id: 'SG-A',
        title: 'Saga',
        type: 'saga',
        status: 'pending',
        priority: 'high',
      },
      { id: 'E-A', title: 'Epic', type: 'epic', status: 'pending', priority: 'high' },
      {
        id: 'T-A',
        title: 'Task',
        type: 'task',
        status: 'pending',
        priority: 'medium',
        parentId: 'E-A',
      },
      {
        id: 'ST-A',
        title: 'Subtask',
        type: 'subtask',
        status: 'pending',
        priority: 'medium',
        parentId: 'T-A',
      },
    ]);
    await env.accessor.addRelation('SG-A', 'E-A', SAGA_GROUPS_RELATION);

    const result = await buildGenericTaskTree(env.tempDir, 'ST-A');
    // Tree itself is just the subtask (no descendants).
    expect(result.tree.totalNodes).toBe(1);
    expect(result.tree.tree[0]?.kind).toBe('subtask');

    // Ancestors walk parent_id upward (groups edges are NOT followed upward).
    // ST-A → T-A → E-A. SG-A is reachable only via a groups edge, so it
    // does not appear in the parent-only ancestor chain.
    const ancestorIds = result.ancestors.map((a) => a.id);
    expect(ancestorIds).toEqual(['T-A', 'E-A']);
  });

  it('is cycle-safe when a parent loop is present in the data', async () => {
    // Synthetic regression — a corrupted DB row pointing parent → child loop.
    // The walker must terminate via the visited set rather than recurse forever.
    // PM-Core V2 type matrix: a valid 3-level parent chain is epic→task→subtask.
    await seedTasks(env.accessor, [
      { id: 'L-A', title: 'A', type: 'epic', status: 'pending', priority: 'medium' },
      {
        id: 'L-B',
        title: 'B',
        type: 'task',
        status: 'pending',
        priority: 'medium',
        parentId: 'L-A',
      },
      {
        id: 'L-C',
        title: 'C',
        type: 'subtask',
        status: 'pending',
        priority: 'medium',
        parentId: 'L-B',
      },
    ]);
    // Manufacture a back-edge L-A → L-C via a groups relation so the DFS would
    // re-encounter L-A from L-C through a different edge type.
    await env.accessor.addRelation('L-C', 'L-A', SAGA_GROUPS_RELATION);

    const result = await buildGenericTaskTree(env.tempDir, 'L-A');
    expect(result.tree.totalNodes).toBe(3);
    const ids = result.tree.tree.map((n) => n.id);
    // L-A appears exactly once even though the DFS would loop without the
    // visited set.
    expect(ids.filter((id) => id === 'L-A')).toHaveLength(1);
  });

  it('returns a typed TreeResponse<GenericTreeMetadata> envelope', async () => {
    await seedTasks(env.accessor, [
      { id: 'X-1', title: 'X', type: 'task', status: 'pending', priority: 'medium' },
    ]);
    const result = await buildGenericTaskTree(env.tempDir, 'X-1');
    const tree: TreeResponse<GenericTreeMetadata> = result.tree;
    expect(tree.root).toBe('X-1');
    expect(tree.tree).toHaveLength(1);
    expect(tree.maxDepth).toBe(0);
  });

  it('throws an E_NOT_FOUND-shaped error for an unknown root', async () => {
    await seedTasks(env.accessor, []);
    await expect(buildGenericTaskTree(env.tempDir, 'T-MISSING')).rejects.toThrow(
      /Task 'T-MISSING' not found/,
    );
  });
});
