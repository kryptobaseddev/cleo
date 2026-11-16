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

import type { TaskStatus, TreeResponse } from '@cleocode/contracts';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reasonWhy } from '../../memory/brain-reasoning.js';
import { getCriticalPath } from '../../orchestration/critical-path.js';
import { collectOrchestrateDashboard } from '../../orchestration/dashboard.js';
import { SAGA_GROUPS_RELATION } from '../../sagas/constants.js';
import { createTestDb, seedTasks, type TestDbEnv } from '../../store/__tests__/test-db-helper.js';
import * as taskAccessors from '../../store/data-accessor.js';
import { getDb, getNativeDb } from '../../store/sqlite.js';
import * as schema from '../../store/tasks-schema.js';
import { buildTaskTree } from '../../task-tools/build-task-tree.js';
import { archiveTasks } from '../archive.js';
import { computeTaskView, computeTaskViews } from '../compute-task-view.js';
import { buildGenericTaskTree, type GenericTreeMetadata } from '../generic-tree.js';
import { showTask } from '../show.js';
import { coreTaskBlockers } from '../task-blockers.js';
import { coreTaskContext } from '../task-context.js';
import { coreTaskDepends, coreTaskDeps, coreTaskRelates } from '../task-data.js';
import { coreTaskTree } from '../task-tree.js';

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

describe('cross-epic readiness metadata shares the execution policy', () => {
  async function seedDependency(status: TaskStatus): Promise<void> {
    await seedTasks(env.accessor, [
      { id: 'T100', type: 'epic' },
      { id: 'T101', parentId: 'T100', status: status === 'archived' ? 'done' : status },
      { id: 'T200', type: 'epic' },
      { id: 'T201', parentId: 'T200', depends: ['T101'] },
      { id: 'T300', depends: ['T201'] },
    ]);
    if (status === 'archived') {
      expect(await archiveTasks({ taskIds: ['T101'] }, env.tempDir, env.accessor)).toMatchObject({
        archived: ['T101'],
      });
      expect((await env.accessor.queryTasks({})).tasks.map((task) => task.id)).not.toContain(
        'T101',
      );
    }
  }

  async function assertReadiness(ready: boolean, dependencyId = 'T101'): Promise<void> {
    const blockedBy = ready ? [] : [dependencyId];
    expect
      .soft(await coreTaskDeps(env.tempDir, 'T201'))
      .toMatchObject({ allDepsReady: ready, unresolvedDeps: blockedBy });
    expect
      .soft(await coreTaskDepends(env.tempDir, 'T201'))
      .toMatchObject({ allDepsReady: ready, unresolvedChain: blockedBy.length });
    const blockers = await coreTaskBlockers(env.tempDir, { analyze: true });
    expect.soft(blockers.blockedTasks.some((task) => task.id === 'T201')).toBe(!ready);
    if (!ready)
      expect
        .soft(blockers.blockedTasks.find((task) => task.id === 'T201')?.blockingChain)
        .toEqual(blockedBy);
    const tree = await coreTaskTree(env.tempDir, 'T200', true);
    expect.soft(tree.totalNodes).toBe(2);
    expect.soft(tree.tree[0]?.children[0]).toMatchObject({
      id: 'T201',
      ready,
      blockedBy,
      blockerChain: blockedBy,
      leafBlockers: blockedBy,
    });
    const generic = await buildGenericTaskTree(env.tempDir, 'T200', { withBlockers: true });
    expect.soft(generic.tree.totalNodes).toBe(2);
    expect
      .soft(generic.tree.tree.find((node) => node.id === 'T201')?.metadata)
      .toMatchObject({ ready, blockedBy, blockerChain: blockedBy, leafBlockers: blockedBy });
    const population = await env.accessor.loadTasks(['T100', 'T101', 'T200', 'T201']);
    const pure = buildTaskTree(population, 'T200', { withBlockers: true });
    expect.soft(pure.totalNodes).toBe(2);
    expect
      .soft(pure.tree[0]?.children[0])
      .toMatchObject({ ready, blockedBy, blockerChain: blockedBy, leafBlockers: blockedBy });
    expect
      .soft((await coreTaskRelates(env.tempDir, 'T201')).relations)
      .toContainEqual(
        expect.objectContaining({ taskId: dependencyId, source: 'dependency', ready }),
      );
    const context = await coreTaskContext(env.tempDir, {
      taskId: 'T201',
      includeAcceptance: false,
      includeDocs: false,
      includeEdges: false,
      includeActivity: false,
    });
    expect
      .soft(
        context.blockers
          ?.filter((blocker) => blocker.kind === 'dependency')
          .map((blocker) => blocker.taskId) ?? [],
      )
      .toEqual(blockedBy);
    expect
      .soft(
        (await showTask('T201', env.tempDir, env.accessor)).unresolvedDeps?.map(
          (dependency) => dependency.id,
        ) ?? [],
      )
      .toEqual(blockedBy);
    const view = await computeTaskView('T201', env.accessor);
    expect.soft(view?.nextAction).toBe(ready ? 'verify' : 'blocked-on-deps');
    expect.soft(await computeTaskViews(['T201'], env.accessor)).toEqual([view]);
    const trace = await reasonWhy('T201', env.tempDir, env.accessor);
    expect.soft(trace.blockers.map((blocker) => blocker.taskId)).toEqual(blockedBy);
    expect.soft(trace.rootCauses).toEqual(blockedBy);
    const critical = await getCriticalPath(env.tempDir, env.accessor);
    expect
      .soft(critical.path.find((node) => node.taskId === 'T201')?.blockerCount)
      .toBe(blockedBy.length);
    const dashboard = await collectOrchestrateDashboard(env.tempDir, {
      accessor: env.accessor,
      worktreeStates: [],
    });
    const prerequisitePending = population.find((task) => task.id === 'T101')?.status === 'pending';
    expect.soft(dashboard.queue.ready).toBe(2 + Number(ready) + Number(prerequisitePending));
  }

  it.each([
    ['done', true],
    ['archived', true],
    ['pending', false],
    ['active', false],
    ['blocked', false],
    ['proposed', false],
    ['cancelled', false],
  ] as const)('retains independent %s dependency evidence', async (status, ready) => {
    await seedDependency(status);
    const before = (await env.accessor.loadTasks(['T100', 'T101', 'T200', 'T201'])).map(
      ({ id, parentId, depends }) => ({ id, parentId, depends }),
    );
    await assertReadiness(ready);
    expect(
      (await env.accessor.loadTasks(['T100', 'T101', 'T200', 'T201'])).map(
        ({ id, parentId, depends }) => ({ id, parentId, depends }),
      ),
    ).toEqual(before);
  });

  it('keeps genuinely missing persisted prerequisites in every blocker projection', async () => {
    await seedDependency('done');
    const db = await getDb(env.tempDir);
    const native = getNativeDb(env.tempDir);
    if (!native) throw new Error('Expected canonical fixture handle');
    native.exec('PRAGMA foreign_keys = OFF');
    try {
      await db
        .update(schema.taskDependencies)
        .set({ dependsOn: 'T999' })
        .where(eq(schema.taskDependencies.taskId, 'T201'))
        .run();
    } finally {
      native.exec('PRAGMA foreign_keys = ON');
    }
    expect(native.prepare('PRAGMA foreign_keys').get()).toMatchObject({ foreign_keys: 1 });
    expect(native.prepare('PRAGMA foreign_key_check').all()).toHaveLength(1);
    await assertReadiness(false, 'T999');
    expect((await env.accessor.loadSingleTask('T201'))?.depends).toEqual(['T999']);
  });

  it('propagates a required archive read failure in every store-backed projection', async () => {
    await seedDependency('archived');
    const canonical = vi.spyOn(taskAccessors, 'getTaskAccessor').mockResolvedValue(env.accessor);
    const read = vi
      .spyOn(env.accessor, 'loadTasks')
      .mockRejectedValue(new Error('dependency evidence unavailable'));
    try {
      await expect(coreTaskDeps(env.tempDir, 'T201')).rejects.toThrow(
        'dependency evidence unavailable',
      );
      await expect(coreTaskDepends(env.tempDir, 'T201')).rejects.toThrow(
        'dependency evidence unavailable',
      );
      await expect(coreTaskBlockers(env.tempDir)).rejects.toThrow(
        'dependency evidence unavailable',
      );
      await expect(coreTaskTree(env.tempDir, 'T200')).rejects.toThrow(
        'dependency evidence unavailable',
      );
      await expect(buildGenericTaskTree(env.tempDir, 'T200')).rejects.toThrow(
        'dependency evidence unavailable',
      );
      await expect(coreTaskRelates(env.tempDir, 'T201')).rejects.toThrow(
        'dependency evidence unavailable',
      );
    } finally {
      read.mockRestore();
      canonical.mockRestore();
    }
  });
});
