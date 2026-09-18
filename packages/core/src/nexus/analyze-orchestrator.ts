/**
 * Nexus analyze orchestrator — business logic extracted from `cleo nexus analyze`.
 *
 * Stages a replacement code graph and publishes it atomically,
 * refreshes the nexus-bridge, updates the multi-project registry, and sweeps
 * the git log for task–symbol links. Post-publication hooks are best-effort.
 *
 * @module nexus/analyze-orchestrator
 * @epic T9833
 * @task T10062
 */

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { GraphIndexAssessment, GraphPublicationRows } from '@cleocode/contracts';
import { sql } from 'drizzle-orm';
import type { NodeSQLiteDatabase } from 'drizzle-orm/node-sqlite';
import { nexusNodes, nexusRelations } from '../store/schema/cleo-project/nexus-graph.js';
import { readKnowledgeIndexAssessment } from './knowledge.js';

/** Capture a source revision without confusing unversioned roots with a known revision. */
function sourceRevision(repoPath: string): string | null {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoPath,
      encoding: 'utf8',
      timeout: 1000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

/** Preserve explicitly selected nested repository scope on routine reindexing. */
function includedRepositoryScope(db: NodeSQLiteDatabase, repoPath: string): string[] {
  return db
    .values(sql`SELECT repositories.value
    FROM main._nexus_meta, json_each(json_extract(_nexus_meta.value, '$.includedRepositories')) AS repositories
    WHERE _nexus_meta.key = 'graph_assessment'
      AND json_extract(_nexus_meta.value, '$.sourceRoot') = ${repoPath}`)
    .map((row) => {
      const repository = row[0];
      if (typeof repository !== 'string') throw new Error('Invalid saved nested repository scope');
      return repository;
    });
}

/** Read the last committed graph generation without opening a write transaction. */
function graphGeneration(db: NodeSQLiteDatabase): string | null {
  const value = db.values(
    sql`SELECT value FROM main._nexus_meta WHERE key = 'graph_generation'`,
  )[0]?.[0];
  return typeof value === 'string' ? value : null;
}

/**
 * Atomically publish staged rows if the graph has not changed since assessment.
 * Failed inserts, FTS repair, or stale generations roll back the entire replacement.
 * Code placed in `packages/core/` per Package-Boundary Check — verified against AGENTS.md.
 */
export function publishNexusGraph(
  db: NodeSQLiteDatabase,
  rows: GraphPublicationRows,
  expectedGeneration: string | null,
): void {
  db.transaction(
    (tx) => {
      if (graphGeneration(tx) !== expectedGeneration) {
        throw new Error(
          'Nexus graph changed during indexing; discard staged generation and retry.',
        );
      }
      tx.delete(nexusRelations).run();
      tx.delete(nexusNodes).run();
      // The optional FTS shadow can contain orphaned rowids; reset it inside
      // the same transaction so trigger failures restore the previous generation.
      if (
        tx.values(sql`SELECT name FROM main.sqlite_master WHERE name = 'nexus_symbols_fts'`)
          .length > 0
      ) {
        tx.run(sql`DELETE FROM main.nexus_symbols_fts`);
      }
      for (let offset = 0; offset < rows.nodes.length; offset += 500) {
        tx.insert(nexusNodes)
          .values(rows.nodes.slice(offset, offset + 500))
          .run();
      }
      for (let offset = 0; offset < rows.relations.length; offset += 500) {
        tx.insert(nexusRelations)
          .values(rows.relations.slice(offset, offset + 500))
          .run();
      }
      if (rows.assessment) {
        tx.run(sql`INSERT INTO main._nexus_meta (key, value) VALUES ('graph_assessment', ${JSON.stringify(rows.assessment)})
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = strftime('%s', 'now')`);
      }
      const generation = randomUUID();
      tx.run(sql`INSERT INTO main._nexus_meta (key, value) VALUES ('graph_generation', ${generation})
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = strftime('%s', 'now')`);
    },
    { behavior: 'immediate' },
  );
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Parameters for {@link runNexusAnalysis}. */
export interface NexusAnalysisParams {
  /** Absolute path to the repository to analyze. */
  repoPath: string;
  /** Override the project ID (default: `base64url(repoPath).slice(0, 32)`). */
  projectIdOverride?: string;
  /** When true, skip unchanged indexes and atomically rebuild changed generations. */
  incremental?: boolean;
  /** Explicit relative paths of nested repositories authorized for source inclusion. */
  includedRepositories?: readonly string[];
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
  /** Committed per-file outcomes and source provenance. */
  assessment: GraphIndexAssessment | null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run the nexus code-intelligence pipeline on a repository.
 *
 * This function:
 * 1. Derives the project ID.
 * 2. Captures the current graph generation for concurrent-write detection.
 * 3. Stages and atomically publishes the `@cleocode/nexus` pipeline output.
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
  const [{ getNexusDb, nexusSchema }, { runPipeline }] = await Promise.all([
    import('@cleocode/core/store/nexus-sqlite' as string),
    import('@cleocode/nexus/pipeline' as string),
  ]);

  const projectId = projectIdOverride ?? Buffer.from(repoPath).toString('base64url').slice(0, 32);

  const db = await getNexusDb();
  const tables = {
    nexusNodes: nexusSchema.nexusNodes,
    nexusRelations: nexusSchema.nexusRelations,
  };

  const expectedGeneration = graphGeneration(db);
  const assessedRevision = sourceRevision(repoPath);
  const includedRepositories = params.includedRepositories ?? includedRepositoryScope(db, repoPath);

  const result = await runPipeline(repoPath, projectId, db, tables, onProgress, {
    incremental: incremental && expectedGeneration !== null,
    assessedRevision,
    includedRepositories,
    publishGraph: (rows: GraphPublicationRows) => {
      if (sourceRevision(repoPath) !== assessedRevision) {
        throw new Error('Source revision changed during indexing; previous graph retained.');
      }
      publishNexusGraph(db, rows, expectedGeneration);
    },
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
    assessment: await readKnowledgeIndexAssessment(),
  };
}
