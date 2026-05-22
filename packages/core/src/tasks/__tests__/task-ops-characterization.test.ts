/**
 * Characterization tests for task-ops.ts public surface.
 * Written BEFORE the split to prove zero behavior change after refactor.
 * @task T10064
 * @epic T9834
 */

import type { Task } from '@cleocode/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../store/data-accessor.js', () => ({
  getAccessor: vi.fn(),
  getTaskAccessor: vi.fn(),
}));

vi.mock('../../store/file-utils.js', () => ({
  readJsonFile: vi.fn(() => null),
  getDataPath: vi.fn((_root: string, file: string) => `/mock/${file}`),
}));

vi.mock('../deps-ready.js', () => ({
  depsReady: vi.fn((depends: string[], taskMap: Map<string, Task>) => {
    if (!depends || depends.length === 0) return true;
    return depends.every((id) => {
      const dep = taskMap.get(id);
      return dep?.status === 'done' || dep?.status === 'cancelled';
    });
  }),
}));

vi.mock('../../intelligence/impact.js', () => ({
  predictImpact: vi.fn().mockResolvedValue({ impact: [] }),
}));

import { getTaskAccessor } from '../../store/data-accessor.js';
import {
  coreTaskAnalyze,
  coreTaskBlockers,
  coreTaskComplexityEstimate,
  coreTaskDepends,
  coreTaskDepsCycles,
  coreTaskDepsOverview,
  coreTaskImport,
  coreTaskNext,
  coreTaskReparent,
  coreTaskTree,
} from '../task-ops.js';

function makeTask(overrides: Partial<Task> & { id: string; title: string }): Task {
  return {
    description: `Description for ${overrides.id}`,
    status: 'pending',
    priority: 'medium',
    createdAt: new Date().toISOString(),
    updatedAt: null,
    depends: [],
    ...overrides,
  } as Task;
}

function setupAccessor(tasks: Task[], extraMethods: Record<string, unknown> = {}): void {
  const mockImpl = {
    queryTasks: vi.fn().mockResolvedValue({ tasks, total: tasks.length }),
    getMetaValue: vi.fn().mockResolvedValue(null),
    loadSingleTask: vi
      .fn()
      .mockImplementation(async (id: string) => tasks.find((t) => t.id === id) ?? null),
    taskExists: vi.fn().mockImplementation(async (id: string) => tasks.some((t) => t.id === id)),
    upsertSingleTask: vi.fn().mockResolvedValue(undefined),
    getChildren: vi
      .fn()
      .mockImplementation(async (parentId: string) => tasks.filter((t) => t.parentId === parentId)),
    getAncestorChain: vi.fn().mockResolvedValue([]),
    getSubtree: vi.fn().mockImplementation(async (id: string) => {
      const result: Task[] = [];
      const collect = (parentId: string) => {
        for (const t of tasks) {
          if (t.parentId === parentId) {
            result.push(t);
            collect(t.id);
          }
        }
      };
      collect(id);
      return result;
    }),
    addRelation: vi.fn().mockResolvedValue(undefined),
    updateTaskFields: vi.fn().mockResolvedValue(undefined),
    claimTask: vi.fn().mockResolvedValue(undefined),
    unclaimTask: vi.fn().mockResolvedValue(undefined),
    ...extraMethods,
  };
  (getTaskAccessor as ReturnType<typeof vi.fn>).mockResolvedValue(mockImpl);
}

describe('coreTaskNext — characterization', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns empty when no pending tasks', async () => {
    setupAccessor([makeTask({ id: 'T001', title: 'Done task', status: 'done' })]);
    const result = await coreTaskNext('/mock');
    expect(result.suggestions).toEqual([]);
    expect(result.totalCandidates).toBe(0);
  });

  it('returns highest-priority task first', async () => {
    setupAccessor([
      makeTask({ id: 'T001', title: 'Low priority', priority: 'low' }),
      makeTask({ id: 'T002', title: 'Critical priority', priority: 'critical' }),
    ]);
    const result = await coreTaskNext('/mock', { count: 2 });
    expect(result.suggestions[0]!.id).toBe('T002');
    expect(result.totalCandidates).toBe(2);
  });

  it('includes reasons when explain=true', async () => {
    setupAccessor([makeTask({ id: 'T001', title: 'Task 1', priority: 'high' })]);
    const result = await coreTaskNext('/mock', { explain: true });
    expect(result.suggestions[0]!.reasons).toBeDefined();
    expect(result.suggestions[0]!.reasons!.length).toBeGreaterThan(0);
  });

  it('respects count limit', async () => {
    setupAccessor([
      makeTask({ id: 'T001', title: 'Task 1' }),
      makeTask({ id: 'T002', title: 'Task 2' }),
      makeTask({ id: 'T003', title: 'Task 3' }),
    ]);
    const result = await coreTaskNext('/mock', { count: 2 });
    expect(result.suggestions.length).toBe(2);
  });
});

describe('coreTaskBlockers — characterization', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns summary with no blocked tasks', async () => {
    setupAccessor([makeTask({ id: 'T001', title: 'Pending task' })]);
    const result = await coreTaskBlockers('/mock');
    expect(result.summary).toBe('No blocked tasks found');
    expect(result.total).toBe(0);
  });

  it('identifies explicitly blocked tasks', async () => {
    setupAccessor([
      makeTask({ id: 'T001', title: 'Blocker task' }),
      makeTask({ id: 'T002', title: 'Blocked task', status: 'blocked' }),
    ]);
    const result = await coreTaskBlockers('/mock');
    expect(result.blockedTasks.length).toBe(1);
    expect(result.blockedTasks[0]!.id).toBe('T002');
    expect(result.total).toBe(1);
  });

  it('identifies dep-blocked pending tasks', async () => {
    setupAccessor([
      makeTask({ id: 'T001', title: 'Blocker task', status: 'pending' }),
      makeTask({ id: 'T002', title: 'Blocked by dep', status: 'pending', depends: ['T001'] }),
    ]);
    const result = await coreTaskBlockers('/mock');
    expect(result.total).toBe(1);
    expect(result.blockedTasks[0]!.id).toBe('T002');
  });

  it('respects limit param', async () => {
    const tasks = Array.from({ length: 5 }, (_, i) =>
      makeTask({ id: `T00${i + 1}`, title: `Task ${i + 1}`, status: 'blocked' }),
    );
    setupAccessor(tasks);
    const result = await coreTaskBlockers('/mock', { limit: 3 });
    expect(result.blockedTasks.length).toBe(3);
    expect(result.total).toBe(5);
  });
});

describe('coreTaskTree — characterization', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns flat list of root tasks with no children', async () => {
    setupAccessor([
      makeTask({ id: 'T001', title: 'Root 1' }),
      makeTask({ id: 'T002', title: 'Root 2' }),
    ]);
    const result = await coreTaskTree('/mock');
    expect(result.tree.length).toBe(2);
    expect(result.totalNodes).toBe(2);
  });

  it('nests children under parents', async () => {
    setupAccessor([
      makeTask({ id: 'T001', title: 'Parent' }),
      makeTask({ id: 'T002', title: 'Child', parentId: 'T001' }),
    ]);
    const result = await coreTaskTree('/mock');
    expect(result.tree.length).toBe(1);
    expect(result.tree[0]!.children.length).toBe(1);
    expect(result.tree[0]!.children[0]!.id).toBe('T002');
    expect(result.totalNodes).toBe(2);
  });

  it('filters to subtree when taskId provided', async () => {
    setupAccessor([
      makeTask({ id: 'T001', title: 'Root 1' }),
      makeTask({ id: 'T002', title: 'Root 2' }),
      makeTask({ id: 'T003', title: 'Child of T001', parentId: 'T001' }),
    ]);
    const result = await coreTaskTree('/mock', 'T001');
    expect(result.tree.length).toBe(1);
    expect(result.tree[0]!.id).toBe('T001');
  });

  it('throws when taskId not found', async () => {
    setupAccessor([makeTask({ id: 'T001', title: 'Task 1' })]);
    await expect(coreTaskTree('/mock', 'T999')).rejects.toThrow("Task 'T999' not found");
  });

  it('annotates blockerChain when withBlockers=true', async () => {
    setupAccessor([
      makeTask({ id: 'T001', title: 'Leaf', status: 'pending' }),
      makeTask({ id: 'T002', title: 'Middle', depends: ['T001'], status: 'pending' }),
    ]);
    const result = await coreTaskTree('/mock', undefined, true);
    const middle = result.tree.find((n) => n.id === 'T002');
    expect(middle?.blockerChain).toBeDefined();
    expect(middle?.leafBlockers).toBeDefined();
  });
});

describe('coreTaskAnalyze — characterization', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns null recommended when no actionable tasks', async () => {
    setupAccessor([makeTask({ id: 'T001', title: 'Done', status: 'done' })]);
    const result = await coreTaskAnalyze('/mock');
    expect(result.recommended).toBeNull();
  });

  it('identifies bottlenecks (tasks that block others)', async () => {
    setupAccessor([
      makeTask({ id: 'T001', title: 'Blocker', status: 'pending' }),
      makeTask({ id: 'T002', title: 'Depends on T001', depends: ['T001'], status: 'pending' }),
      makeTask({ id: 'T003', title: 'Also depends on T001', depends: ['T001'], status: 'pending' }),
    ]);
    const result = await coreTaskAnalyze('/mock');
    expect(result.bottlenecks.length).toBeGreaterThan(0);
    expect(result.bottlenecks[0]!.id).toBe('T001');
    expect(result.bottlenecks[0]!.blocksCount).toBe(2);
  });

  it('returns correct metrics', async () => {
    setupAccessor([
      makeTask({ id: 'T001', title: 'Pending', status: 'pending' }),
      makeTask({ id: 'T002', title: 'Active', status: 'active' }),
      makeTask({ id: 'T003', title: 'Blocked', status: 'blocked' }),
    ]);
    const result = await coreTaskAnalyze('/mock');
    expect(result.metrics.totalTasks).toBe(3);
    expect(result.metrics.actionable).toBe(2); // pending + active
    expect(result.metrics.blocked).toBe(1);
  });

  it('respects tierLimit', async () => {
    const tasks = Array.from({ length: 10 }, (_, i) =>
      makeTask({
        id: `T${String(i + 1).padStart(3, '0')}`,
        title: `Task ${i + 1}`,
        priority: 'critical',
      }),
    );
    setupAccessor(tasks);
    const result = await coreTaskAnalyze('/mock', undefined, { tierLimit: 3 });
    expect(result.tierLimit).toBe(3);
    expect(result.tiers.critical.length).toBeLessThanOrEqual(3);
  });
});

describe('coreTaskComplexityEstimate — characterization', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns small for minimal task', async () => {
    setupAccessor([makeTask({ id: 'T001', title: 'Simple task', description: 'Short desc' })]);
    const result = await coreTaskComplexityEstimate('/mock', { taskId: 'T001' });
    expect(result.size).toBe('small');
    expect(result.factors.length).toBeGreaterThan(0);
  });

  it('returns large for complex task', async () => {
    const longDesc = 'x'.repeat(600);
    const tasks = [
      makeTask({
        id: 'T001',
        title: 'Complex task',
        description: longDesc,
        acceptance: ['AC1', 'AC2', 'AC3'],
        depends: ['T002', 'T003'],
      }),
      makeTask({ id: 'T002', title: 'Dep 1', depends: ['T003'] }),
      makeTask({ id: 'T003', title: 'Dep 2' }),
    ];
    setupAccessor(tasks);
    const result = await coreTaskComplexityEstimate('/mock', { taskId: 'T001' });
    expect(result.size).toBe('large');
  });

  it('throws when task not found', async () => {
    setupAccessor([]);
    await expect(coreTaskComplexityEstimate('/mock', { taskId: 'T999' })).rejects.toThrow(
      "Task 'T999' not found",
    );
  });

  it('returns correct factor names', async () => {
    setupAccessor([makeTask({ id: 'T001', title: 'Task' })]);
    const result = await coreTaskComplexityEstimate('/mock', { taskId: 'T001' });
    const names = result.factors.map((f) => f.name);
    expect(names).toContain('descriptionLength');
    expect(names).toContain('acceptanceCriteria');
    expect(names).toContain('dependencyDepth');
    expect(names).toContain('subtaskCount');
    expect(names).toContain('fileReferences');
  });
});

describe('coreTaskDepends — characterization', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns upstream deps', async () => {
    setupAccessor([
      makeTask({ id: 'T001', title: 'Upstream' }),
      makeTask({ id: 'T002', title: 'Downstream', depends: ['T001'] }),
    ]);
    const result = await coreTaskDepends('/mock', 'T002', 'upstream');
    expect(result.upstream.length).toBe(1);
    expect(result.upstream[0]!.id).toBe('T001');
    expect(result.downstream.length).toBe(0);
  });

  it('returns downstream deps', async () => {
    setupAccessor([
      makeTask({ id: 'T001', title: 'Upstream' }),
      makeTask({ id: 'T002', title: 'Downstream', depends: ['T001'] }),
    ]);
    const result = await coreTaskDepends('/mock', 'T001', 'downstream');
    expect(result.downstream.length).toBe(1);
    expect(result.downstream[0]!.id).toBe('T002');
  });

  it('counts unresolvedChain transitively', async () => {
    setupAccessor([
      makeTask({ id: 'T001', title: 'Root' }),
      makeTask({ id: 'T002', title: 'Middle', depends: ['T001'] }),
      makeTask({ id: 'T003', title: 'Leaf', depends: ['T002'] }),
    ]);
    const result = await coreTaskDepends('/mock', 'T003', 'both');
    expect(result.unresolvedChain).toBe(2);
  });

  it('throws when task not found', async () => {
    setupAccessor([]);
    await expect(coreTaskDepends('/mock', 'T999')).rejects.toThrow("Task 'T999' not found");
  });
});

describe('coreTaskDepsOverview — characterization', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns project-wide dep summary', async () => {
    setupAccessor([
      makeTask({ id: 'T001', title: 'Pending' }),
      makeTask({ id: 'T002', title: 'Has dep', depends: ['T001'] }),
    ]);
    const result = await coreTaskDepsOverview('/mock');
    expect(result.totalTasks).toBe(2);
    expect(result.tasksWithDeps).toBe(1);
  });
});

describe('coreTaskDepsCycles — characterization', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns no cycles for acyclic deps', async () => {
    setupAccessor([
      makeTask({ id: 'T001', title: 'Root' }),
      makeTask({ id: 'T002', title: 'Child', depends: ['T001'] }),
    ]);
    const result = await coreTaskDepsCycles('/mock');
    expect(result.hasCycles).toBe(false);
    expect(result.cycles).toHaveLength(0);
  });
});

describe('coreTaskReparent — characterization', () => {
  beforeEach(() => vi.clearAllMocks());

  it('promotes to root when newParentId is null', async () => {
    const tasks = [
      makeTask({ id: 'T001', title: 'Parent' }),
      makeTask({ id: 'T002', title: 'Child', parentId: 'T001' }),
    ];
    setupAccessor(tasks);
    const result = await coreTaskReparent('/mock', 'T002', null);
    expect(result.reparented).toBe(true);
    expect(result.oldParent).toBe('T001');
    expect(result.newParent).toBeNull();
  });

  it('throws when task not found', async () => {
    setupAccessor([]);
    await expect(coreTaskReparent('/mock', 'T999', null)).rejects.toThrow("Task 'T999' not found");
  });

  it('throws when new parent is subtask', async () => {
    const tasks = [
      makeTask({ id: 'T001', title: 'Subtask parent', type: 'subtask' }),
      makeTask({ id: 'T002', title: 'Task to reparent' }),
    ];
    setupAccessor(tasks);
    await expect(coreTaskReparent('/mock', 'T002', 'T001')).rejects.toThrow(
      "Cannot parent under subtask 'T001'",
    );
  });
});

describe('coreTaskImport — characterization', () => {
  beforeEach(() => vi.clearAllMocks());

  it('imports tasks from JSON array', async () => {
    setupAccessor([]);
    const json = JSON.stringify([
      { id: 'T500', title: 'Imported task', status: 'pending', priority: 'medium' },
    ]);
    const result = await coreTaskImport('/mock', json);
    expect(result.imported).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  it('skips existing tasks when overwrite=false', async () => {
    setupAccessor([makeTask({ id: 'T001', title: 'Existing' })]);
    const json = JSON.stringify([
      { id: 'T001', title: 'Existing', status: 'pending', priority: 'medium' },
    ]);
    const result = await coreTaskImport('/mock', json, false);
    expect(result.skipped).toBe(1);
    expect(result.imported).toBe(0);
  });

  it('returns error for invalid JSON', async () => {
    setupAccessor([]);
    await expect(coreTaskImport('/mock', 'not-json')).rejects.toThrow('Invalid JSON');
  });

  it('reports error for tasks missing id or title', async () => {
    setupAccessor([]);
    const json = JSON.stringify([{ status: 'pending' }]);
    const result = await coreTaskImport('/mock', json);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.skipped).toBe(1);
  });
});
