/**
 * T14069 — the brain writer worker drains its scheduled embeddings before it
 * is terminated.
 *
 * The worker embeds new observations inline, which loads the native
 * onnxruntime addon. A `terminate()` that cut through that load or an
 * inference aborted the whole vitest fork on CI ("Worker exited
 * unexpectedly"). These tests pin the drain: it waits for every embedding in
 * flight, and nothing new starts after it.
 *
 * @task T14069
 */

import { describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  started: 0,
  release: null as (() => void) | null,
}));

vi.mock('../brain-host.js', () => ({
  isLongLivedBrainHost: () => true,
  isBrainWriterIsolate: () => true,
}));

vi.mock('../brain-embedding.js', () => ({
  ensureEmbeddingProvider: async () => true,
  getEmbeddingProvider: () => ({ model: 'test-model' }),
  embedText: () => {
    state.started += 1;
    return new Promise<null>((resolve) => {
      state.release = () => resolve(null);
    });
  },
}));

const { drainScheduledEmbeddings, scheduleEmbedding } = await import('../embedding-backfill.js');

describe('drainScheduledEmbeddings (T14069)', () => {
  it('waits for an embedding in flight, and no embedding starts after it', async () => {
    scheduleEmbedding('/p', 'O-1', 'text');
    await vi.waitFor(() => expect(state.started).toBe(1));

    let drained = false;
    const drain = drainScheduledEmbeddings().then(() => {
      drained = true;
    });
    await new Promise((r) => setImmediate(r));
    expect(drained).toBe(false); // the embedding still runs

    state.release?.();
    await drain;
    expect(drained).toBe(true);

    scheduleEmbedding('/p', 'O-2', 'text');
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(state.started).toBe(1);
  });
});
