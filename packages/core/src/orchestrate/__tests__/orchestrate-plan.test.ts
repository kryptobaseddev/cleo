/**
 * Orchestrate Plan Engine Tests (T889 / W3-6)
 *
 * Real-DB tests for `orchestratePlan` — deterministic wave+worker plan
 * emission with agent-resolver integration and E_VALIDATION enforcement.
 *
 * Uses a tmpdir tasks.db + `CLEO_HOME` override to isolate the global
 * signaldock.db so resolver lookups do not hit the operator's live home.
 *
 * @task T889 / W3-6
 * @epic T889
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OrchestratePlanResult } from '@cleocode/contracts/operations/orchestrate';
import { orchestratePlan, orchestrateReady } from '@cleocode/core/internal';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// Fixtures — one epic + a small diamond dep graph
//   T600 (epic, has children)
//   ├─ T601 (done, no deps)                — wave placeholder (filtered as done)
//   ├─ T602 (pending, depends on T601)     — wave 1
//   ├─ T603 (pending, depends on T601)     — wave 1
//   └─ T604 (pending, depends on T602,T603) — wave 2
// ---------------------------------------------------------------------------

const ISO = '2026-04-17T00:00:00Z';

const EPIC_TASKS: Array<Record<string, unknown>> = [
  {
    id: 'T600',
    title: 'Plan test epic',
    description: 'Epic parent for orchestrate plan tests',
    status: 'active',
    priority: 'high',
    type: 'epic',
    createdAt: ISO,
    updatedAt: ISO,
  },
  {
    id: 'T601',
    title: 'First child',
    description: 'Seed child (done)',
    status: 'done',
    priority: 'high',
    parentId: 'T600',
    files: ['packages/core/src/a.ts'],
    createdAt: ISO,
    updatedAt: ISO,
  },
  {
    id: 'T602',
    title: 'docs: update readme',
    description: 'Docs worker candidate',
    status: 'pending',
    priority: 'medium',
    parentId: 'T600',
    depends: ['T601'],
    files: ['docs/readme.md'],
    createdAt: ISO,
    updatedAt: ISO,
  },
  {
    id: 'T603',
    title: 'Third child — impl worker',
    description: 'Impl worker candidate',
    status: 'pending',
    priority: 'high',
    parentId: 'T600',
    depends: ['T601'],
    files: ['packages/core/src/b.ts'],
    createdAt: ISO,
    updatedAt: ISO,
  },
  {
    id: 'T604',
    title: 'Fourth child — merges upstream',
    description: 'Final convergent worker',
    status: 'pending',
    priority: 'low',
    parentId: 'T600',
    depends: ['T602', 'T603'],
    // Intentionally no `files` to exercise W_NO_ATOMIC_SCOPE warning.
    createdAt: ISO,
    updatedAt: ISO,
  },
];

// Non-epic task (for E_VALIDATION test).
const LEAF_TASK: Record<string, unknown> = {
  id: 'T610',
  title: 'Leaf task',
  description: 'No children, not an epic',
  status: 'pending',
  priority: 'medium',
  type: 'feature',
  files: ['packages/core/src/c.ts'],
  createdAt: ISO,
  updatedAt: ISO,
};

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let TEST_ROOT: string;
let CLEO_HOME_DIR: string;
let PRIOR_CLEO_HOME: string | undefined;

async function seedTasks(testRoot: string, tasks: Array<Record<string, unknown>>): Promise<void> {
  const cleoDir = join(testRoot, '.cleo');
  mkdirSync(cleoDir, { recursive: true });
  const { getDb, createTask } = await import('@cleocode/core/internal');
  await getDb(testRoot);
  for (const task of tasks) {
    // createTask accepts full Task shape; cast narrowly at the boundary.
    await createTask(task as Parameters<typeof createTask>[0], testRoot);
  }
}

describe('orchestratePlan (T889 / W3-6)', () => {
  beforeEach(async () => {
    const base = mkdtempSync(join(tmpdir(), 'cleo-plan-'));
    TEST_ROOT = join(base, 'project');
    CLEO_HOME_DIR = join(base, 'cleo-home');
    mkdirSync(TEST_ROOT, { recursive: true });
    mkdirSync(CLEO_HOME_DIR, { recursive: true });

    // Isolate global signaldock.db: plan engine opens it via getCleoHome().
    PRIOR_CLEO_HOME = process.env['CLEO_HOME'];
    process.env['CLEO_HOME'] = CLEO_HOME_DIR;

    // Reset any cached global signaldock handle from a prior test.
    const { _resetGlobalSignaldockDb_TESTING_ONLY } = await import('@cleocode/core/internal');
    _resetGlobalSignaldockDb_TESTING_ONLY();

    await seedTasks(TEST_ROOT, [...EPIC_TASKS, LEAF_TASK]);
  });

  afterEach(async () => {
    try {
      const { closeAllDatabases, _resetGlobalSignaldockDb_TESTING_ONLY } = await import(
        '@cleocode/core/internal'
      );
      await closeAllDatabases();
      _resetGlobalSignaldockDb_TESTING_ONLY();
    } catch {
      /* ignore */
    }
    // Restore CLEO_HOME to its prior value (empty string when unset —
    // avoids `delete`, which Biome flags as a performance anti-pattern).
    process.env['CLEO_HOME'] = PRIOR_CLEO_HOME ?? '';
    rmSync(join(TEST_ROOT, '..'), { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // 1. At least one wave, with a workers array
  // -------------------------------------------------------------------------
  it('returns ≥ 1 wave with a workers array for a real epic', async () => {
    const result = await orchestratePlan({ epicId: 'T600', projectRoot: TEST_ROOT });
    expect(result.success).toBe(true);
    const data = result.data as OrchestratePlanResult;
    expect(data.epicId).toBe('T600');
    expect(data.totalTasks).toBe(4);
    expect(data.waves.length).toBeGreaterThanOrEqual(1);
    for (const wave of data.waves) {
      expect(Array.isArray(wave.workers)).toBe(true);
      expect(wave.wave).toBeGreaterThanOrEqual(1);
    }
  });

  // -------------------------------------------------------------------------
  // 2. Deterministic — same input → same inputHash
  // -------------------------------------------------------------------------
  it('plan output is deterministic — two back-to-back calls agree on inputHash', async () => {
    const first = await orchestratePlan({ epicId: 'T600', projectRoot: TEST_ROOT });
    const second = await orchestratePlan({ epicId: 'T600', projectRoot: TEST_ROOT });
    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    const d1 = first.data as OrchestratePlanResult;
    const d2 = second.data as OrchestratePlanResult;
    expect(d1.inputHash).toBe(d2.inputHash);
    expect(d1.deterministic).toBe(true);
    expect(d2.deterministic).toBe(true);
    // `generatedAt` is NOT part of determinism contract — may differ.
  });

  // -------------------------------------------------------------------------
  // 3. Rejects non-epic with E_VALIDATION
  // -------------------------------------------------------------------------
  it('rejects a non-epic task id with E_VALIDATION', async () => {
    const result = await orchestratePlan({ epicId: 'T610', projectRoot: TEST_ROOT });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('E_VALIDATION');
    expect(result.error?.message).toMatch(/not an epic/i);
  });

  it('rejects a missing epic id with E_NOT_FOUND', async () => {
    const result = await orchestratePlan({ epicId: 'T999', projectRoot: TEST_ROOT });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('E_NOT_FOUND');
  });

  // -------------------------------------------------------------------------
  // 4. Every worker entry has the documented keys
  // -------------------------------------------------------------------------
  it('every worker entry carries {taskId, persona, tier, atomicScope, role, orchLevel}', async () => {
    const result = await orchestratePlan({ epicId: 'T600', projectRoot: TEST_ROOT });
    expect(result.success).toBe(true);
    const data = result.data as OrchestratePlanResult;
    const allWorkers = data.waves.flatMap((w) => w.workers);
    expect(allWorkers.length).toBeGreaterThan(0);
    for (const w of allWorkers) {
      expect(typeof w.taskId).toBe('string');
      expect(typeof w.persona).toBe('string');
      expect(w.persona.length).toBeGreaterThan(0);
      expect([0, 1, 2]).toContain(w.tier);
      expect(['orchestrator', 'lead', 'worker']).toContain(w.role);
      expect(typeof w.orchLevel).toBe('number');
      expect(w.atomicScope).toBeDefined();
      expect(Array.isArray(w.atomicScope.files)).toBe(true);
      expect(Array.isArray(w.dependsOn)).toBe(true);
    }
  });

  // -------------------------------------------------------------------------
  // 5. Missing AC.files → empty atomicScope but task still present + warning
  // -------------------------------------------------------------------------
  it('tasks with missing AC.files get empty atomicScope.files but are still included', async () => {
    const result = await orchestratePlan({ epicId: 'T600', projectRoot: TEST_ROOT });
    expect(result.success).toBe(true);
    const data = result.data as OrchestratePlanResult;
    const t604 = data.waves.flatMap((w) => w.workers).find((w) => w.taskId === 'T604');
    expect(t604).toBeDefined();
    expect(t604?.atomicScope.files).toEqual([]);
    // Warning must surface W_NO_ATOMIC_SCOPE for T604 when role=worker.
    if (t604?.role === 'worker') {
      const warn = data.warnings.find((w) => w.taskId === 'T604' && w.code === 'W_NO_ATOMIC_SCOPE');
      expect(warn).toBeDefined();
    }
  });

  // -------------------------------------------------------------------------
  // 6. Wave 1 matches orchestrate ready --epic output
  // -------------------------------------------------------------------------
  it('wave 1 task-set matches orchestrate ready output (same underlying logic)', async () => {
    const planResult = await orchestratePlan({ epicId: 'T600', projectRoot: TEST_ROOT });
    const readyResult = await orchestrateReady('T600', TEST_ROOT);
    expect(planResult.success).toBe(true);
    expect(readyResult.success).toBe(true);

    const planData = planResult.data as OrchestratePlanResult;
    const readyData = readyResult.data as { readyTasks: Array<{ id: string }> };

    const wave1Ids = planData.waves[0]?.workers.map((w) => w.taskId).sort() ?? [];
    const readyIds = readyData.readyTasks.map((t) => t.id).sort();
    expect(wave1Ids).toEqual(readyIds);
  });
});
