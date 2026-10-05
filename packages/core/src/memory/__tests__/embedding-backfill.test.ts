/**
 * T13126 — the bounded background embedding backfill.
 *
 * One-shot processes store observations unembedded; this batch (run by the
 * `cleo session end` worker and the sentient tick) embeds them. These tests
 * pin its contract: it never loads the model for an empty backlog, it respects
 * a governor deferral, it is bounded, and it never throws.
 *
 * @task T13126
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  pending: 0,
  deferred: false,
  released: 0,
  populateCalls: [] as Array<{ limit?: number }>,
  populateThrows: false,
}));

vi.mock('../../store/memory-sqlite.js', () => ({
  getBrainDb: async () => undefined,
  getBrainNativeDb: () => ({
    prepare: () => ({ get: () => ({ n: state.pending }) }),
  }),
}));

vi.mock('../../resources/governor.js', () => ({
  admitFailOpen: async (_cls: string, acquire: () => Promise<unknown>) => ({
    admission: await acquire(),
    ungoverned: null,
  }),
  governor: {
    tryAcquire: async (cls: string) =>
      state.deferred
        ? { deferred: true, class: cls, retryAfterMs: 1000, reason: 'memory pressure' }
        : {
            deferred: false,
            class: cls,
            slot: 0,
            acquiredAtMs: Date.now(),
            release: async () => {
              state.released += 1;
            },
          },
  },
}));

vi.mock('../retrieval/observe.js', () => ({
  populateEmbeddings: async (_root: string, opts: { limit?: number }) => {
    state.populateCalls.push(opts);
    if (state.populateThrows) throw new Error('model load failed');
    return {
      processed: Math.min(state.pending, opts.limit ?? state.pending),
      skipped: 0,
      errors: 0,
    };
  },
}));

beforeEach(() => {
  state.pending = 0;
  state.deferred = false;
  state.released = 0;
  state.populateCalls = [];
  state.populateThrows = false;
});

describe('runBoundedEmbeddingBackfill (T13126)', () => {
  it('does nothing, and never reaches the model, when nothing is pending', async () => {
    const { runBoundedEmbeddingBackfill } = await import('../embedding-backfill.js');
    const r = await runBoundedEmbeddingBackfill('/p');
    expect(r).toEqual({ ran: false, skipped: 'none-pending', pending: 0, processed: 0, errors: 0 });
    expect(state.populateCalls).toEqual([]);
  });

  it('embeds one bounded batch and releases the governor slot', async () => {
    state.pending = 120;
    const { runBoundedEmbeddingBackfill, DEFAULT_EMBEDDING_BACKFILL_LIMIT } = await import(
      '../embedding-backfill.js'
    );
    const r = await runBoundedEmbeddingBackfill('/p');
    expect(state.populateCalls).toEqual([{ limit: DEFAULT_EMBEDDING_BACKFILL_LIMIT }]);
    expect(r).toMatchObject({
      ran: true,
      pending: 120,
      processed: DEFAULT_EMBEDDING_BACKFILL_LIMIT,
    });
    expect(state.released).toBe(1);
  });

  it('honours an explicit limit', async () => {
    state.pending = 9;
    const { runBoundedEmbeddingBackfill } = await import('../embedding-backfill.js');
    await runBoundedEmbeddingBackfill('/p', { limit: 3 });
    expect(state.populateCalls).toEqual([{ limit: 3 }]);
  });

  it('skips the batch when the governor defers background work', async () => {
    state.pending = 5;
    state.deferred = true;
    const { runBoundedEmbeddingBackfill } = await import('../embedding-backfill.js');
    const r = await runBoundedEmbeddingBackfill('/p');
    expect(r).toMatchObject({ ran: false, skipped: 'deferred', pending: 5 });
    expect(state.populateCalls).toEqual([]);
  });

  it('never throws, and still releases the slot, when the batch fails', async () => {
    state.pending = 5;
    state.populateThrows = true;
    const { runBoundedEmbeddingBackfill } = await import('../embedding-backfill.js');
    await expect(runBoundedEmbeddingBackfill('/p')).resolves.toMatchObject({
      ran: true,
      errors: 1,
    });
    expect(state.released).toBe(1);
  });
});
