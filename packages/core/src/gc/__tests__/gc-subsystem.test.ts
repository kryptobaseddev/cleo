/**
 * GC Subsystem Tests (T11505 — R5-T3)
 *
 * Covers:
 * - createGcSubsystem: returns a valid frozen Subsystem<GcSubsystemContext>
 * - start(): registers daemon PID, runs crash recovery when pendingPrune is
 *   non-empty, runs missed-run recovery when elapsed > 24h, schedules cron
 * - healthProbe(): reports 'stopped' before start, 'running' after start
 * - shutdown(): destroys the cron task so the process can exit cleanly
 * - Full SubsystemRegistry integration: start → healthProbe → shutdown
 *
 * Uses real temp directories (mkdtemp). Mocks node-cron and runGC so tests
 * do not actually perform GC or wait for cron ticks.
 *
 * @task T11505
 * @epic T11256
 * @saga T11243 SG-RUNTIME-UNIFICATION
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Mock node-cron so tests do not schedule real OS timers
vi.mock('node-cron', () => {
  const destroy = vi.fn();
  const schedule = vi.fn().mockReturnValue({ destroy });
  return { default: { schedule }, __destroy: destroy };
});

// Mock runGC so tests do not touch the real filesystem or disk-space
vi.mock('../runner.js', () => ({
  runGC: vi.fn().mockResolvedValue(undefined),
}));

import cron from 'node-cron';
import { createGcSubsystem } from '../gc-subsystem.js';
import { runGC } from '../runner.js';
import { patchGCState, readGCState } from '../state.js';

const mockSchedule = vi.mocked(cron.schedule);
const mockRunGC = vi.mocked(runGC);

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Create a fresh temp directory with a .cleo/ layout for one test. */
async function makeTmpCleoDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'cleo-gc-subsystem-test-'));
  const cleoDir = join(root, '.cleo');
  await mkdir(cleoDir, { recursive: true });
  return cleoDir;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createGcSubsystem', () => {
  let cleoDir: string;

  beforeEach(async () => {
    cleoDir = await makeTmpCleoDir();
    vi.clearAllMocks();
    // Default: cron.schedule returns a fresh destroy mock each test
    const destroy = vi.fn();
    mockSchedule.mockReturnValue({ destroy } as ReturnType<typeof cron.schedule>);
  });

  afterEach(async () => {
    const root = join(cleoDir, '..');
    await rm(root, { recursive: true, force: true });
  });

  it('returns a frozen subsystem named "gc"', () => {
    const sub = createGcSubsystem(cleoDir);
    expect(sub.name).toBe('gc');
    expect(Object.isFrozen(sub)).toBe(true);
    expect(typeof sub.start).toBe('function');
    expect(typeof sub.healthProbe).toBe('function');
    expect(typeof sub.shutdown).toBe('function');
  });

  it('healthProbe() returns stopped state before start()', () => {
    const sub = createGcSubsystem(cleoDir);
    const health = sub.healthProbe();
    expect(health.child_id).toBe('gc');
    expect(health.state).toBe('stopped');
    expect(health.pid).toBe(0);
  });

  it('start() registers daemon PID in gc-state.json', async () => {
    const sub = createGcSubsystem(cleoDir);
    const ctx = await sub.start();
    expect(ctx.pid).toBe(process.pid);
    expect(ctx.startedAt).toBeTruthy();

    const state = await readGCState(join(cleoDir, 'gc-state.json'));
    expect(state.daemonPid).toBe(process.pid);
  });

  it('start() schedules the cron job', async () => {
    const sub = createGcSubsystem(cleoDir);
    await sub.start();
    expect(mockSchedule).toHaveBeenCalledOnce();
    const [expr, , opts] = mockSchedule.mock.calls[0]!;
    expect(expr).toBe('0 3 * * *');
    expect((opts as { timezone: string }).timezone).toBe('UTC');
    expect((opts as { noOverlap: boolean }).noOverlap).toBe(true);
  });

  it('start() runs missed-run recovery when no lastRunAt is recorded', async () => {
    // Default state has lastRunAt=null → elapsed is Infinity → recovery runs
    const sub = createGcSubsystem(cleoDir);
    await sub.start();
    // At least one runGC call for missed-run recovery
    expect(mockRunGC).toHaveBeenCalledWith({ cleoDir });
  });

  it('start() runs crash recovery when pendingPrune is non-empty', async () => {
    // Seed a pending prune in state
    await patchGCState(join(cleoDir, 'gc-state.json'), {
      pendingPrune: ['blob-a', 'blob-b'],
      // Set lastRunAt to now so missed-run recovery does NOT fire (avoids
      // an extra runGC call that would make counting ambiguous)
      lastRunAt: new Date().toISOString(),
    });

    const sub = createGcSubsystem(cleoDir);
    await sub.start();
    // Crash-recovery fires with resumeFrom
    expect(mockRunGC).toHaveBeenCalledWith({ cleoDir, resumeFrom: ['blob-a', 'blob-b'] });
  });

  it('start() does NOT run missed-run recovery when last run was recent', async () => {
    // Set lastRunAt to now — elapsed ≈ 0ms → no missed-run recovery
    await patchGCState(join(cleoDir, 'gc-state.json'), {
      lastRunAt: new Date().toISOString(),
    });

    const sub = createGcSubsystem(cleoDir);
    await sub.start();
    // No runGC call for missed-run recovery; crash recovery also skipped
    // (pendingPrune defaults to null)
    expect(mockRunGC).not.toHaveBeenCalled();
  });

  it('healthProbe() returns running state after start()', async () => {
    const sub = createGcSubsystem(cleoDir);
    await sub.start();
    const health = sub.healthProbe();
    expect(health.child_id).toBe('gc');
    expect(health.state).toBe('running');
    expect(health.pid).toBe(process.pid);
  });

  it('shutdown() destroys the cron task', async () => {
    const destroy = vi.fn();
    mockSchedule.mockReturnValue({ destroy } as ReturnType<typeof cron.schedule>);

    const sub = createGcSubsystem(cleoDir);
    const ctx = await sub.start();
    sub.shutdown(ctx);

    expect(destroy).toHaveBeenCalledOnce();
  });

  it('healthProbe() returns stopped after shutdown()', async () => {
    const sub = createGcSubsystem(cleoDir);
    const ctx = await sub.start();
    sub.shutdown(ctx);
    const health = sub.healthProbe();
    expect(health.state).toBe('stopped');
  });

  it('start() is crash-recovery non-fatal when runGC rejects for pendingPrune', async () => {
    await patchGCState(join(cleoDir, 'gc-state.json'), {
      pendingPrune: ['bad-blob'],
      lastRunAt: new Date().toISOString(),
    });
    mockRunGC.mockRejectedValueOnce(new Error('crash recovery fail'));

    const sub = createGcSubsystem(cleoDir);
    // Should not throw — crash recovery failure is non-fatal
    await expect(sub.start()).resolves.toBeDefined();
  });

  it('start() is missed-run recovery non-fatal when runGC rejects', async () => {
    // lastRunAt = null → missed-run recovery fires; runGC will reject
    mockRunGC.mockRejectedValueOnce(new Error('missed-run fail'));

    const sub = createGcSubsystem(cleoDir);
    // Should not throw — missed-run failure is non-fatal
    await expect(sub.start()).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// SubsystemRegistry integration (uses SubsystemRegistry duck-type manually to
// avoid a @cleocode/runtime import in @cleocode/core tests)
// ---------------------------------------------------------------------------

describe('createGcSubsystem — manual lifecycle integration', () => {
  let cleoDir: string;

  beforeEach(async () => {
    cleoDir = await makeTmpCleoDir();
    vi.clearAllMocks();
    const destroy = vi.fn();
    mockSchedule.mockReturnValue({ destroy } as ReturnType<typeof cron.schedule>);
    // Set lastRunAt to now so missed-run recovery does not fire by default
    await patchGCState(join(cleoDir, 'gc-state.json'), {
      lastRunAt: new Date().toISOString(),
    });
  });

  afterEach(async () => {
    const root = join(cleoDir, '..');
    await rm(root, { recursive: true, force: true });
  });

  it('full start → healthProbe → shutdown lifecycle without loss', async () => {
    const sub = createGcSubsystem(cleoDir);

    // Pre-start: stopped
    expect(sub.healthProbe().state).toBe('stopped');

    // Start
    const ctx = await sub.start();
    expect(ctx.pid).toBe(process.pid);

    // Health: running
    const health = sub.healthProbe();
    expect(health.state).toBe('running');
    expect(health.pid).toBe(process.pid);
    expect(health.child_id).toBe('gc');

    // Shutdown
    sub.shutdown(ctx);
    expect(sub.healthProbe().state).toBe('stopped');
  });

  it('GcSubsystemContext.runs increments on crash + missed-run recovery', async () => {
    // Seed pending prune AND stale lastRunAt so both recovery paths fire
    await patchGCState(join(cleoDir, 'gc-state.json'), {
      pendingPrune: ['x', 'y'],
      lastRunAt: null,
    });

    const sub = createGcSubsystem(cleoDir);
    const ctx = await sub.start();
    // Both crash recovery AND missed-run recovery ran → runs >= 2
    expect(ctx.runs).toBeGreaterThanOrEqual(2);
  });
});
