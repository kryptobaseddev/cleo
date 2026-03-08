/**
 * Tests for brain-embedding.ts — pluggable embedding provider interface.
 *
 * @epic T5149
 * @task T5386
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearEmbeddingProvider,
  EMBEDDING_DIMENSIONS,
  type EmbeddingProvider,
  embedText,
  getEmbeddingProvider,
  isEmbeddingAvailable,
  setEmbeddingProvider,
} from '../brain-embedding.js';

/** Create a mock provider that returns a deterministic vector. */
function createMockProvider(overrides?: Partial<EmbeddingProvider>): EmbeddingProvider {
  return {
    dimensions: EMBEDDING_DIMENSIONS,
    isAvailable: () => true,
    embed: vi.fn(async (_text: string) => new Float32Array(EMBEDDING_DIMENSIONS).fill(0.1)),
    ...overrides,
  };
}

describe('brain-embedding', () => {
  beforeEach(() => {
    clearEmbeddingProvider();
  });

  describe('without provider', () => {
    it('embedText returns null when no provider is set', async () => {
      const result = await embedText('hello world');
      expect(result).toBeNull();
    });

    it('isEmbeddingAvailable returns false when no provider is set', () => {
      expect(isEmbeddingAvailable()).toBe(false);
    });

    it('getEmbeddingProvider returns null when no provider is set', () => {
      expect(getEmbeddingProvider()).toBeNull();
    });
  });

  describe('with provider', () => {
    it('setEmbeddingProvider wires a mock provider', () => {
      const provider = createMockProvider();
      setEmbeddingProvider(provider);
      expect(getEmbeddingProvider()).toBe(provider);
    });

    it('embedText calls provider.embed when available', async () => {
      const provider = createMockProvider();
      setEmbeddingProvider(provider);

      const result = await embedText('test input');

      expect(provider.embed).toHaveBeenCalledWith('test input');
      expect(result).toBeInstanceOf(Float32Array);
      expect(result!.length).toBe(EMBEDDING_DIMENSIONS);
    });

    it('embedText returns Float32Array with correct dimensions', async () => {
      const provider = createMockProvider();
      setEmbeddingProvider(provider);

      const result = await embedText('some text');
      expect(result).not.toBeNull();
      expect(result!.length).toBe(384);
      expect(result!.every((v) => Math.abs(v - 0.1) < 1e-6)).toBe(true);
    });

    it('embedText returns null when provider reports unavailable', async () => {
      const provider = createMockProvider({ isAvailable: () => false });
      setEmbeddingProvider(provider);

      const result = await embedText('test');
      expect(result).toBeNull();
    });

    it('isEmbeddingAvailable returns true when provider is available', () => {
      setEmbeddingProvider(createMockProvider());
      expect(isEmbeddingAvailable()).toBe(true);
    });

    it('isEmbeddingAvailable returns false when provider reports unavailable', () => {
      setEmbeddingProvider(createMockProvider({ isAvailable: () => false }));
      expect(isEmbeddingAvailable()).toBe(false);
    });
  });

  describe('dimension validation', () => {
    it('rejects provider with wrong dimensions', () => {
      const badProvider = createMockProvider({ dimensions: 768 });
      expect(() => setEmbeddingProvider(badProvider)).toThrow(
        /dimensions \(768\) do not match vec0 table \(384\)/,
      );
    });
  });

  describe('clearEmbeddingProvider', () => {
    it('resets provider to null', () => {
      setEmbeddingProvider(createMockProvider());
      expect(getEmbeddingProvider()).not.toBeNull();

      clearEmbeddingProvider();
      expect(getEmbeddingProvider()).toBeNull();
      expect(isEmbeddingAvailable()).toBe(false);
    });
  });

  describe('EMBEDDING_DIMENSIONS constant', () => {
    it('equals 384 to match brain_embeddings vec0 table', () => {
      expect(EMBEDDING_DIMENSIONS).toBe(384);
    });
  });
});
