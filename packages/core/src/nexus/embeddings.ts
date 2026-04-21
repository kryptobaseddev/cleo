/**
 * Code Symbol Embeddings — semantic search via transformers.js.
 *
 * Provides text-to-vector embedding for semantic code search.
 * Uses @huggingface/transformers with snowflake-arctic-embed-xs (384-dim)
 * as default, with pluggable provider interface.
 *
 * Gracefully degrades to BM25-only search when embeddings unavailable.
 *
 * @task T1058 EP1-T2
 */

/**
 * Contract for code embeddings providers.
 * Can be replaced via CLEO_EMBEDDINGS_PROVIDER env var.
 */
export interface CodeEmbeddingProvider {
  /**
   * Convert code text into a fixed-dimension vector.
   * Text should be symbol name + docstring for best results.
   */
  embed(text: string): Promise<Float32Array>;
  /**
   * Vector dimensionality (384 for snowflake-arctic-embed-xs).
   * Must match nexus_embeddings vec0 table schema.
   */
  readonly dimensions: number;
  /**
   * Whether the provider is ready to produce embeddings.
   * Returns false if model loading failed or dependencies unavailable.
   */
  isAvailable(): boolean;
}

/** Standard vector dimension for code embeddings (matches nexus schema). */
export const CODE_EMBEDDING_DIMENSIONS = 384;

let currentProvider: CodeEmbeddingProvider | null = null;

/**
 * Register a code embeddings provider.
 *
 * @throws Error if provider dimensions do not match CODE_EMBEDDING_DIMENSIONS
 */
export function setCodeEmbeddingProvider(provider: CodeEmbeddingProvider): void {
  if (provider.dimensions !== CODE_EMBEDDING_DIMENSIONS) {
    throw new Error(
      `Code embeddings provider dimensions (${provider.dimensions}) do not match nexus schema (${CODE_EMBEDDING_DIMENSIONS})`,
    );
  }
  currentProvider = provider;
}

/** Get the currently registered code embeddings provider. */
export function getCodeEmbeddingProvider(): CodeEmbeddingProvider | null {
  return currentProvider;
}

/** Clear the current code embeddings provider (useful for testing). */
export function clearCodeEmbeddingProvider(): void {
  currentProvider = null;
}

/** Check if code embeddings are available. */
export function isCodeEmbeddingAvailable(): boolean {
  return currentProvider?.isAvailable() ?? false;
}

/**
 * Embed code text using the registered provider.
 *
 * @param text - Symbol name + docstring or full source
 * @returns Float vector or null if embeddings unavailable
 */
export async function embedCodeSymbol(text: string): Promise<Float32Array | null> {
  if (!currentProvider?.isAvailable()) return null;
  return currentProvider.embed(text);
}

/**
 * Transformer.js-backed code embeddings provider.
 *
 * Uses Xenova/snowflake-arctic-embed-xs (384-dim, 85MB).
 * Lazy-loads @huggingface/transformers on first use.
 *
 * @internal
 */
export class TransformersCodeEmbeddingProvider implements CodeEmbeddingProvider {
  readonly dimensions = CODE_EMBEDDING_DIMENSIONS;
  private extractor: import('@huggingface/transformers').FeatureExtractionPipeline | null = null;
  private initPromise: Promise<void> | null = null;
  private initError: Error | null = null;

  isAvailable(): boolean {
    return this.extractor !== null && this.initError === null;
  }

  /**
   * Initialize the transformer model (lazy-loaded).
   *
   * @throws Error if @huggingface/transformers unavailable or model fails to load
   */
  async ensureInitialized(): Promise<void> {
    if (this.extractor !== null) return;
    if (this.initPromise) return this.initPromise;
    if (this.initError) throw this.initError;

    this.initPromise = this.initializeExtractor();
    try {
      await this.initPromise;
    } finally {
      this.initPromise = null;
    }
  }

  /**
   * Internal: load the transformers pipeline.
   *
   * @throws Error if module not found or model download fails
   */
  private async initializeExtractor(): Promise<void> {
    try {
      // Dynamic import to keep startup fast and make dependency optional.
      // eslint-disable-next-line import/no-unresolved, @typescript-eslint/no-var-requires
      const transformers = await import('@huggingface/transformers');

      // Use Xenova/snowflake-arctic-embed-xs (HITL decision from T1042).
      // This is a lightweight but capable embeddings model (85MB).
      // env-swappable via CLEO_EMBEDDINGS_PROVIDER if custom provider needed.
      const model = process.env['CLEO_EMBEDDINGS_PROVIDER'] || 'Xenova/snowflake-arctic-embed-xs';

      this.extractor = await transformers.pipeline('feature-extraction', model);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.initError = error;
      throw new Error(
        `E_EMBEDDINGS_UNAVAILABLE: Could not load embeddings model. ` +
          `${error.message}. ` +
          `fix: pnpm add -w @huggingface/transformers`,
      );
    }
  }

  /**
   * Embed code symbol name + docstring.
   *
   * @param text - Symbol name or name + docstring
   * @returns 384-dim vector
   * @throws Error if model unavailable or extraction fails
   */
  async embed(text: string): Promise<Float32Array> {
    await this.ensureInitialized();

    if (!this.extractor) {
      throw new Error('E_EMBEDDINGS_UNAVAILABLE: Extractor not initialized');
    }

    // Use mean pooling to convert token embeddings to sentence embedding
    // Transformer output: shape [1, numTokens, 384]
    // We average across tokens to get [1, 384] then extract [384]
    const output = await this.extractor(text, {
      pooling: 'mean',
      normalize: true,
    });

    // Output shape is [1, dimensions]; extract the single embedding.
    // The Tensor.data property holds the underlying typed array at runtime.
    const embedding = output.data as Float32Array;

    // Validate dimensionality
    if (embedding.length !== CODE_EMBEDDING_DIMENSIONS) {
      throw new Error(
        `Embedding dimensionality mismatch: got ${embedding.length}, ` +
          `expected ${CODE_EMBEDDING_DIMENSIONS}`,
      );
    }

    return embedding;
  }
}

/**
 * Initialize the default code embeddings provider.
 *
 * Uses @huggingface/transformers with snowflake-arctic-embed-xs model.
 * Gracefully degrades if package unavailable (returns null).
 *
 * @returns true if initialized successfully, false if unavailable
 *
 * @task T1058
 */
export async function initDefaultCodeEmbeddingProvider(): Promise<boolean> {
  try {
    const provider = new TransformersCodeEmbeddingProvider();
    await provider.ensureInitialized();
    setCodeEmbeddingProvider(provider);
    return true;
  } catch {
    // Silently fail — embeddings are optional for code search
    // (falls back to BM25-only via smartSearch)
    return false;
  }
}
