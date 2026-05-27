/**
 * Nexus analyze orchestrator — business logic extracted from `cleo nexus analyze`.
 *
 * Runs the code-intelligence pipeline, clears the existing index for full runs,
 * refreshes the nexus-bridge, updates the multi-project registry, and sweeps
 * the git log for task–symbol links. All side-effects are best-effort and do
 * not fail the pipeline on error.
 *
 * @module nexus/analyze-orchestrator
 * @epic T9833
 * @task T10062
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Parameters for {@link runNexusAnalysis}. */
export interface NexusAnalysisParams {
  /** Absolute path to the repository to analyze. */
  repoPath: string;
  /** Override the project ID (default: `base64url(repoPath).slice(0, 32)`). */
  projectIdOverride?: string;
  /** When true, only re-index files that changed since the last run. */
  incremental?: boolean;
  /**
   * Progress callback invoked every 50 files (and on completion).
   * Omit for JSON output mode.
   */
  onProgress?: (current: number, total: number, filePath: string) => void;
}

/** Result of a successful {@link runNexusAnalysis} call. */
export interface NexusAnalysisResult {
  projectId: string;
  repoPath: string;
  incremental: boolean;
  nodeCount: number;
  relationCount: number;
  fileCount: number;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run the nexus code-intelligence pipeline on a repository.
 *
 * This function:
 * 1. Derives the project ID.
 * 2. For full runs, clears the existing nexus index.
 * 3. Runs `@cleocode/nexus` pipeline.
 * 4. Best-effort: refreshes `nexus-bridge.md`.
 * 5. Best-effort: updates the multi-project registry.
 * 6. Best-effort: sweeps the git log for task–symbol links.
 *
 * @param params - Analysis configuration
 * @returns Pipeline result with node/relation/file counts and duration
 * @throws {Error} When the pipeline itself fails (best-effort steps never throw)
 */
export async function runNexusAnalysis(params: NexusAnalysisParams): Promise<NexusAnalysisResult> {
  const { repoPath, projectIdOverride, incremental = false, onProgress } = params;

  const startTime = Date.now();

  // SSoT-EXEMPT:pipeline-progress — requires direct DB handle access and a
  // progress callback that is CLI-only. Extracted here to keep the core
  // runnable without the CLI layer, but the DB/pipeline imports still happen
  // via dynamic imports so the CLI controls when heavy deps are loaded.
  const [{ getNexusDb, nexusSchema }, { runPipeline }, { eq }] = await Promise.all([
    import('@cleocode/core/store/nexus-sqlite' as string),
    import('@cleocode/nexus/pipeline' as string),
    import('drizzle-orm' as string),
  ]);

  const projectId = projectIdOverride ?? Buffer.from(repoPath).toString('base64url').slice(0, 32);

  const db = await getNexusDb();
  const tables = {
    nexusNodes: nexusSchema.nexusNodes,
    nexusRelations: nexusSchema.nexusRelations,
  };

  if (!incremental) {
    try {
      db.delete(nexusSchema.nexusNodes)
        .where(eq(nexusSchema.nexusNodes.projectId, projectId))
        .run();
    } catch {
      // table may be empty — ignore
    }
    try {
      db.delete(nexusSchema.nexusRelations)
        .where(eq(nexusSchema.nexusRelations.projectId, projectId))
        .run();
    } catch {
      // table may be empty — ignore
    }
  }

  const result = await runPipeline(repoPath, projectId, db, tables, onProgress, {
    incremental,
  });

  // Best-effort: refresh nexus-bridge.md
  try {
    const { refreshNexusBridge } = await import('@cleocode/core/internal' as string);
    await refreshNexusBridge(repoPath, projectId);
  } catch {
    // non-fatal
  }

  // Best-effort: update multi-project registry
  try {
    const { nexusUpdateIndexStats } = await import('@cleocode/core/internal' as string);
    await nexusUpdateIndexStats(repoPath, {
      nodeCount: result.nodeCount,
      relationCount: result.relationCount,
      fileCount: result.fileCount,
    });
  } catch {
    // non-fatal
  }

  // Best-effort: sweep git log for task–symbol links
  try {
    const { runGitLogTaskLinker } = await import('@cleocode/core/nexus' as string);
    const sweeperResult = await runGitLogTaskLinker(repoPath);
    if (sweeperResult.commitsProcessed > 0) {
      process.stderr.write(
        `[nexus] Task-symbol sweep: ${sweeperResult.commitsProcessed} commit(s), ${sweeperResult.tasksFound} task(s), ${sweeperResult.linked} edge(s) linked.\n`,
      );
    }
  } catch {
    // non-fatal
  }

  return {
    projectId,
    repoPath,
    incremental,
    nodeCount: result.nodeCount,
    relationCount: result.relationCount,
    fileCount: result.fileCount,
    durationMs: Date.now() - startTime,
  };
}
