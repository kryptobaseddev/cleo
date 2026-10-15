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

import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  allowModelDownload: undefined as boolean | undefined,
  enabled: true,
  cached: false,
  pipelineOptions: [] as Array<{ revision?: string; dtype?: string; local_files_only?: boolean }>,
  fetched: [] as string[],
  cacheDir: '',
}));

vi.mock('../../config.js', () => ({
  loadConfig: async () => ({
    brain: {
      embedding: {
        enabled: state.enabled,
        provider: 'local',
        ...(state.allowModelDownload === undefined
          ? {}
          : { allowModelDownload: state.allowModelDownload }),
      },
    },
  }),
}));

vi.mock('@huggingface/transformers', () => ({
  env: {
    allowRemoteModels: true,
    get cacheDir() {
      return state.cacheDir;
    },
  },
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
  state.enabled = true;
  state.cached = false;
  state.pipelineOptions = [];
  state.fetched = [];
  // A fake cached model file; the load verifies the weights' hash (T13740).
  state.cacheDir = mkdtempSync(join(tmpdir(), 'cleo-model-cache-'));
  const onnxDir = join(state.cacheDir, 'Xenova', 'all-MiniLM-L6-v2', 'onnx');
  mkdirSync(onnxDir, { recursive: true });
  writeFileSync(join(onnxDir, 'model.onnx'), 'fake weights');
  const { __resetLocalEmbeddingStateForTests, __setExpectedModelSha256ForTests } = await import(
    '../embedding-local.js'
  );
  __resetLocalEmbeddingStateForTests();
  __setExpectedModelSha256ForTests(createHash('sha256').update('fake weights').digest('hex'));
});

afterEach(() => {
  rmSync(state.cacheDir, { recursive: true, force: true });
});

describe('local embedding model download gate (T13716)', () => {
  it('default config: an uncached model is never fetched, and the failure latches', async () => {
    const { LocalEmbeddingProvider } = await import('../embedding-local.js');
    const provider = new LocalEmbeddingProvider();

    await expect(provider.embed('hello')).rejects.toThrow(/not found locally/);
    await expect(provider.embedBatch(['again'])).rejects.toThrow(/unavailable/);

    expect(state.fetched).toEqual([]);
    expect(state.pipelineOptions).toEqual([
      { revision: 'main', dtype: 'fp32', local_files_only: true },
    ]);
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
    expect(state.pipelineOptions).toEqual([
      { revision: 'main', dtype: 'fp32', local_files_only: true },
    ]);
  });

  it('explicit opt-in: the model is downloaded', async () => {
    state.allowModelDownload = true;
    const { LocalEmbeddingProvider } = await import('../embedding-local.js');
    const vec = await new LocalEmbeddingProvider().embed('hello');
    expect(vec).toHaveLength(384);
    expect(state.pipelineOptions).toEqual([
      { revision: 'main', dtype: 'fp32', local_files_only: false },
    ]);
    expect(state.fetched).toHaveLength(1);
    expect(state.fetched[0]).toContain('huggingface.co');
  });

  it('brain.embedding.enabled=false: ensureEmbeddingProvider refuses even with a provider', async () => {
    state.enabled = false;
    const { LocalEmbeddingProvider } = await import('../embedding-local.js');
    const { clearEmbeddingProvider, ensureEmbeddingProvider, setEmbeddingProvider } = await import(
      '../brain-embedding.js'
    );
    setEmbeddingProvider(new LocalEmbeddingProvider());
    try {
      expect(await ensureEmbeddingProvider('/p')).toBe(false);
      state.enabled = true;
      expect(await ensureEmbeddingProvider('/p')).toBe(true);
    } finally {
      clearEmbeddingProvider();
    }
    expect(state.pipelineOptions).toEqual([]);
  });

  it('cached weights with another hash latch the provider unavailable (T13740)', async () => {
    state.cached = true;
    const { LocalEmbeddingProvider } = await import('../embedding-local.js');
    writeFileSync(
      join(state.cacheDir, 'Xenova', 'all-MiniLM-L6-v2', 'onnx', 'model.onnx'),
      'other weights',
    );
    const provider = new LocalEmbeddingProvider();

    await expect(provider.embed('hello')).rejects.toThrow(/sha256 .* embeddings are off/);
    expect(provider.isAvailable()).toBe(false);
    await expect(provider.embed('again')).rejects.toThrow(/unavailable/);
    expect(provider.model).toBe('Xenova/all-MiniLM-L6-v2@onnx-sha256:759c3cd2b7fe:fp32');
  });

  it('weights missing from the cache latch with a clear message, not a raw ENOENT (T13740)', async () => {
    state.cached = true;
    rmSync(join(state.cacheDir, 'Xenova'), { recursive: true, force: true });
    const { LocalEmbeddingProvider } = await import('../embedding-local.js');
    const provider = new LocalEmbeddingProvider();

    await expect(provider.embed('hello')).rejects.toThrow(/cannot be verified/);
    expect(provider.isAvailable()).toBe(false);
  });
});
