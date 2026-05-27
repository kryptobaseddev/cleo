/**
 * Local embedding provider using @huggingface/transformers (transformers.js v4).
 *
 * Implements the EmbeddingProvider interface for brain memory vector search.
 * Uses all-MiniLM-L6-v2 (22MB, 384 dimensions) — matches the brain_embeddings
 * vec0 table schema. Model downloads on first call and is cached locally by
 * the transformers library.
 *
 * @epic T134
 * @task T136
 * @why Ship vector search out-of-the-box without external API keys
 * @what Local embedding provider using @huggingface/transformers all-MiniLM-L6-v2
 * @remarks Brain embeddings are a FIRST-CLASS CLEO feature — the transformers
 *   package is a regular dependency of `@cleocode/core`, not optional.
 *   Migrated from `@xenova/transformers` v2 to `@huggingface/transformers`
 *   v4 (upstream rename, same author) which drops the deprecated
 *   `prebuild-install` transitive via `sharp@0.34+`.
 */

import type { EmbeddingProvider } from './brain-embedding.js';
import { EMBEDDING_DIMENSIONS } from './brain-embedding.js';

/** Model identifier for all-MiniLM-L6-v2 via Xenova hub. */
const MODEL_NAME = 'Xenova/all-MiniLM-L6-v2';

/** Pipeline singleton — initialized lazily on first call. */
let _pipeline: import('@huggingface/transformers').FeatureExtractionPipeline | null = null;

/** Whether the pipeline has been successfully initialized. */
let _ready = false;

/**
 * Load the transformers feature-extraction pipeline lazily.
 * Dynamic import prevents the heavy model from loading unless embedding is enabled.
 */
async function loadPipeline(): Promise<void> {
  if (_ready) return;
  // Dynamic import — only resolves when embedding is explicitly enabled
  const { pipeline } = await import('@huggingface/transformers');
  _pipeline = await pipeline('feature-extraction', MODEL_NAME);
  _ready = true;
}

/**
 * Local embedding provider backed by @huggingface/transformers.
 *
 * Produces 384-dimension Float32Array vectors compatible with the
 * brain_embeddings vec0 table. The model is downloaded on first use
 * and cached locally by the transformers library.
 *
 * Use {@link initDefaultProvider} (in brain-embedding.ts) to register an
 * instance when brain.embedding.enabled=true and
 * brain.embedding.provider='local'.
 */
export class LocalEmbeddingProvider implements EmbeddingProvider {
  /** Number of dimensions produced — must match brain_embeddings vec0 table. */
  readonly dimensions = EMBEDDING_DIMENSIONS;

  /**
   * Whether the pipeline has been successfully initialized and is ready to produce embeddings.
   */
  isAvailable(): boolean {
    return _ready;
  }

  /**
   * Convert a single text string into a 384-dimension float vector.
   * Triggers model download on first call if not already cached.
   *
   * @param text - The text to embed.
   * @returns A Float32Array of length 384.
   */
  async embed(text: string): Promise<Float32Array> {
    await loadPipeline();
    const output = await _pipeline!(text, { pooling: 'mean', normalize: true });
    // output.data is DataArray (AnyTypedArray | any[]). For feature-extraction
    // with all-MiniLM-L6-v2, the runtime value is always Float32Array. Copy via
    // Float32Array constructor which accepts any iterable of numbers.
    return Float32Array.from(output.data as Float32Array);
  }

  /**
   * Embed multiple texts in sequence, reusing the cached pipeline.
   *
   * @param texts - Array of text strings to embed.
   * @returns Array of Float32Array vectors, one per input text.
   */
  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    await loadPipeline();
    const results: Float32Array[] = [];
    for (const text of texts) {
      const output = await _pipeline!(text, { pooling: 'mean', normalize: true });
      results.push(Float32Array.from(output.data as Float32Array));
    }
    return results;
  }
}

/** Module-level singleton instance. */
let _instance: LocalEmbeddingProvider | null = null;

/**
 * Get or create the shared LocalEmbeddingProvider singleton.
 *
 * @returns The shared LocalEmbeddingProvider instance.
 */
export function getLocalEmbeddingProvider(): LocalEmbeddingProvider {
  if (!_instance) {
    _instance = new LocalEmbeddingProvider();
  }
  return _instance;
}
