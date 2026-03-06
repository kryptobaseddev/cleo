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
  /** Whether the provider is ready to produce embeddings. */
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
  if (!currentProvider || !currentProvider.isAvailable()) return null;
  return currentProvider.embed(text);
}

/** Check whether embedding is currently available. */
export function isEmbeddingAvailable(): boolean {
  return currentProvider !== null && currentProvider.isAvailable();
}
