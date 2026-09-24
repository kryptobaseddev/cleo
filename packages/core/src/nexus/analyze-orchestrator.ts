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

import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import type {
  GraphIndexAssessment,
  GraphIndexFileReport,
  GraphIndexRunSummary,
  GraphParseCacheEntry,
  GraphParseCacheUpdate,
  GraphPublicationRows,
  ParserExecutionLimits,
} from '@cleocode/contracts';
import type { GraphSourceRootAssessment } from '@cleocode/contracts/graph';
import type { ScannedFile } from '@cleocode/nexus/pipeline';
import { sql } from 'drizzle-orm';
import type { NodeSQLiteDatabase } from 'drizzle-orm/node-sqlite';
import { z } from 'zod';
import { worktreeScope } from '../paths.js';
import { getProjectInfo } from '../project-info.js';
import { createParserExecutionPort } from '../resources/spawn-wrapper.js';
import { nexusNodes, nexusRelations } from '../store/schema/cleo-project/nexus-graph.js';
import {
  buildFileManifest,
  clearFileManifest,
  type GraphFileManifest,
  writeFileManifest,
  writeRunCost,
} from './graph-manifest.js';
import { generateProjectHash } from './hash.js';
import { readKnowledgeIndexAssessment } from './knowledge.js';
import { resolveSourceRoots } from './source-roots.js';

/** Compare ownership and observed revisions without treating observation time as a change. */
function rootFingerprint(roots: GraphSourceRootAssessment): string {
  return JSON.stringify({
    projectId: roots.projectId,
    projectRoot: roots.projectRoot,
    sourceRoot: roots.sourceRoot,
    roots: roots.roots.map((root) => ({
      requestedPath: root.requestedPath,
      canonicalPath: root.canonicalPath,
      graphPrefix: root.graphPrefix,
      explicitlyIncluded: root.explicitlyIncluded,
      revision: root.revision,
      status: root.status,
      diagnostics: root.diagnostics,
    })),
  });
}

/**
 * Compare source OWNERSHIP only — never the observed revision.
 *
 * Reusing a file's extraction depends on its bytes (content hash), not on which
 * commit produced them, so a new commit must not by itself force a full
 * rebuild (T12315). The revision is still recorded as provenance and still
 * guards against concurrent change via {@link rootFingerprint}.
 */
function ownershipFingerprint(roots: GraphSourceRootAssessment): string {
  return JSON.stringify({
    projectId: roots.projectId,
    projectRoot: roots.projectRoot,
    sourceRoot: roots.sourceRoot,
    roots: roots.roots.map((root) => ({
      requestedPath: root.requestedPath,
      canonicalPath: root.canonicalPath,
      graphPrefix: root.graphPrefix,
      explicitlyIncluded: root.explicitlyIncluded,
      status: root.status,
    })),
  });
}

/** Read the parse cache committed with the current generation (T12315). */
export function readNexusParseCache(db: NodeSQLiteDatabase): GraphParseCacheEntry[] {
  return db
    .values(
      sql`SELECT path, content_hash, fingerprint, generation, payload FROM main._nexus_parse_cache`,
    )
    .map((row) => {
      const [path, contentHash, fingerprint, generation, payload] = row;
      if (
        typeof path !== 'string' ||
        typeof contentHash !== 'string' ||
        typeof fingerprint !== 'string' ||
        typeof generation !== 'string' ||
        !(payload instanceof Uint8Array)
      )
        throw new Error('Invalid nexus parse cache row');
      return { path, contentHash, fingerprint, generation, payload };
    });
}

/** Apply a parse-cache mutation inside the caller's publication transaction. */
function applyParseCacheUpdate(tx: NodeSQLiteDatabase, update: GraphParseCacheUpdate): void {
  if (update.reset) tx.run(sql`DELETE FROM main._nexus_parse_cache`);
  for (let offset = 0; offset < update.deletePaths.length; offset += 500) {
    const batch = update.deletePaths.slice(offset, offset + 500);
    tx.run(
      sql`DELETE FROM main._nexus_parse_cache WHERE path IN (${sql.join(
        batch.map((path) => sql`${path}`),
        sql`, `,
      )})`,
    );
  }
  for (const entry of update.upserts) {
    if (entry.fingerprint !== update.fingerprint)
      throw new Error(`Parse cache entry ${entry.path} carries a foreign extractor fingerprint`);
    tx.run(sql`INSERT INTO main._nexus_parse_cache (path, content_hash, fingerprint, generation, payload)
      VALUES (${entry.path}, ${entry.contentHash}, ${entry.fingerprint}, ${entry.generation}, ${entry.payload})
      ON CONFLICT(path) DO UPDATE SET content_hash = excluded.content_hash,
        fingerprint = excluded.fingerprint, generation = excluded.generation, payload = excluded.payload`);
  }
}

/** Fail closed when a required root observation did not finish successfully. */
function requireObservedRoots(roots: GraphSourceRootAssessment): void {
  const failed = roots.roots.filter(
    (root) => root.status !== 'available' && root.status !== 'unversioned',
  );
  if (failed.length)
    throw new Error(
      `Source-root observation incomplete; previous graph retained: ${failed.map((root) => `${root.requestedPath}: ${root.diagnostics.join('; ')}`).join(' | ')}`,
    );
}

/** Verify persisted parent identity without promoting a legacy path hash into authority. */
async function readAnalysisIdentity(
  projectRoot: string,
  previousRoots: GraphSourceRootAssessment | undefined,
  projectIdOverride: string | undefined,
): Promise<string> {
  const canonicalParent = await realpath(projectRoot);
  if (previousRoots && previousRoots.projectRoot !== canonicalParent)
    throw new Error(
      'Stored graph ownership differs from the current project root; previous graph retained.',
    );
  let projectId: string | undefined;
  try {
    const info = await getProjectInfo(projectRoot);
    projectId = info.projectId || info.projectHash;
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    projectId = previousRoots?.projectId;
  }
  if (!projectId)
    throw new Error(
      'Stable project identity is unavailable; initialize this project or restore its verified project identity.',
    );
  if (previousRoots && previousRoots.projectId !== projectId)
    throw new Error(
      'Stored graph identity differs from the current project identity; previous graph retained.',
    );
  if (projectIdOverride !== undefined && projectIdOverride !== projectId)
    throw new Error('Explicit analysis identity differs from the verified project identity.');
  return projectId;
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

/** Read the extractor fingerprint recorded with the committed generation (T12315). */
function publishedExtractorFingerprint(db: NodeSQLiteDatabase): string | null {
  const value = db.values(
    sql`SELECT value FROM main._nexus_meta WHERE key = 'graph_extractor_fingerprint'`,
  )[0]?.[0];
  return typeof value === 'string' ? value : null;
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
 * @param db - Owning project graph database with the canonical schema installed.
 * @param rows - Validated staged nodes, relations and source assessment to publish.
 * @param expectedGeneration - Previously observed generation; null for the first publication.
 * @remarks The transaction rejects stale generation preconditions and restores the
 * prior live rows on failure. Successful replacement does not itself retain an
 * independently recoverable historical generation.
 * @example
 * ```ts
 * publishNexusGraph(db, stagedRows, expectedGeneration);
 * ```
 */
export function publishNexusGraph(
  db: NodeSQLiteDatabase,
  rows: GraphPublicationRows,
  expectedGeneration: string | null,
): void {
  const generation = rows.generation ?? randomUUID();
  if (rows.generation !== undefined) {
    z.uuid().parse(generation);
    if (generation === expectedGeneration)
      throw new Error('Publication generation must be a fresh immutable identity');
    if (rows.assessment?.generation !== generation)
      throw new Error('Staged assessment publication generation does not match rows');
    if (
      rows.assessment.references?.some(
        (reference) =>
          reference.publicationGeneration !== undefined &&
          reference.publicationGeneration !== generation,
      )
    )
      throw new Error('Staged reference publication generation does not match rows');
  }
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
      if (
        rows.generation !== undefined &&
        tx.values(sql`
        SELECT id FROM main.nexus_nodes
        WHERE json_extract(meta_json, '$.lexicalCapability') = 'typescript-javascript'
          AND json_extract(meta_json, '$.publicationGeneration') IS NOT ${generation}
        LIMIT 1
      `).length > 0
      ) {
        throw new Error('Staged lexical declaration publication generation does not match rows');
      }
      if (rows.parseCache) applyParseCacheUpdate(tx, rows.parseCache);
      // The fingerprint names the extractor build that produced these rows; a
      // publisher without a parse cache leaves the build unproven.
      if (rows.parseCache?.fingerprint) {
        tx.run(sql`INSERT INTO main._nexus_meta (key, value) VALUES ('graph_extractor_fingerprint', ${rows.parseCache.fingerprint})
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = strftime('%s', 'now')`);
      } else {
        tx.run(sql`DELETE FROM main._nexus_meta WHERE key = 'graph_extractor_fingerprint'`);
      }
      if (rows.assessment)
        writeFileManifest(tx, buildFileManifest(rows.assessment, rows.assessment.files));
      else clearFileManifest(tx);
      if (rows.assessment) {
        tx.run(sql`INSERT INTO main._nexus_meta (key, value) VALUES ('graph_assessment', ${JSON.stringify(rows.assessment)})
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = strftime('%s', 'now')`);
      }
      tx.run(sql`INSERT INTO main._nexus_meta (key, value) VALUES ('graph_generation', ${generation})
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = strftime('%s', 'now')`);
    },
    { behavior: 'immediate' },
  );
}

/**
 * Re-record source provenance for a generation whose files were just verified
 * byte-identical to the current tree, without replacing any graph rows.
 * @param db - Owning project graph database.
 * @param assessment - The previous assessment with current roots and revision, or
 *   `null` when only the file manifest needs re-recording.
 * @param manifest - File manifest re-observed from the verified tree.
 * @param expectedGeneration - Generation the verification was performed against.
 * @returns The recorded assessment, or `null` when none was re-recorded.
 * @throws When the generation changed since verification.
 */
function recordVerifiedProvenance(
  db: NodeSQLiteDatabase,
  assessment: GraphIndexAssessment | null,
  manifest: GraphFileManifest,
  expectedGeneration: string | null,
): GraphIndexAssessment | null {
  db.transaction(
    (tx) => {
      if (graphGeneration(tx) !== expectedGeneration)
        throw new Error('Nexus graph changed during verification; provenance not updated.');
      if (assessment)
        tx.run(sql`UPDATE main._nexus_meta SET value = ${JSON.stringify(assessment)},
          updated_at = strftime('%s', 'now') WHERE key = 'graph_assessment'`);
      writeFileManifest(tx, manifest);
    },
    { behavior: 'immediate' },
  );
  return assessment;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Parameters for {@link runNexusAnalysis}. */
export interface NexusAnalysisParams {
  /** Per-file parser bounds and cancellation; native RSS containment is unverified. */
  parserLimits?: ParserExecutionLimits;
  /** Absolute path to the repository to analyze. */
  repoPath: string;
  /** Stable identity parent; defaults to repoPath and can differ from the analyzed source. */
  projectRoot?: string;
  /** Explicit existing identity override; otherwise require persisted parent identity. */
  projectIdOverride?: string;
  /**
   * Parse every file instead of reusing the previous generation's extractions.
   * When omitted, an analysis reuses what is provably current (T12315) and
   * falls back to a full parse — reporting why — when it cannot.
   */
  full?: boolean;
  /**
   * @deprecated Incremental reuse is the default since T12315; this flag is
   * accepted for compatibility and has no effect. Use `full` to force a rebuild.
   */
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
  /** Whether this run reused previous extractions (mode `incremental` or `unchanged`). */
  incremental: boolean;
  /** Mode, reason, per-file counts and phase costs of this run. */
  summary: GraphIndexRunSummary;
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
 * 1. Captures the existing parent identity and explicit source roots.
 * 2. Captures the current graph generation for concurrent-write detection.
 * 3. Stages and atomically publishes the `@cleocode/nexus` pipeline output.
 * 4. Best-effort: refreshes `nexus-bridge.md`.
 * 5. Best-effort: updates the multi-project registry.
 * 6. Best-effort: sweeps the git log for task–symbol links.
 *
 * @param params - Analysis configuration
 * @returns Pipeline result with node/relation/file counts and duration
 * @throws {Error} When identity, source preconditions or the pipeline fail.
 * @remarks Root revisions and file hashes are optimistic preconditions, not a
 * filesystem lock. Publication uses the owning store's synchronous generation CAS;
 * optional post-publication hooks cannot replace its committed result.
 * @example
 * ```ts
 * const result = await runNexusAnalysis({ repoPath: '/identity', includedRepositories: ['app'] });
 * ```
 */
export async function runNexusAnalysis(params: NexusAnalysisParams): Promise<NexusAnalysisResult> {
  const captured = {
    ...params,
    parserLimits: params.parserLimits ? { ...params.parserLimits } : undefined,
    includedRepositories: params.includedRepositories
      ? [...params.includedRepositories]
      : undefined,
  };
  const projectRoot = resolve(captured.projectRoot ?? captured.repoPath);
  const inherited = worktreeScope.getStore();
  if (inherited?.execution && resolve(inherited.execution.identity.projectRoot) !== projectRoot)
    throw new Error('Analysis project differs from captured execution scope.');
  return worktreeScope.run(
    { ...inherited, worktreeRoot: projectRoot, projectHash: generateProjectHash(projectRoot) },
    () => runScopedNexusAnalysis(captured, projectRoot),
  );
}

/** Keep the entire asynchronous analysis bound to its captured identity parent. */
async function runScopedNexusAnalysis(
  params: NexusAnalysisParams,
  projectRoot: string,
): Promise<NexusAnalysisResult> {
  const { projectIdOverride, full = false, onProgress } = params;
  const execution = worktreeScope.getStore()?.execution;
  execution?.assertActive();
  const signals = [params.parserLimits?.signal, execution?.signal].filter(
    (signal): signal is AbortSignal => signal !== undefined,
  );
  const signal = signals.length ? AbortSignal.any(signals) : undefined;
  signal?.throwIfAborted();
  const startTime = Date.now();

  // SSoT-EXEMPT:pipeline-progress — requires direct DB handle access and a
  // progress callback that is CLI-only. Extracted here to keep the core
  // runnable without the CLI layer, but the DB/pipeline imports still happen
  // via dynamic imports so the CLI controls when heavy deps are loaded.
  const [{ getNexusDb, nexusSchema }, { runPipeline, walkRepositoryPaths }] = await Promise.all([
    import('@cleocode/core/store/nexus-sqlite' as string),
    import('@cleocode/nexus/pipeline' as string),
  ]);

  const db = await getNexusDb(projectRoot);
  const expectedGeneration = graphGeneration(db);
  const previousAssessment = await readKnowledgeIndexAssessment(projectRoot);
  const projectId = await readAnalysisIdentity(
    projectRoot,
    previousAssessment?.sourceRoots,
    projectIdOverride,
  );
  if (execution && execution.identity.projectId !== projectId)
    throw new Error('Analysis identity differs from captured execution scope.');
  const tables = {
    nexusNodes: nexusSchema.nexusNodes,
    nexusRelations: nexusSchema.nexusRelations,
  };

  const requestedSource = resolve(params.repoPath);
  const includedRepositories =
    params.includedRepositories ?? includedRepositoryScope(db, requestedSource);
  const rootRequest = {
    projectId,
    projectRoot,
    sourceRoot: requestedSource,
    includedRepositories,
    signal,
    ...(execution ? { deadline: execution.deadlineAt } : {}),
  };
  const sourceRoots = await resolveSourceRoots(rootRequest);
  requireObservedRoots(sourceRoots);
  execution?.assertActive();
  const repoPath = sourceRoots.sourceRoot;
  const assessedRevision = sourceRoots.roots[0]?.revision ?? null;
  const unchangedOwnership =
    previousAssessment?.sourceRoots !== undefined &&
    ownershipFingerprint(previousAssessment.sourceRoots) === ownershipFingerprint(sourceRoots);
  const fullReason = full
    ? 'full rebuild requested (--full)'
    : expectedGeneration === null
      ? 'no previous generation to reuse'
      : previousAssessment?.sourceRoots === undefined
        ? 'the previous generation predates source-root provenance'
        : !unchangedOwnership
          ? 'source ownership (project root, source root or included repositories) changed since the previous generation'
          : undefined;
  const useIncremental = fullReason === undefined;
  let committedAssessment: GraphIndexAssessment | null = null;

  const recheckRoots = async (): Promise<void> => {
    execution?.assertActive();
    if (
      (await readAnalysisIdentity(
        projectRoot,
        previousAssessment?.sourceRoots,
        projectIdOverride,
      )) !== projectId
    )
      throw new Error('Project identity changed during indexing; previous graph retained.');
    const currentRoots = await resolveSourceRoots(rootRequest);
    requireObservedRoots(currentRoots);
    execution?.assertActive();
    signal?.throwIfAborted();
    if (rootFingerprint(currentRoots) !== rootFingerprint(sourceRoots))
      throw new Error(
        'Source ownership or revision changed during indexing; previous graph retained.',
      );
  };
  const recheckFiles = async (assessment: GraphIndexAssessment): Promise<ScannedFile[]> => {
    // Git observation yields. Reuse the full walker after it so an edit,
    // addition, rename or deletion during that await cannot publish stale bytes.
    const failures: string[] = [];
    const currentFiles = await walkRepositoryPaths(
      repoPath,
      undefined,
      (report: GraphIndexFileReport) => {
        if (report.status === 'failed') failures.push(report.path);
      },
      includedRepositories,
    );
    const recorded = new Map(
      assessment.files
        .filter((file) => file.contentHash)
        .map((file) => [file.path, file.contentHash]),
    );
    if (
      failures.length ||
      currentFiles.length !== recorded.size ||
      currentFiles.some(
        (file: ScannedFile) => !file.contentHash || recorded.get(file.path) !== file.contentHash,
      )
    )
      throw new Error('Source files changed before publication; previous graph retained.');
    return currentFiles;
  };

  const result = await runPipeline(repoPath, projectId, db, tables, onProgress, {
    parserExecution: createParserExecutionPort(),
    parserLimits: { ...params.parserLimits, signal },
    incremental: useIncremental,
    ...(fullReason ? { fullReason } : {}),
    loadParseCache: () => readNexusParseCache(db),
    publishedFingerprint: publishedExtractorFingerprint(db),
    assessedRevision,
    sourceRoots,
    includedRepositories,
    publishGraph: async (rows: GraphPublicationRows) => {
      const recheckStart = Date.now();
      await recheckRoots();
      if (
        !rows.assessment?.sourceRoots ||
        rootFingerprint(rows.assessment.sourceRoots) !== rootFingerprint(sourceRoots)
      )
        throw new Error('Staged source ownership does not match the assessed roots.');
      await recheckFiles(rows.assessment);
      execution?.assertActive();
      signal?.throwIfAborted();
      const commitStart = Date.now();
      publishNexusGraph(db, rows, expectedGeneration);
      process.stderr.write(
        `[nexus] Publication: source recheck ${commitStart - recheckStart}ms, atomic commit of ` +
          `${rows.nodes.length} nodes + ${rows.relations.length} relations ${Date.now() - commitStart}ms\n`,
      );
      committedAssessment = rows.assessment;
    },
  });

  if (!committedAssessment && previousAssessment) {
    // Incremental no-op still needs current provenance: Git or source bytes can
    // change while the pipeline scans without ever invoking the publisher.
    await recheckRoots();
    const verifiedFiles = await recheckFiles(previousAssessment);
    execution?.assertActive();
    signal?.throwIfAborted();
    // T12315: a new commit with byte-identical sources no longer forces a full
    // rebuild, so the unchanged graph must still record the revision it was
    // just verified against — otherwise knowledge coverage would report it
    // stale forever. The files were re-hashed above, so the claim is exact.
    const provenance =
      previousAssessment.sourceRoots &&
      rootFingerprint(previousAssessment.sourceRoots) !== rootFingerprint(sourceRoots)
        ? {
            ...previousAssessment,
            sourceRoots,
            assessedRevision,
            assessedAt: new Date().toISOString(),
          }
        : null;
    // T12316: re-record current mtimes as well, so freshness checks keep taking
    // the metadata fast path after a checkout or `touch` that changed no bytes.
    committedAssessment =
      recordVerifiedProvenance(
        db,
        provenance,
        buildFileManifest(provenance ?? previousAssessment, verifiedFiles),
        expectedGeneration,
      ) ?? committedAssessment;
  }

  // Advisory: remember what a publishing run cost, so a later freshness check
  // can estimate a refresh before starting one (T12316).
  if (result.summary.mode !== 'unchanged') {
    try {
      writeRunCost(db, {
        summary: result.summary,
        durationMs: Date.now() - startTime,
        recordedAt: new Date().toISOString(),
      });
    } catch {
      // non-fatal: estimates degrade to "unknown cost"
    }
  }

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
    incremental: result.summary.mode !== 'full',
    summary: result.summary,
    nodeCount: result.nodeCount,
    relationCount: result.relationCount,
    fileCount: result.fileCount,
    durationMs: Date.now() - startTime,
    assessment: committedAssessment ?? previousAssessment,
  };
}
