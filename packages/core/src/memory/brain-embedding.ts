/**
 * Brain Embedding System
 *
 * Provides text-to-vector embedding for semantic search in brain.db.
 * Uses a pluggable provider interface — real model integration
 * (e.g. @huggingface/transformers with all-MiniLM-L6-v2) is separate
 * from the embedding pipeline. When no provider is set, the system
 * falls back to FTS5-only search gracefully.
 *
 * @epic T5149
 * @task T5386
 */

/** Contract for embedding providers (local models, API services, etc.). */
export interface EmbeddingProvider {
  /** Convert text into a fixed-dimension float vector. */
  embed(text: string): Promise<Float32Array>;
  /** Number of dimensions the provider produces. Must match vec0 table. */
  readonly dimensions: number;
  /**
   * Whether the provider CAN produce embeddings — capability, not state.
   *
   * Implementations MUST NOT return "has already produced one": a provider
   * that reports unavailable until it has embedded something can never be
   * asked to embed anything, because every caller checks this first. That
   * deadlock made local embeddings entirely inert (gh#1217). A provider whose
   * model loads lazily is AVAILABLE before the first load; it becomes
   * unavailable only once loading has actually failed.
   */
  isAvailable(): boolean;
}

/** Matches the brain_embeddings vec0 table: FLOAT[384]. */
export const EMBEDDING_DIMENSIONS = 384;

let currentProvider: EmbeddingProvider | null = null;

/**
 * Register an embedding provider for the brain system.
 * Validates that the provider's dimensions match the vec0 table.
 *
 * @throws Error if provider dimensions do not match EMBEDDING_DIMENSIONS
 */
export function setEmbeddingProvider(provider: EmbeddingProvider): void {
  if (provider.dimensions !== EMBEDDING_DIMENSIONS) {
    throw new Error(
      `Embedding provider dimensions (${provider.dimensions}) do not match vec0 table (${EMBEDDING_DIMENSIONS})`,
    );
  }
  currentProvider = provider;
}

/** Get the currently registered embedding provider, or null. */
export function getEmbeddingProvider(): EmbeddingProvider | null {
  return currentProvider;
}

/** Clear the current embedding provider (useful for testing). */
export function clearEmbeddingProvider(): void {
  currentProvider = null;
}

/**
 * Embed text into a float vector using the registered provider.
 * Returns null when no provider is set or not available (FTS5-only fallback).
 */
export async function embedText(text: string): Promise<Float32Array | null> {
  if (!currentProvider?.isAvailable()) return null;
  try {
    return await currentProvider.embed(text);
  } catch {
    // gh#1217: `isAvailable()` is capability, so the first real embed is also
    // the first model load and CAN fail (offline with no cached model, for
    // one). Callers treat `null` as "no vector — fall back to FTS5", which is
    // the correct degradation. Throwing instead would reject the whole search,
    // and on the fire-and-forget write path it would surface as an unhandled
    // rejection. The provider latches its own failure, so this is not a retry
    // loop.
    return null;
  }
}

/**
 * Check whether embedding is available — i.e. a provider is registered and
 * has not failed to load.
 *
 * This is a CAPABILITY check. It is deliberately true before the first
 * embedding is produced: gating the only call that can warm a lazy provider on
 * that provider already being warm is the gh#1217 deadlock.
 */
export function isEmbeddingAvailable(): boolean {
  return currentProvider?.isAvailable() ?? false;
}

/**
 * Initialize the default local embedding provider.
 *
 * Loads the LocalEmbeddingProvider dynamically and registers it via
 * setEmbeddingProvider(). Should be called once at startup when
 * `brain.embedding.enabled` is true.
 *
 * Uses dynamic import to avoid loading the heavy @huggingface/transformers
 * bundle unless embedding is actually requested.
 *
 * @task T136 @epic T134
 */
export async function initDefaultProvider(): Promise<void> {
  const { LocalEmbeddingProvider } = await import('./embedding-local.js');
  const provider = new LocalEmbeddingProvider();
  setEmbeddingProvider(provider);
}
