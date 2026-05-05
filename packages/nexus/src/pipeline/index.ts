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
export type { ScannedFile } from './filesystem-walker.js';
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

import fs from 'node:fs/promises';
import { and, type Column, eq } from 'drizzle-orm';
import { resolveCalls } from './call-processor.js';
import { detectCommunities } from './community-processor.js';
import type { ScannedFile } from './filesystem-walker.js';
import { walkRepositoryPaths } from './filesystem-walker.js';
import { buildHeritageMap, processHeritage } from './heritage-processor.js';
import {
  buildImportResolutionContext,
  loadTsconfigPaths,
  loadWorkspacePackages,
} from './import-processor.js';
import type { KnowledgeGraph, NexusDbInsert, NexusTables } from './knowledge-graph.js';
import { createKnowledgeGraph } from './knowledge-graph.js';
import { runParseLoop } from './parse-loop.js';
import { detectProcesses } from './process-processor.js';
import { resolveAccesses } from './processors/access-processor.js';
import { createResolutionContext } from './resolution-context.js';
import { processStructure } from './structure-processor.js';

// ---------------------------------------------------------------------------
// Pipeline options
// ---------------------------------------------------------------------------

/**
 * Options for `runPipeline` controlling full vs. incremental execution.
 */
export interface PipelineOptions {
  /**
   * When `true`, only re-index files that have changed since the last
   * full or incremental index run. Uses file mtime comparison against
   * the `indexed_at` timestamp stored in `nexus_nodes`.
   *
   * Incremental mode:
   * 1. Reads all existing `nexus_nodes.file_path` + `indexed_at` rows for
   *    the project to build a map of `filePath → lastIndexedAt`.
   * 2. Scans the filesystem for current file mtimes.
   * 3. Identifies changed files (mtime > lastIndexedAt) and new files.
   * 4. Identifies deleted files (present in DB but absent from filesystem).
   * 5. Atomically deletes all nodes + relations whose `file_path` matches a
   *    changed-or-deleted file.
   * 6. Re-parses only the changed/new files.
   * 7. Runs heritage + call resolution on the full graph (needs complete
   *    picture because deferred calls cross file boundaries).
   *
   * @default false
   */
  incremental?: boolean;
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
  select: (fields?: Record<string, unknown>) => {
    from: (table: unknown) => {
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
}

// ---------------------------------------------------------------------------
// getIndexStats
// ---------------------------------------------------------------------------

/**
 * Return freshness statistics for the code intelligence index of a project.
 *
 * Safe to call even if the project has never been indexed — returns
 * `{ indexed: false, ... }` in that case.
 *
 * @param projectId - Project registry ID (same value passed to `runPipeline`)
 * @param repoPath - Absolute path to the repository root (used for mtime checks)
 * @param db - Drizzle database instance
 * @param tables - Drizzle table references
 */
export async function getIndexStats(
  projectId: string,
  repoPath: string,
  db: NexusDbReadInsert,
  tables: NexusTables,
): Promise<IndexStats> {
  type NodeRow = { filePath: string | null; indexedAt: string };

  // Column accessors — tables are typed as unknown to decouple from @cleocode/core;
  // cast to column-like objects for use with Drizzle's eq() helper.
  type DrizzleCol = { name: string; table: unknown };
  const nodesTable = tables.nexusNodes as Record<string, DrizzleCol>;
  const relationsTable = tables.nexusRelations as Record<string, DrizzleCol>;

  let rows: NodeRow[] = [];
  try {
    const raw = await db
      .select({
        filePath: nodesTable['filePath'],
        indexedAt: nodesTable['indexedAt'],
      })
      .from(tables.nexusNodes)
      .where(eq(nodesTable['projectId'] as unknown as Column, projectId));
    rows = raw as NodeRow[];
  } catch {
    // Table may not exist yet
    return {
      indexed: false,
      nodeCount: 0,
      relationCount: 0,
      fileCount: 0,
      lastIndexedAt: null,
      staleFileCount: -1,
    };
  }

  if (rows.length === 0) {
    return {
      indexed: false,
      nodeCount: 0,
      relationCount: 0,
      fileCount: 0,
      lastIndexedAt: null,
      staleFileCount: -1,
    };
  }

  // Count distinct file nodes (filePath !== null)
  const fileRows = rows.filter((r) => r.filePath !== null);
  const fileCount = fileRows.length;

  // Find most recent indexedAt
  let lastIndexedAt: string | null = null;
  for (const row of rows) {
    if (row.indexedAt && (!lastIndexedAt || row.indexedAt > lastIndexedAt)) {
      lastIndexedAt = row.indexedAt;
    }
  }

  // Count relations
  let relationCount = 0;
  try {
    const relRows = await db
      .select({ id: relationsTable['id'] })
      .from(tables.nexusRelations)
      .where(eq(relationsTable['projectId'] as unknown as Column, projectId));
    relationCount = (relRows as unknown[]).length;
  } catch {
    // ignore
  }

  // Check stale files — compare filesystem mtime against indexedAt
  let staleFileCount = 0;
  const filePathMap = new Map<string, string>();
  for (const row of fileRows) {
    if (row.filePath) filePathMap.set(row.filePath, row.indexedAt);
  }

  for (const [relPath, indexedAt] of filePathMap) {
    const absPath = relPath.startsWith('/') ? relPath : `${repoPath}/${relPath}`;
    try {
      const stat = await fs.stat(absPath);
      const mtimeIso = stat.mtime.toISOString();
      if (mtimeIso > indexedAt) staleFileCount++;
    } catch {
      // File deleted — counts as stale
      staleFileCount++;
    }
  }

  return {
    indexed: true,
    nodeCount: rows.length,
    relationCount,
    fileCount,
    lastIndexedAt,
    staleFileCount,
  };
}

// ---------------------------------------------------------------------------
// Incremental mode helpers
// ---------------------------------------------------------------------------

/** Internal: get existing indexed file paths and their indexedAt timestamps. */
async function getIndexedFileMtimes(
  projectId: string,
  db: NexusDbReadInsert,
  tables: NexusTables,
): Promise<Map<string, string>> {
  type Row = { filePath: string | null; indexedAt: string };
  type DrizzleCol = { name: string; table: unknown };
  const nodesTable = tables.nexusNodes as Record<string, DrizzleCol>;
  try {
    const rows = await db
      .select({
        filePath: nodesTable['filePath'],
        indexedAt: nodesTable['indexedAt'],
      })
      .from(tables.nexusNodes)
      .where(eq(nodesTable['projectId'] as unknown as Column, projectId));
    const map = new Map<string, string>();
    for (const row of rows as Row[]) {
      if (row.filePath) map.set(row.filePath, row.indexedAt);
    }
    return map;
  } catch {
    return new Map();
  }
}

/**
 * Internal: delete all nodes and relations whose filePath matches a changed
 * or deleted file, wrapped in a transaction for atomicity.
 */
async function deleteStaleEntries(
  projectId: string,
  stalePaths: string[],
  db: NexusDbReadInsert,
  tables: NexusTables,
): Promise<void> {
  if (stalePaths.length === 0) return;

  type DrizzleCol = { name: string; table: unknown };
  const nodesTable = tables.nexusNodes as Record<string, DrizzleCol>;
  const relationsTable = tables.nexusRelations as Record<string, DrizzleCol>;

  // Delete in chunks to avoid SQLite parameter limits (999 per statement)
  const CHUNK = 200;
  for (let i = 0; i < stalePaths.length; i += CHUNK) {
    const chunk = stalePaths.slice(i, i + CHUNK);
    // Delete nodes for these file paths
    for (const filePath of chunk) {
      try {
        await (db as NexusDbReadInsert)
          .delete(tables.nexusNodes)
          .where(
            and(
              eq(nodesTable['projectId'] as unknown as Column, projectId),
              eq(nodesTable['filePath'] as unknown as Column, filePath),
            ),
          );
      } catch {
        // ignore — node may not exist for this file
      }
    }
    // Relations are soft-referenced — orphaned relations are pruned on next full index.
    // For incremental, we only delete relations where sourceId starts with a stale path.
    for (const filePath of chunk) {
      try {
        await (db as NexusDbReadInsert)
          .delete(tables.nexusRelations)
          .where(
            and(
              eq(relationsTable['projectId'] as unknown as Column, projectId),
              eq(relationsTable['sourceId'] as unknown as Column, filePath),
            ),
          );
      } catch {
        // ignore
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Pipeline entry point
// ---------------------------------------------------------------------------

/**
 * Run the full code intelligence ingestion pipeline for a repository.
 *
 * Executes Phase 1 (filesystem walk) and Phase 2 (structure processing),
 * then flushes all nodes and relations to the database.
 *
 * When `options.incremental` is `true`, only re-indexes files that have
 * changed since the last run (detected via mtime comparison). Unchanged
 * files are left in the database as-is.
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
  const startTime = Date.now();
  const isIncremental = options?.incremental === true;
  const graph: KnowledgeGraph = createKnowledgeGraph();

  // Phase 1: Scan repository filesystem
  process.stderr.write('[nexus] Phase 1: Scanning filesystem...\n');
  const files = await walkRepositoryPaths(repoPath, onProgress);
  process.stderr.write(`[nexus] Found ${files.length} files\n`);

  // Incremental mode: detect changed/new/deleted files, prune stale DB entries,
  // then proceed with only the changed/new subset.
  let filesToParse: ScannedFile[] = files;
  if (isIncremental) {
    process.stderr.write('[nexus] Incremental mode: computing changed files...\n');
    const readableDb = db as NexusDbReadInsert;
    const indexedMtimes = await getIndexedFileMtimes(projectId, readableDb, tables);

    // If no files indexed yet, run full parse
    if (indexedMtimes.size > 0) {
      // Build current filesystem mtime map
      const currentMtimes = new Map<string, string>();
      for (const file of files) {
        const absPath = file.path.startsWith('/') ? file.path : `${repoPath}/${file.path}`;
        try {
          const stat = await fs.stat(absPath);
          currentMtimes.set(file.path, stat.mtime.toISOString());
        } catch {
          // File disappeared between walk and stat — skip
        }
      }

      // Find changed/new files
      const changedPaths = new Set<string>();
      for (const file of files) {
        const currentMtime = currentMtimes.get(file.path);
        if (!currentMtime) continue; // Couldn't stat — skip
        const indexedAt = indexedMtimes.get(file.path);
        if (!indexedAt || currentMtime > indexedAt) {
          changedPaths.add(file.path);
        }
      }

      // Find deleted files (in DB but not in current filesystem)
      const currentFileSet = new Set(files.map((f) => f.path));
      for (const indexedPath of indexedMtimes.keys()) {
        if (!currentFileSet.has(indexedPath)) {
          changedPaths.add(indexedPath);
        }
      }

      process.stderr.write(
        `[nexus] Incremental: ${changedPaths.size} changed/new/deleted files (${indexedMtimes.size} previously indexed)\n`,
      );

      if (changedPaths.size === 0) {
        process.stderr.write('[nexus] Incremental: no changes detected — index is up to date.\n');
        // Return stats from existing index (no writes needed)
        let existingNodeCount = 0;
        let existingRelationCount = 0;
        try {
          type DrizzleCol = { name: string; table: unknown };
          const nodesT = tables.nexusNodes as Record<string, DrizzleCol>;
          const relationsT = tables.nexusRelations as Record<string, DrizzleCol>;
          const nr = await readableDb
            .select()
            .from(tables.nexusNodes)
            .where(eq(nodesT['projectId'] as unknown as Column, projectId));
          existingNodeCount = (nr as unknown[]).length;
          const rr = await readableDb
            .select()
            .from(tables.nexusRelations)
            .where(eq(relationsT['projectId'] as unknown as Column, projectId));
          existingRelationCount = (rr as unknown[]).length;
        } catch {
          /* ignore */
        }
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
        };
      }

      // Delete stale nodes + relations for changed/deleted files (atomic)
      process.stderr.write('[nexus] Incremental: pruning stale index entries...\n');
      await deleteStaleEntries(projectId, [...changedPaths], readableDb, tables);

      // Restrict parse to changed/new files only
      filesToParse = files.filter((f) => changedPaths.has(f.path));
      process.stderr.write(`[nexus] Incremental: re-parsing ${filesToParse.length} files\n`);
    } else {
      process.stderr.write('[nexus] Incremental: no existing index — running full parse\n');
    }
  }

  // Phase 2: Build File + Folder nodes with CONTAINS edges
  // Use all files for structure (needed for folder nodes), but only parse changed files.
  process.stderr.write('[nexus] Phase 2: Building file structure...\n');
  processStructure(isIncremental ? filesToParse : files, graph);

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
  // Use all files for import context so cross-file resolution works in incremental mode.
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

  // Phase 3: Parse loop — extract symbols, imports, heritage, calls
  // In incremental mode, only `filesToParse` (the changed/new subset) is parsed.
  // Heritage + call resolution still runs on the full in-memory graph so
  // cross-file call edges across the changed/unchanged boundary are preserved.
  process.stderr.write('[nexus] Phase 3: Parsing files...\n');
  const { allHeritage, allCalls, allAccesses, barrelMap } = await runParseLoop(
    filesToParse,
    graph,
    symbolTable,
    importCtx,
    repoPath,
    { tsconfigPaths, namedImportMap, onProgress },
  );

  // Phase 3c: Heritage resolution — emit EXTENDS + IMPLEMENTS edges
  // Uses resolutionCtx (fully populated after parse loop) for parent type lookup.
  process.stderr.write('[nexus] Phase 3c: Resolving heritage...\n');
  const heritageResult = processHeritage(allHeritage, graph, resolutionCtx);
  process.stderr.write(
    `[nexus] Heritage: ${heritageResult.extendsCount} extends, ${heritageResult.implementsCount} implements, ${heritageResult.methodOverridesCount} method_overrides, ${heritageResult.skippedCount} skipped\n`,
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
  const accessResult = await resolveAccesses(allAccesses, graph, symbolTable);
  process.stderr.write(
    `[nexus] Accesses: tier1=${accessResult.tier1Count}, tier3=${accessResult.tier3Count}, unresolved=${accessResult.unresolvedCount}\n`,
  );

  // Phase 5: Community detection (Louvain)
  process.stderr.write('[nexus] Phase 5: Detecting communities...\n');
  const communityResult = await detectCommunities(graph);
  process.stderr.write(
    `[nexus] Communities: ${communityResult.stats.totalCommunities} detected, modularity=${communityResult.stats.modularity.toFixed(3)}, nodes=${communityResult.stats.nodesProcessed}\n`,
  );

  // Phase 6: Process (execution flow) detection
  process.stderr.write('[nexus] Phase 6: Detecting execution flows...\n');
  const processResult = await detectProcesses(graph, communityResult.memberships);
  process.stderr.write(
    `[nexus] Processes: ${processResult.stats.totalProcesses} flows, cross-community=${processResult.stats.crossCommunityCount}, avg-steps=${processResult.stats.avgStepCount}\n`,
  );

  // Flush all nodes and relations to Drizzle
  process.stderr.write('[nexus] Flushing to database...\n');
  await graph.flush(projectId, db, tables);

  const durationMs = Date.now() - startTime;
  process.stderr.write(
    `[nexus] Pipeline complete: ${graph.nodes.size} nodes, ${graph.relations.length} relations in ${durationMs}ms\n`,
  );

  return {
    nodeCount: graph.nodes.size,
    relationCount: graph.relations.length,
    fileCount: files.length,
    durationMs,
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
  };
}
