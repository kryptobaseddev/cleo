/**
 * T12314 — a consumer must not race the deferred provider registration.
 *
 * T12129 removed the unsatisfiable availability check. With that gone, the
 * remaining reason embeddings never populated became visible: nothing
 * registers a provider in time. `store/memory-sqlite.ts` schedules
 * `initEmbeddingProvider` inside a `setImmediate` once vec loads and swallows
 * its errors, so a consumer asking `isEmbeddingAvailable()` is told "no" both
 * when the provider failed AND when it simply has not been registered yet.
 *
 * Measured against the installed 2026.9.14: provider absent at import;
 * registering it explicitly took 0 ms and then produced a real 384-dimension
 * vector. Registration is free — the ~22 MB model download happens on the
 * first embed — so there is no cost argument for making a consumer race a
 * registration it cannot observe.
 *
 * @task T12314
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearEmbeddingProvider,
  EMBEDDING_DIMENSIONS,
  ensureEmbeddingProvider,
  getEmbeddingProvider,
  isEmbeddingAvailable,
  setEmbeddingProvider,
} from '../brain-embedding.js';

beforeEach(() => clearEmbeddingProvider());
afterEach(() => clearEmbeddingProvider());

describe('T12314 AC1 — a consumer ensures registration rather than assuming it', () => {
  it('reports unavailable before registration, which is the raced state', () => {
    // Exactly what a consumer saw when it ran before the setImmediate fired.
    expect(getEmbeddingProvider()).toBeNull();
    expect(isEmbeddingAvailable()).toBe(false);
  });

  it('registers a provider on demand and then reports available', async () => {
    const ok = await ensureEmbeddingProvider();
    expect(ok).toBe(true);
    expect(getEmbeddingProvider()).not.toBeNull();
    expect(isEmbeddingAvailable()).toBe(true);
  });

  it('is idempotent and never displaces a provider already registered', async () => {
    const stub = {
      dimensions: EMBEDDING_DIMENSIONS,
      isAvailable: () => true,
      embed: async () => new Float32Array(EMBEDDING_DIMENSIONS),
    };
    setEmbeddingProvider(stub);
    await ensureEmbeddingProvider();
    // A consumer calling ensure must not replace a deliberately injected
    // provider — that would make the call order observable again.
    expect(getEmbeddingProvider()).toBe(stub);
  });

  it('leaves a registered-but-failed provider reporting its own failure', async () => {
    const failed = {
      dimensions: EMBEDDING_DIMENSIONS,
      isAvailable: () => false,
      embed: async () => new Float32Array(EMBEDDING_DIMENSIONS),
    };
    setEmbeddingProvider(failed);
    // ensure() answers "is one registered", NOT "does it work" — the two are
    // different faults with different remedies, which is the whole point.
    expect(await ensureEmbeddingProvider()).toBe(true);
    expect(isEmbeddingAvailable()).toBe(false);
  });
});
