/**
 * T12115 — `shutdownCliRuntime` must survive a teardown step that never settles.
 *
 * This is the regression test for the real defect. The pre-T12115 `safely()`
 * helper swallowed *throws* but awaited its step indefinitely, so one stalled
 * subsystem hung the whole exit path — and because closing the databases is
 * step 3 of 4, a stall in step 1 or 2 left SQLite descriptors open forever.
 * That is precisely the state found on a live host: `cleo update` resident 12.9
 * hours in `ep_poll`, envelope long since printed, descriptors still held.
 *
 * A stalled step is not hypothetical. The embedding queue can hold an in-flight
 * inline `provider.embed()` — a transformers.js model load on the main thread —
 * that no one awaits or cancels; if the model never becomes ready, the promise
 * never settles.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const closers = vi.hoisted(() => ({
  brain: vi.fn(),
  embedding: vi.fn(),
  databases: vi.fn(),
  logger: vi.fn(),
}));
vi.mock('../memory/brain-writer-thread.js', () => ({ shutdownBrainWriter: closers.brain }));
vi.mock('../memory/embedding-queue.js', () => ({ resetEmbeddingQueue: closers.embedding }));
vi.mock('../store/sqlite.js', () => ({ closeAllDatabases: closers.databases }));
vi.mock('../logger.js', () => ({ closeLogger: closers.logger }));

import { shutdownCliRuntime } from '../shutdown.js';
import { STEP_DEADLINE_MS } from '../shutdown-deadline.js';
import { awaitBackgroundOps, trackBackgroundOp } from '../store/background-ops.js';
import { _resetTeardownSignalForTests } from '../teardown-signal.js';

/** A promise that never settles — the shape of the real stall. */
const neverSettles = () => new Promise<void>(() => {});

beforeEach(() => {
  vi.useFakeTimers();
  _resetTeardownSignalForTests();
  for (const closer of Object.values(closers)) closer.mockReset().mockResolvedValue(undefined);
});
afterEach(async () => {
  await awaitBackgroundOps();
  vi.useRealTimers();
  _resetTeardownSignalForTests();
});

describe('shutdownCliRuntime', () => {
  it('returns even when a teardown step never settles', async () => {
    closers.embedding.mockImplementation(neverSettles);
    const startedAt = Date.now();
    const shutdown = shutdownCliRuntime();
    await vi.advanceTimersByTimeAsync(STEP_DEADLINE_MS);
    const outcomes = await shutdown;
    expect(Date.now() - startedAt).toBe(STEP_DEADLINE_MS);
    expect(outcomes.find((o) => o.label === 'embedding-queue')?.settled).toBe(false);
  });

  it('reports later steps unstarted when an earlier stall consumes the shared deadline', async () => {
    // The previous assertion required database closure after a producer failed
    // to stop. One overall deadline cannot safely grant those closers a fresh
    // budget; every omitted subsystem must remain explicitly incomplete.
    closers.brain.mockImplementation(neverSettles);
    const shutdown = shutdownCliRuntime();
    await vi.advanceTimersByTimeAsync(STEP_DEADLINE_MS);
    const outcomes = await shutdown;
    expect(closers.databases).not.toHaveBeenCalled();
    expect(closers.embedding).not.toHaveBeenCalled();
    expect(closers.logger).not.toHaveBeenCalled();
    expect(outcomes.find((o) => o.label === 'brain-writer')?.settled).toBe(false);
    expect(outcomes.find((o) => o.label === 'databases')).toMatchObject({
      settled: false,
      durationMs: 0,
    });
  });

  it('reports every step so a caller can surface which subsystem leaked', async () => {
    const outcomes = await shutdownCliRuntime();
    expect(outcomes.map((o) => o.label)).toEqual([
      'background-operations',
      'brain-writer',
      'embedding-queue',
      'databases',
      'logger',
    ]);
    expect(outcomes.every((outcome) => outcome.settled && !outcome.threw)).toBe(true);
  });

  it('does not close subsequent resources when a closer registers unfinished work', async () => {
    const release = Promise.withResolvers<void>();
    closers.brain.mockImplementation(async () => {
      trackBackgroundOp(release.promise);
    });
    try {
      const outcomes = await shutdownCliRuntime();
      expect(closers.brain).toHaveBeenCalledTimes(1);
      expect(closers.embedding).not.toHaveBeenCalled();
      expect(closers.databases).not.toHaveBeenCalled();
      expect(closers.logger).not.toHaveBeenCalled();
      expect(outcomes.find((outcome) => outcome.label === 'databases')).toMatchObject({
        settled: false,
        threw: false,
      });
    } finally {
      release.resolve();
    }
  });
});
