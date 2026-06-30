/**
 * Agent admission tests (T12000, Epic T11992) — Never-OOM wave/spawn gating.
 *
 * Covers:
 *  - {@link computeAgentAdmission}: ungated (off / unbounded) admits everything;
 *    a finite budget splits admitted vs deferred preserving order; budget 0
 *    defers everything; empty input is empty.
 *  - `orchestrateReady` / `orchestrateWaves`: the additive `admission` annotation
 *    under a forced zero-budget governor (everything deferred) and a full-budget
 *    governor (today's `readyTasks`/`total` output is unchanged — AC3).
 *  - `orchestrateSpawnExecute`: a denied `agent-session` grant short-circuits to
 *    a retryable `E_RESOURCE_DEFERRED` BEFORE any worktree/process is provisioned
 *    (AC1 — no partial artifacts).
 *
 * The governor singleton is spied so budgets are deterministic and host-/CI-
 * core-count independent.
 */

import { mkdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as governorModule from '../../resources/governor.js';
import { computeAgentAdmission } from '../admission.js';
import { orchestrateReady, orchestrateWaves } from '../query-ops.js';
import { orchestrateSpawnExecute } from '../spawn-ops.js';

let TEST_ROOT: string;

/** Epic T900 with three ready, no-dependency children (T901/T902/T903). */
async function seedTasks(testRoot: string): Promise<void> {
  const cleoDir = join(testRoot, '.cleo');
  mkdirSync(cleoDir, { recursive: true });
  const { getDb, createTask } = await import('@cleocode/core/internal');
  await getDb(testRoot);

  const tasks = [
    {
      id: 'T900',
      title: 'Admission Test Epic',
      description: 'Parent epic',
      type: 'epic',
      status: 'active',
      priority: 'high',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: null,
    },
    ...['T901', 'T902', 'T903'].map((id, i) => ({
      id,
      title: `Ready task ${id}`,
      description: 'No dependencies, pending',
      type: 'task',
      status: 'pending',
      priority: 'medium',
      parentId: 'T900',
      files: [`packages/core/src/${id.toLowerCase()}-placeholder.ts`],
      createdAt: `2026-01-01T00:0${i}:00Z`,
      updatedAt: null,
    })),
  ];

  for (const task of tasks) {
    await createTask(task as Parameters<typeof createTask>[0], testRoot);
  }
}

beforeEach(async () => {
  TEST_ROOT = await mkdtemp(join(tmpdir(), 'cleo-admission-'));
  mkdirSync(join(TEST_ROOT, '.git'), { recursive: true });
  await seedTasks(TEST_ROOT);
});

afterEach(async () => {
  vi.restoreAllMocks();
  try {
    const { closeAllDatabases } = await import('@cleocode/core/internal');
    await closeAllDatabases();
  } catch {
    // ignore cleanup errors
  }
  await rm(TEST_ROOT, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// computeAgentAdmission — unit
// ---------------------------------------------------------------------------

describe('computeAgentAdmission', () => {
  it('admits everything when the governor is ungated (Infinity budget)', async () => {
    vi.spyOn(governorModule.governor, 'available').mockResolvedValue(Number.POSITIVE_INFINITY);
    const a = await computeAgentAdmission(['T1', 'T2', 'T3']);
    expect(a.admitted).toEqual(['T1', 'T2', 'T3']);
    expect(a.deferred).toEqual([]);
    expect(a.agentBudget).toBe(3);
  });

  it('splits admitted vs deferred at a finite budget, preserving order', async () => {
    vi.spyOn(governorModule.governor, 'available').mockResolvedValue(2);
    const a = await computeAgentAdmission(['T1', 'T2', 'T3', 'T4']);
    expect(a.admitted).toEqual(['T1', 'T2']);
    expect(a.deferred).toEqual(['T3', 'T4']);
    expect(a.agentBudget).toBe(2);
  });

  it('defers everything at budget 0', async () => {
    vi.spyOn(governorModule.governor, 'available').mockResolvedValue(0);
    const a = await computeAgentAdmission(['T1', 'T2']);
    expect(a.admitted).toEqual([]);
    expect(a.deferred).toEqual(['T1', 'T2']);
    expect(a.agentBudget).toBe(0);
  });

  it('is empty for an empty candidate set', async () => {
    vi.spyOn(governorModule.governor, 'available').mockResolvedValue(5);
    const a = await computeAgentAdmission([]);
    expect(a.admitted).toEqual([]);
    expect(a.deferred).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// orchestrateReady / orchestrateWaves — admission annotation
// ---------------------------------------------------------------------------

type ReadyData = {
  readyTasks: Array<{ id: string }>;
  total: number;
  admission: { agentBudget: number; admitted: string[]; deferred: string[] };
};

describe('orchestrateReady — admission annotation', () => {
  it('full-budget governor reproduces today’s ready output unchanged (AC3)', async () => {
    vi.spyOn(governorModule.governor, 'available').mockResolvedValue(Number.POSITIVE_INFINITY);
    const result = await orchestrateReady('T900', TEST_ROOT);
    expect(result.success).toBe(true);
    const data = result.data as ReadyData;

    const ids = data.readyTasks.map((t) => t.id).sort();
    expect(ids).toEqual(['T901', 'T902', 'T903']);
    expect(data.total).toBe(3);
    // Annotation is additive: everything admitted, nothing deferred.
    expect(data.admission.admitted.sort()).toEqual(['T901', 'T902', 'T903']);
    expect(data.admission.deferred).toEqual([]);
  });

  it('zero-budget governor defers every ready task while preserving readyTasks/total', async () => {
    vi.spyOn(governorModule.governor, 'available').mockResolvedValue(0);
    const result = await orchestrateReady('T900', TEST_ROOT);
    expect(result.success).toBe(true);
    const data = result.data as ReadyData;

    // The full ready set is still reported (non-destructive)...
    expect(data.readyTasks).toHaveLength(3);
    expect(data.total).toBe(3);
    // ...but every task is annotated as deferred for the orchestrator to retry.
    expect(data.admission.admitted).toEqual([]);
    expect(data.admission.deferred).toHaveLength(3);
    expect(data.admission.agentBudget).toBe(0);
  });

  it('clamps the admitted set to a finite budget', async () => {
    vi.spyOn(governorModule.governor, 'available').mockResolvedValue(1);
    const result = await orchestrateReady('T900', TEST_ROOT);
    const data = result.data as ReadyData;
    expect(data.admission.admitted).toHaveLength(1);
    expect(data.admission.deferred).toHaveLength(2);
  });
});

describe('orchestrateWaves — admission annotation', () => {
  it('annotates the first actionable wave under a finite budget', async () => {
    vi.spyOn(governorModule.governor, 'available').mockResolvedValue(2);
    const result = await orchestrateWaves('T900', TEST_ROOT);
    expect(result.success).toBe(true);
    const data = result.data as {
      waves: Array<{ taskIds: string[] }>;
      admission: { admitted: string[]; deferred: string[] };
    };
    // Wave 1 holds all three no-dep tasks; admission clamps to 2.
    expect(data.admission.admitted).toHaveLength(2);
    expect(data.admission.deferred).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// orchestrateSpawnExecute — hard admission gate (AC1)
// ---------------------------------------------------------------------------

describe('orchestrateSpawnExecute — agent-session admission gate', () => {
  it('short-circuits to a retryable E_RESOURCE_DEFERRED when no slot is grantable', async () => {
    vi.spyOn(governorModule.governor, 'tryAcquire').mockResolvedValue({
      deferred: true,
      class: 'agent-session',
      retryAfterMs: 2000,
      reason: 'agent-session at capacity under pressure',
    });

    const result = await orchestrateSpawnExecute('T901', undefined, undefined, TEST_ROOT);

    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected deferral');
    expect(result.error.code).toBe('E_RESOURCE_DEFERRED');
    const details = result.error.details as { class: string; retryAfterMs: number };
    expect(details.class).toBe('agent-session');
    expect(details.retryAfterMs).toBe(2000);
  });
});
