/**
 * TypeScript import resolution engine for the code intelligence pipeline.
 *
 * Resolves raw TypeScript/JavaScript import paths to concrete repository file
 * paths and emits `imports` edges in the KnowledgeGraph. Handles:
 *
 * - Relative imports: `'./foo'` → `foo.ts`, `foo.tsx`, `foo/index.ts`
 * - Barrel exports:   `'./models'` → `./models/index.ts`
 * - tsconfig aliases: `'@cleocode/contracts'` → `packages/contracts/src/index.ts`
 * - node_modules:     `'drizzle-orm'` → skipped (marked as external)
 *
 * Named import tracking: when a file contains `import { Foo } from './bar'`,
 * the `namedImportMap` records which local names map to which source file and
 * exported symbol. This is consumed by the resolution context (Tier 2a).
 *
 * Ported from GitNexus `src/core/ingestion/import-processor.ts` and
 * `src/core/ingestion/import-resolvers/standard.ts`, adapted to:
 * - Remove all non-TypeScript/JavaScript language paths
 * - Remove tree-sitter AST parsing (T534 wires that separately)
 * - Use CLEO KnowledgeGraph contract (source/target instead of sourceId/targetId)
 * - Accept pre-extracted import records for the pipeline fast-path
 *
 * @task T533
 * @module pipeline/import-processor
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import type { KnowledgeGraph } from './knowledge-graph.js';
import {
  buildSuffixIndex,
  type SuffixIndex,
  suffixResolve,
  tryResolveWithExtensions,
} from './suffix-index.js';

// ---------------------------------------------------------------------------
// Tsconfig path alias types
// ---------------------------------------------------------------------------

/**
 * Parsed TypeScript path alias configuration from tsconfig.json.
 */
export interface TsconfigPaths {
  /** Map of alias prefix → target prefix (e.g. `"@/"` → `"src/"`) */
  aliases: Map<string, string>;
  /** Base URL for path resolution (relative to repo root, e.g. `"."`) */
  baseUrl: string;
}

// ---------------------------------------------------------------------------
// Named import types
// ---------------------------------------------------------------------------

/**
 * A single named import binding: the local alias and the original exported name.
 *
 * For `import { User as U } from './models'`:
 *   - `local` = `"U"`
 *   - `exported` = `"User"`
 */
export interface NamedImportBinding {
  /** The local name used in this file. */
  local: string;
  /** The exported name in the source module. */
  exported: string;
}

/**
 * Pre-extracted import record from the AST parse phase (T534).
 *
 * Allows the import processor to operate without re-running tree-sitter
 * when parse results are available from a prior phase.
 */
export interface ExtractedImport {
  /** Relative file path that contains the import statement. */
  filePath: string;
  /** Raw import path string as it appears in source (e.g. `"./models/user"`). */
  rawImportPath: string;
  /** Named bindings from a destructured import, if any. */
  namedBindings?: NamedImportBinding[];
}

// ---------------------------------------------------------------------------
// Import resolution context
// ---------------------------------------------------------------------------

/**
 * Pre-built lookup structures for import resolution.
 *
 * Build once via `buildImportResolutionContext()`, then reuse across all
 * files in a pipeline run. Avoids rebuilding the suffix index per file.
 */
export interface ImportResolutionContext {
  /** Set of all known file paths for O(1) membership checks. */
  allFilePaths: Set<string>;
  /** Ordered list of all file paths. */
  allFileList: string[];
  /** Forward-slash-normalized version of `allFileList`. */
  normalizedFileList: string[];
  /** Pre-built suffix index for O(1) path suffix lookups. */
  index: SuffixIndex;
  /** Cache of previously resolved imports: `"sourceFile::importPath"` → result. */
  resolveCache: Map<string, string | null>;
}

/**
 * Build an ImportResolutionContext from a list of all repository file paths.
 *
 * @param allPaths - All file paths in the repository (relative to repo root)
 * @returns A pre-built context for use in `resolveTypescriptImport`
 */
export function buildImportResolutionContext(allPaths: string[]): ImportResolutionContext {
  const normalizedFileList = allPaths.map((p) => p.replace(/\\/g, '/'));
  const allFilePaths = new Set(allPaths);
  const index = buildSuffixIndex(normalizedFileList, allPaths);
  return {
    allFilePaths,
    allFileList: allPaths,
    normalizedFileList,
    index,
    resolveCache: new Map(),
  };
}

// ---------------------------------------------------------------------------
// Named import map type (for Tier 2a resolution)
// ---------------------------------------------------------------------------

/**
 * Named binding entry: tracks which source file and exported symbol a local
 * import name resolves to.
 *
 * For `import { User as U } from './models'`:
 *   - `sourcePath` = `"src/models/user.ts"`
 *   - `exportedName` = `"User"`
 */
export interface NamedImportEntry {
  /** Resolved file path of the import source. */
  sourcePath: string;
  /** Original exported name in the source file. */
  exportedName: string;
}

/**
 * Map of importing file path → (local name → source file + exported name).
 *
 * Used by the ResolutionContext for Tier 2a named-import resolution.
 *
 * Example:
 * ```
 * app.ts imports { User as U } from './models/user'
 * → namedImportMap.get('app.ts').get('U') === { sourcePath: 'src/models/user.ts', exportedName: 'User' }
 * ```
 */
export type NamedImportMap = Map<string, Map<string, NamedImportEntry>>;

/**
 * Map of importing file path → (module alias → resolved source file path).
 *
 * Tracks `import * as X from './utils'` style module-namespace imports.
 * e.g. `moduleAliasMap.get('app.ts')?.get('Utils') === 'src/utils/index.ts'`
 */
export type ModuleAliasMap = Map<string, Map<string, string>>;

// ---------------------------------------------------------------------------
// Resolve cache cap
// ---------------------------------------------------------------------------

/** Maximum resolve cache entries before partial eviction (20% oldest). */
const RESOLVE_CACHE_CAP = 100_000;

// ---------------------------------------------------------------------------
// Core TypeScript import resolver
// ---------------------------------------------------------------------------

/**
 * Resolve a raw TypeScript/JavaScript import path to a repository file path.
 *
 * Resolution order:
 * 1. Cache hit — return immediately
 * 2. tsconfig path alias rewriting (if `tsconfigPaths` is provided)
 * 3. Relative path resolution (`./` and `../`) with extension probing
 * 4. node_modules detection — return null (external dependency)
 * 5. Generic suffix matching via SuffixIndex (absolute/package imports)
 *
 * @param currentFile - The file that contains the import statement
 * @param importPath - The raw import path string from the AST
 * @param allFiles - Set of all known file paths for membership checks
 * @param allFileList - Ordered list of all file paths
 * @param normalizedFileList - Forward-slash-normalized file paths
 * @param resolveCache - Mutable cache shared across calls
 * @param tsconfigPaths - Parsed tsconfig path alias config, if available
 * @param index - Pre-built SuffixIndex for O(1) lookups
 * @returns Resolved relative file path, or null if unresolvable/external
 */
export function resolveTypescriptImport(
  currentFile: string,
  importPath: string,
  allFiles: Set<string>,
  allFileList: string[],
  normalizedFileList: string[],
  resolveCache: Map<string, string | null>,
  tsconfigPaths: TsconfigPaths | null,
  index?: SuffixIndex,
): string | null {
  const cacheKey = `${currentFile}::${importPath}`;
  if (resolveCache.has(cacheKey)) return resolveCache.get(cacheKey) ?? null;

  const cache = (result: string | null): string | null => {
    // Evict 20% of oldest entries when cap is reached
    if (resolveCache.size >= RESOLVE_CACHE_CAP) {
      const evictCount = Math.floor(RESOLVE_CACHE_CAP * 0.2);
      const iter = resolveCache.keys();
      for (let i = 0; i < evictCount; i++) {
        const key = iter.next().value;
        if (key !== undefined) resolveCache.delete(key);
      }
    }
    resolveCache.set(cacheKey, result);
    return result;
  };

  // 1. tsconfig path alias rewriting (only for non-relative, non-node_modules imports)
  if (tsconfigPaths && !importPath.startsWith('.')) {
    for (const [aliasPrefix, targetPrefix] of tsconfigPaths.aliases) {
      if (importPath.startsWith(aliasPrefix)) {
        const remainder = importPath.slice(aliasPrefix.length);
        const rewritten =
          tsconfigPaths.baseUrl === '.'
            ? targetPrefix + remainder
            : `${tsconfigPaths.baseUrl}/${targetPrefix}${remainder}`;

        // Try direct resolution from repo root
        const direct = tryResolveWithExtensions(rewritten, allFiles);
        if (direct) return cache(direct);

        // Try suffix matching as fallback
        const parts = rewritten.split('/').filter(Boolean);
        const suffixed = suffixResolve(parts, normalizedFileList, allFileList, index);
        if (suffixed) return cache(suffixed);
      }
    }
  }

  // 2. Relative path resolution (./ and ../)
  if (importPath.startsWith('.')) {
    const currentDir = currentFile.replace(/\\/g, '/').split('/').slice(0, -1);
    const parts = importPath.replace(/\\/g, '/').split('/');

    for (const part of parts) {
      if (part === '.') continue;
      if (part === '..') {
        currentDir.pop();
      } else {
        currentDir.push(part);
      }
    }

    const basePath = currentDir.join('/');
    return cache(tryResolveWithExtensions(basePath, allFiles));
  }

  // 3. node_modules / external package: skip (no resolution)
  // A non-relative, non-aliased import that does not start with a known
  // repository path is an external dependency. Return null to signal external.
  // We detect this heuristically: if the import contains no '/' or starts with
  // a scoped package '@', it is almost certainly an npm package.
  if (!importPath.includes('/') || importPath.startsWith('@')) {
    // Still try suffix resolution as last resort for scoped workspace packages
    const parts = importPath.split('/').filter(Boolean);
    const resolved = suffixResolve(parts, normalizedFileList, allFileList, index);
    return cache(resolved);
  }

  // 4. Generic absolute/package path: suffix matching
  const pathParts = importPath.split('/').filter(Boolean);
  return cache(suffixResolve(pathParts, normalizedFileList, allFileList, index));
}

// ---------------------------------------------------------------------------
// Graph edge helper
// ---------------------------------------------------------------------------

/**
 * Generate a stable node ID for a file node.
 *
 * Mirrors the convention used by the structure processor: `file:<relPath>`.
 */
function fileNodeId(filePath: string): string {
  return `file:${filePath.replace(/\\/g, '/')}`;
}

/**
 * Emit an `imports` edge in the KnowledgeGraph for a resolved import.
 */
function addImportEdge(graph: KnowledgeGraph, fromFile: string, toFile: string): void {
  graph.addRelation({
    source: fileNodeId(fromFile),
    target: fileNodeId(toFile),
    type: 'imports',
    confidence: 1.0,
    reason: 'static import',
  });
}

// ---------------------------------------------------------------------------
// Named import map population
// ---------------------------------------------------------------------------

/**
 * Record a named binding in the namedImportMap.
 *
 * If the same local name is imported from multiple source files (ambiguous),
 * the entry is deleted so resolution falls through to broader tiers.
 */
function recordNamedBinding(
  namedImportMap: NamedImportMap,
  importingFile: string,
  local: string,
  sourcePath: string,
  exportedName: string,
): void {
  if (!namedImportMap.has(importingFile)) {
    namedImportMap.set(importingFile, new Map());
  }
  const fileBindings = namedImportMap.get(importingFile)!;
  const existing = fileBindings.get(local);
  if (existing && existing.sourcePath !== sourcePath) {
    // Ambiguous — imported from multiple sources, remove so Tier 2a sees all candidates
    fileBindings.delete(local);
  } else {
    fileBindings.set(local, { sourcePath, exportedName });
  }
}

// ---------------------------------------------------------------------------
// Tsconfig loader
// ---------------------------------------------------------------------------

/**
 * Parse tsconfig.json (and fallback candidates) to extract TypeScript path
 * alias configuration.
 *
 * Tries `tsconfig.json`, `tsconfig.app.json`, and `tsconfig.base.json` in order.
 * Strips `// ...` and `/* ... *​/` JSON comments before parsing.
 *
 * @param repoRoot - Absolute path to the repository root
 * @returns Parsed TsconfigPaths, or null if no applicable tsconfig was found
 */
export async function loadTsconfigPaths(repoRoot: string): Promise<TsconfigPaths | null> {
  const candidates = ['tsconfig.json', 'tsconfig.app.json', 'tsconfig.base.json'];

  for (const filename of candidates) {
    try {
      const tsconfigPath = path.join(repoRoot, filename);
      const raw = await fs.readFile(tsconfigPath, 'utf-8');
      // Strip JSON comments for robustness (tsconfig files often use them)
      const stripped = raw.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
      const tsconfig = JSON.parse(stripped) as {
        compilerOptions?: {
          paths?: Record<string, string[]>;
          baseUrl?: string;
        };
      };
      const compilerOptions = tsconfig.compilerOptions;
      if (!compilerOptions?.paths) continue;

      const baseUrl = compilerOptions.baseUrl ?? '.';
      const aliases = new Map<string, string>();

      for (const [pattern, targets] of Object.entries(compilerOptions.paths)) {
        if (!Array.isArray(targets) || targets.length === 0) continue;
        const target = targets[0];
        if (typeof target !== 'string') continue;
        // Convert glob patterns: "@/*" -> "@/", "src/*" -> "src/"
        const aliasPrefix = pattern.endsWith('/*') ? pattern.slice(0, -1) : pattern;
        const targetPrefix = target.endsWith('/*') ? target.slice(0, -1) : target;
        aliases.set(aliasPrefix, targetPrefix);
      }

      if (aliases.size > 0) {
        return { aliases, baseUrl };
      }
    } catch {
      // File doesn't exist or isn't valid JSON — try next candidate
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Main import processor (fast-path: pre-extracted imports)
// ---------------------------------------------------------------------------

/**
 * Options for `processExtractedImports`.
 */
export interface ProcessImportsOptions {
  /** Pre-extracted import records from the AST parse phase (T534). */
  imports: ExtractedImport[];
  /** Graph to emit `imports` edges into. */
  graph: KnowledgeGraph;
  /** Pre-built import resolution context (from `buildImportResolutionContext`). */
  importCtx: ImportResolutionContext;
  /** Named import map to populate for Tier 2a resolution. */
  namedImportMap: NamedImportMap;
  /** Module alias map to populate for namespace imports. */
  moduleAliasMap?: ModuleAliasMap;
  /** Parsed tsconfig path aliases, if available. */
  tsconfigPaths: TsconfigPaths | null;
  /** Optional progress callback (invoked per file processed). */
  onProgress?: (current: number, total: number) => void;
}

/**
 * Process pre-extracted import records and emit `imports` edges.
 *
 * This is the pipeline fast-path: the AST parse phase (T534) extracts raw
 * import strings, then this function resolves them to file paths and writes
 * graph edges + named import map entries in one pass.
 *
 * @param options - Import processing options
 * @returns Total number of `imports` edges emitted to the graph
 */
export async function processExtractedImports(options: ProcessImportsOptions): Promise<number> {
  const { imports, graph, importCtx, namedImportMap, moduleAliasMap, tsconfigPaths, onProgress } =
    options;

  const { allFilePaths, allFileList, normalizedFileList, index, resolveCache } = importCtx;

  let edgesEmitted = 0;

  // Group by file for progress reporting
  const importsByFile = new Map<string, ExtractedImport[]>();
  for (const imp of imports) {
    let list = importsByFile.get(imp.filePath);
    if (!list) {
      list = [];
      importsByFile.set(imp.filePath, list);
    }
    list.push(imp);
  }

  const totalFiles = importsByFile.size;
  let filesProcessed = 0;

  for (const [filePath, fileImports] of importsByFile) {
    filesProcessed++;
    if (filesProcessed % 100 === 0) {
      onProgress?.(filesProcessed, totalFiles);
      // Yield to event loop periodically on large repos
      await Promise.resolve();
    }

    for (const imp of fileImports) {
      const resolved = resolveTypescriptImport(
        filePath,
        imp.rawImportPath,
        allFilePaths,
        allFileList,
        normalizedFileList,
        resolveCache,
        tsconfigPaths,
        index,
      );

      if (!resolved) continue;

      // Emit graph edge
      addImportEdge(graph, filePath, resolved);
      edgesEmitted++;

      // Populate named import map for Tier 2a resolution
      if (imp.namedBindings && imp.namedBindings.length > 0) {
        for (const binding of imp.namedBindings) {
          recordNamedBinding(namedImportMap, filePath, binding.local, resolved, binding.exported);
        }
      }

      // Populate module alias map (import * as X from './foo')
      // Named bindings with local === exported and a '*' pattern are namespace imports.
      // T534 will set a flag on the binding; for now we check a naming convention.
      if (moduleAliasMap && imp.namedBindings) {
        for (const binding of imp.namedBindings) {
          // A binding where exported === '*' signals a namespace import
          if (binding.exported === '*') {
            if (!moduleAliasMap.has(filePath)) {
              moduleAliasMap.set(filePath, new Map());
            }
            moduleAliasMap.get(filePath)!.set(binding.local, resolved);
          }
        }
      }
    }
  }

  onProgress?.(totalFiles, totalFiles);
  return edgesEmitted;
}

/**
 * Check if a file is directly inside a package directory identified by its suffix.
 *
 * Used by the resolution context for Go/C# directory-level import matching.
 *
 * @param filePath - Relative file path (forward slashes)
 * @param dirSuffix - Directory suffix including leading and trailing slashes
 */
export function isFileInPackageDir(filePath: string, dirSuffix: string): boolean {
  const normalized = '/' + filePath.replace(/\\/g, '/');
  if (!normalized.includes(dirSuffix)) return false;
  const afterDir = normalized.substring(normalized.indexOf(dirSuffix) + dirSuffix.length);
  return !afterDir.includes('/');
}
