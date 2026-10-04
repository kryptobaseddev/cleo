/**
 * Sentient-tick admission tests (T12001 AC3, Epic T11992) — Never-OOM.
 *
 * The whole tick (pick + spawn + the background dream/deriver/hygiene/drift/
 * prune scans) is db-heavy. `safeRunTick` gates it through the governor's
 * `db-heavy` class: under memory pressure it skips the interval cleanly (a
 * `backoff` outcome carrying `tickSkipped:pressure`, no user-visible error) and
 * never runs the heavy work; otherwise it proceeds and releases the slot.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Task } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResourceSample } from '../../resources/backend.js';
import * as governorModule from '../../resources/governor.js';
import { ResourceMonitor } from '../../resources/monitor.js';
import { SENTIENT_STATE_FILE } from '../daemon.js';
import { DEFAULT_SENTIENT_STATE, writeSentientState } from '../state.js';
import { safeRunTick, type TickOptions } from '../tick.js';

function makeTask(id: string): Task {
  return {
    id,
    title: `Task ${id}`,
    status: 'pending',
    priority: 'medium',
    createdAt: new Date().toISOString(),
  } as Task;
}

function mkTickOpts(projectRoot: string, overrides: Partial<TickOptions> = {}): TickOptions {
  return {
    projectRoot,
    statePath: join(projectRoot, SENTIENT_STATE_FILE),
    pickTask: async () => null,
    spawn: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    skipReVerify: true,
    runDeriverBatch: false,
    ...overrides,
  };
}

describe('safeRunTick — db-heavy admission (T12001 AC3)', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'cleo-tick-admission-'));
    await writeSentientState(join(root, SENTIENT_STATE_FILE), { ...DEFAULT_SENTIENT_STATE });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  });

  it('skips the tick under pressure without running the heavy work', async () => {
    vi.spyOn(governorModule.governor, 'tryAcquire').mockResolvedValue({
      deferred: true,
      class: 'db-heavy',
      retryAfterMs: 2000,
      reason: 'db-heavy budget is 0 under current pressure',
    });
    const pickTask = vi.fn(async () => makeTask('T001'));
    const checkAndDream = vi.fn(async () => ({
      triggered: false,
      tier: null,
      skippedReason: 'test',
    }));

    const outcome = await safeRunTick(mkTickOpts(root, { pickTask, checkAndDream }));

    expect(outcome.kind).toBe('backoff');
    expect(outcome.detail).toContain('tickSkipped:pressure');
    // The heavy tick body never ran: neither the task picker nor the dream scan.
    expect(pickTask).not.toHaveBeenCalled();
    expect(checkAndDream).not.toHaveBeenCalled();
  });

  it('proceeds and releases the slot when admitted', async () => {
    const release = vi.fn(async () => {});
    vi.spyOn(governorModule.governor, 'tryAcquire').mockResolvedValue({
      deferred: false,
      class: 'db-heavy',
      slot: 0,
      acquiredAtMs: 1,
      release,
    });
    const pickTask = vi.fn(async () => null);
    // Inject a no-op dream scan so the tick opens no DB — otherwise a real
    // brain.db open would itself acquire/release db-heavy (exodus gate, #1111)
    // and double-count the shared release spy.
    const checkAndDream = vi.fn(async () => ({
      triggered: false,
      tier: null,
      skippedReason: 'test',
    }));

    const outcome = await safeRunTick(mkTickOpts(root, { pickTask, checkAndDream }));

    // No task available → normal no-task outcome (NOT a pressure skip).
    expect(outcome.kind).toBe('no-task');
    expect(pickTask).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });

  it('runs the tick ungated when the governor cannot write its state (#1777 R8-1)', async () => {
    vi.spyOn(governorModule.governor, 'tryAcquire').mockRejectedValue(
      Object.assign(new Error('EROFS: read-only file system'), { code: 'EROFS' }),
    );
    const pickTask = vi.fn(async () => null);
    const checkAndDream = vi.fn(async () => ({
      triggered: false,
      tier: null,
      skippedReason: 'test',
    }));

    const outcome = await safeRunTick(mkTickOpts(root, { pickTask, checkAndDream }));

    expect(outcome.kind).toBe('no-task'); // not a pressure skip, not a throw
    expect(pickTask).toHaveBeenCalledOnce();
  });

  // The real governor on a darwin-shaped sample (T13170): macOS reads the load
  // average as CPU pressure (T12981), so a busy CI runner or a Mac running
  // agents reports cpu some avg10 far past backoff while memory is calm. That
  // skipped every tick, so the dream trigger never fired on macOS CI.
  const darwinSample = (memorySome: number, cpuSome: number): ResourceSample => {
    const line = (v: number) => ({ avg10: v, avg60: v, avg300: v, totalUs: 0 });
    return {
      sampledAtMs: 1,
      pressureAvailable: true,
      memAvailableBytes: 24 * 1024 ** 3,
      globalPressure: { some: line(memorySome), full: line(0) },
      slicePressure: null,
      cpuPressure: { some: line(cpuSome), full: null },
      walObservations: [],
    };
  };

  it('a busy CPU with healthy memory runs the tick (real governor, darwin sample, T13170)', async () => {
    governorModule._resetGovernorStateForTest();
    vi.spyOn(ResourceMonitor.prototype, 'sample').mockResolvedValue(darwinSample(0, 75));
    const pickTask = vi.fn(async () => null);
    const checkAndDream = vi.fn(async () => ({
      triggered: false,
      tier: null,
      skippedReason: 'test',
    }));

    const outcome = await safeRunTick(mkTickOpts(root, { pickTask, checkAndDream }));

    expect(outcome.kind).toBe('no-task');
    expect(checkAndDream).toHaveBeenCalledOnce();
    governorModule._resetGovernorStateForTest();
  });

  it('memory pressure still skips the tick (real governor, darwin sample, T13170)', async () => {
    governorModule._resetGovernorStateForTest();
    vi.spyOn(ResourceMonitor.prototype, 'sample').mockResolvedValue(darwinSample(30, 0));
    const pickTask = vi.fn(async () => null);

    const outcome = await safeRunTick(mkTickOpts(root, { pickTask }));

    expect(outcome.kind).toBe('backoff');
    expect(outcome.detail).toContain('tickSkipped:pressure');
    expect(pickTask).not.toHaveBeenCalled();
    governorModule._resetGovernorStateForTest();
  });
});
