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
 *   T-S (type='saga') — Saga
 *     ↳ parentId=T-S → T-E1 (epic)
 *         ↳ T-E1-A (pending, no deps)        — wave 1
 *         ↳ T-E1-B (pending, depends T-E1-A) — wave 2
 *     ↳ parentId=T-S → T-E2 (epic)
 *         ↳ T-E2-A (pending, no deps)        — wave 1
 *         ↳ T-E2-B (done)                    — excluded
 *     ↳ parentId=T-S → T-E3 (epic)
 *         ↳ T-E3-A (pending, no deps)        — wave 1
 *
 *   T-REGULAR (epic) — regression target
 *     ↳ T-REG-A (pending) — child via parentId
 *
 * @bug gh-390
 * @adr ADR-073
 * @task T9839
 * @task T10966 — Unify saga traversal and deep rollup Core semantics
 * @task T10969 — Add saga ready frontier tests
 */

import { createTask, orchestrateReady, orchestrateWaves, sagas } from '@cleocode/core/internal';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDbEnv } from '../../store/__tests__/test-db-helper.js';

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
      id: 'T-S',
      title: 'Saga Root',
      description: 'Saga grouping epics',
      type: 'saga' as const,
      status: 'active' as const,
      priority: 'high' as const,
      createdAt: ts,
      updatedAt: null,
    },
    // Member epics (linked via parentId=T-S)
    {
      id: 'T-E1',
      title: 'Member epic 1',
      description: 'First saga member',
      type: 'epic' as const,
      status: 'active' as const,
      priority: 'high' as const,
      parentId: 'T-S',
      createdAt: ts,
      updatedAt: null,
    },
    {
      id: 'T-E2',
      title: 'Member epic 2',
      description: 'Second saga member',
      type: 'epic' as const,
      status: 'active' as const,
      priority: 'medium' as const,
      parentId: 'T-S',
      createdAt: ts,
      updatedAt: null,
    },
    {
      id: 'T-E3',
      title: 'Member epic 3',
      description: 'Third saga member',
      type: 'epic' as const,
      status: 'active' as const,
      priority: 'medium' as const,
      parentId: 'T-S',
      createdAt: ts,
      updatedAt: null,
    },
    // T-E1 children
    {
      id: 'T-E1-A',
      title: 'E1 wave-1 task',
      description: 'Pending, no deps — wave 1',
      type: 'task' as const,
      status: 'pending' as const,
      priority: 'high' as const,
      parentId: 'T-E1',
      createdAt: ts,
      updatedAt: null,
    },
    {
      id: 'T-E1-B',
      title: 'E1 wave-2 task',
      description: 'Depends on E1-A — wave 2',
      type: 'task' as const,
      status: 'pending' as const,
      priority: 'medium' as const,
      parentId: 'T-E1',
      depends: ['T-E1-A'],
      createdAt: ts,
      updatedAt: null,
    },
    // T-E2 children
    {
      id: 'T-E2-A',
      title: 'E2 wave-1 task',
      description: 'Pending, no deps',
      type: 'task' as const,
      status: 'pending' as const,
      priority: 'critical' as const,
      parentId: 'T-E2',
      createdAt: ts,
      updatedAt: null,
    },
    {
      id: 'T-E2-B',
      title: 'E2 completed task',
      description: 'Already done',
      type: 'task' as const,
      status: 'done' as const,
      priority: 'low' as const,
      parentId: 'T-E2',
      createdAt: ts,
      updatedAt: null,
    },
    // T-E3 children
    {
      id: 'T-E3-A',
      title: 'E3 wave-1 task',
      description: 'Pending, no deps',
      type: 'task' as const,
      status: 'pending' as const,
      priority: 'medium' as const,
      parentId: 'T-E3',
      createdAt: ts,
      updatedAt: null,
    },
    // Regression baseline — regular epic with parentId-attached child.
    {
      id: 'T-REGULAR',
      title: 'Non-saga epic',
      description: 'Regular epic — should still walk parentId',
      type: 'epic' as const,
      status: 'active' as const,
      priority: 'medium' as const,
      createdAt: ts,
      updatedAt: null,
    },
    {
      id: 'T-REG-A',
      title: 'Regular child',
      description: 'Pending child of T-REGULAR',
      type: 'task' as const,
      status: 'pending' as const,
      priority: 'medium' as const,
      parentId: 'T-REGULAR',
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
    const result = await orchestrateReady('T-S', TEST_ROOT);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const data = result.data as ReadyData;

    // T-E1-A (high), T-E2-A (critical), T-E3-A (medium) are the wave-1
    // ready tasks across the 3 members. T-E1-B is blocked, T-E2-B is done.
    expect(data.via, 'auto-detected saga traversal').toBe('saga');
    expect(data.sagaMembers, 'all 3 member epics surfaced').toEqual(['T-E1', 'T-E2', 'T-E3']);
    expect(data.total, 'three wave-1 tasks ready across members').toBe(3);

    const ids = data.readyTasks.map((t) => t.id).sort();
    expect(ids).toEqual(['T-E1-A', 'T-E2-A', 'T-E3-A']);

    // Verify priority ordering (critical first).
    expect(data.readyTasks[0]?.id).toBe('T-E2-A');
    expect(data.readyTasks[0]?.priority).toBe('critical');
  });

  it('deduplicates tasks that appear under multiple members', async () => {
    const result = await orchestrateReady('T-S', TEST_ROOT);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const data = result.data as ReadyData;
    const ids = data.readyTasks.map((t) => t.id);
    expect(new Set(ids).size, 'no duplicate IDs').toBe(ids.length);
  });

  it('regression: non-saga epic still walks parentId', async () => {
    const result = await orchestrateReady('T-REGULAR', TEST_ROOT);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const data = result.data as ReadyData;
    expect(data.via).toBe('parent');
    expect(data.total).toBe(1);
    expect(data.readyTasks[0]?.id).toBe('T-REG-A');
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
    const result = await orchestrateWaves('T-S', TEST_ROOT);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const data = result.data as WavesData;

    expect(data.via).toBe('saga');
    expect(data.sagaMembers).toEqual(['T-E1', 'T-E2', 'T-E3']);

    // T-E1 has 2 waves (A then B). T-E2/T-E3 have 1 wave each (A only).
    // Merged: wave 1 = {E1-A, E2-A, E3-A}, wave 2 = {E1-B}.
    expect(data.totalWaves).toBe(2);

    const wave1Ids = data.waves[0]?.taskIds.sort() ?? [];
    expect(wave1Ids).toEqual(['T-E1-A', 'T-E2-A', 'T-E3-A']);

    const wave2Ids = data.waves[1]?.taskIds ?? [];
    expect(wave2Ids).toEqual(['T-E1-B']);

    // taskIds mirrors tasks.map(t => t.id) per wave (waves contract).
    for (const wave of data.waves) {
      expect(wave.taskIds).toEqual(wave.tasks.map((t) => t.id));
    }
  });

  it('regression: non-saga epic still walks parentId', async () => {
    const result = await orchestrateWaves('T-REGULAR', TEST_ROOT);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const data = result.data as WavesData;
    expect(data.via).toBe('parent');
    expect(data.totalTasks).toBe(1);
    expect(data.totalWaves).toBe(1);
    expect(data.waves[0]?.taskIds).toEqual(['T-REG-A']);
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
    const result = await sagas.sagaRollup(TEST_ROOT, { sagaId: 'T-S' });
    expect(result.success).toBe(true);
    if (!result.success) return;
    const data = result.data as DeepRollupData;

    // 3 member epics, all active
    expect(data.sagaId).toBe('T-S');
    expect(data.total).toBe(3);
    expect(data.active).toBe(3);
    expect(data.done).toBe(0);
    expect(data.completionPct).toBe(0);
  });

  it('includes deep task-level progress when requested', async () => {
    const result = await sagas.sagaRollup(TEST_ROOT, { sagaId: 'T-S' }, true);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const data = result.data as DeepRollupData;

    // Verify per-epic breakdowns exist
    expect(data.memberEpics).toBeDefined();
    expect(data.memberEpics!.length).toBe(3);

    // T-E1 has 2 descendant tasks (T-E1-A, T-E1-B), both pending
    const e1 = data.memberEpics!.find((m) => m.id === 'T-E1');
    expect(e1).toBeDefined();
    expect(e1!.descendantTaskCount).toBe(2);
    expect(e1!.descendantPending).toBe(2);
    expect(e1!.descendantDone).toBe(0);

    // T-E2 has 2 descendant tasks (T-E2-A pending, T-E2-B done)
    const e2 = data.memberEpics!.find((m) => m.id === 'T-E2');
    expect(e2).toBeDefined();
    expect(e2!.descendantTaskCount).toBe(2);
    expect(e2!.descendantPending).toBe(1);
    expect(e2!.descendantDone).toBe(1);
    expect(e2!.descendantCompletionPct).toBe(50);

    // T-E3 has 1 descendant task (T-E3-A), pending
    const e3 = data.memberEpics!.find((m) => m.id === 'T-E3');
    expect(e3).toBeDefined();
    expect(e3!.descendantTaskCount).toBe(1);
    expect(e3!.descendantPending).toBe(1);

    // Aggregate descendant stats
    expect(data.totalDescendantTasks).toBe(5); // 2 + 2 + 1
    expect(data.descendantDone).toBe(1); // T-E2-B
    expect(data.descendantCompletionPct).toBe(20); // 1/5
  });

  it('returns E_NOT_FOUND for non-existent saga', async () => {
    const result = await sagas.sagaRollup(TEST_ROOT, { sagaId: 'T-NONEXISTENT' });
    expect(result.success).toBe(false);
  });

  it('returns E_NOT_FOUND for a regular epic (not a saga)', async () => {
    const result = await sagas.sagaRollup(TEST_ROOT, { sagaId: 'T-REGULAR' });
    expect(result.success).toBe(false);
  });
});
