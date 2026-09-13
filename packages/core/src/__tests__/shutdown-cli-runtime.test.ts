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

import { afterEach, describe, expect, it, vi } from 'vitest';

/** A promise that never settles — the shape of the real stall. */
const neverSettles = () => new Promise<void>(() => {});

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
});

describe('shutdownCliRuntime', () => {
  it('returns even when a teardown step never settles', async () => {
    vi.doMock('../memory/embedding-queue.js', () => ({
      resetEmbeddingQueue: neverSettles,
    }));

    const { shutdownCliRuntime } = await import('../shutdown.js');

    const startedAt = Date.now();
    const outcomes = await shutdownCliRuntime();
    const elapsed = Date.now() - startedAt;

    // Against the old unbounded `safely()` this call never returns and the test
    // dies by timeout instead of asserting.
    expect(elapsed).toBeLessThan(10_000);

    const stalled = outcomes.find((o) => o.label === 'embedding-queue');
    expect(stalled?.settled).toBe(false);
  });

  it('runs every later step after an earlier one stalls', async () => {
    // The descriptor evidence from the live host: teardown stalled at step 1 or
    // 2, so `closeAllDatabases` (step 3) never ran and the SQLite handles
    // stayed open. Abandoning a stalled step is what restores the later ones.
    vi.doMock('../memory/brain-writer-thread.js', () => ({
      shutdownBrainWriter: neverSettles,
    }));

    const closeAllDatabases = vi.fn(async () => {});
    vi.doMock('../store/sqlite.js', () => ({ closeAllDatabases }));

    const { shutdownCliRuntime } = await import('../shutdown.js');
    const outcomes = await shutdownCliRuntime();

    expect(closeAllDatabases).toHaveBeenCalledTimes(1);
    expect(outcomes.find((o) => o.label === 'brain-writer')?.settled).toBe(false);
    expect(outcomes.find((o) => o.label === 'databases')?.settled).toBe(true);
  });

  it('reports every step so a caller can surface which subsystem leaked', async () => {
    const { shutdownCliRuntime } = await import('../shutdown.js');
    const outcomes = await shutdownCliRuntime();

    expect(outcomes.map((o) => o.label)).toEqual([
      'brain-writer',
      'embedding-queue',
      'databases',
      'logger',
    ]);
  });
});
