/**
 * Code intelligence ingestion pipeline — entry point.
 *
 * Orchestrates the multi-phase ingestion run for a single repository:
 *
 * Phase 1 (filesystem-walker): Scan the directory tree, stat files, collect
 *   paths and sizes. Skips files > 512 KB and excluded directories.
 *
 * Phase 2 (structure-processor): Create File and Folder graph nodes with
 *   CONTAINS edges linking each folder to its immediate children.
 *
 * Phase 3a (import-processor): Build ImportResolutionContext from all file
 *   paths (suffix index + tsconfig alias map) for use by Phase 3 and Phase 4.
 *
 * Phase 3 (parse loop — T534): Parse each source file with tree-sitter,
 *   extract symbols into the SymbolTable, extract raw imports, resolve them
 *   to IMPORTS edges via processExtractedImports, and populate the
 *   ResolutionContext's namedImportMap.
 *
 * Phase 4 (call resolution — T535+): Walk call sites and emit CALLS edges
 *   using the ResolutionContext's tiered lookup.
 *
 * Phase 5 (community detection — T538): Cluster symbol nodes by call density
 *   using the Louvain algorithm (graphology-communities-louvain). Writes
 *   Community nodes and MEMBER_OF edges into the graph.
 *
 * Phase 6 (process detection — T538): BFS-trace execution flows from scored
 *   entry points through CALLS edges. Writes Process nodes, STEP_IN_PROCESS
 *   edges, and ENTRY_POINT_OF edges into the graph.
 *
 * After all phases complete the in-memory KnowledgeGraph is flushed to
 * `nexus_nodes` and `nexus_relations` in the provided Drizzle database.
 *
 * The caller is responsible for obtaining the Drizzle DB instance and
 * passing it to `runPipeline`. This keeps the pipeline decoupled from
 * `@cleocode/core` (which depends on `@cleocode/nexus`, so a reverse import
 * would create a circular dependency).
 *
 * @task T532
 * @task T533
 * @task T538
 * @module pipeline
 */

// Call processor (T536)
export type { CallResolutionResult } from './call-processor.js';
export { emitClassMemberEdges, resolveCalls } from './call-processor.js';
// Community detection (T538)
export type {
  CommunityDetectionResult,
  CommunityInfo,
  CommunityMembership,
} from './community-processor.js';
export { detectCommunities } from './community-processor.js';
// Entry point scoring (T538)
export type { EntryPointScoreResult } from './entry-point-scoring.js';
export {
  calculateEntryPointScore,
  isTestFile,
  isUtilityFile,
} from './entry-point-scoring.js';
// TypeScript extractor (T534, T536, T617)
export type {
  ExtractedCall,
  ExtractedHeritage,
  ExtractedReExport,
  TypeScriptExtractionResult,
} from './extractors/typescript-extractor.js';
export {
  extractCalls,
  extractHeritage,
  extractImports,
  extractReExports,
  extractTypeScript,
} from './extractors/typescript-extractor.js';
export type { KnownFileFingerprint, ScannedFile, WalkOptions } from './filesystem-walker.js';
export { walkRepositoryPaths } from './filesystem-walker.js';
// Heritage processor (T536)
export type { HeritageMap, HeritageProcessingResult } from './heritage-processor.js';
export { buildHeritageMap, processHeritage } from './heritage-processor.js';
// Import processor (T533, T617)
export type {
  BarrelExportEntry,
  BarrelExportMap,
  ExtractedImport,
  ExtractedReExportRecord,
  ImportResolutionContext,
  ModuleAliasMap,
  NamedImportBinding,
  NamedImportEntry,
  NamedImportMap,
  ProcessImportsOptions,
  TsconfigPaths,
} from './import-processor.js';
export {
  buildBarrelExportMap,
  buildImportResolutionContext,
  isFileInPackageDir,
  loadTsconfigPaths,
  loadWorkspacePackages,
  processExtractedImports,
  resolveBarrelBinding,
  resolveTypescriptImport,
  WILDCARD_EXPORT_KEY_PREFIX,
} from './import-processor.js';
export type { KnowledgeGraph, NexusDbInsert, NexusTables } from './knowledge-graph.js';
export { createKnowledgeGraph } from './knowledge-graph.js';
export { detectLanguageFromPath, isIndexableFile } from './language-detection.js';
// Parse cache (T12315)
export type { FileExtraction } from './parse-cache.js';
export {
  computeExtractorFingerprint,
  decodeParseCacheEntry,
  encodeParseCacheEntry,
} from './parse-cache.js';
// Parse loop (T534, T536)
export type { ParseLoopOptions, ParseLoopResult } from './parse-loop.js';
export { runParseLoop } from './parse-loop.js';
// Process detection (T538)
export type {
  ProcessDetectionConfig,
  ProcessDetectionResult,
  ProcessInfo,
  ProcessStep,
} from './process-processor.js';
export { detectProcesses } from './process-processor.js';
// Access processor (T1837)
export type {
  AccessMode,
  AccessResolutionResult,
  ExtractedAccess,
} from './processors/access-processor.js';
export { extractAccesses, resolveAccesses } from './processors/access-processor.js';
// Resolution context (T533)
export type {
  ImportMap,
  ResolutionContext,
  ResolutionTier,
  TieredCandidates,
} from './resolution-context.js';
export { createResolutionContext, TIER_CONFIDENCE } from './resolution-context.js';
export { processStructure } from './structure-processor.js';
// Suffix index (T533)
export type { SuffixIndex } from './suffix-index.js';
export {
  buildSuffixIndex,
  EMPTY_SUFFIX_INDEX,
  EXTENSIONS,
  suffixResolve,
  tryResolveWithExtensions,
} from './suffix-index.js';
// Symbol table (T533)
export type { SymbolDefinition, SymbolTable } from './symbol-table.js';
export { CALLABLE_KINDS, CLASS_KINDS, createSymbolTable } from './symbol-table.js';
// Worker pool (T540)
export type { WorkerPool } from './workers/worker-pool.js';
export { createWorkerPool } from './workers/worker-pool.js';

import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import type {
  GraphIndexFileReport,
  GraphIndexReferenceReport,
  GraphIndexRunSummary,
  GraphParseCacheEntry,
  GraphParseCacheUpdate,
  GraphPublicationRows,
  ParserExecutionLimits,
  ParserExecutionPort,
} from '@cleocode/contracts';
import type { GraphSourceRootAssessment } from '@cleocode/contracts/graph';
import { sql } from 'drizzle-orm';
import { resolveCalls } from './call-processor.js';
import { detectCommunities } from './community-processor.js';
import type { ExtractedCall } from './extractors/typescript-extractor.js';
import { walkRepositoryPaths } from './filesystem-walker.js';
import { buildHeritageMap, processHeritage } from './heritage-processor.js';
import {
  buildImportResolutionContext,
  loadTsconfigPaths,
  loadWorkspacePackages,
} from './import-processor.js';
import type { KnowledgeGraph, NexusDbInsert, NexusTables } from './knowledge-graph.js';
import { createKnowledgeGraph } from './knowledge-graph.js';
import {
  computeExtractorFingerprint,
  decodeParseCacheEntry,
  encodeParseCacheEntry,
  type FileExtraction,
} from './parse-cache.js';
import { runParseLoop } from './parse-loop.js';
import { detectProcesses } from './process-processor.js';
import { type ExtractedAccess, resolveAccesses } from './processors/access-processor.js';
import { createResolutionContext } from './resolution-context.js';
import { processStructure } from './structure-processor.js';

// ---------------------------------------------------------------------------
// Pipeline options
// ---------------------------------------------------------------------------

/**
 * Options for `runPipeline` controlling full vs. incremental execution.
 */
export interface PipelineOptions {
  /** Per-file parser bounds and cancellation propagated into isolated execution. */
  parserLimits?: ParserExecutionLimits;
  /** Existing runtime process launcher; required for isolated production parsing. */
  parserExecution?: ParserExecutionPort;
  /**
   * When `true`, reuse the previous generation where that is provably exact
   * (T12315): unchanged indexes publish nothing, and changed indexes re-parse
   * only files without a reusable {@link GraphParseCacheEntry}, then re-run
   * every resolution phase over the complete merged extraction. Falls back to a
   * full parse — and says why in {@link PipelineResult.summary} — when there is
   * no previous index or parse cache, the extractor build changed, or more than
   * {@link PipelineOptions.maxIncrementalChangeRatio} of the files changed.
   * No live rows are deleted during analysis; `publishGraph` replaces atomically.
   *
   * @default false
   */
  incremental?: boolean;
  /** Owner-supplied reason reported when `incremental` is false (e.g. `--full`). */
  fullReason?: string;
  /**
   * Share of files that may change before an incremental run falls back to a
   * full rebuild. Above it, reuse saves little and a clean rebuild also sheds
   * cache entries for files that no longer exist.
   *
   * @default 0.3
   */
  maxIncrementalChangeRatio?: number;
  /**
   * Read the parse cache committed with the previous generation. Required for
   * incremental reuse; without it an incremental request parses every file.
   */
  loadParseCache?: () => GraphParseCacheEntry[] | Promise<GraphParseCacheEntry[]>;
  /**
   * Extractor fingerprint recorded with the published generation (`null` when
   * none was recorded). An unchanged tree is reported `unchanged` only when it
   * equals the current build's fingerprint; otherwise the published graph was
   * produced by different extractor code and is rebuilt.
   */
  publishedFingerprint?: string | null;
  /** Explicit relative paths of nested repositories authorized for inclusion. */
  includedRepositories?: readonly string[];
  /** Revision captured by the owning project before indexing. */
  assessedRevision?: string | null;

  /** Explicit parent and repository provenance observed by the owning core service. */
  sourceRoots?: GraphSourceRootAssessment;

  /**
   * Publish a validated generation atomically using the owning store.
   * Completion awaits this callback; rejection propagates without reporting success.
   * The owner must reject before mutation or roll back its own transaction on failure.
   * Cancellation after the owner commits must not be reported as an uncommitted failure.
   */
  publishGraph?: (rows: GraphPublicationRows) => void | Promise<void>;
}

// ---------------------------------------------------------------------------
// Index stats
// ---------------------------------------------------------------------------

/**
 * Snapshot of index freshness for a project — returned by `getIndexStats`.
 */
export interface IndexStats {
  /** Whether the project has ever been indexed. */
  indexed: boolean;
  /** Total graph nodes in the index (0 if not indexed). */
  nodeCount: number;
  /** Total directed edges in the index (0 if not indexed). */
  relationCount: number;
  /** Total source files tracked in the index (0 if not indexed). */
  fileCount: number;
  /**
   * ISO 8601 timestamp of the most recent indexing run for this project,
   * or `null` if the project has never been indexed.
   */
  lastIndexedAt: string | null;
  /**
   * Number of files on disk whose mtime is newer than their `indexed_at`
   * timestamp in the database — i.e., files that would be re-indexed by
   * an incremental run. `-1` if staleness check is not performed.
   */
  staleFileCount: number;
}

// ---------------------------------------------------------------------------
// Database query helpers (generic, avoid importing core types)
// ---------------------------------------------------------------------------

/**
 * Extended DB interface for read queries needed by incremental mode and stats.
 * Extends the insert-only NexusDbInsert with select capabilities.
 */
export interface NexusDbReadInsert extends NexusDbInsert {
  // `from(table)` is itself awaitable (the Drizzle query builder is a thenable
  // resolving to the rows) AND chainable with `.where()` / `.orderBy()`. The
  // awaitable shape is required since ADR-090 · T11648 dropped the per-query
  // `WHERE project_id = ?` filter — project-scoped graph reads now await the
  // unfiltered `select().from(table)` directly.
  select: (fields?: Record<string, unknown>) => {
    from: (table: unknown) => Promise<Record<string, unknown>[]> & {
      where: (condition: unknown) => Promise<Record<string, unknown>[]>;
      orderBy?: (...args: unknown[]) => Promise<Record<string, unknown>[]>;
    };
  };
  delete: (table: unknown) => {
    where: (condition: unknown) => Promise<unknown>;
  };
  transaction: <T>(fn: (tx: NexusDbReadInsert) => Promise<T>) => Promise<T>;
}

// ---------------------------------------------------------------------------
// Pipeline result
// ---------------------------------------------------------------------------

/**
 * Result returned by `runPipeline` after all phases complete.
 */
export interface PipelineResult {
  /** Total number of graph nodes written to nexus_nodes. */
  nodeCount: number;
  /** Total number of directed edges written to nexus_relations. */
  relationCount: number;
  /** Number of source files scanned (excludes filtered/skipped files). */
  fileCount: number;
  /** Wall-clock milliseconds for the full pipeline run. */
  durationMs: number;
  /** File outcomes that distinguish exclusion, extraction limits, and failures. */
  files?: GraphIndexFileReport[];
  /** AST references retained as explicit extraction limitations, not graph edges. */
  references?: GraphIndexReferenceReport[];
  /** Number of EXTENDS edges emitted by the heritage processor. */
  extendsCount: number;
  /** Number of IMPLEMENTS edges emitted by the heritage processor. */
  implementsCount: number;
  /** Number of CALLS edges emitted at Tier 1 (same-file). */
  callsTier1Count: number;
  /** Number of CALLS edges emitted at Tier 2a (named-import). */
  callsTier2aCount: number;
  /** Number of CALLS edges emitted at Tier 3 (global fallback). */
  callsTier3Count: number;
  /** Number of HAS_METHOD edges emitted. */
  hasMethodCount: number;
  /** Number of HAS_PROPERTY edges emitted. */
  hasPropertyCount: number;
  /** Number of ACCESSES edges emitted at Tier 1 (Phase 3f — T1837). */
  accessesTier1Count: number;
  /** Number of ACCESSES edges emitted at Tier 3 (Phase 3f — T1837). */
  accessesTier3Count: number;
  /** Number of communities detected by Phase 5 (Louvain). */
  communityCount: number;
  /** Louvain modularity score for the community partition (0 – 1). */
  communityModularity: number;
  /** Number of execution flow processes detected by Phase 6. */
  processCount: number;
  /** Number of cross-community processes detected by Phase 6. */
  crossCommunityProcessCount: number;
  /** Mode chosen (incremental, full or unchanged), why, file counts and phase costs. */
  summary: GraphIndexRunSummary;
}

/** Default share of changed files above which an incremental run rebuilds fully. */
export const DEFAULT_MAX_INCREMENTAL_CHANGE_RATIO = 0.3;

// ---------------------------------------------------------------------------
// getIndexStats
// ---------------------------------------------------------------------------

/**
 * Share of a repository that may fail to parse before a generation is refused.
 *
 * Below it the unparsed files are recorded and reported and the rest is
 * published; above it the generation would misrepresent the codebase, so the
 * previous graph is retained instead (T12313).
 */
export const UNPARSED_FILE_REFUSAL_RATIO = 0.1;

/**
 * Return freshness statistics for the code intelligence index of a project.
 *
 * An empty readable graph returns `{ indexed: false, ... }`. Database failures
 * propagate so callers cannot mistake a diagnostic failure for missing coverage.
 *
 * @param _projectId - Unused since ADR-090 · T11648 (project-scoped graph DB);
 *   retained for call-site compatibility with `runPipeline`.
 * @param repoPath - Absolute path to the repository root (used for mtime checks)
 * @param db - Drizzle database instance
 * @param tables - Drizzle table references
 * @param options - `staleScan: false` skips re-hashing every indexed file and
 *   reports `staleFileCount: -1`; for callers with a cheaper freshness answer (T12348).
 * @returns Counts, last indexed time and stale-file count.
 */
export async function getIndexStats(
  _projectId: string,
  repoPath: string,
  db: NexusDbReadInsert,
  tables: NexusTables,
  options: { staleScan?: boolean } = {},
): Promise<IndexStats> {
  // Column accessors — DrizzleTableRef declares string-indexed Column properties
  // so eq() / db.select() can take them directly without per-call casts (T9767).
  const nodesTable = tables.nexusNodes;
  const relationsTable = tables.nexusRelations;

  // ADR-090 · T11648: the graph tables are PROJECT-scoped (one project per
  // `cleo.db`), so these queries no longer filter by `project_id`.
  //
  // T12348: aggregates in SQL. Loading all 89k node rows and 185k relation
  // ids into JS to count them dominated `cleo nexus status`. `NULLIF` keeps
  // the previous rule that an empty `indexedAt` never wins.
  const [totals] = (await db
    .select({
      nodeCount: sql<number>`count(*)`,
      lastIndexedAt: sql<string | null>`max(nullif(${nodesTable['indexedAt']}, ''))`,
    })
    .from(tables.nexusNodes)) as Array<{ nodeCount: number; lastIndexedAt: string | null }>;
  const nodeCount = Number(totals?.nodeCount ?? 0);

  if (nodeCount === 0) {
    return {
      indexed: false,
      nodeCount: 0,
      relationCount: 0,
      fileCount: 0,
      lastIndexedAt: null,
      staleFileCount: -1,
    };
  }

  const [relations] = (await db
    .select({ relationCount: sql<number>`count(*)` })
    .from(relationsTable)) as Array<{ relationCount: number }>;
  const relationCount = Number(relations?.relationCount ?? 0);

  // Distinct file nodes (filePath !== null), with the hash each was indexed at.
  const fileRows = (await db
    .select({
      filePath: nodesTable['filePath'],
      contentHash: sql`json_extract(${nodesTable['metaJson']}, '$.contentHash')`,
    })
    .from(tables.nexusNodes)
    .where(
      sql`${nodesTable['kind']} = 'file' AND ${nodesTable['filePath']} IS NOT NULL`,
    )) as Array<{ filePath: string | null; contentHash: string | null }>;
  const filePathMap = new Map<string, string>();
  for (const row of fileRows) {
    if (row.filePath) filePathMap.set(row.filePath, row.contentHash ?? '');
  }
  const fileCount = filePathMap.size;

  // Check stale files — re-hash every indexed file. A caller that already has
  // a cheaper freshness answer (the file manifest, T12316) skips this and
  // receives -1, the existing "not assessed" value.
  let staleFileCount = options.staleScan === false ? -1 : 0;
  if (options.staleScan !== false) {
    for (const [relPath, contentHash] of filePathMap) {
      const absPath = relPath.startsWith('/') ? relPath : `${repoPath}/${relPath}`;
      try {
        const currentHash = createHash('sha256')
          .update(await fs.readFile(absPath))
          .digest('hex');
        if (!contentHash || currentHash !== contentHash) staleFileCount++;
      } catch {
        // File deleted — counts as stale
        staleFileCount++;
      }
    }
  }

  return {
    indexed: true,
    nodeCount,
    relationCount,
    fileCount,
    lastIndexedAt: totals?.lastIndexedAt ?? null,
    staleFileCount,
  };
}

// ---------------------------------------------------------------------------
// Incremental mode helpers
// ---------------------------------------------------------------------------

/** Internal: get existing indexed file paths and their indexedAt timestamps. */
async function getIndexedFileHashes(
  _projectId: string,
  db: NexusDbReadInsert,
  tables: NexusTables,
): Promise<Map<string, string>> {
  type Row = { filePath: string | null; contentHash: string | null; kind: string };
  const nodesTable = tables.nexusNodes;
  // ADR-090 · T11648: project-scoped graph DB — no `project_id` predicate.
  const rows = await db
    .select({
      kind: nodesTable['kind'],
      filePath: nodesTable['filePath'],
      indexedAt: nodesTable['indexedAt'],
      contentHash: sql`json_extract(${nodesTable['metaJson']}, '$.contentHash')`,
    })
    .from(tables.nexusNodes);
  const map = new Map<string, string>();
  for (const row of rows as Row[]) {
    if (row.kind === 'file' && row.filePath) map.set(row.filePath, row.contentHash ?? '');
  }
  return map;
}

// ---------------------------------------------------------------------------
// Pipeline entry point
// ---------------------------------------------------------------------------

/** Keep AST-proven but unmodeled source scopes as diagnostics, never invented graph declarations. */
function retainAnalyzedReferences(
  graph: KnowledgeGraph,
  calls: readonly ExtractedCall[],
  accesses: readonly ExtractedAccess[],
): GraphIndexReferenceReport[] {
  const syntaxScopes = new Map<string, string>();
  for (const call of calls) syntaxScopes.set(`calls\0${call.sourceId}`, call.filePath);
  for (const access of accesses) syntaxScopes.set(`accesses\0${access.sourceId}`, access.filePath);
  const reports: GraphIndexReferenceReport[] = [];
  let retained = 0;
  for (const relation of graph.relations) {
    const filePath = syntaxScopes.get(`${relation.type}\0${relation.source}`);
    const file = filePath ? graph.nodes.get(filePath) : undefined;
    const target = graph.nodes.get(relation.target);
    if (
      (relation.type === 'calls' || relation.type === 'accesses') &&
      !graph.nodes.has(relation.source) &&
      target &&
      filePath &&
      file?.kind === 'file' &&
      file.filePath === filePath
    ) {
      reports.push({
        kind: 'unmodeled-source',
        filePath,
        sourceId: relation.source,
        targetId: relation.target,
        targetName: target.name,
        relationship: relation.type,
        reason: `AST enclosing scope has no analyzed declaration; ${relation.reason ?? 'static reference'}`,
      });
      continue;
    }
    // Unexpected missing sources, missing targets, and non-reference relations
    // stay in the graph so strict publication validation still rejects them.
    graph.relations[retained++] = relation;
  }
  graph.relations.length = retained;
  return reports;
}

/**
 * Run the full code intelligence ingestion pipeline for a repository.
 *
 * Executes Phase 1 (filesystem walk) and Phase 2 (structure processing),
 * then flushes all nodes and relations to the database.
 *
 * When `options.incremental` is `true`, unchanged indexes are skipped.
 * Changed indexes rebuild in memory and publish through `publishGraph` so
 * unchanged callers remain available for cross-file resolution.
 *
 * @param repoPath - Absolute path to the repository root
 * @param projectId - Project registry ID (from project_registry.project_id)
 * @param db - Drizzle database instance (pass result of getNexusDb())
 * @param tables - Drizzle table references for nexus_nodes + nexus_relations
 * @param onProgress - Optional progress callback during filesystem walk
 * @param options - Pipeline options (e.g., `{ incremental: true }`)
 * @returns Pipeline result with node/relation/file counts
 *
 * @example
 * ```typescript
 * import { getNexusDb } from '@cleocode/core/store/nexus-sqlite';
 * import { nexusNodes, nexusRelations } from '@cleocode/core/store/nexus-schema';
 * import { runPipeline } from '@cleocode/nexus/pipeline';
 *
 * const db = await getNexusDb();
 * const result = await runPipeline('/path/to/repo', 'project-uuid', db, {
 *   nexusNodes,
 *   nexusRelations,
 * });
 * console.log(`Indexed ${result.nodeCount} nodes`);
 * ```
 */
export async function runPipeline(
  repoPath: string,
  projectId: string,
  db: NexusDbInsert,
  tables: NexusTables,
  onProgress?: (current: number, total: number, filePath: string) => void,
  options?: PipelineOptions,
): Promise<PipelineResult> {
  options?.parserLimits?.signal?.throwIfAborted();
  const startTime = Date.now();
  const phaseMs: Record<string, number> = {};
  let phaseStart = startTime;
  const endPhase = (name: string): void => {
    const now = Date.now();
    phaseMs[name] = (phaseMs[name] ?? 0) + (now - phaseStart);
    phaseStart = now;
  };
  const publicationGeneration = randomUUID();
  const sourceRoots = options?.sourceRoots ? structuredClone(options.sourceRoots) : undefined;
  const isIncremental = options?.incremental === true;
  const graph: KnowledgeGraph = createKnowledgeGraph();

  // Phase 1: Scan repository filesystem
  process.stderr.write('[nexus] Phase 1: Scanning filesystem...\n');
  const reports = new Map<string, GraphIndexFileReport>();
  const files = await walkRepositoryPaths(
    repoPath,
    onProgress,
    (report) => reports.set(report.path, report),
    options?.includedRepositories,
  );
  const scannedFiles = new Map(files.map((file) => [file.path, file]));
  process.stderr.write(`[nexus] Found ${files.length} files\n`);
  endPhase('scan');

  // Mode decision (T12315). Extraction is reused only where it is provably what
  // re-parsing would produce; everything downstream of extraction always reruns.
  const fingerprint = options?.publishGraph ? computeExtractorFingerprint() : null;
  let mode: 'incremental' | 'full' = 'full';
  let reason = options?.fullReason ?? 'full rebuild requested';
  let changedFiles = 0;
  let addedFiles = 0;
  let deletedFiles = 0;
  const reusedExtractions = new Map<string, FileExtraction>();
  let cachedPaths: string[] = [];
  if (isIncremental) {
    const readableDb = db as NexusDbReadInsert;
    const indexedHashes = await getIndexedFileHashes(projectId, readableDb, tables);
    for (const file of files) {
      const previous = indexedHashes.get(file.path);
      if (previous === undefined) addedFiles++;
      else if (!file.contentHash || previous !== file.contentHash) changedFiles++;
    }
    const current = new Set(files.map((file) => file.path));
    for (const indexedPath of indexedHashes.keys()) {
      if (!current.has(indexedPath)) deletedFiles++;
    }
    const differing = changedFiles + addedFiles + deletedFiles;
    const denominator = Math.max(1, indexedHashes.size, files.length);
    const maxRatio = options?.maxIncrementalChangeRatio ?? DEFAULT_MAX_INCREMENTAL_CHANGE_RATIO;

    const currentBuild = fingerprint !== null && options?.publishedFingerprint === fingerprint;
    if (indexedHashes.size === 0) {
      reason = 'no previous index to reuse';
    } else if (differing === 0 && !currentBuild) {
      reason = fingerprint
        ? 'no source changed, but the published generation was produced by a different extractor build'
        : 'no source changed, but the extractor build could not be fingerprinted to prove the published generation current';
    } else if (differing === 0) {
      process.stderr.write(
        '[nexus] Incremental: no source fingerprint changes; returning existing graph statistics.\n',
      );
      // Return stats from existing index (no writes needed)
      const existingNodeCount = (await readableDb.select().from(tables.nexusNodes)).length;
      const existingRelationCount = (await readableDb.select().from(tables.nexusRelations)).length;
      endPhase('compare');
      return {
        nodeCount: existingNodeCount,
        relationCount: existingRelationCount,
        fileCount: files.length,
        durationMs: Date.now() - startTime,
        extendsCount: 0,
        implementsCount: 0,
        callsTier1Count: 0,
        callsTier2aCount: 0,
        callsTier3Count: 0,
        hasMethodCount: 0,
        hasPropertyCount: 0,
        accessesTier1Count: 0,
        accessesTier3Count: 0,
        communityCount: 0,
        communityModularity: 0,
        processCount: 0,
        crossCommunityProcessCount: 0,
        summary: {
          mode: 'unchanged',
          reason: `all ${files.length} files match the published generation`,
          changedFiles: 0,
          addedFiles: 0,
          deletedFiles: 0,
          parsedFiles: 0,
          reusedFiles: 0,
          resolvedFiles: 0,
          phaseMs,
        },
      };
    } else if (differing / denominator > maxRatio) {
      reason =
        `${differing} of ${denominator} files differ from the published generation ` +
        `(${Math.round((differing / denominator) * 100)}%), above the ` +
        `${Math.round(maxRatio * 100)}% incremental threshold`;
    } else if (!fingerprint) {
      reason = options?.publishGraph
        ? 'the extractor build could not be fingerprinted, so no cached extraction is provably current'
        : 'no atomic publisher was supplied, so no parse cache is maintained';
    } else if (!options?.loadParseCache) {
      reason = 'the caller supplied no parse cache';
    } else {
      endPhase('compare');
      const entries = await options.loadParseCache();
      endPhase('cacheRead');
      cachedPaths = entries.map((entry) => entry.path);
      const matching = entries.filter((entry) => entry.fingerprint === fingerprint);
      if (entries.length === 0) {
        reason = 'no parse cache was committed with the previous generation';
      } else if (matching.length === 0) {
        reason =
          'the extractor build changed since the cached parse, so no cached extraction is current';
      } else {
        for (const entry of matching) {
          const scanned = scannedFiles.get(entry.path);
          if (!scanned?.contentHash || scanned.contentHash !== entry.contentHash) continue;
          try {
            reusedExtractions.set(entry.path, decodeParseCacheEntry(entry, publicationGeneration));
          } catch (error) {
            // An undecodable entry is re-parsed, never trusted.
            process.stderr.write(
              `[nexus] Incremental: cached extraction for ${entry.path} is unreadable (${error instanceof Error ? error.message : String(error)}); re-parsing it.\n`,
            );
          }
        }
        endPhase('cacheDecode');
        mode = 'incremental';
        reason =
          `${changedFiles} changed, ${addedFiles} added, ${deletedFiles} deleted of ` +
          `${indexedHashes.size} previously indexed files`;
      }
    }
    process.stderr.write(
      `[nexus] ${mode === 'incremental' ? 'Incremental' : 'Full rebuild'}: ${reason}\n`,
    );
    endPhase('compare');
  }

  // Phase 2: Build File + Folder nodes with CONTAINS edges
  // Include all files so the replacement graph has complete structure.
  process.stderr.write('[nexus] Phase 2: Building file structure...\n');
  processStructure(files, graph);

  // Phase 3a: Build import resolution context (suffix index + tsconfig aliases)
  // Built once here and reused across all files in the repository so the
  // suffix index (~O(files × path_depth)) is not rebuilt per file.
  //
  // The ResolutionContext owns the SymbolTable and NamedImportMap — both are
  // passed into runParseLoop by reference so the parse loop populates them
  // in-place. After the loop, heritage and call resolution use the same
  // context without any data copying.
  process.stderr.write('[nexus] Phase 3a: Building import resolution context...\n');
  const resolutionCtx = createResolutionContext();
  const symbolTable = resolutionCtx.symbols;
  const namedImportMap = resolutionCtx.namedImportMap;
  const importCtx = buildImportResolutionContext(files.map((f) => f.path));
  const tsconfigPaths = await loadTsconfigPaths(repoPath);
  if (tsconfigPaths) {
    process.stderr.write(`[nexus] Loaded tsconfig paths: ${tsconfigPaths.aliases.size} aliases\n`);
  }
  const workspacePackageMap = await loadWorkspacePackages(repoPath, importCtx.allFilePaths);
  importCtx.workspacePackageMap = workspacePackageMap;
  if (workspacePackageMap.size > 0) {
    process.stderr.write(
      `[nexus] Loaded workspace packages: ${workspacePackageMap.size} entries\n`,
    );
  }
  endPhase('structure');

  // Phase 3: Parse loop — extract symbols, imports, heritage, calls, then
  // resolve imports and barrels over the MERGED extraction of every file.
  process.stderr.write('[nexus] Phase 3: Parsing files...\n');
  const cacheUpserts: GraphParseCacheEntry[] = [];
  const { allHeritage, allCalls, allAccesses, barrelMap, parsedFileCount, reusedFileCount } =
    await runParseLoop(files, graph, symbolTable, importCtx, repoPath, {
      tsconfigPaths,
      namedImportMap,
      publicationGeneration,
      onProgress,
      parserLimits: options?.parserLimits,
      parserExecution: options?.parserExecution,
      reusedExtractions,
      onFileExtracted: fingerprint
        ? (file) => {
            const contentHash = scannedFiles.get(file.path)?.contentHash;
            if (contentHash)
              cacheUpserts.push(
                encodeParseCacheEntry(file, contentHash, fingerprint, publicationGeneration),
              );
          }
        : undefined,
      onFileReport: (report) => {
        const file = scannedFiles.get(report.path);
        reports.set(report.path, {
          ...report,
          mtimeMs: file?.mtimeMs,
          size: file?.size,
          contentHash: file?.contentHash,
        });
      },
    });
  if (mode === 'incremental') {
    process.stderr.write(
      `[nexus] Incremental: parsed ${parsedFileCount} file(s), reused ${reusedFileCount} cached extraction(s); resolving all ${parsedFileCount + reusedFileCount} against the merged symbol table\n`,
    );
  }
  endPhase('parse');

  // Phase 3c: Heritage resolution — emit EXTENDS + IMPLEMENTS edges
  // Uses resolutionCtx (fully populated after parse loop) for parent type lookup.
  process.stderr.write('[nexus] Phase 3c: Resolving heritage...\n');
  const heritageResult = processHeritage(allHeritage, graph, resolutionCtx);
  process.stderr.write(
    `[nexus] Heritage: ${heritageResult.extendsCount} extends, ${heritageResult.implementsCount} implements, ${heritageResult.methodOverridesCount} method_overrides, ${heritageResult.methodImplementsCount} method_implements, ${heritageResult.skippedCount} skipped\n`,
  );

  // Build HeritageMap from accumulated records (for future virtual dispatch)
  const heritageMap = buildHeritageMap(allHeritage, resolutionCtx);
  void heritageMap; // Available for future virtual-dispatch wave

  // Phase 3e: Call resolution — emit CALLS + HAS_METHOD + HAS_PROPERTY edges
  // Pass barrelMap so Tier 2a can trace imports through barrel re-export chains (T617).
  process.stderr.write('[nexus] Phase 3e: Resolving calls...\n');
  const callResult = await resolveCalls(allCalls, graph, symbolTable, namedImportMap, barrelMap);
  process.stderr.write(
    `[nexus] Calls: tier1=${callResult.tier1Count}, tier2a=${callResult.tier2aCount}, tier3=${callResult.tier3Count}, unresolved=${callResult.unresolvedCount}\n`,
  );
  process.stderr.write(
    `[nexus] Class members: has_method=${callResult.hasMethodCount}, has_property=${callResult.hasPropertyCount}\n`,
  );

  // Phase 3f: Access resolution — emit ACCESSES edges (T1837)
  // Runs after call resolution so the SymbolTable is fully populated with all
  // class members and properties. Same-file and global tiers are used.
  process.stderr.write('[nexus] Phase 3f: Resolving member accesses...\n');
  const accessResult = await resolveAccesses(
    allAccesses,
    graph,
    symbolTable,
    namedImportMap,
    barrelMap,
  );
  process.stderr.write(
    `[nexus] Accesses: tier1=${accessResult.tier1Count}, tier2a=${accessResult.tier2aCount}, tier3=${accessResult.tier3Count}, unresolved=${accessResult.unresolvedCount}\n`,
  );

  const referenceReports = [
    ...callResult.references,
    ...accessResult.references,
    ...retainAnalyzedReferences(graph, allCalls, allAccesses),
  ];
  if (referenceReports.length > 0) {
    process.stderr.write(
      `[nexus] Reference limitations: ${referenceReports.length} unresolved or unmodeled static sites retained with available evidence.\n`,
    );
  }
  endPhase('resolve');

  // Phase 5: Community detection (Louvain)
  process.stderr.write('[nexus] Phase 5: Detecting communities...\n');
  const communityResult = await detectCommunities(graph);
  process.stderr.write(
    `[nexus] Communities: ${communityResult.stats.totalCommunities} detected, modularity=${communityResult.stats.modularity.toFixed(3)}, nodes=${communityResult.stats.nodesProcessed}\n`,
  );
  endPhase('communities');

  // Phase 6: Process (execution flow) detection
  process.stderr.write('[nexus] Phase 6: Detecting execution flows...\n');
  const processResult = await detectProcesses(graph, communityResult.memberships);
  process.stderr.write(
    `[nexus] Processes: ${processResult.stats.totalProcesses} flows, cross-community=${processResult.stats.crossCommunityCount}, avg-steps=${processResult.stats.avgStepCount}\n`,
  );
  endPhase('flows');

  // Flush all nodes and relations to Drizzle
  process.stderr.write('[nexus] Flushing to database...\n');
  options?.parserLimits?.signal?.throwIfAborted();
  if (options?.publishGraph) {
    // T12313: refusing the whole generation over individual unparseable files
    // meant a repository containing ANY of them could never be indexed at all.
    // Measured on a 3 499-file project: two files the parser rejected — both
    // of which `tsc` accepts as syntactically valid — discarded every other
    // file's symbols and left the caller with no index and no way forward.
    //
    // An index missing two files is far more useful than no index, PROVIDED
    // the gap is stated rather than implied. The generation is published with
    // the unparsed files recorded and reported; silence about a gap is the
    // failure this project keeps fixing, and a loud refusal is its mirror
    // image rather than its remedy.
    const failed = [...reports.values()].filter((report) => report.status === 'failed');
    if (failed.length > 0) {
      const ratio = failed.length / Math.max(1, reports.size);
      // A systemic failure differs in kind from a few awkward files: if most of
      // the repository will not parse, the generation would misrepresent it.
      if (ratio > UNPARSED_FILE_REFUSAL_RATIO) {
        throw new Error(
          `Index generation failed for ${failed.length} of ${reports.size} file(s) — more than ` +
            `${Math.round(UNPARSED_FILE_REFUSAL_RATIO * 100)}% of the repository, so the ` +
            `generation would misrepresent it and the previous graph is retained: ${failed
              .map((report) => `${report.path}: ${report.reason}`)
              .join('; ')}`,
        );
      }
      process.stderr.write(
        `[nexus] ${failed.length} of ${reports.size} file(s) could not be parsed and are ABSENT ` +
          `from this index; every other file was indexed. Symbols defined in them will not be ` +
          `found:\n${failed.map((report) => `  ${report.path}: ${report.reason}`).join('\n')}\n`,
      );
    }
    // Refuse a generation built from files edited, removed, or renamed while
    // parsing. Its timestamp must never make mixed source revisions look fresh.
    const finalScanFailures: GraphIndexFileReport[] = [];
    const currentFiles = await walkRepositoryPaths(
      repoPath,
      undefined,
      (report) => {
        if (report.status === 'failed') finalScanFailures.push(report);
      },
      options.includedRepositories,
    );
    const currentPaths = new Set(currentFiles.map((file) => file.path));
    const changedPaths = [
      ...currentFiles
        .filter((file) => {
          const original = scannedFiles.get(file.path);
          return !original || original.contentHash !== file.contentHash;
        })
        .map((file) => file.path),
      ...files.filter((file) => !currentPaths.has(file.path)).map((file) => file.path),
      ...finalScanFailures.map((file) => file.path),
    ];
    if (changedPaths.length > 0) {
      throw new Error(
        `Source files changed during indexing; previous graph retained: ${changedPaths.slice(0, 20).join(', ')}${changedPaths.length > 20 ? ` (and ${changedPaths.length - 20} more)` : ''}`,
      );
    }
    endPhase('verify');
    const publication = graph.preparePublication();
    publication.generation = publicationGeneration;
    publication.assessment = {
      generation: publicationGeneration,
      references: referenceReports,
      ...(sourceRoots ? { sourceRoots } : {}),
      sourceRoot: repoPath,
      includedRepositories: [...(options.includedRepositories ?? [])],
      assessedRevision: options.assessedRevision ?? null,
      assessedAt: new Date(startTime).toISOString(),
      files: [...reports.values()],
    };
    publication.parseCache = buildParseCacheUpdate(
      fingerprint,
      mode,
      cacheUpserts,
      reusedExtractions,
      cachedPaths,
    );
    options.parserLimits?.signal?.throwIfAborted();
    await options.publishGraph(publication);
  } else {
    await graph.flush(projectId, db, tables);
  }
  endPhase('publish');

  const durationMs = Date.now() - startTime;
  process.stderr.write(
    `[nexus] Pipeline complete: ${graph.nodes.size} nodes, ${graph.relations.length} relations in ${durationMs}ms (${mode})\n`,
  );

  return {
    nodeCount: graph.nodes.size,
    relationCount: graph.relations.length,
    fileCount: files.length,
    durationMs,
    files: [...reports.values()],
    references: referenceReports,
    extendsCount: heritageResult.extendsCount,
    implementsCount: heritageResult.implementsCount,
    callsTier1Count: callResult.tier1Count,
    callsTier2aCount: callResult.tier2aCount,
    callsTier3Count: callResult.tier3Count,
    hasMethodCount: callResult.hasMethodCount,
    hasPropertyCount: callResult.hasPropertyCount,
    accessesTier1Count: accessResult.tier1Count,
    accessesTier3Count: accessResult.tier3Count,
    communityCount: communityResult.stats.totalCommunities,
    communityModularity: communityResult.stats.modularity,
    processCount: processResult.stats.totalProcesses,
    crossCommunityProcessCount: processResult.stats.crossCommunityCount,
    summary: {
      mode,
      reason,
      changedFiles,
      addedFiles,
      deletedFiles,
      parsedFiles: parsedFileCount,
      reusedFiles: reusedFileCount,
      resolvedFiles: parsedFileCount + reusedFileCount,
      phaseMs,
    },
  };
}

/**
 * Derive the parse-cache mutation to commit with a generation.
 *
 * A full rebuild replaces the cache wholesale. An incremental run upserts what
 * it parsed and deletes every previously cached path it neither reused nor
 * re-parsed successfully (deleted files, files that now fail, entries from an
 * older extractor build), so the committed cache describes exactly this
 * generation's successfully extracted files.
 */
function buildParseCacheUpdate(
  fingerprint: string | null,
  mode: 'incremental' | 'full',
  upserts: GraphParseCacheEntry[],
  reused: ReadonlyMap<string, FileExtraction>,
  cachedPaths: readonly string[],
): GraphParseCacheUpdate {
  // Without a fingerprint nothing can be proven current; clear rather than keep.
  if (!fingerprint) return { fingerprint: '', reset: true, upserts: [], deletePaths: [] };
  if (mode === 'full') return { fingerprint, reset: true, upserts, deletePaths: [] };
  const written = new Set(upserts.map((entry) => entry.path));
  return {
    fingerprint,
    reset: false,
    upserts,
    deletePaths: cachedPaths.filter((path) => !reused.has(path) && !written.has(path)),
  };
}
