/**
 * Nexus wiki orchestrator — business logic extracted from `cleo nexus wiki`.
 *
 * Resolves the LOOM provider (if available), then delegates to
 * `generateNexusWikiIndex`. The CLI handler calls {@link runNexusWiki} and
 * emits the LAFS envelope.
 *
 * @module nexus/wiki-orchestrator
 * @epic T9833
 * @task T10062
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Options for {@link runNexusWiki}. */
export interface NexusWikiOptions {
  /** Absolute path to the project root. */
  projectRoot: string;
  /** Output directory for generated wiki files (default: `<projectRoot>/.cleo/wiki`). */
  outputDir?: string;
  /** When set, restrict generation to a single community ID. */
  communityFilter?: string;
  /** Only regenerate communities whose symbols changed since the last wiki run. */
  incremental?: boolean;
}

/** Result of a successful {@link runNexusWiki} call. */
export interface NexusWikiResult {
  success: boolean;
  error?: string;
  outputDir: string;
  durationMs: number;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate the community-grouped wiki index from the nexus code graph.
 *
 * Attempts to wire a LOOM provider via `resolveLlmBackend('warm')` for
 * LLM-driven narratives; falls back to scaffold mode when no backend is
 * available. All LOOM resolution errors are swallowed — the wiki always runs.
 *
 * @param opts - Wiki generation options
 * @returns Result envelope forwarded from `generateNexusWikiIndex`
 * @throws {Error} When `generateNexusWikiIndex` throws
 */
export async function runNexusWiki(opts: NexusWikiOptions): Promise<NexusWikiResult> {
  const { projectRoot, communityFilter, incremental = false } = opts;

  const { join } = await import('node:path');
  const outputDir = opts.outputDir ?? join(projectRoot, '.cleo', 'wiki');

  const startTime = Date.now();

  // SSoT-EXEMPT:loom-provider — LLM backend resolution for wiki generation
  // requires CLI-side async provider wiring that cannot be passed through the
  // dispatch layer. The dispatch 'wiki' op always uses loomProvider=null.
  let loomProvider: ((prompt: string) => Promise<string>) | null = null;
  try {
    const { resolveLlmBackend } = await import('@cleocode/core/memory/llm-backend-resolver.js');
    const backend = await resolveLlmBackend('warm');
    if (backend !== null && backend.name !== 'transformers') {
      loomProvider = async (prompt: string): Promise<string> => {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        const aiMod = await import('ai' as string);
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        const generateTextFn = aiMod.generateText as (opts: {
          model: unknown;
          prompt: string;
          maxTokens: number;
        }) => Promise<{ text: string }>;
        const { text } = await generateTextFn({
          model: backend.model,
          prompt,
          maxTokens: 256,
        });
        return text;
      };
    }
  } catch {
    // LOOM unavailable — scaffold mode
    loomProvider = null;
  }

  const { generateNexusWikiIndex } = await import('@cleocode/core/nexus/wiki-index.js' as string);
  const result = await generateNexusWikiIndex(outputDir, projectRoot, {
    communityFilter,
    incremental,
    loomProvider,
    projectRoot,
  });

  return {
    ...result,
    outputDir,
    durationMs: Date.now() - startTime,
  };
}
