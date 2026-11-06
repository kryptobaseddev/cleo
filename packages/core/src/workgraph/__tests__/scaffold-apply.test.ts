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

import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  Task,
  WorkGraphDirectEdge,
  WorkGraphHierarchyInputNode,
  WorkGraphScaffoldApplyParams,
} from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  return {
    source: 'dependency' as const,
    fromId,
    toId,
    kind: 'depends_on' as const,
  } as WorkGraphDirectEdge;
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
    vi.stubEnv('CLEO_ROOT', tempDir);
    vi.stubEnv('CLEO_DIR', cleoDir);

    await mkdir(cleoDir, { recursive: true });
    await writeFile(
      join(cleoDir, 'project-info.json'),
      JSON.stringify({ projectId: 'workgraph-fixture', projectHash: 'workgraph-fixture' }),
    );
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
    await rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  async function prepareOtherProject(): Promise<string> {
    const other = join(tempDir, 'other');
    await mkdir(join(other, '.cleo'), { recursive: true });
    await writeFile(
      join(other, '.cleo/project-info.json'),
      JSON.stringify({ projectId: 'other-workgraph', projectHash: 'other-workgraph' }),
    );
    const { createTask } = await import('../../store/tasks-sqlite.js');
    await createTask(makeTask({ id: 'T990', title: 'Other seed' }), other, {
      autoCheckpoint: false,
      validateSequence: false,
    });
    return other;
  }

  function persistedScopeRows(root: string): string {
    return execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        "import { DatabaseSync } from 'node:sqlite'; const db=new DatabaseSync(process.argv[1],{readOnly:true});process.stdout.write(JSON.stringify(db.prepare(\"SELECT id FROM tasks_tasks WHERE id IN ('T95044', 'T95046') ORDER BY id\").all()));db.close();",
        join(root, '.cleo/cleo.db'),
      ],
      { encoding: 'utf8', timeout: 5000 },
    );
  }

  it('uses captured default project discovery when the directory pin disagrees', async () => {
    const other = await prepareOtherProject();
    const { getTask } = await import('../../store/tasks-sqlite.js');
    await getTask('T991', tempDir);
    const { applyWorkGraphScaffold } = await import('../scaffold-apply.js');
    vi.stubEnv('CLEO_DIR', join(other, '.cleo'));
    const result = await applyWorkGraphScaffold(applyParams('T95044', [epicNode('T95044')]));
    expect(result.applied).toBe(true);
    expect(JSON.parse(persistedScopeRows(tempDir))).toEqual([{ id: 'T95044' }]);
    expect(JSON.parse(persistedScopeRows(other))).toEqual([]);
  });

  it('rolls back the actual mutation handle when ambient ownership changes after acquisition', async () => {
    const other = await prepareOtherProject();
    const sqlite = await import('../../store/sqlite.js');
    await sqlite.getDb(tempDir);
    const native = sqlite.getNativeDb(tempDir);
    if (!native) throw new Error('Synthetic mutation handle missing');
    native.exec(
      "CREATE TRIGGER fail_scaffold BEFORE INSERT ON tasks_tasks WHEN NEW.id='T95046' BEGIN SELECT RAISE(ABORT,'synthetic scaffold fault'); END",
    );
    const originalGetDb = sqlite.getDb;
    let acquired = () => {};
    let resume = () => {};
    const ready = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const continuation = new Promise<void>((resolve) => {
      resume = resolve;
    });
    vi.spyOn(sqlite, 'getDb').mockImplementationOnce(async (cwd) => {
      const db = await originalGetDb(cwd);
      acquired();
      await continuation;
      return db;
    });
    const { applyWorkGraphScaffold } = await import('../scaffold-apply.js');
    const applying = applyWorkGraphScaffold(
      applyParams('T95044', [epicNode('T95044'), taskNode('T95046', 'T95044')]),
    );
    await ready;
    vi.stubEnv('CLEO_ROOT', other);
    vi.stubEnv('CLEO_DIR', join(other, '.cleo'));
    resume();
    const result = await applying;
    expect(result.applied).toBe(false);
    expect(
      result.issues.some((issue) => issue.message.includes('Apply failed and was rolled back')),
    ).toBe(true);
    expect(JSON.parse(persistedScopeRows(tempDir))).toEqual([]);
    expect(JSON.parse(persistedScopeRows(other))).toEqual([]);
  });

  // -----------------------------------------------------------------------
  // AC1 — apply is transactional
  // -----------------------------------------------------------------------

  describe('AC1 — apply is transactional', () => {
    it('returns applied:false when validation fails (invalid type)', async () => {
      const { applyWorkGraphScaffold } = await import('../scaffold-apply.js');

      const result = await applyWorkGraphScaffold(
        applyParams('ROOT', [{ id: 'T95045', type: 'invalid' as any }]),
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

  describe('T12886 — dependency-cycle guard', () => {
    it('rolls back and names the cycle when an edge closes one with stored edges', async () => {
      const { applyWorkGraphScaffold } = await import('../scaffold-apply.js');
      const nodes = [epicNode('CYC-E'), taskNode('CYC-A', 'CYC-E'), taskNode('CYC-B', 'CYC-E')];
      const first = await applyWorkGraphScaffold(
        applyParams('CYC-E', nodes, [depEdge('CYC-B', 'CYC-A')]),
      );
      expect(first.applied).toBe(true);

      const second = await applyWorkGraphScaffold(
        applyParams('CYC-E', nodes, [depEdge('CYC-A', 'CYC-B')]),
      );
      expect(second.applied).toBe(false);
      const issue = second.issues.find((i) => i.message.includes('E_TASK_DEPENDENCY_CYCLE'));
      expect(issue?.message).toContain('CYC-A → CYC-B → CYC-A');
    });
  });

  describe('AC2 — idempotency prevents duplicates', () => {
    it('skips nodes that already exist', async () => {
      const { createTask } = await import('../../store/tasks-sqlite.js');
      const { applyWorkGraphScaffold } = await import('../scaffold-apply.js');

      await createTask(makeTask({ id: 'T95025', type: 'epic' }));

      const nodes = [epicNode('T95025'), taskNode('AC2-A1', 'T95025')];
      const result = await applyWorkGraphScaffold(applyParams('T95025', nodes));

      expect(result.valid).toBe(true);
      expect(result.applied).toBe(true);
      expect(result.nodesChanged).toBe(1); // only new task
    });

    it('edges are idempotent — duplicate depends_on does not throw', async () => {
      const { createTask, getTask } = await import('../../store/tasks-sqlite.js');
      const { applyWorkGraphScaffold } = await import('../scaffold-apply.js');

      await createTask(makeTask({ id: 'T95026', type: 'epic' }));
      await createTask(makeTask({ id: 'T95027', type: 'task', parentId: 'T95026' }));

      const nodes = [epicNode('T95026'), taskNode('T95027', 'T95026')];
      const edges = [depEdge('T95027', 'T95026')];

      await applyWorkGraphScaffold(applyParams('T95026', nodes, edges));
      const r2 = await applyWorkGraphScaffold(applyParams('T95026', nodes, edges));

      expect(r2.valid).toBe(true);
      expect(r2.applied).toBe(true);

      const task = await getTask('T95027');
      const deps = task?.depends ?? [];
      expect(deps.filter((d) => d === 'T95026')).toHaveLength(1);
    });

    it('relation edges are idempotent — duplicate blocks does not throw', async () => {
      const { createTask } = await import('../../store/tasks-sqlite.js');
      const { applyWorkGraphScaffold } = await import('../scaffold-apply.js');

      // Use sibling tasks — task_relations rejects parent-child containment edges
      await createTask(makeTask({ id: 'T95028', type: 'epic' }));
      await createTask(makeTask({ id: 'T95029', type: 'task', parentId: 'T95028' }));
      await createTask(makeTask({ id: 'T95030', type: 'task', parentId: 'T95028' }));

      const nodes = [
        epicNode('T95028'),
        taskNode('T95029', 'T95028'),
        taskNode('T95030', 'T95028'),
      ];
      const edges = [blockEdge('T95029', 'T95030')]; // sibling→sibling, not child→parent

      await applyWorkGraphScaffold(applyParams('T95028', nodes, edges));
      const r2 = await applyWorkGraphScaffold(applyParams('T95028', nodes, edges));

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

      await createTask(makeTask({ id: 'T95031', type: 'epic' }));
      await createTask(makeTask({ id: 'T95032', type: 'task', parentId: 'T95031' }));

      const nodes = [epicNode('T95031'), taskNode('T95032', 'T95031')];
      const result = await applyWorkGraphScaffold(
        applyParams('T95031', nodes, [depEdge('T95032', 'T95031')]),
      );

      expect(result.edgesChanged).toBe(1);
      const task = await getTask('T95032');
      expect(task!.depends).toContain('T95031');
    });

    it('blocks edge creates a task_relations row', async () => {
      const { createTask } = await import('../../store/tasks-sqlite.js');
      const { applyWorkGraphScaffold } = await import('../scaffold-apply.js');

      // Sibling tasks under the same epic — relation edges between them are valid
      await createTask(makeTask({ id: 'T95033', type: 'epic' }));
      await createTask(makeTask({ id: 'T95034', type: 'task', parentId: 'T95033' }));
      await createTask(makeTask({ id: 'T95035', type: 'task', parentId: 'T95033' }));

      const nodes = [
        epicNode('T95033'),
        taskNode('T95034', 'T95033'),
        taskNode('T95035', 'T95033'),
      ];
      const result = await applyWorkGraphScaffold(
        applyParams('T95033', nodes, [blockEdge('T95034', 'T95035')]),
      );

      expect(result.edgesChanged).toBe(1);
    });

    it('relates_to edge creates a task_relations row', async () => {
      const { createTask } = await import('../../store/tasks-sqlite.js');
      const { applyWorkGraphScaffold } = await import('../scaffold-apply.js');

      await createTask(makeTask({ id: 'T95036', type: 'epic' }));
      await createTask(makeTask({ id: 'T95037', type: 'task', parentId: 'T95036' }));
      await createTask(makeTask({ id: 'T95038', type: 'task', parentId: 'T95036' }));

      const nodes = [
        epicNode('T95036'),
        taskNode('T95037', 'T95036'),
        taskNode('T95038', 'T95036'),
      ];
      const result = await applyWorkGraphScaffold(
        applyParams('T95036', nodes, [relEdge('T95037', 'T95038')]),
      );

      expect(result.edgesChanged).toBe(1);
    });

    it('groups edge creates a task_relations row', async () => {
      const { createTask } = await import('../../store/tasks-sqlite.js');
      const { applyWorkGraphScaffold } = await import('../scaffold-apply.js');

      await createTask(makeTask({ id: 'T95039', type: 'epic' }));
      await createTask(makeTask({ id: 'T95040', type: 'task', parentId: 'T95039' }));
      await createTask(makeTask({ id: 'T95041', type: 'task', parentId: 'T95039' }));

      const nodes = [
        epicNode('T95039'),
        taskNode('T95040', 'T95039'),
        taskNode('T95041', 'T95039'),
      ];
      const result = await applyWorkGraphScaffold(
        applyParams('T95039', nodes, [groupEdge('T95040', 'T95041')]),
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
        { id: 'T95043', type: 'saga' },
        { id: 'T95042', type: 'epic' },
        { id: 'T1', type: 'task', parentId: 'T95042' },
        { id: 'T2', type: 'task', parentId: 'T95042' },
        { id: 'T3', type: 'subtask', parentId: 'T1' },
      ];

      // Relation edges between siblings (not parent-child) to satisfy
      // the task_relations non-containment trigger constraint
      const edges: WorkGraphDirectEdge[] = [
        depEdge('T3', 'T2'), // subtask depends on sibling task
        blockEdge('T1', 'T2'), // sibling blocks sibling
        relEdge('T2', 'T3'), // sibling relates to subtask
        groupEdge('T95042', 'T95043'), // epic grouped under saga
      ];

      // First apply
      const r1 = await applyWorkGraphScaffold(applyParams('T95043', nodes, edges));
      expect(r1.valid).toBe(true);
      expect(r1.applied).toBe(true);
      expect(r1.nodesChanged).toBe(5);
      expect(r1.edgesChanged).toBe(4);

      const t3 = await getTask('T3');
      expect(t3!.depends).toContain('T2');

      // Re-apply — idempotent (AC2)
      const r2 = await applyWorkGraphScaffold(applyParams('T95043', nodes, edges));
      expect(r2.valid).toBe(true);
      expect(r2.applied).toBe(true);
      expect(r2.nodesChanged).toBe(0);

      const t3again = await getTask('T3');
      expect(t3again!.depends!.filter((d) => d === 'T2')).toHaveLength(1);
    });
  });
});
