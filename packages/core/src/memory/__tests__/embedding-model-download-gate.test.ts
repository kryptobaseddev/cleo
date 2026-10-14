/**
 * T13716 — the local embedding model is downloaded only on explicit opt-in.
 *
 * The session-end worker's backfill reached huggingface.co with default
 * config. `loadPipeline` is the one place the model is fetched, so it gates
 * the download: without `brain.embedding.allowModelDownload` it loads with
 * `local_files_only`, which transformers.js serves from its cache and never
 * fetches remotely.
 *
 * The fake `pipeline` mirrors that library contract: with `local_files_only`
 * it loads a cached model or throws, and only otherwise calls the fetch layer.
 *
 * @task T13716
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  allowModelDownload: undefined as boolean | undefined,
  cached: false,
  pipelineOptions: [] as Array<{ local_files_only?: boolean }>,
  fetched: [] as string[],
}));

vi.mock('../../config.js', () => ({
  loadConfig: async () => ({
    brain: {
      embedding: {
        enabled: true,
        provider: 'local',
        ...(state.allowModelDownload === undefined
          ? {}
          : { allowModelDownload: state.allowModelDownload }),
      },
    },
  }),
}));

vi.mock('@huggingface/transformers', () => ({
  pipeline: async (_task: string, model: string, opts: { local_files_only?: boolean }) => {
    state.pipelineOptions.push(opts);
    if (!state.cached) {
      if (opts.local_files_only) throw new Error(`${model} was not found locally`);
      state.fetched.push(`https://huggingface.co/${model}/resolve/main/config.json`);
    }
    return async () => ({ data: new Float32Array(384).fill(0.25) });
  },
}));

beforeEach(async () => {
  state.allowModelDownload = undefined;
  state.cached = false;
  state.pipelineOptions = [];
  state.fetched = [];
  const { __resetLocalEmbeddingStateForTests } = await import('../embedding-local.js');
  __resetLocalEmbeddingStateForTests();
});

describe('local embedding model download gate (T13716)', () => {
  it('default config: an uncached model is never fetched, and the failure latches', async () => {
    const { LocalEmbeddingProvider } = await import('../embedding-local.js');
    const provider = new LocalEmbeddingProvider();

    await expect(provider.embed('hello')).rejects.toThrow(/not found locally/);
    await expect(provider.embedBatch(['again'])).rejects.toThrow(/unavailable/);

    expect(state.fetched).toEqual([]);
    expect(state.pipelineOptions).toEqual([{ local_files_only: true }]);
    expect(provider.isAvailable()).toBe(false);
  });

  it('default config: the backfill path (embedText) skips quietly with no fetch', async () => {
    const { LocalEmbeddingProvider } = await import('../embedding-local.js');
    const { clearEmbeddingProvider, embedText, setEmbeddingProvider } = await import(
      '../brain-embedding.js'
    );
    setEmbeddingProvider(new LocalEmbeddingProvider());
    try {
      await expect(embedText('row one')).resolves.toBeNull();
      await expect(embedText('row two')).resolves.toBeNull();
      expect(state.fetched).toEqual([]);
    } finally {
      clearEmbeddingProvider();
    }
  });

  it('default config: an already cached model still loads (no regression for cached users)', async () => {
    state.cached = true;
    const { LocalEmbeddingProvider } = await import('../embedding-local.js');
    const vec = await new LocalEmbeddingProvider().embed('hello');
    expect(vec).toHaveLength(384);
    expect(state.fetched).toEqual([]);
    expect(state.pipelineOptions).toEqual([{ local_files_only: true }]);
  });

  it('explicit opt-in: the model is downloaded', async () => {
    state.allowModelDownload = true;
    const { LocalEmbeddingProvider } = await import('../embedding-local.js');
    const vec = await new LocalEmbeddingProvider().embed('hello');
    expect(vec).toHaveLength(384);
    expect(state.pipelineOptions).toEqual([{ local_files_only: false }]);
    expect(state.fetched).toHaveLength(1);
    expect(state.fetched[0]).toContain('huggingface.co');
  });
});
