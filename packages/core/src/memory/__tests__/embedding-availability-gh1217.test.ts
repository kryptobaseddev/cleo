/**
 * Regression tests for gh#1217 — "BRAIN local embeddings are unreachable
 * (isAvailable gate deadlock; EmbeddingQueue has no callers)".
 *
 * ## The deadlock
 *
 * `LocalEmbeddingProvider.isAvailable()` returned `_ready`, the "pipeline has
 * loaded" flag. `_ready` is set only by `loadPipeline()`, which runs only
 * inside `embed()` — and every caller of `embed()` checks `isAvailable()`
 * first. In a fresh process `_ready` is false, so nothing called `embed()`, so
 * `_ready` never became true. **The readiness check could only ever be
 * satisfied by the call it guarded.**
 *
 * It failed silently and completely: `cleo brain maintenance` reported
 * `{processed: 0, skipped: 0, errors: 0}` on every run, `brain_embeddings`
 * stayed empty after dozens of observations, new writes were never embedded,
 * and every hybrid search degraded to FTS5 — all while
 * `brain.embedding.enabled` was true and the provider itself worked perfectly
 * when called directly.
 *
 * The fix separates CAPABILITY ("can this provider produce embeddings?") from
 * STATE ("has it loaded yet?"). These tests pin that distinction, because
 * re-conflating them restores the deadlock while every other test still
 * passes.
 *
 * @task T12129 (gh#1217)
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearEmbeddingProvider,
  type EmbeddingProvider,
  embedText,
  isEmbeddingAvailable,
  setEmbeddingProvider,
} from '../brain-embedding.js';

beforeEach(() => {
  clearEmbeddingProvider();
});
afterEach(() => {
  clearEmbeddingProvider();
});

describe('gh#1217 — availability is capability, not "has already run"', () => {
  it('a provider that has never embedded is still AVAILABLE', () => {
    // THE regression test. A provider reporting unavailable until it has
    // produced an embedding can never be asked to produce one.
    let embedCalls = 0;
    const lazy: EmbeddingProvider = {
      dimensions: 384,
      isAvailable: () => true, // capability — has not loaded anything yet
      embed: async (_t: string) => {
        embedCalls++;
        return new Float32Array(384);
      },
    };
    setEmbeddingProvider(lazy);

    expect(isEmbeddingAvailable()).toBe(true);
    expect(embedCalls).toBe(0); // availability must not require a prior call
  });

  it('an available provider is actually reached by embedText', async () => {
    let embedCalls = 0;
    setEmbeddingProvider({
      dimensions: 384,
      isAvailable: () => true,
      embed: async () => {
        embedCalls++;
        return new Float32Array(384).fill(0.5);
      },
    });

    const vec = await embedText('hello');
    expect(vec).not.toBeNull();
    expect(vec).toHaveLength(384);
    expect(embedCalls).toBe(1);
  });

  it('reproduces the deadlock shape when availability is tied to prior success', async () => {
    // A provider written the old way: "ready" only after embed() has run.
    // Nothing can ever start it, and no error is raised — it just does nothing.
    let ready = false;
    let embedCalls = 0;
    setEmbeddingProvider({
      dimensions: 384,
      isAvailable: () => ready,
      embed: async () => {
        ready = true;
        embedCalls++;
        return new Float32Array(384);
      },
    });

    expect(isEmbeddingAvailable()).toBe(false);
    expect(await embedText('anything')).toBeNull();
    expect(embedCalls).toBe(0); // never reached — silently inert
  });
});

describe('gh#1217 — a failing load degrades, it does not throw', () => {
  it('embedText returns null when the provider throws, so callers fall back to FTS5', async () => {
    // Because availability is now capability, the FIRST real embed is also the
    // first model load and can genuinely fail (offline, no cached model).
    // Callers treat null as "no vector"; throwing would reject the whole
    // search, and on the fire-and-forget write path would surface as an
    // unhandled rejection.
    setEmbeddingProvider({
      dimensions: 384,
      isAvailable: () => true,
      embed: async () => {
        throw new Error('no network and no cached model');
      },
    });

    await expect(embedText('hello')).resolves.toBeNull();
  });

  it('a provider that reports itself unavailable is not called at all', async () => {
    let embedCalls = 0;
    setEmbeddingProvider({
      dimensions: 384,
      isAvailable: () => false, // load already failed — latched
      embed: async () => {
        embedCalls++;
        return new Float32Array(384);
      },
    });

    expect(await embedText('hello')).toBeNull();
    expect(embedCalls).toBe(0);
  });

  it('no provider registered means unavailable, not a crash', async () => {
    clearEmbeddingProvider();
    expect(isEmbeddingAvailable()).toBe(false);
    await expect(embedText('hello')).resolves.toBeNull();
  });
});
