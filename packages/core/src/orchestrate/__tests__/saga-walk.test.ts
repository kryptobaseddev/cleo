/**
 * Regression tests for gh-390 — `orchestrate.ready` and `orchestrate.waves`
 * must traverse the Saga `task_relations.type='groups'` relation when the
 * target epic carries `label='saga'` (ADR-073).
 *
 * Before this fix both ops walked only `parentId`, so sagas (which DO NOT
 * use `parentId` for member linkage) returned `total: 0` with
 * `reason: "epic has no children"`. This test seeds a saga with 3 member
 * epics, each holding a small pending task set, and asserts the aggregated
 * ready + merged wave plans flow through.
 *
 * Fixture layout:
 *
 *   T-S (epic, labels=['saga']) — Saga
 *     ↳ groups → T-E1 (epic)
 *         ↳ T-E1-A (pending, no deps)        — wave 1
 *         ↳ T-E1-B (pending, depends T-E1-A) — wave 2
 *     ↳ groups → T-E2 (epic)
 *         ↳ T-E2-A (pending, no deps)        — wave 1
 *         ↳ T-E2-B (done)                    — excluded
 *     ↳ groups → T-E3 (epic)
 *         ↳ T-E3-A (pending, no deps)        — wave 1
 *
 *   T-REGULAR (epic, no labels) — regression target
 *     ↳ T-REG-A (pending) — child via parentId
 *
 * @bug gh-390
 * @adr ADR-073
 * @task T9839
 */

import { mkdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  addRelation,
  createTask,
  getDb,
  orchestrateReady,
  orchestrateWaves,
} from '@cleocode/core/internal';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let TEST_ROOT: string;

/**
 * Seed the saga fixture described in the file header.
 */
async function seedSagaFixture(testRoot: string): Promise<void> {
  const cleoDir = join(testRoot, '.cleo');
  mkdirSync(cleoDir, { recursive: true });
  // validateProjectRoot requires `.git/` sibling for the walk-up.
  mkdirSync(join(testRoot, '.git'), { recursive: true });
  await getDb(testRoot);

  const ts = '2026-05-21T00:00:00Z';

  const tasks = [
    // Saga
    {
      id: 'T-S',
      title: 'Saga Root',
      description: 'Saga grouping epic',
      type: 'epic' as const,
      status: 'active' as const,
      priority: 'high' as const,
      labels: ['saga'],
      createdAt: ts,
      updatedAt: null,
    },
    // Member epics
    {
      id: 'T-E1',
      title: 'Member epic 1',
      description: 'First saga member',
      type: 'epic' as const,
      status: 'active' as const,
      priority: 'high' as const,
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

  // Link saga members via task_relations.type='groups'.
  await addRelation('T-S', 'T-E1', 'groups', testRoot);
  await addRelation('T-S', 'T-E2', 'groups', testRoot);
  await addRelation('T-S', 'T-E3', 'groups', testRoot);
}

beforeEach(async () => {
  TEST_ROOT = await mkdtemp(join(tmpdir(), 'cleo-saga-walk-test-'));
  await seedSagaFixture(TEST_ROOT);
});

afterEach(async () => {
  try {
    const { closeAllDatabases } = await import('@cleocode/core/internal');
    await closeAllDatabases();
  } catch {
    // ignore cleanup errors
  }
  await rm(TEST_ROOT, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// orchestrateReady — saga walk
// ---------------------------------------------------------------------------

describe('orchestrateReady — saga groups-relation walk (gh-390)', () => {
  interface ReadyData {
    epicId: string;
    readyTasks: Array<{ id: string; title: string; priority: string; depends: string[] }>;
    total: number;
    via?: 'parent' | 'saga';
    sagaMembers?: string[];
    reason?: string;
  }

  it('default --via=both: aggregates ready tasks from saga member epics', async () => {
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
    // Re-issuing the same ready query MUST not double-count.
    const result = await orchestrateReady('T-S', TEST_ROOT);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const data = result.data as ReadyData;
    const ids = data.readyTasks.map((t) => t.id);
    expect(new Set(ids).size, 'no duplicate IDs').toBe(ids.length);
  });

  it('--via=parent on a saga returns empty (legacy behaviour preserved)', async () => {
    const result = await orchestrateReady('T-S', TEST_ROOT, { via: 'parent' });
    expect(result.success).toBe(true);
    if (!result.success) return;
    const data = result.data as ReadyData;
    expect(data.via).toBe('parent');
    expect(data.total).toBe(0);
    expect(data.reason).toBe('epic has no children');
  });

  it('--via=saga walks ONLY the groups relation', async () => {
    const result = await orchestrateReady('T-S', TEST_ROOT, { via: 'saga' });
    expect(result.success).toBe(true);
    if (!result.success) return;
    const data = result.data as ReadyData;
    expect(data.via).toBe('saga');
    expect(data.total).toBe(3);
    expect(data.sagaMembers).toEqual(['T-E1', 'T-E2', 'T-E3']);
  });

  it('regression: non-saga epic still walks parentId (default via=both)', async () => {
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
// orchestrateWaves — saga walk
// ---------------------------------------------------------------------------

describe('orchestrateWaves — saga groups-relation walk (gh-390)', () => {
  interface WavesData {
    epicId: string;
    waves: Array<{ waveNumber: number; taskIds: string[]; tasks: Array<{ id: string }> }>;
    totalWaves: number;
    totalTasks: number;
    via?: 'parent' | 'saga';
    sagaMembers?: string[];
  }

  it('default --via=both: merges per-member wave plans by wave index', async () => {
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

  it('--via=parent on a saga returns empty wave list (legacy behaviour)', async () => {
    const result = await orchestrateWaves('T-S', TEST_ROOT, { via: 'parent' });
    expect(result.success).toBe(true);
    if (!result.success) return;
    const data = result.data as WavesData;
    expect(data.via).toBe('parent');
    expect(data.totalWaves).toBe(0);
    expect(data.waves.length).toBe(0);
  });

  it('--via=saga walks ONLY the groups relation', async () => {
    const result = await orchestrateWaves('T-S', TEST_ROOT, { via: 'saga' });
    expect(result.success).toBe(true);
    if (!result.success) return;
    const data = result.data as WavesData;
    expect(data.via).toBe('saga');
    expect(data.totalWaves).toBe(2);
    expect(data.sagaMembers).toEqual(['T-E1', 'T-E2', 'T-E3']);
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
