/**
 * Local embedding provider using @huggingface/transformers (transformers.js v4).
 *
 * Implements the EmbeddingProvider interface for brain memory vector search.
 * Uses all-MiniLM-L6-v2 (22MB, 384 dimensions) — matches the brain_embeddings
 * vec0 table schema. The model loads from the transformers cache, and is
 * downloaded only when `brain.embedding.allowModelDownload` is true (T13716).
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

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import { pipeline as streamPipeline } from 'node:stream/promises';
import { getLogger } from '../logger.js';
import type { EmbeddingProvider } from './brain-embedding.js';
import { EMBEDDING_DIMENSIONS } from './brain-embedding.js';

/** Model identifier for all-MiniLM-L6-v2 via Xenova hub. */
const MODEL_NAME = 'Xenova/all-MiniLM-L6-v2';

/**
 * Hub revision loaded. Kept at `main`: transformers.js caches any other
 * revision under `<model>/<revision>/`, so pinning a commit would orphan every
 * existing cached model while downloads are opt-in (T13716). The weights'
 * content hash below is the version instead.
 */
const MODEL_REVISION = 'main';

/** Weight dtype loaded (`onnx/model.onnx`); part of the stored model tag (T13740). */
const MODEL_DTYPE = 'fp32';

/**
 * sha256 of the `onnx/model.onnx` this build embeds with. Every load verifies
 * it, and its 12-hex prefix is the version in the stored model tag (T13740).
 */
const MODEL_ONNX_SHA256 = '759c3cd2b7fe7e93933ad23c4c9181b7396442a2ed746ec7c1d46192c469c46e';

/** The weights a load must hash to; swapped only by tests. */
let _expectedOnnxSha256 = MODEL_ONNX_SHA256;

/**
 * How a user opts into the one-time model download (T13716).
 *
 * @task T13716
 */
export const ENABLE_MODEL_DOWNLOAD_HINT =
  'cleo config set brain.embedding.allowModelDownload true --type boolean --scope global';

/**
 * Import transformers.js with hub access gated on the opt-in (T13716).
 *
 * The one gate for every CLEO model load (this embedding model and the
 * transcript extractor's text-generation model). transformers.js 4.0.1 still
 * fetches config and tokenizer metadata from the hub under `local_files_only`,
 * so the gate sets the process-global `env.allowRemoteModels` from
 * `brain.embedding.allowModelDownload` before every load: one rule, one value,
 * so concurrent loads cannot disagree and nothing needs restoring.
 *
 * @returns The transformers module and whether downloads are allowed.
 * @task T13716
 */
export async function importGatedTransformers(): Promise<{
  transformers: typeof import('@huggingface/transformers');
  allowDownload: boolean;
}> {
  const transformers = await import('@huggingface/transformers');
  const { loadConfig } = await import('../config.js');
  const allowDownload = (await loadConfig()).brain?.embedding?.allowModelDownload === true;
  transformers.env.allowRemoteModels = allowDownload;
  return { transformers, allowDownload };
}

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
 * This is the ONE place the model is fetched (T13716): it downloads the ~22 MB
 * model only when `brain.embedding.allowModelDownload` is true. Otherwise it
 * loads from the local cache with no network, and an uncached model latches as
 * unavailable, so background callers (the session-end worker, the sentient
 * tick) skip quietly instead of reaching huggingface.co.
 */
async function loadPipeline(): Promise<void> {
  if (_ready) return;
  if (_loadFailed) {
    throw new Error(`Local embedding pipeline is unavailable in this process: ${_loadError}`);
  }
  let allowDownload = false;
  try {
    // Dynamic import — only resolves when embedding is explicitly enabled
    const gated = await importGatedTransformers();
    allowDownload = gated.allowDownload;
    const pipeline = await gated.transformers.pipeline('feature-extraction', MODEL_NAME, {
      revision: MODEL_REVISION,
      dtype: MODEL_DTYPE,
      local_files_only: !allowDownload,
    });
    // T13740: vectors are tagged with these exact weights; any other file
    // (an updated hub `main`, a corrupt cache) must not write under that tag.
    const onnxPath = join(gated.transformers.env.cacheDir ?? '', MODEL_NAME, 'onnx', 'model.onnx');
    const actual = await hashModelFile(onnxPath);
    if (actual !== _expectedOnnxSha256) {
      const message =
        `Embedding model ${onnxPath} has sha256 ${actual.slice(0, 12)}…, but this CLEO ` +
        `build embeds with ${_expectedOnnxSha256.slice(0, 12)}…; embeddings are off ` +
        'and search uses FTS5 only. Replace the cached file or upgrade CLEO.';
      getLogger('embedding-local').warn({ onnxPath, actual }, message);
      // @sync-invariant none:local-only the local model file is not the expected weights; nothing is written
      throw new Error(message);
    }
    _pipeline = pipeline;
    _ready = true;
  } catch (err) {
    _loadFailed = true;
    _loadError = err instanceof Error ? err.message : String(err);
    if (!allowDownload) {
      getLogger('embedding-local').debug(
        { err },
        'Embedding model is not cached and downloads are off; skipping embeddings. ' +
          `To enable: ${ENABLE_MODEL_DOWNLOAD_HINT}, then restart the CLEO process.`,
      );
    }
    throw err;
  }
}

/**
 * Stream-hash the cached weights file (T13740).
 *
 * @param onnxPath - Cached `onnx/model.onnx`.
 * @returns Its hex sha256.
 * @throws When the file is not in the transformers cache (for example a model
 *   served from `env.localModelPath`): the weights cannot be verified.
 */
async function hashModelFile(onnxPath: string): Promise<string> {
  const hash = createHash('sha256');
  try {
    await streamPipeline(createReadStream(onnxPath), hash);
  } catch (err) {
    const message =
      `Embedding model weights are not at ${onnxPath}, so they cannot be verified against ` +
      `this CLEO build (${_expectedOnnxSha256.slice(0, 12)}…); embeddings are off and search ` +
      'uses FTS5 only. CLEO only loads the model from the transformers cache.';
    getLogger('embedding-local').warn({ onnxPath, err }, message);
    // @sync-invariant none:local-only the local model file is missing; nothing is written
    throw new Error(message);
  }
  return hash.digest('hex');
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
  _expectedOnnxSha256 = MODEL_ONNX_SHA256;
}

/**
 * Override the weights hash a load must match. Test-only.
 *
 * @param sha256 - Expected hex sha256 of `onnx/model.onnx`.
 * @internal
 * @task T13740
 */
export function __setExpectedModelSha256ForTests(sha256: string): void {
  _expectedOnnxSha256 = sha256;
}

/**
 * Local embedding provider backed by @huggingface/transformers.
 *
 * Produces 384-dimension Float32Array vectors compatible with the
 * brain_embeddings vec0 table. The model loads from the local cache; it is
 * downloaded only when `brain.embedding.allowModelDownload` is true (T13716).
 *
 * Use {@link initDefaultProvider} (in brain-embedding.ts) to register an
 * instance when brain.embedding.enabled=true and
 * brain.embedding.provider='local'.
 */
export class LocalEmbeddingProvider implements EmbeddingProvider {
  /** Number of dimensions produced — must match brain_embeddings vec0 table. */
  readonly dimensions = EMBEDDING_DIMENSIONS;

  /** Model tag stored beside every vector this provider produces (T13740). */
  readonly model = `${MODEL_NAME}@onnx-sha256:${MODEL_ONNX_SHA256.slice(0, 12)}:${MODEL_DTYPE}`;

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
   * Loads the model on first call (downloading it only on opt-in, T13716).
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
