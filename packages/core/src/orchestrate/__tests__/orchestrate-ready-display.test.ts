/**
 * Regression tests for `orchestrate ready` and `orchestrate waves` display bugs.
 *
 * Bug B: `orchestrateReady` always reported `priority=medium` regardless of
 *        the actual stored priority.  Root cause: query-ops.ts hardcoded
 *        `priority: 'medium'` because `TaskReadiness` lacked the field.
 *
 * Bug A: `orchestrateReady` returned only unmet deps in the `depends` field
 *        instead of the full declared `depends` array.  Root cause: the mapping
 *        used `t.blockers` (unmet deps only) instead of `t.depends`.
 *
 * Bug C: `orchestrateWaves` wave entries had empty task lists for epics with
 *        pending children.  This test asserts that wave tasks are populated.
 *
 * @task T1956
 */

import { mkdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { orchestrateReady, orchestrateWaves } from '@cleocode/core/internal';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let TEST_ROOT: string;

/**
 * Task layout:
 *   T800 (epic)
 *     T801 (done,     priority=medium,  no deps)
 *     T802 (pending,  priority=high,    depends=[T801])
 *     T803 (pending,  priority=critical,depends=[T801])
 *     T804 (pending,  priority=low,     depends=[T802, T803])
 *     T805 (pending,  priority=medium,  no deps)
 *
 * Wave structure:
 *   Wave 1: T802, T803, T805  (T801 done; T805 has no deps)
 *   Wave 2: T804              (blocked by T802 + T803)
 */
async function seedTasks(testRoot: string): Promise<void> {
  const cleoDir = join(testRoot, '.cleo');
  mkdirSync(cleoDir, { recursive: true });
  const { getDb } = await import('@cleocode/core/internal');
  const { createTask } = await import('@cleocode/core/internal');
  await getDb(testRoot);

  const tasks = [
    {
      id: 'T800',
      title: 'Test Epic',
      description: 'Parent epic',
      type: 'epic',
      status: 'active',
      priority: 'high',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: null,
    },
    {
      id: 'T801',
      title: 'Done dependency',
      description: 'Already completed',
      type: 'task',
      status: 'done',
      priority: 'medium',
      parentId: 'T800',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: null,
    },
    {
      id: 'T802',
      title: 'High priority task',
      description: 'Task with high priority and one dep',
      type: 'task',
      status: 'pending',
      priority: 'high',
      parentId: 'T800',
      depends: ['T801'],
      files: ['packages/core/src/t802-placeholder.ts'],
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: null,
    },
    {
      id: 'T803',
      title: 'Critical priority task',
      description: 'Task with critical priority and one dep',
      type: 'task',
      status: 'pending',
      priority: 'critical',
      parentId: 'T800',
      depends: ['T801'],
      files: ['packages/core/src/t803-placeholder.ts'],
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: null,
    },
    {
      id: 'T804',
      title: 'Low priority task with multiple deps',
      description: 'Blocked by T802 and T803',
      type: 'task',
      status: 'pending',
      priority: 'low',
      parentId: 'T800',
      depends: ['T802', 'T803'],
      files: ['packages/core/src/t804-placeholder.ts'],
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: null,
    },
    {
      id: 'T805',
      title: 'Medium priority no-dep task',
      description: 'No dependencies, pending',
      type: 'task',
      status: 'pending',
      priority: 'medium',
      parentId: 'T800',
      files: ['packages/core/src/t805-placeholder.ts'],
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: null,
    },
  ];

  for (const task of tasks) {
    // createTask accepts a loose CreateTaskInput — cast through unknown for test fixture
    await createTask(task as Parameters<typeof createTask>[0], testRoot);
  }
}

beforeEach(async () => {
  TEST_ROOT = await mkdtemp(join(tmpdir(), 'cleo-ready-display-'));
  await seedTasks(TEST_ROOT);
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
// Bug B: priority field
// ---------------------------------------------------------------------------

describe('orchestrateReady — Bug B: priority field', () => {
  it('returns actual stored priority per task, not always "medium"', async () => {
    const result = await orchestrateReady('T800', TEST_ROOT);
    expect(result.success).toBe(true);

    const data = result.data as {
      readyTasks: Array<{ id: string; priority: string }>;
    };

    // T802 = high, T803 = critical, T805 = medium  (all ready in wave 1)
    const byId = Object.fromEntries(data.readyTasks.map((t) => [t.id, t]));

    expect(byId['T802'], 'T802 must be in ready set').toBeDefined();
    expect(byId['T802']!.priority, 'T802.priority must be high').toBe('high');

    expect(byId['T803'], 'T803 must be in ready set').toBeDefined();
    expect(byId['T803']!.priority, 'T803.priority must be critical').toBe('critical');

    expect(byId['T805'], 'T805 must be in ready set').toBeDefined();
    expect(byId['T805']!.priority, 'T805.priority must be medium').toBe('medium');

    // T804 is blocked by T802 + T803 and must NOT be in the ready set
    expect(byId['T804'], 'T804 must NOT be in ready set — still blocked').toBeUndefined();

    // Regression guard: T802 must not be wrongly reported as "medium"
    const wrongPriority = data.readyTasks.filter((t) => t.id === 'T802' && t.priority === 'medium');
    expect(wrongPriority, 'T802 must not be reported as medium').toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Bug A: depends field
// ---------------------------------------------------------------------------

describe('orchestrateReady — Bug A: depends field', () => {
  it('returns the full declared depends array, not only unmet blockers', async () => {
    const result = await orchestrateReady('T800', TEST_ROOT);
    expect(result.success).toBe(true);

    const data = result.data as {
      readyTasks: Array<{ id: string; depends: string[] }>;
    };

    const byId = Object.fromEntries(data.readyTasks.map((t) => [t.id, t]));

    // T802 depends on T801 (which is done).
    // Before the fix: depends=[] because it used t.blockers (empty for a ready task).
    // After the fix:  depends=['T801'] — full declared depends array.
    expect(byId['T802']).toBeDefined();
    expect(byId['T802']!.depends, 'T802.depends must include T801').toEqual(['T801']);

    // T803 same: declared dep on T801 which is done → depends=['T801']
    expect(byId['T803']).toBeDefined();
    expect(byId['T803']!.depends, 'T803.depends must include T801').toEqual(['T801']);

    // T805 has no declared deps → empty array
    expect(byId['T805']).toBeDefined();
    expect(byId['T805']!.depends, 'T805.depends must be empty array').toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Bug C: wave tasks populated
// ---------------------------------------------------------------------------

describe('orchestrateWaves — Bug C: wave tasks populated', () => {
  it('returns non-empty tasks arrays for an epic with pending children', async () => {
    const result = await orchestrateWaves('T800', TEST_ROOT);
    expect(result.success).toBe(true);

    const data = result.data as {
      epicId: string;
      waves: Array<{ waveNumber: number; tasks: Array<{ id: string }> }>;
      totalWaves: number;
      totalTasks: number;
    };

    // Should produce at least 1 wave (wave 1: T802, T803, T805)
    expect(data.waves.length, 'must produce at least 1 wave').toBeGreaterThanOrEqual(1);

    // Every wave must have at least one task — no empty task arrays
    for (const wave of data.waves) {
      expect(
        wave.tasks.length,
        `wave ${wave.waveNumber} must have at least 1 task`,
      ).toBeGreaterThan(0);
    }

    // All pending tasks (T802, T803, T804, T805) must appear across all waves
    const allWaveTaskIds = data.waves.flatMap((w) => w.tasks.map((t) => t.id));
    expect(allWaveTaskIds, 'T802 must appear in some wave').toContain('T802');
    expect(allWaveTaskIds, 'T803 must appear in some wave').toContain('T803');
    expect(allWaveTaskIds, 'T804 must appear in some wave').toContain('T804');
    expect(allWaveTaskIds, 'T805 must appear in some wave').toContain('T805');

    // totalTasks includes all children (including done T801)
    expect(data.totalTasks, 'totalTasks must count all 5 children').toBe(5);
  });

  it('wave 1 task-set matches the orchestrateReady output (same underlying logic)', async () => {
    const [readyResult, wavesResult] = await Promise.all([
      orchestrateReady('T800', TEST_ROOT),
      orchestrateWaves('T800', TEST_ROOT),
    ]);

    expect(readyResult.success).toBe(true);
    expect(wavesResult.success).toBe(true);

    const readyData = readyResult.data as { readyTasks: Array<{ id: string }> };
    const wavesData = wavesResult.data as {
      waves: Array<{ waveNumber: number; tasks: Array<{ id: string }> }>;
    };

    const readyIds = readyData.readyTasks.map((t) => t.id).sort();
    const wave1Ids = (wavesData.waves[0]?.tasks ?? []).map((t) => t.id).sort();

    // Wave 1 must contain exactly the same set as the ready set
    expect(wave1Ids, 'wave 1 task IDs must match orchestrateReady task IDs').toEqual(readyIds);
  });
});
