/**
 * Tests for `orchestrate.ready` and `orchestrate.waves` saga traversal
 * using `type='saga'` with `parent_id` containment (T10638 / T10966).
 *
 * After T10638, sagas use `type='saga'` and member Epics are linked via
 * `parentId` pointing at the saga (NOT `task_relations.groups`). The
 * saga walk auto-detects `type='saga'` and aggregates ready/wave data
 * across all member epics.
 *
 * After T10966, the `via` parameter is deprecated — all callers get
 * auto-detect behavior regardless of `via` value.
 *
 * Fixture layout (parent_id containment):
 *
 *   T97011 (type='saga') — Saga
 *     ↳ parentId=T97011 → T97000 (epic)
 *         ↳ T97001 (pending, no deps)        — wave 1
 *         ↳ T97002 (pending, depends T97001) — wave 2
 *     ↳ parentId=T97011 → T97003 (epic)
 *         ↳ T97004 (pending, no deps)        — wave 1
 *         ↳ T97005 (done)                    — excluded
 *     ↳ parentId=T97011 → T97006 (epic)
 *         ↳ T97007 (pending, no deps)        — wave 1
 *
 *   T97010 (epic) — regression target
 *     ↳ T97009 (pending) — child via parentId
 *
 * @bug gh-390
 * @adr ADR-073
 * @task T9839
 * @task T10966 — Unify saga traversal and deep rollup Core semantics
 * @task T10969 — Add saga ready frontier tests
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTask, orchestrateReady, orchestrateWaves, sagas } from '@cleocode/core/internal';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureProjectScope, worktreeScope } from '../../project-scope.js';
import { createTestDb, type TestDbEnv } from '../../store/__tests__/test-db-helper.js';
import { createOperationExecutionContext } from '../../store/background-ops.js';
import { getTaskAccessor } from '../../store/data-accessor.js';
import { getNativeTasksDb } from '../../store/sqlite.js';
import { loadTasks, orchestrateStatus } from '../query-ops.js';

let TEST_ROOT: string;
let env: TestDbEnv;

/**
 * Seed the saga fixture with type='saga' and parent_id containment.
 */
async function seedSagaFixture(testRoot: string): Promise<void> {
  const ts = '2026-05-21T00:00:00Z';

  const tasks = [
    // Saga (type='saga', NOT type='epic' + labels)
    {
      id: 'T97011',
      title: 'Saga Root',
      description: 'Saga grouping epics',
      type: 'saga' as const,
      status: 'active' as const,
      priority: 'high' as const,
      createdAt: ts,
      updatedAt: null,
    },
    // Member epics (linked via parentId=T97011)
    {
      id: 'T97000',
      title: 'Member epic 1',
      description: 'First saga member',
      type: 'epic' as const,
      status: 'active' as const,
      priority: 'high' as const,
      parentId: 'T97011',
      createdAt: ts,
      updatedAt: null,
    },
    {
      id: 'T97003',
      title: 'Member epic 2',
      description: 'Second saga member',
      type: 'epic' as const,
      status: 'active' as const,
      priority: 'medium' as const,
      parentId: 'T97011',
      createdAt: ts,
      updatedAt: null,
    },
    {
      id: 'T97006',
      title: 'Member epic 3',
      description: 'Third saga member',
      type: 'epic' as const,
      status: 'active' as const,
      priority: 'medium' as const,
      parentId: 'T97011',
      createdAt: ts,
      updatedAt: null,
    },
    // T97000 children
    {
      id: 'T97001',
      title: 'E1 wave-1 task',
      description: 'Pending, no deps — wave 1',
      type: 'task' as const,
      status: 'pending' as const,
      priority: 'high' as const,
      parentId: 'T97000',
      createdAt: ts,
      updatedAt: null,
    },
    {
      id: 'T97002',
      title: 'E1 wave-2 task',
      description: 'Depends on E1-A — wave 2',
      type: 'task' as const,
      status: 'pending' as const,
      priority: 'medium' as const,
      parentId: 'T97000',
      depends: ['T97001'],
      createdAt: ts,
      updatedAt: null,
    },
    // T97003 children
    {
      id: 'T97004',
      title: 'E2 wave-1 task',
      description: 'Pending, no deps',
      type: 'task' as const,
      status: 'pending' as const,
      priority: 'critical' as const,
      parentId: 'T97003',
      createdAt: ts,
      updatedAt: null,
    },
    {
      id: 'T97005',
      title: 'E2 completed task',
      description: 'Already done',
      type: 'task' as const,
      status: 'done' as const,
      priority: 'low' as const,
      parentId: 'T97003',
      createdAt: ts,
      updatedAt: null,
    },
    // T97006 children
    {
      id: 'T97007',
      title: 'E3 wave-1 task',
      description: 'Pending, no deps',
      type: 'task' as const,
      status: 'pending' as const,
      priority: 'medium' as const,
      parentId: 'T97006',
      createdAt: ts,
      updatedAt: null,
    },
    // Regression baseline — regular epic with parentId-attached child.
    {
      id: 'T97010',
      title: 'Non-saga epic',
      description: 'Regular epic — should still walk parentId',
      type: 'epic' as const,
      status: 'active' as const,
      priority: 'medium' as const,
      createdAt: ts,
      updatedAt: null,
    },
    {
      id: 'T97009',
      title: 'Regular child',
      description: 'Pending child of T97010',
      type: 'task' as const,
      status: 'pending' as const,
      priority: 'medium' as const,
      parentId: 'T97010',
      createdAt: ts,
      updatedAt: null,
    },
  ];

  for (const task of tasks) {
    await createTask(task as Parameters<typeof createTask>[0], testRoot);
  }
}

beforeEach(async () => {
  env = await createTestDb();
  TEST_ROOT = env.tempDir;
  await seedSagaFixture(TEST_ROOT);
});

afterEach(async () => {
  try {
    const { closeAllDatabases } = await import('@cleocode/core/internal');
    await closeAllDatabases();
  } catch {
    // ignore cleanup errors
  }
  vi.unstubAllEnvs();
  await env.cleanup();
});

// ---------------------------------------------------------------------------
// orchestrateReady — saga walk (T10966: auto-detect)
// ---------------------------------------------------------------------------

describe('orchestrateReady — saga traversal (type=saga, T10966)', () => {
  interface ReadyData {
    epicId: string;
    readyTasks: Array<{ id: string; title: string; priority: string; depends: string[] }>;
    total: number;
    via?: 'parent' | 'saga';
    sagaMembers?: string[];
    reason?: string;
  }

  it('auto-detects saga shape and aggregates ready tasks from member epics', async () => {
    const result = await orchestrateReady('T97011', TEST_ROOT);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const data = result.data as ReadyData;

    // T97001 (high), T97004 (critical), T97007 (medium) are the wave-1
    // ready tasks across the 3 members. T97002 is blocked, T97005 is done.
    expect(data.via, 'auto-detected saga traversal').toBe('saga');
    expect(data.sagaMembers, 'all 3 member epics surfaced').toEqual(['T97000', 'T97003', 'T97006']);
    expect(data.total, 'three wave-1 tasks ready across members').toBe(3);

    const ids = data.readyTasks.map((t) => t.id).sort();
    expect(ids).toEqual(['T97001', 'T97004', 'T97007']);

    // Verify priority ordering (critical first).
    expect(data.readyTasks[0]?.id).toBe('T97004');
    expect(data.readyTasks[0]?.priority).toBe('critical');
  });

  it('deduplicates tasks that appear under multiple members', async () => {
    const result = await orchestrateReady('T97011', TEST_ROOT);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const data = result.data as ReadyData;
    const ids = data.readyTasks.map((t) => t.id);
    expect(new Set(ids).size, 'no duplicate IDs').toBe(ids.length);
  });

  it('regression: non-saga epic still walks parentId', async () => {
    const result = await orchestrateReady('T97010', TEST_ROOT);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const data = result.data as ReadyData;
    expect(data.via).toBe('parent');
    expect(data.total).toBe(1);
    expect(data.readyTasks[0]?.id).toBe('T97009');
    expect(data.sagaMembers).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// orchestrateWaves — saga walk (T10966: auto-detect)
// ---------------------------------------------------------------------------

describe('orchestrateWaves — saga traversal (type=saga, T10966)', () => {
  interface WavesData {
    epicId: string;
    waves: Array<{ waveNumber: number; taskIds: string[]; tasks: Array<{ id: string }> }>;
    totalWaves: number;
    totalTasks: number;
    via?: 'parent' | 'saga';
    sagaMembers?: string[];
  }

  it('auto-detects saga shape and merges per-member wave plans by wave index', async () => {
    const result = await orchestrateWaves('T97011', TEST_ROOT);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const data = result.data as WavesData;

    expect(data.via).toBe('saga');
    expect(data.sagaMembers).toEqual(['T97000', 'T97003', 'T97006']);

    // T97000 has 2 waves (A then B). T97003/T97006 have 1 wave each (A only).
    // Merged: wave 1 = {E1-A, E2-A, E3-A}, wave 2 = {E1-B}.
    expect(data.totalWaves).toBe(2);

    const wave1Ids = data.waves[0]?.taskIds.toSorted() ?? [];
    // Done T97005 keeps its wave too (stable numbering, T12682).
    expect(wave1Ids).toEqual(['T97001', 'T97004', 'T97005', 'T97007']);

    const wave2Ids = data.waves[1]?.taskIds ?? [];
    expect(wave2Ids).toEqual(['T97002']);

    // taskIds mirrors tasks.map(t => t.id) per wave (waves contract).
    for (const wave of data.waves) {
      expect(wave.taskIds).toEqual(wave.tasks.map((t) => t.id));
    }
  });

  it('regression: non-saga epic still walks parentId', async () => {
    const result = await orchestrateWaves('T97010', TEST_ROOT);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const data = result.data as WavesData;
    expect(data.via).toBe('parent');
    expect(data.totalTasks).toBe(1);
    expect(data.totalWaves).toBe(1);
    expect(data.waves[0]?.taskIds).toEqual(['T97009']);
    expect(data.sagaMembers).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// sagas.sagaRollup — deep task-level progress (T10966)
// ---------------------------------------------------------------------------

describe('sagas.sagaRollup — deep rollup with task-level progress (T10966)', () => {
  interface DeepRollupData {
    sagaId: string;
    total: number;
    done: number;
    active: number;
    blocked: number;
    pending: number;
    completionPct: number;
    memberEpics?: Array<{
      id: string;
      title: string;
      status: string;
      descendantTaskCount: number;
      descendantDone: number;
      descendantActive: number;
      descendantBlocked: number;
      descendantPending: number;
      descendantCompletionPct: number;
    }>;
    totalDescendantTasks?: number;
    descendantDone?: number;
    descendantCompletionPct?: number;
  }

  it('returns epic-level rollup for a saga', async () => {
    const result = await sagas.sagaRollup(TEST_ROOT, { sagaId: 'T97011' });
    expect(result.success).toBe(true);
    if (!result.success) return;
    const data = result.data as DeepRollupData;

    // 3 member epics, all active
    expect(data.sagaId).toBe('T97011');
    expect(data.total).toBe(3);
    expect(data.active).toBe(3);
    expect(data.done).toBe(0);
    expect(data.completionPct).toBe(0);
  });

  it('includes deep task-level progress when requested', async () => {
    const result = await sagas.sagaRollup(TEST_ROOT, { sagaId: 'T97011' }, true);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const data = result.data as DeepRollupData;

    // Verify per-epic breakdowns exist
    expect(data.memberEpics).toBeDefined();
    expect(data.memberEpics!.length).toBe(3);

    // T97000 has 2 descendant tasks (T97001, T97002), both pending
    const e1 = data.memberEpics!.find((m) => m.id === 'T97000');
    expect(e1).toBeDefined();
    expect(e1!.descendantTaskCount).toBe(2);
    expect(e1!.descendantPending).toBe(2);
    expect(e1!.descendantDone).toBe(0);

    // T97003 has 2 descendant tasks (T97004 pending, T97005 done)
    const e2 = data.memberEpics!.find((m) => m.id === 'T97003');
    expect(e2).toBeDefined();
    expect(e2!.descendantTaskCount).toBe(2);
    expect(e2!.descendantPending).toBe(1);
    expect(e2!.descendantDone).toBe(1);
    expect(e2!.descendantCompletionPct).toBe(50);

    // T97006 has 1 descendant task (T97007), pending
    const e3 = data.memberEpics!.find((m) => m.id === 'T97006');
    expect(e3).toBeDefined();
    expect(e3!.descendantTaskCount).toBe(1);
    expect(e3!.descendantPending).toBe(1);

    // Aggregate descendant stats
    expect(data.totalDescendantTasks).toBe(5); // 2 + 2 + 1
    expect(data.descendantDone).toBe(1); // T97005
    expect(data.descendantCompletionPct).toBe(20); // 1/5
  });

  it('returns E_NOT_FOUND for non-existent saga', async () => {
    const result = await sagas.sagaRollup(TEST_ROOT, { sagaId: 'T97008' });
    expect(result.success).toBe(false);
  });

  it('returns E_NOT_FOUND for a regular epic (not a saga)', async () => {
    const result = await sagas.sagaRollup(TEST_ROOT, { sagaId: 'T97010' });
    expect(result.success).toBe(false);
  });
});

describe('orchestrate query project ownership and diagnostics', () => {
  function emptyProject(): string {
    const root = join(TEST_ROOT, 'other');
    mkdirSync(join(root, '.cleo'), { recursive: true });
    writeFileSync(
      join(root, '.cleo', 'config.json'),
      JSON.stringify({ verification: { enabled: false } }),
    );
    return root;
  }

  it('keeps explicit saga queries in their requested project despite contradictory ambient pins', async () => {
    const other = emptyProject();
    await getTaskAccessor(other);
    vi.stubEnv('CLEO_ROOT', other);
    vi.stubEnv('CLEO_DIR', join(other, '.cleo'));
    const result = await orchestrateReady('T97011', TEST_ROOT);
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ epicId: 'T97011', total: 3 });
    expect((await loadTasks(TEST_ROOT)).some((task) => task.id === 'T97011')).toBe(true);
    expect(await loadTasks(other)).toEqual([]);
    expect((await orchestrateStatus(undefined, other)).success).toBe(true);
  });

  it('captures the default root before awaits and keeps interleaved explicit reads distinct', async () => {
    const other = emptyProject();
    vi.stubEnv('CLEO_ROOT', TEST_ROOT);
    vi.stubEnv('CLEO_DIR', join(TEST_ROOT, '.cleo'));
    const captured = loadTasks();
    vi.stubEnv('CLEO_ROOT', other);
    vi.stubEnv('CLEO_DIR', join(other, '.cleo'));
    const [original, empty, explicit] = await Promise.all([
      captured,
      loadTasks(other),
      loadTasks(TEST_ROOT),
    ]);
    expect(original.map((task) => task.id)).toContain('T97011');
    expect(explicit.map((task) => task.id)).toContain('T97011');
    expect(empty).toEqual([]);
  });

  it('returns the established query error envelope when inherited authority has expired', async () => {
    const controller = new AbortController();
    const context = createOperationExecutionContext(
      {
        projectId: 'cancelled-query-fixture',
        projectRoot: TEST_ROOT,
        actor: 'test',
        operation: 'orchestrate.status',
        idempotencyKey: 'expired-query',
      },
      { signal: controller.signal },
    );
    controller.abort();
    try {
      const scope = { worktreeRoot: TEST_ROOT, projectHash: 'fixture', execution: context };
      const result = await worktreeScope.run(scope, () => orchestrateStatus(undefined, TEST_ROOT));
      expect(result.success).toBe(false);
      expect(result.error?.message).toMatch(/cancel|abort/i);
      await expect(worktreeScope.run(scope, () => loadTasks(TEST_ROOT))).rejects.toThrow(
        /cancel|abort/i,
      );
    } finally {
      context.close();
    }
  });

  it('surfaces a real storage read failure instead of reporting an empty healthy project', async () => {
    const native = await worktreeScope.run(captureProjectScope(TEST_ROOT, undefined), () =>
      getNativeTasksDb(TEST_ROOT),
    );
    native.exec('ALTER TABLE tasks_tasks RENAME TO tasks_tasks_unreadable_fixture');
    try {
      await expect(loadTasks(TEST_ROOT)).rejects.toThrow(/tasks_tasks/);
      const result = await orchestrateStatus(undefined, TEST_ROOT);
      expect(result.success).toBe(false);
      expect(result.error?.message).toMatch(/tasks_tasks/);
    } finally {
      native.exec('ALTER TABLE tasks_tasks_unreadable_fixture RENAME TO tasks_tasks');
    }
  });
});
