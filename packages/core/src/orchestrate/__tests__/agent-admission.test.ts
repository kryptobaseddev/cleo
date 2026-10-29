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
import { spawnRegistry } from '../../spawn/adapter-registry.js';
import { computeAgentAdmission } from '../admission.js';
import { orchestrateReady, orchestrateWaves } from '../query-ops.js';
import { orchestrateSpawn, orchestrateSpawnExecute } from '../spawn-ops.js';

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
  // Explicit cwd must resolve this fixture rather than the shared setup project.
  vi.stubEnv('CLEO_ROOT', undefined);
  vi.stubEnv('CLEO_DIR', undefined);
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
  vi.unstubAllEnvs();
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

  it('fails open when the governor cannot write its state: the spawn proceeds ungated (#1777 R8-1)', async () => {
    vi.spyOn(governorModule.governor, 'tryAcquire').mockRejectedValue(
      Object.assign(new Error("EACCES: permission denied, mkdir '…/slot-0.lock.lock'"), {
        code: 'EACCES',
      }),
    );
    // Stop right after admission: no adapter, so nothing is ever spawned.
    vi.spyOn(spawnRegistry, 'listSpawnCapable').mockResolvedValue([]);

    const result = await orchestrateSpawnExecute('T901', undefined, undefined, TEST_ROOT);

    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected no adapter');
    expect(result.error.code).toBe('E_SPAWN_NO_ADAPTER'); // past the gate, not deferred
  });

  it('any other governor error still propagates', async () => {
    vi.spyOn(governorModule.governor, 'tryAcquire').mockRejectedValue(new TypeError('boom'));
    await expect(orchestrateSpawnExecute('T901', undefined, undefined, TEST_ROOT)).rejects.toThrow(
      TypeError,
    );
  });
});

// ---------------------------------------------------------------------------
// T14133 — a packet spawn's lease and in-flight reporting (VidaPeps T2374)
// ---------------------------------------------------------------------------

describe('a spawned task is in flight and its lease holds a slot (T14133)', () => {
  const MB = 1024 ** 2;
  /** Room for exactly three 4 GiB agent sessions above the 2 GiB headroom. */
  const OPTS = {
    sample: {
      sampledAtMs: 1,
      pressureAvailable: true,
      memAvailableBytes: 2048 * MB + 3 * 4096 * MB,
      globalPressure: {
        some: { avg10: 0, avg60: 0, avg300: 0, totalUs: 0 },
        full: { avg10: 0, avg60: 0, avg300: 0, totalUs: 0 },
      },
      slicePressure: null,
      walObservations: [],
    },
    cpuCount: 16,
    totalMemBytes: 64 * 1024 ** 3,
  } as const;

  beforeEach(async () => {
    vi.stubEnv('CLEO_HOME', await mkdtemp(join(tmpdir(), 'cleo-admission-home-')));
    vi.stubEnv('CLEO_RESOURCES_MODE', 'local');
    governorModule._resetGovernorStateForTest();
    const real = governorModule.ResourceGovernor.prototype;
    const g = governorModule.governor;
    vi.spyOn(g, 'available').mockImplementation((cls) => real.available.call(g, cls, OPTS));
    vi.spyOn(g, 'tryAcquire').mockImplementation((cls) =>
      real.acquire.call(g, cls, { ...OPTS, blocking: false }),
    );
  });
  afterEach(() => {
    governorModule._resetGovernorStateForTest();
  });

  type Admission = {
    agentBudget: number;
    admitted: string[];
    deferred: string[];
    inFlight: string[];
  };

  it('T2374: admit 3, spawn one, and the spawned task stays in flight, never deferred', async () => {
    const before = (await orchestrateReady('T900', TEST_ROOT)).data as {
      admission: Admission;
    };
    expect(before.admission.agentBudget).toBe(3);
    expect(before.admission.admitted.sort()).toEqual(['T901', 'T902', 'T903']);

    // What a packet spawn of T903 does: lease a slot, then claim for its session.
    const taken = await governorModule.takeAgentSessionLease('T903', TEST_ROOT, 3_600_000);
    if (!('lease' in taken) || taken.lease === null) throw new Error('expected a lease');
    const { writeAgentLease } = await import('../../resources/agent-lease.js');
    writeAgentLease({ ...taken.lease, sessionId: 'ses_spawned_t903' });
    const { getTaskAccessor } = await import('../../store/data-accessor.js');
    await (await getTaskAccessor(TEST_ROOT)).claimTask('T903', {
      sessionId: 'ses_spawned_t903',
      agentId: null,
      mode: 'acquire',
    });

    const after = (await orchestrateReady('T900', TEST_ROOT)).data as {
      readyTasks: Array<{ id: string }>;
      admission: Admission;
    };
    expect(after.admission.agentBudget).toBe(2);
    expect(after.admission.inFlight).toEqual(['T903']);
    expect(after.admission.admitted.sort()).toEqual(['T901', 'T902']);
    expect(after.admission.deferred).toEqual([]);
    expect(after.readyTasks.map((t) => t.id)).not.toContain('T903');

    // The session ends: its lease frees the slot.
    const { releaseAgentLeasesForSession } = await import('../../resources/agent-lease.js');
    releaseAgentLeasesForSession('ses_spawned_t903');
    expect(
      ((await orchestrateReady('T900', TEST_ROOT)).data as { admission: Admission }).admission
        .agentBudget,
    ).toBe(3);
  });

  it('a packet spawn with no lease available is refused as retryable before any claim', async () => {
    const { writeAgentLease } = await import('../../resources/agent-lease.js');
    for (const id of ['a', 'b', 'c']) {
      writeAgentLease({
        id,
        taskId: 'TX',
        projectRoot: TEST_ROOT,
        sessionId: `ses_${id}`,
        takenAtMs: Date.now(),
        expiresAtMs: Date.now() + 3_600_000,
      });
    }
    const result = await orchestrateSpawn('T901', undefined, TEST_ROOT, 0, true);
    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected a deferral');
    expect(result.error.code).toBe('E_RESOURCE_DEFERRED');
    const { getTaskAccessor } = await import('../../store/data-accessor.js');
    expect(
      (await (await getTaskAccessor(TEST_ROOT)).loadSingleTask('T901'))?.claim,
    ).toBeUndefined();
  });
});
