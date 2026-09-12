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
 * Whether loading the pipeline failed in THIS process (no model cached and no
 * network, unsupported platform, corrupt download). Latched so a failed load
 * is not retried on every call — one download attempt per process is enough to
 * establish that embeddings are not obtainable here.
 *
 * @task T12129 (gh#1217)
 */
let _loadFailed = false;

/** Reason for the latched failure, surfaced in diagnostics. */
let _loadError: string | null = null;

/**
 * Load the transformers feature-extraction pipeline lazily.
 * Dynamic import prevents the heavy model from loading unless embedding is enabled.
 *
 * On first call this downloads ~22 MB. That cost is expected and is the reason
 * the load is lazy — it is NOT a reason to refuse to start it (gh#1217).
 */
async function loadPipeline(): Promise<void> {
  if (_ready) return;
  if (_loadFailed) {
    throw new Error(`Local embedding pipeline is unavailable in this process: ${_loadError}`);
  }
  try {
    // Dynamic import — only resolves when embedding is explicitly enabled
    const { pipeline } = await import('@huggingface/transformers');
    _pipeline = await pipeline('feature-extraction', MODEL_NAME);
    _ready = true;
  } catch (err) {
    _loadFailed = true;
    _loadError = err instanceof Error ? err.message : String(err);
    throw err;
  }
}

/**
 * Has the pipeline actually been loaded in this process?
 *
 * Distinct from {@link LocalEmbeddingProvider.isAvailable}, which reports
 * CAPABILITY. This reports STATE, and exists for diagnostics — notably to warn
 * when `brain.embedding.enabled` is true but nothing was ever embedded.
 *
 * @returns `true` once a real embedding pipeline exists.
 *
 * @task T12129 (gh#1217)
 */
export function isEmbeddingPipelineLoaded(): boolean {
  return _ready;
}

/**
 * Reset the module-level pipeline state. Test-only.
 *
 * @internal
 * @task T12129 (gh#1217)
 */
export function __resetLocalEmbeddingStateForTests(): void {
  _pipeline = null;
  _ready = false;
  _loadFailed = false;
  _loadError = null;
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
   * Whether this provider CAN produce embeddings — not whether it already has.
   *
   * ## The deadlock this fixes (gh#1217)
   *
   * This previously returned `_ready`, the "pipeline has loaded" flag. But
   * `_ready` is set only by `loadPipeline()`, which runs only inside
   * {@link embed} — and every caller of `embed` first checks `isAvailable()`.
   * In any fresh CLI process `_ready` is false, so nothing ever called
   * `embed`, so `_ready` never became true. **The readiness check could only
   * be satisfied by the call it guarded.**
   *
   * The observable result was total, silent inertness: `cleo brain
   * maintenance` reported `{processed: 0, skipped: 0, errors: 0}` forever,
   * `brain_embeddings` stayed empty after dozens of observations, new writes
   * were never embedded, and every hybrid search quietly degraded to FTS5 —
   * while `brain.embedding.enabled` was true and the provider itself was
   * perfectly healthy when called directly.
   *
   * Availability is therefore capability: this provider can load its pipeline
   * on demand, and says so until a load actually fails. The ~22 MB first-call
   * download is the expected cost of the lazy design, not a reason to refuse
   * to begin.
   *
   * @returns `true` unless loading the pipeline has already failed here.
   *
   * @task T12129 (gh#1217)
   */
  isAvailable(): boolean {
    return !_loadFailed;
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
