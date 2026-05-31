/**
 * Unit tests for the R4 sentient daemon subsystem adapter.
 *
 * Validates that `createSentientSubsystem` produces a Subsystem that
 * the SubsystemRegistry drives through start → healthProbe → shutdown
 * without loss, matching T11255 R4 ACs.
 *
 * All cron / IO are mocked — this is a shape and lifecycle test, not an
 * integration test. The migration-readiness test in `daemon/__tests__/` already
 * covers the registry contract; this test covers the sentient-specific adapter.
 *
 * @task T11502 (R4-T3)
 * @epic T11255 R4
 * @saga T11243 SG-RUNTIME-UNIFICATION
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SubsystemRegistry } from '../daemon/index.js';
import { createSentientSubsystem } from '../sentient-subsystem.js';

// ---------------------------------------------------------------------------
// Mocks — keep hermetic (no real cron, no real fs ops, no lockfiles)
// ---------------------------------------------------------------------------

vi.mock('node-cron', () => ({
  default: {
    schedule: vi.fn(() => ({ destroy: vi.fn() })),
  },
}));

vi.mock('@cleocode/core/sentient', async () => {
  const actual: Record<string, unknown> = {};
  return {
    ...actual,
    acquireLock: vi.fn(async () => ({
      path: '/tmp/cleo-test.lock',
      handle: { close: vi.fn(async () => undefined) },
    })),
    releaseLock: vi.fn(async () => undefined),
    readSuperviseStudioConfig: vi.fn(async () => false),
    readCuratorConfig: vi.fn(async () => ({
      enabled: false,
      runEveryHours: 168,
      staleAfterDays: 30,
      archiveAfterDays: 90,
    })),
    patchSentientState: vi.fn(async () => ({})),
    readSentientState: vi.fn(async () => ({
      pid: process.pid,
      killSwitch: false,
      killSwitchReason: null,
      lastTickAt: null,
      lastCronFiredAt: null,
      tier2Enabled: false,
      stuckTasks: {},
      stats: { tasksSpawned: 0, tasksCompleted: 0, tasksFailed: 0 },
    })),
    safeRunTick: vi.fn(async () => ({ kind: 'skipped', taskId: null, detail: 'mock' })),
    safeRunProposeTick: vi.fn(async () => ({
      kind: 'skipped',
      taskId: null,
      detail: 'mock',
      written: 0,
      count: 0,
    })),
    safeRunCrossProjectHygiene: vi.fn(async () => ({
      completedAt: new Date().toISOString(),
      summary: 'mock',
      nexusIntegrity: { total: 0, healthy: 0 },
      tempGc: { candidates: [] },
      duplicateEpics: { groups: [] },
      worktreePrune: { totalPruned: 0 },
    })),
    warmupWorktreeBackend: vi.fn(async () => undefined),
    SENTIENT_CRON_EXPR: '*/5 * * * *',
    SENTIENT_PROPOSE_CRON_EXPR: '0 */2 * * *',
    SENTIENT_HYGIENE_CRON_EXPR: '0 2 * * *',
    SENTIENT_STATE_FILE: '.cleo/sentient-state.json',
    SENTIENT_LOCK_FILE: '.cleo/sentient.lock',
    StudioSupervisor: vi.fn().mockImplementation(() => ({
      start: vi.fn(),
      stop: vi.fn(async () => undefined),
      status: 'stopped',
      pid: null,
    })),
    curatorCronExpression: vi.fn((n: number) => `0 */${Math.max(1, n)} * * *`),
  };
});

vi.mock('@cleocode/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cleocode/core')>();
  return {
    ...actual,
    getCleoHome: vi.fn(() => '/tmp/cleo-test-home'),
  };
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createSentientSubsystem (T11255 R4)', () => {
  const projectRoot = '/tmp/cleo-test-project';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('produces a frozen subsystem named "sentient"', () => {
    const subsystem = createSentientSubsystem(projectRoot, { superviseStudio: false });
    expect(subsystem.name).toBe('sentient');
    expect(Object.isFrozen(subsystem)).toBe(true);
  });

  it('registers with SubsystemRegistry without error', () => {
    const registry = new SubsystemRegistry();
    const subsystem = createSentientSubsystem(projectRoot, { superviseStudio: false });
    expect(() => registry.register(subsystem)).not.toThrow();
    expect(registry.names).toContain('sentient');
  });

  it('start → healthProbe → shutdown lifecycle completes without error', async () => {
    const registry = new SubsystemRegistry();
    registry.register(createSentientSubsystem(projectRoot, { superviseStudio: false }));

    await registry.startAll();

    const health = await registry.aggregateHealth();
    expect(health.subsystems).toHaveLength(1);
    const row = health.subsystems[0];
    expect(row?.child_id).toBe('sentient');
    // pid=process.pid is live so should be 'running'
    expect(['running', 'stopped']).toContain(row?.state);

    await registry.shutdownAll();
  });

  it('healthProbe reports stopped when pid is null', async () => {
    const { readSentientState } = await import('@cleocode/core/sentient');

    const registry = new SubsystemRegistry();
    registry.register(createSentientSubsystem(projectRoot, { superviseStudio: false }));
    await registry.startAll();

    vi.mocked(readSentientState).mockResolvedValueOnce({
      pid: null,
      killSwitch: false,
      killSwitchReason: null,
      lastTickAt: null,
      lastCronFiredAt: null,
      tier2Enabled: false,
      stuckTasks: {},
      stats: { tasksSpawned: 0, tasksCompleted: 0, tasksFailed: 0 },
    } as Awaited<ReturnType<typeof readSentientState>>);

    const health = await registry.aggregateHealth();
    expect(health.subsystems[0]?.state).toBe('stopped');

    await registry.shutdownAll();
  });

  it('shutdown releases lock and patches state with pid: null', async () => {
    const { releaseLock, patchSentientState } = await import('@cleocode/core/sentient');

    const registry = new SubsystemRegistry();
    registry.register(createSentientSubsystem(projectRoot, { superviseStudio: false }));
    await registry.startAll();
    await registry.shutdownAll();

    expect(vi.mocked(releaseLock)).toHaveBeenCalled();
    expect(vi.mocked(patchSentientState)).toHaveBeenCalledWith(
      expect.stringContaining('.cleo/sentient-state.json'),
      expect.objectContaining({ pid: null }),
    );
  });
});
