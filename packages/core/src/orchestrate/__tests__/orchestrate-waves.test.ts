/**
 * Regression tests for `orchestrateWaves` — wave task population and taskIds field.
 *
 * Verifies that:
 * 1. For an epic with N pending children and deps producing M waves,
 *    `orchestrateWaves(epicId)` returns waves with non-empty `taskIds` and
 *    `tasks` arrays whose sum equals the pending task count.
 * 2. The `taskIds` field exactly mirrors `tasks.map(t => t.id)`.
 * 3. For an empty epic (no pending children), the wave list is empty.
 *
 * Task layout used in these tests:
 *
 *   T900 (epic)
 *     T901 (done, no deps)           — pre-seeds the completed set
 *     T902 (pending, depends=[T901]) — Wave 1
 *     T903 (pending, depends=[T901]) — Wave 1
 *     T904 (pending, depends=[T902, T903]) — Wave 2
 *     T905 (pending, no deps)        — Wave 1
 *
 * Wave structure:
 *   Wave 1: T902, T903, T905  (T901 done; T905 has no deps)
 *   Wave 2: T904              (blocked by T902 + T903)
 *
 * @task T9159
 */

import { mkdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Task } from '@cleocode/contracts';
import { orchestrateWaves } from '@cleocode/core/internal';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { validateSpawnReadiness } from '../../orchestration/validate-spawn.js';
import { getEnrichedWaves } from '../../orchestration/waves.js';
import { governor } from '../../resources/governor.js';
import { awaitBackgroundOps } from '../../store/background-ops.js';
import * as taskAccessors from '../../store/data-accessor.js';
import { createTask } from '../../store/tasks-sqlite.js';
import { archiveTasks } from '../../tasks/archive.js';

let TEST_ROOT: string;

/**
 * Seed a minimal epic with tasks that produce 2 waves.
 */
async function seedTasks(testRoot: string): Promise<void> {
  const cleoDir = join(testRoot, '.cleo');
  mkdirSync(cleoDir, { recursive: true });
  // T9583 fix: getProjectRoot() in the release/orchestrate engines validates
  // the project root via validateProjectRoot, which requires `.cleo/` + `.git/`
  // siblings. Without `.git/` the walk-up rejects the temp dir.
  mkdirSync(join(testRoot, '.git'), { recursive: true });
  const { getDb } = await import('@cleocode/core/internal');
  const { createTask } = await import('@cleocode/core/internal');
  await getDb(testRoot);

  const tasks = [
    {
      id: 'T900',
      title: 'Wave Regression Epic',
      description: 'Parent epic for wave-population regression tests',
      type: 'epic',
      status: 'active',
      priority: 'high',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: null,
    },
    {
      id: 'T901',
      title: 'Done dependency',
      description: 'Already completed — seeds the completed set so T902/T903 are ready',
      type: 'task',
      status: 'done',
      priority: 'medium',
      parentId: 'T900',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: null,
    },
    {
      id: 'T902',
      title: 'Wave-1 task A',
      description: 'Depends on T901 (done) — goes in Wave 1',
      type: 'task',
      status: 'pending',
      priority: 'high',
      parentId: 'T900',
      depends: ['T901'],
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: null,
    },
    {
      id: 'T903',
      title: 'Wave-1 task B',
      description: 'Depends on T901 (done) — goes in Wave 1',
      type: 'task',
      status: 'pending',
      priority: 'critical',
      parentId: 'T900',
      depends: ['T901'],
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: null,
    },
    {
      id: 'T904',
      title: 'Wave-2 task',
      description: 'Blocked by T902 and T903 — goes in Wave 2',
      type: 'task',
      status: 'pending',
      priority: 'low',
      parentId: 'T900',
      depends: ['T902', 'T903'],
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: null,
    },
    {
      id: 'T905',
      title: 'Wave-1 task C (no deps)',
      description: 'No dependencies — also goes in Wave 1',
      type: 'task',
      status: 'pending',
      priority: 'medium',
      parentId: 'T900',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: null,
    },
  ];

  for (const task of tasks) {
    await createTask(task as Parameters<typeof createTask>[0], testRoot);
  }
}

/**
 * Seed an epic whose children are all done — waves should be empty.
 */
async function seedAllDoneEpic(testRoot: string): Promise<void> {
  const { getDb } = await import('@cleocode/core/internal');
  const { createTask } = await import('@cleocode/core/internal');
  await getDb(testRoot);

  await createTask(
    {
      id: 'T910',
      title: 'All-done epic',
      description: 'Epic with no pending children',
      type: 'epic',
      status: 'done',
      priority: 'medium',
      createdAt: '2026-01-02T00:00:00Z',
      updatedAt: null,
    } as Parameters<typeof createTask>[0],
    testRoot,
  );
  await createTask(
    {
      id: 'T911',
      title: 'Done child',
      description: 'Completed task',
      type: 'task',
      status: 'done',
      priority: 'medium',
      parentId: 'T910',
      createdAt: '2026-01-02T00:00:00Z',
      updatedAt: null,
    } as Parameters<typeof createTask>[0],
    testRoot,
  );
}

// Each scenario owns its seeded task store and explicitly selected project.
beforeEach(() => {
  vi.stubEnv('CLEO_ROOT', undefined);
  vi.stubEnv('CLEO_DIR', undefined);
});
afterEach(() => vi.unstubAllEnvs());

beforeEach(async () => {
  TEST_ROOT = await mkdtemp(join(tmpdir(), 'cleo-waves-test-'));
  await seedTasks(TEST_ROOT);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await awaitBackgroundOps();
  try {
    const { closeAllDatabases } = await import('@cleocode/core/internal');
    await closeAllDatabases();
  } catch {
    // ignore cleanup errors
  }
  await rm(TEST_ROOT, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Wave population
// ---------------------------------------------------------------------------

describe('orchestrateWaves — taskIds population', () => {
  it('returns non-empty taskIds arrays for an epic with pending children', async () => {
    const result = await orchestrateWaves('T900', TEST_ROOT);
    expect(result.success).toBe(true);

    const data = result.data as {
      epicId: string;
      waves: Array<{ waveNumber: number; tasks: Array<{ id: string }>; taskIds: string[] }>;
      totalWaves: number;
      totalTasks: number;
    };

    // Must produce exactly 2 waves
    expect(data.waves.length, 'must produce exactly 2 waves').toBe(2);

    // Wave 1: T902, T903, T905 — all pending, all unblocked
    const wave1 = data.waves[0]!;
    expect(wave1.taskIds.length, 'wave 1 taskIds must be non-empty').toBeGreaterThan(0);
    expect(wave1.taskIds.sort(), 'wave 1 must contain T902, T903, T905').toEqual(
      ['T902', 'T903', 'T905'].sort(),
    );

    // Wave 2: T904 — blocked until T902+T903 done
    const wave2 = data.waves[1]!;
    expect(wave2.taskIds.length, 'wave 2 taskIds must be non-empty').toBeGreaterThan(0);
    expect(wave2.taskIds, 'wave 2 must contain T904').toContain('T904');
  });

  it('taskIds exactly mirrors tasks.map(t => t.id) for every wave', async () => {
    const result = await orchestrateWaves('T900', TEST_ROOT);
    expect(result.success).toBe(true);

    const data = result.data as {
      waves: Array<{ tasks: Array<{ id: string }>; taskIds: string[] }>;
    };

    for (const wave of data.waves) {
      const derivedIds = wave.tasks.map((t) => t.id);
      expect(wave.taskIds, 'taskIds must equal tasks.map(t => t.id) for each wave').toEqual(
        derivedIds,
      );
    }
  });

  it('sum of all wave taskIds equals total pending task count', async () => {
    const result = await orchestrateWaves('T900', TEST_ROOT);
    expect(result.success).toBe(true);

    const data = result.data as {
      waves: Array<{ taskIds: string[] }>;
      totalTasks: number;
    };

    // T901 is done; pending = T902, T903, T904, T905 = 4 tasks across 2 waves
    const allIds = data.waves.flatMap((w) => w.taskIds);
    expect(allIds.length, 'sum of wave taskIds must equal pending task count (4)').toBe(4);

    // totalTasks counts ALL children including done T901 = 5
    expect(data.totalTasks, 'totalTasks must count all 5 children').toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Empty epic
// ---------------------------------------------------------------------------

describe('orchestrateWaves — empty and all-done epics', () => {
  it('returns empty wave list when all children are done', async () => {
    await seedAllDoneEpic(TEST_ROOT);

    const result = await orchestrateWaves('T910', TEST_ROOT);
    expect(result.success).toBe(true);

    const data = result.data as {
      waves: Array<{ taskIds: string[] }>;
      totalWaves: number;
    };

    // computeWaves only processes non-terminal tasks; if all done, no waves
    expect(data.waves.length, 'wave list must be empty for all-done epic').toBe(0);
    expect(data.totalWaves, 'totalWaves must be 0 for all-done epic').toBe(0);
  });
});

/** Seed hard cross-epic dependencies through the canonical task store. */
async function seedCrossEpicTasks(): Promise<void> {
  const records: Partial<Task>[] = [
    { id: 'T100', type: 'saga' },
    { id: 'T110', type: 'epic', parentId: 'T100' },
    { id: 'T120', type: 'epic', parentId: 'T100' },
    { id: 'T111', parentId: 'T110' },
    { id: 'T121', parentId: 'T120', depends: ['T111'] },
  ];
  for (const record of records) {
    await createTask(
      {
        id: 'T100',
        title: 'Cross-epic prerequisite',
        description: 'Independent readiness oracle',
        status: 'pending',
        priority: 'medium',
        type: 'task',
        createdAt: '2026-09-20T00:00:00Z',
        ...record,
      },
      TEST_ROOT,
    );
  }
  // Keep resource capacity deterministic; admission's filtering algorithm remains real.
  vi.spyOn(governor, 'available').mockResolvedValue(2);
}

describe('orchestrateWaves — global hard dependencies (T12293)', () => {
  it('orders cross-member work once and admits only currently ready tasks', async () => {
    await seedCrossEpicTasks();
    const result = await orchestrateWaves('T100', TEST_ROOT);
    expect(result).toMatchObject({
      success: true,
      data: {
        totalTasks: 2,
        totalWaves: 2,
        via: 'saga',
        sagaMembers: ['T110', 'T120'],
        waves: [
          { waveNumber: 1, taskIds: ['T111'], tasks: [{ id: 'T111', ready: true, blockedBy: [] }] },
          {
            waveNumber: 2,
            taskIds: ['T121'],
            tasks: [{ id: 'T121', ready: false, blockedBy: ['T111'] }],
          },
        ],
        admission: { admitted: ['T111'], deferred: [] },
      },
    });
    const accessor = await taskAccessors.getTaskAccessor(TEST_ROOT);
    expect(await validateSpawnReadiness('T121', TEST_ROOT, accessor)).toMatchObject({
      ready: false,
      issues: [expect.objectContaining({ code: 'V_UNMET_DEP' })],
    });
    await accessor.updateTaskFields('T111', { status: 'done', pipelineStage: 'contribution' });
    expect(await orchestrateWaves('T100', TEST_ROOT)).toMatchObject({
      success: true,
      data: {
        totalTasks: 2,
        totalWaves: 1,
        waves: [{ taskIds: ['T121'], tasks: [{ id: 'T121', ready: true, blockedBy: [] }] }],
        admission: { admitted: ['T121'], deferred: [] },
      },
    });
    expect(await validateSpawnReadiness('T121', TEST_ROOT, accessor)).toMatchObject({
      ready: true,
    });
  });

  it('keeps an external pending prerequisite visible and out of admission', async () => {
    await seedCrossEpicTasks();
    expect(await orchestrateWaves('T120', TEST_ROOT)).toMatchObject({
      success: true,
      data: {
        totalTasks: 1,
        waves: [
          { taskIds: ['T121'], tasks: [{ depends: ['T111'], blockedBy: ['T111'], ready: false }] },
        ],
        admission: { admitted: [], deferred: [] },
      },
    });
  });

  it.each([
    'done',
    'archived',
  ] as const)('accepts external %s prerequisites without selecting them', async (status) => {
    await seedCrossEpicTasks();
    const accessor = await taskAccessors.getTaskAccessor(TEST_ROOT);
    await accessor.updateTaskFields('T111', { status: 'done', pipelineStage: 'contribution' });
    if (status === 'archived') {
      expect(await archiveTasks({ taskIds: ['T111'] }, TEST_ROOT, accessor)).toMatchObject({
        archived: ['T111'],
      });
      const fresh = await taskAccessors.getTaskAccessor(TEST_ROOT);
      expect(await fresh.loadTasks(['T111'])).toMatchObject([{ id: 'T111', status: 'archived' }]);
      expect((await fresh.queryTasks({ parentId: 'T110' })).tasks).toEqual([]);
    }
    expect(await orchestrateWaves('T120', TEST_ROOT)).toMatchObject({
      success: true,
      data: {
        totalTasks: 1,
        totalWaves: 1,
        waves: [{ taskIds: ['T121'], tasks: [{ blockedBy: [], ready: true }] }],
        admission: { admitted: ['T121'], deferred: [] },
      },
    });
    expect(await validateSpawnReadiness('T121', TEST_ROOT, accessor)).toMatchObject({
      ready: true,
    });
  });

  it('does not treat cancelled prerequisites as satisfied or schedulable', async () => {
    await seedCrossEpicTasks();
    const accessor = await taskAccessors.getTaskAccessor(TEST_ROOT);
    await accessor.updateTaskFields('T111', { status: 'cancelled', pipelineStage: 'cancelled' });
    for (const id of ['T100', 'T120']) {
      expect(await orchestrateWaves(id, TEST_ROOT)).toMatchObject({
        success: true,
        data: {
          waves: [{ taskIds: ['T121'], tasks: [{ blockedBy: ['T111'], ready: false }] }],
          admission: { admitted: [], deferred: [] },
        },
      });
    }
    expect(await validateSpawnReadiness('T121', TEST_ROOT, accessor)).toMatchObject({
      ready: false,
      issues: [expect.objectContaining({ code: 'V_UNMET_DEP' })],
    });
  });

  it('preserves a missing dependency as blocked and propagates failed reads', async () => {
    await seedCrossEpicTasks();
    const accessor = await taskAccessors.getTaskAccessor(TEST_ROOT);
    const load = vi.spyOn(accessor, 'loadTasks').mockResolvedValueOnce([]);
    const result = await getEnrichedWaves('T120', TEST_ROOT, accessor);
    expect(load).toHaveBeenCalledExactlyOnceWith(['T111']);
    expect(result.waves[0]?.tasks).toMatchObject([
      { id: 'T121', blockedBy: ['T111'], ready: false },
    ]);
    const failure = new Error('Independent global dependency population read failed');
    load.mockRejectedValue(failure);
    vi.spyOn(taskAccessors, 'getTaskAccessor').mockResolvedValue(accessor);
    expect(await orchestrateWaves('T120', TEST_ROOT)).toMatchObject({
      success: false,
      error: { code: 'E_GENERAL', message: failure.message },
    });
  });
});
