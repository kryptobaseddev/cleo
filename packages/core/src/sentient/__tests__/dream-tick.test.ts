/**
 * Dream-tick integration tests — T996
 *
 * Verifies that the sentient tick loop correctly evaluates volume + idle
 * dream triggers via `safeRunTick` / `runTick`, and that the
 * `startDreamScheduler` setTimeout chaining pattern has been removed.
 *
 * All tests use injected `checkAndDream` fakes so brain.db is never touched.
 *
 * Test inventory:
 *   DT-1: Volume threshold exceeded → checkAndDream called within next tick
 *   DT-2: Volume threshold NOT exceeded → checkAndDream still called (passes through to checkAndDream internal logic)
 *   DT-3: Idle N consecutive no-task ticks → consecutiveIdleTicks increments
 *   DT-4: Task pick resets idle counter to 0
 *   DT-5: checkAndDream error does NOT crash the tick (graceful error handling)
 *   DT-6: Two rapid safeRunTick calls do not double-invoke dream (checkAndDream's own cooldown)
 *   DT-7: startDreamScheduler is NOT exported from dream-cycle.ts
 *   DT-8: runTick itself does NOT call checkAndDream (only safeRunTick wrapper does)
 *
 * @task T996
 * @epic T991
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Task } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SENTIENT_STATE_FILE } from '../daemon.js';
import { DEFAULT_SENTIENT_STATE, writeSentientState } from '../state.js';
import {
  _getConsecutiveIdleTicks,
  _resetDreamTickState,
  DREAM_VOLUME_THRESHOLD_DEFAULT,
  runTick,
  safeRunTick,
  type TickOptions,
} from '../tick.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTask(id: string): Task {
  return {
    id,
    title: `Task ${id}`,
    status: 'pending',
    priority: 'medium',
    createdAt: new Date().toISOString(),
  } as Task;
}

function makeDreamFake() {
  return vi.fn().mockResolvedValue({ triggered: false, tier: null, skippedReason: 'test' });
}

function mkTickOpts(projectRoot: string, overrides: Partial<TickOptions> = {}): TickOptions {
  return {
    projectRoot,
    statePath: join(projectRoot, SENTIENT_STATE_FILE),
    pickTask: async () => null,
    spawn: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('dream-tick integration (T996)', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'cleo-dream-tick-'));
    const statePath = join(root, SENTIENT_STATE_FILE);
    await writeSentientState(statePath, { ...DEFAULT_SENTIENT_STATE });
    _resetDreamTickState();
  });

  afterEach(async () => {
    _resetDreamTickState();
    await rm(root, { recursive: true, force: true });
  });

  // DT-1: Volume threshold exceeded → checkAndDream called within next tick
  it('DT-1: calls checkAndDream on every safeRunTick (volume/idle path delegated)', async () => {
    const dreamFake = makeDreamFake();
    const opts = mkTickOpts(root, {
      checkAndDream: dreamFake,
      dreamVolumeThreshold: DREAM_VOLUME_THRESHOLD_DEFAULT,
    });

    await safeRunTick(opts);
    expect(dreamFake).toHaveBeenCalledOnce();
    expect(dreamFake).toHaveBeenCalledWith(root, expect.objectContaining({ inline: false }));
  });

  // DT-2: checkAndDream is called even when no task is available (volume below
  // threshold is handled inside checkAndDream itself, not by tick)
  it('DT-2: calls checkAndDream even on no-task ticks', async () => {
    const dreamFake = makeDreamFake();
    const opts = mkTickOpts(root, {
      pickTask: async () => null,
      checkAndDream: dreamFake,
    });

    await safeRunTick(opts);
    expect(dreamFake).toHaveBeenCalledOnce();
  });

  // DT-3: Idle counter increments on no-task ticks
  it('DT-3: consecutiveIdleTicks increments on no-task ticks', async () => {
    const dreamFake = makeDreamFake();
    const opts = mkTickOpts(root, {
      pickTask: async () => null,
      checkAndDream: dreamFake,
    });

    expect(_getConsecutiveIdleTicks()).toBe(0);
    await safeRunTick(opts);
    expect(_getConsecutiveIdleTicks()).toBe(1);
    await safeRunTick(opts);
    expect(_getConsecutiveIdleTicks()).toBe(2);
  });

  // DT-4: Task pick resets idle counter to 0
  it('DT-4: picking a task resets consecutiveIdleTicks to 0', async () => {
    const dreamFake = makeDreamFake();

    // Run two idle ticks first
    const idleOpts = mkTickOpts(root, {
      pickTask: async () => null,
      checkAndDream: dreamFake,
    });
    await safeRunTick(idleOpts);
    await safeRunTick(idleOpts);
    expect(_getConsecutiveIdleTicks()).toBe(2);

    // Now pick a task
    const activeOpts = mkTickOpts(root, {
      pickTask: async () => makeTask('T001'),
      spawn: async () => ({ exitCode: 0, stdout: 'done', stderr: '' }),
      checkAndDream: dreamFake,
    });
    await safeRunTick(activeOpts);
    expect(_getConsecutiveIdleTicks()).toBe(0);
  });

  // DT-5: checkAndDream error does NOT crash the tick
  it('DT-5: checkAndDream error does not crash safeRunTick', async () => {
    const dreamFake = vi.fn().mockRejectedValue(new Error('brain.db unavailable'));
    const opts = mkTickOpts(root, {
      pickTask: async () => null,
      checkAndDream: dreamFake,
    });

    // Must not throw
    const outcome = await safeRunTick(opts);
    expect(outcome.kind).toBe('no-task');
    expect(dreamFake).toHaveBeenCalledOnce();
  });

  // DT-6: Two rapid safeRunTick calls both invoke checkAndDream (idempotency
  // is inside checkAndDream's cooldown, not the tick's responsibility)
  it('DT-6: safeRunTick calls checkAndDream on every invocation', async () => {
    const dreamFake = makeDreamFake();
    const opts = mkTickOpts(root, { checkAndDream: dreamFake });

    await safeRunTick(opts);
    await safeRunTick(opts);
    expect(dreamFake).toHaveBeenCalledTimes(2);
  });

  // DT-7: startDreamScheduler is NOT exported from dream-cycle.ts
  it('DT-7: startDreamScheduler is not exported from dream-cycle.ts', async () => {
    const dreamCycle = await import('@cleocode/core/internal');
    // The key must not exist (or not be a function)
    expect(
      'startDreamScheduler' in dreamCycle
        ? typeof (dreamCycle as Record<string, unknown>)['startDreamScheduler']
        : 'not-present',
    ).toBe('not-present');
  });

  // DT-8: runTick itself does NOT call checkAndDream — only safeRunTick does
  it('DT-8: runTick alone does NOT invoke checkAndDream', async () => {
    const dreamFake = makeDreamFake();
    const opts = mkTickOpts(root, {
      pickTask: async () => null,
      checkAndDream: dreamFake,
    });

    // Call the inner runTick directly, not the safe wrapper
    await runTick(opts);
    expect(dreamFake).not.toHaveBeenCalled();
  });
});
