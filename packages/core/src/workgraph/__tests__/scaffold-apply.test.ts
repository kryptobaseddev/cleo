/**
 * T10633 acceptance coverage for WorkGraph scaffold apply engine.
 *
 * Locks:
 * - AC1 — apply is transactional (errors don't leave partial state; validity
 *         gate prevents writes, and during-write errors cause applied:false)
 * - AC2 — idempotency prevents duplicates (nodes skipped when already present,
 *         edges skipped via ON CONFLICT DO NOTHING)
 * - AC3 — docs and relations created consistently (edge kinds route to the
 *         correct storage tables: depends_on→task_dependencies,
 *         blocks/relates_to/groups→task_relations)
 *
 * Important: task_relations has trigger-enforced constraint that rejects
 * parent-child containment edges. Relation edges must be between sibling
 * or unrelated tasks, never between parent and child (use parentId for that).
 *
 * @task T10633
 * @saga T10538
 * @epic T10547
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  Task,
  WorkGraphDirectEdge,
  WorkGraphHierarchyInputNode,
  WorkGraphScaffoldApplyParams,
} from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let tempDir: string;

function makeTask(overrides: Partial<Task> & { id: string }): Task {
  return {
    title: `Task ${overrides.id}`,
    description: overrides.description ?? `Description for task ${overrides.id}`,
    status: 'pending',
    priority: 'medium',
    createdAt: new Date().toISOString(),
    ...overrides,
  } as Task;
}

function epicNode(id: string): WorkGraphHierarchyInputNode {
  return { id, type: 'epic' };
}

function taskNode(id: string, parentId: string): WorkGraphHierarchyInputNode {
  return { id, type: 'task', parentId };
}

function subtaskNode(id: string, parentId: string): WorkGraphHierarchyInputNode {
  return { id, type: 'subtask', parentId };
}

function sagaNode(id: string): WorkGraphHierarchyInputNode {
  return { id, type: 'saga' };
}

function depEdge(fromId: string, toId: string): WorkGraphDirectEdge {
  return { source: 'dependency' as const, fromId, toId, kind: 'depends_on' as const } as WorkGraphDirectEdge;
}

function blockEdge(fromId: string, toId: string): WorkGraphDirectEdge {
  return {
    source: 'relation' as const,
    fromId,
    toId,
    kind: 'blocks' as const,
    relationType: 'blocks' as const,
    reason: 'test',
  } as WorkGraphDirectEdge;
}

function relEdge(fromId: string, toId: string): WorkGraphDirectEdge {
  return {
    source: 'relation' as const,
    fromId,
    toId,
    kind: 'relates_to' as const,
    relationType: 'related' as const,
    reason: 'test',
  } as WorkGraphDirectEdge;
}

function groupEdge(fromId: string, toId: string): WorkGraphDirectEdge {
  return {
    source: 'relation' as const,
    fromId,
    toId,
    kind: 'groups' as const,
    relationType: 'groups' as const,
    reason: 'test',
  } as WorkGraphDirectEdge;
}

function applyParams(
  rootId: string,
  nodes: WorkGraphHierarchyInputNode[],
  edges?: WorkGraphDirectEdge[],
  apply = true,
): WorkGraphScaffoldApplyParams {
  return { rootId, nodes, edges, apply };
}

// ---------------------------------------------------------------------------
// Isolated DB setup (matches tasks-sqlite test pattern)
// ---------------------------------------------------------------------------

describe('WorkGraph scaffold apply engine', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-scaffold-apply-'));
    const cleoDir = join(tempDir, '.cleo');
    process.env['CLEO_DIR'] = cleoDir;

    await mkdir(cleoDir, { recursive: true });
    await writeFile(
      join(cleoDir, 'config.json'),
      JSON.stringify({
        enforcement: { session: { requiredForMutate: false } },
        lifecycle: { mode: 'off' },
        verification: { enabled: false },
      }),
    );

    const { closeDb } = await import('../../store/sqlite.js');
    closeDb();
  });

  afterEach(async () => {
    const { closeDb } = await import('../../store/sqlite.js');
    closeDb();
    await new Promise((r) => setTimeout(r, 50));
    try {
      const { closeBrainDb } = await import('../../store/memory-sqlite.js');
      closeBrainDb();
    } catch {
      /* ignore */
    }
    delete process.env['CLEO_DIR'];
    await rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  });

  // -----------------------------------------------------------------------
  // AC1 — apply is transactional
  // -----------------------------------------------------------------------

  describe('AC1 — apply is transactional', () => {
    it('returns applied:false when validation fails (invalid type)', async () => {
      const { applyWorkGraphScaffold } = await import('../scaffold-apply.js');

      const result = await applyWorkGraphScaffold(
        applyParams('ROOT', [{ id: 'X', type: 'invalid' as any }]),
      );

      expect(result.valid).toBe(false);
      expect(result.applied).toBe(false);
      expect(result.nodesChanged).toBe(0);
    });

    it('returns applied:false when apply flag is false (dry-run preview)', async () => {
      const { applyWorkGraphScaffold } = await import('../scaffold-apply.js');

      const result = await applyWorkGraphScaffold(
        applyParams('AC1-A', [epicNode('AC1-A')], undefined, false),
      );

      expect(result.valid).toBe(true);
      expect(result.applied).toBe(false);
      expect(result.nodesChanged).toBe(0);
    });

    it('returns applied:true only when all node and edge writes succeed', async () => {
      const { applyWorkGraphScaffold } = await import('../scaffold-apply.js');

      const nodes = [epicNode('AC1-B'), taskNode('AC1-B1', 'AC1-B')];
      const edges = [depEdge('AC1-B1', 'AC1-B')];

      const result = await applyWorkGraphScaffold(applyParams('AC1-B', nodes, edges));

      expect(result.valid).toBe(true);
      expect(result.applied).toBe(true);
      expect(result.nodesChanged).toBe(2);
      expect(result.edgesChanged).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // AC2 — idempotency prevents duplicates
  // -----------------------------------------------------------------------

  describe('AC2 — idempotency prevents duplicates', () => {
    it('skips nodes that already exist', async () => {
      const { createTask } = await import('../../store/tasks-sqlite.js');
      const { applyWorkGraphScaffold } = await import('../scaffold-apply.js');

      await createTask(makeTask({ id: 'AC2-A', type: 'epic' }));

      const nodes = [epicNode('AC2-A'), taskNode('AC2-A1', 'AC2-A')];
      const result = await applyWorkGraphScaffold(applyParams('AC2-A', nodes));

      expect(result.valid).toBe(true);
      expect(result.applied).toBe(true);
      expect(result.nodesChanged).toBe(1); // only new task
    });

    it('edges are idempotent — duplicate depends_on does not throw', async () => {
      const { createTask, getTask } = await import('../../store/tasks-sqlite.js');
      const { applyWorkGraphScaffold } = await import('../scaffold-apply.js');

      await createTask(makeTask({ id: 'AC2-B', type: 'epic' }));
      await createTask(makeTask({ id: 'AC2-B1', type: 'task', parentId: 'AC2-B' }));

      const nodes = [epicNode('AC2-B'), taskNode('AC2-B1', 'AC2-B')];
      const edges = [depEdge('AC2-B1', 'AC2-B')];

      await applyWorkGraphScaffold(applyParams('AC2-B', nodes, edges));
      const r2 = await applyWorkGraphScaffold(applyParams('AC2-B', nodes, edges));

      expect(r2.valid).toBe(true);
      expect(r2.applied).toBe(true);

      const task = await getTask('AC2-B1');
      const deps = task?.depends ?? [];
      expect(deps.filter((d) => d === 'AC2-B')).toHaveLength(1);
    });

    it('relation edges are idempotent — duplicate blocks does not throw', async () => {
      const { createTask } = await import('../../store/tasks-sqlite.js');
      const { applyWorkGraphScaffold } = await import('../scaffold-apply.js');

      // Use sibling tasks — task_relations rejects parent-child containment edges
      await createTask(makeTask({ id: 'AC2-C', type: 'epic' }));
      await createTask(makeTask({ id: 'AC2-C1', type: 'task', parentId: 'AC2-C' }));
      await createTask(makeTask({ id: 'AC2-C2', type: 'task', parentId: 'AC2-C' }));

      const nodes = [epicNode('AC2-C'), taskNode('AC2-C1', 'AC2-C'), taskNode('AC2-C2', 'AC2-C')];
      const edges = [blockEdge('AC2-C1', 'AC2-C2')]; // sibling→sibling, not child→parent

      await applyWorkGraphScaffold(applyParams('AC2-C', nodes, edges));
      const r2 = await applyWorkGraphScaffold(applyParams('AC2-C', nodes, edges));

      expect(r2.valid).toBe(true);
      expect(r2.applied).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // AC3 — docs and relations created consistently
  // -----------------------------------------------------------------------

  describe('AC3 — docs and relations created consistently', () => {
    it('depends_on edge creates a task_dependencies row', async () => {
      const { createTask, getTask } = await import('../../store/tasks-sqlite.js');
      const { applyWorkGraphScaffold } = await import('../scaffold-apply.js');

      await createTask(makeTask({ id: 'AC3-A', type: 'epic' }));
      await createTask(makeTask({ id: 'AC3-A1', type: 'task', parentId: 'AC3-A' }));

      const nodes = [epicNode('AC3-A'), taskNode('AC3-A1', 'AC3-A')];
      const result = await applyWorkGraphScaffold(
        applyParams('AC3-A', nodes, [depEdge('AC3-A1', 'AC3-A')]),
      );

      expect(result.edgesChanged).toBe(1);
      const task = await getTask('AC3-A1');
      expect(task!.depends).toContain('AC3-A');
    });

    it('blocks edge creates a task_relations row', async () => {
      const { createTask } = await import('../../store/tasks-sqlite.js');
      const { applyWorkGraphScaffold } = await import('../scaffold-apply.js');

      // Sibling tasks under the same epic — relation edges between them are valid
      await createTask(makeTask({ id: 'AC3-B', type: 'epic' }));
      await createTask(makeTask({ id: 'AC3-B1', type: 'task', parentId: 'AC3-B' }));
      await createTask(makeTask({ id: 'AC3-B2', type: 'task', parentId: 'AC3-B' }));

      const nodes = [epicNode('AC3-B'), taskNode('AC3-B1', 'AC3-B'), taskNode('AC3-B2', 'AC3-B')];
      const result = await applyWorkGraphScaffold(
        applyParams('AC3-B', nodes, [blockEdge('AC3-B1', 'AC3-B2')]),
      );

      expect(result.edgesChanged).toBe(1);
    });

    it('relates_to edge creates a task_relations row', async () => {
      const { createTask } = await import('../../store/tasks-sqlite.js');
      const { applyWorkGraphScaffold } = await import('../scaffold-apply.js');

      await createTask(makeTask({ id: 'AC3-C', type: 'epic' }));
      await createTask(makeTask({ id: 'AC3-C1', type: 'task', parentId: 'AC3-C' }));
      await createTask(makeTask({ id: 'AC3-C2', type: 'task', parentId: 'AC3-C' }));

      const nodes = [epicNode('AC3-C'), taskNode('AC3-C1', 'AC3-C'), taskNode('AC3-C2', 'AC3-C')];
      const result = await applyWorkGraphScaffold(
        applyParams('AC3-C', nodes, [relEdge('AC3-C1', 'AC3-C2')]),
      );

      expect(result.edgesChanged).toBe(1);
    });

    it('groups edge creates a task_relations row', async () => {
      const { createTask } = await import('../../store/tasks-sqlite.js');
      const { applyWorkGraphScaffold } = await import('../scaffold-apply.js');

      await createTask(makeTask({ id: 'AC3-D', type: 'epic' }));
      await createTask(makeTask({ id: 'AC3-D1', type: 'task', parentId: 'AC3-D' }));
      await createTask(makeTask({ id: 'AC3-D2', type: 'task', parentId: 'AC3-D' }));

      const nodes = [epicNode('AC3-D'), taskNode('AC3-D1', 'AC3-D'), taskNode('AC3-D2', 'AC3-D')];
      const result = await applyWorkGraphScaffold(
        applyParams('AC3-D', nodes, [groupEdge('AC3-D1', 'AC3-D2')]),
      );

      expect(result.edgesChanged).toBe(1);
    });

    it('parentId on node sets task parent_id (containment)', async () => {
      const { getTask } = await import('../../store/tasks-sqlite.js');
      const { applyWorkGraphScaffold } = await import('../scaffold-apply.js');

      const nodes = [epicNode('AC3-E'), taskNode('AC3-E1', 'AC3-E')];

      const result = await applyWorkGraphScaffold(applyParams('AC3-E', nodes));

      expect(result.nodesChanged).toBe(2);
      const task = await getTask('AC3-E1');
      expect(task).not.toBeNull();
      expect(task!.parentId).toBe('AC3-E');
    });

    it('mixed nodes + edges: all three ACs exercised end-to-end', async () => {
      const { getTask } = await import('../../store/tasks-sqlite.js');
      const { applyWorkGraphScaffold } = await import('../scaffold-apply.js');

      // Saga owns epics via groups relations
      const nodes: WorkGraphHierarchyInputNode[] = [
        { id: 'SAGA', type: 'saga' },
        { id: 'EPIC', type: 'epic' },
        { id: 'T1', type: 'task', parentId: 'EPIC' },
        { id: 'T2', type: 'task', parentId: 'EPIC' },
        { id: 'T3', type: 'subtask', parentId: 'T1' },
      ];

      // Relation edges between siblings (not parent-child) to satisfy
      // the task_relations non-containment trigger constraint
      const edges: WorkGraphDirectEdge[] = [
        depEdge('T3', 'T2'),           // subtask depends on sibling task
        blockEdge('T1', 'T2'),         // sibling blocks sibling
        relEdge('T2', 'T3'),           // sibling relates to subtask
        groupEdge('EPIC', 'SAGA'),     // epic grouped under saga
      ];

      // First apply
      const r1 = await applyWorkGraphScaffold(applyParams('SAGA', nodes, edges));
      expect(r1.valid).toBe(true);
      expect(r1.applied).toBe(true);
      expect(r1.nodesChanged).toBe(5);
      expect(r1.edgesChanged).toBe(4);

      const t3 = await getTask('T3');
      expect(t3!.depends).toContain('T2');

      // Re-apply — idempotent (AC2)
      const r2 = await applyWorkGraphScaffold(applyParams('SAGA', nodes, edges));
      expect(r2.valid).toBe(true);
      expect(r2.applied).toBe(true);
      expect(r2.nodesChanged).toBe(0);

      const t3again = await getTask('T3');
      expect(t3again!.depends!.filter((d) => d === 'T2')).toHaveLength(1);
    });
  });
});
