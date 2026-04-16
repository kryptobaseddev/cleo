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
  /**
   * Workspace package name → resolved entry file path (relative to repo root).
   *
   * Built by `loadWorkspacePackages` from `packages/*\/package.json` files.
   * Maps e.g. `"@cleocode/core"` → `"packages/core/src/index.ts"`.
   * Optional: if absent, workspace package resolution is skipped.
   */
  workspacePackageMap?: Map<string, string>;
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

/**
 * Shape of a package.json `exports` sub-path entry.
 *
 * Supports the conditional-export object form as well as bare string form.
 * e.g. `"./internal": { "types": "./dist/internal.d.ts", "import": "./dist/internal.js" }`
 */
type PackageExportsEntry =
  | string
  | {
      types?: string;
      import?: string;
      require?: string;
      default?: string;
    };

/**
 * Derive the TypeScript source file path from a dist output path.
 *
 * Performs the inverse of the TypeScript build transform:
 * - `./dist/internal.js`       → `<pkgDir>/src/internal.ts`
 * - `./dist/conduit/index.js`  → `<pkgDir>/src/conduit/index.ts`
 * - `./dist/index.d.ts`        → `<pkgDir>/src/index.ts`
 *
 * Returns null when the path does not follow the `dist/` layout convention.
 *
 * @param distPath - dist-relative path from the exports field (e.g. `"./dist/internal.js"`)
 * @param pkgDir - Package directory prefix relative to repo root (e.g. `"packages/core"`)
 * @param allFilePaths - Set of all known repo-relative file paths (for existence check)
 */
function distPathToSourcePath(
  distPath: string,
  pkgDir: string,
  allFilePaths: Set<string>,
): string | null {
  // Strip leading "./"
  const normalized = distPath.startsWith('./') ? distPath.slice(2) : distPath;

  // Only handle dist/ paths
  if (!normalized.startsWith('dist/')) return null;

  const relativeToDist = normalized.slice('dist/'.length); // e.g. "internal.js"

  // Try TypeScript source extension variants in priority order
  const base = relativeToDist.replace(/\.(js|d\.ts)$/, '');
  const candidates = [`${pkgDir}/src/${base}.ts`, `${pkgDir}/src/${base}.tsx`];

  for (const candidate of candidates) {
    if (allFilePaths.has(candidate)) return candidate;
  }

  return null;
}

/**
 * Scan all `packages/*\/package.json` files under `repoRoot` and build a map
 * from package name (and sub-path specifiers) to source file paths.
 *
 * **Root entry resolution** (priority order):
 * 1. `<pkgDir>/src/index.ts`  — TypeScript source (preferred for nexus analysis)
 * 2. `<pkgDir>/index.ts`      — flat-layout TypeScript source
 * 3. `<pkgDir>/src/index.js`  — JavaScript source fallback
 * 4. `<pkgDir>/index.js`      — flat-layout JavaScript fallback
 *
 * **Sub-path export resolution** (T617 barrel fix):
 * Reads the `exports` field and registers each non-root sub-path like
 * `./internal` as `@scope/pkg/internal` → the corresponding TypeScript
 * source file (derived from the dist output path in the exports entry).
 *
 * This enables correct resolution of imports like:
 * ```ts
 * import { findTasks } from '@cleocode/core/internal';
 * ```
 * which previously resolved to `null`, causing all callers to be missed.
 *
 * The resulting map is stored in `ImportResolutionContext.workspacePackageMap`
 * so that `resolveTypescriptImport` can resolve `@scope/package` and
 * `@scope/package/sub-path` imports to their source files.
 *
 * @param repoRoot - Absolute path to the repository root
 * @param allFilePaths - Set of all known file paths (relative to repo root)
 * @returns Map of package name/sub-path → relative entry file path
 */
export async function loadWorkspacePackages(
  repoRoot: string,
  allFilePaths: Set<string>,
): Promise<Map<string, string>> {
  const result = new Map<string, string>();

  let packagesDir: string[];
  try {
    packagesDir = await fs.readdir(path.join(repoRoot, 'packages'));
  } catch {
    return result;
  }

  for (const pkgName of packagesDir) {
    const pkgDir = `packages/${pkgName}`;
    const pkgJsonPath = path.join(repoRoot, pkgDir, 'package.json');
    try {
      const raw = await fs.readFile(pkgJsonPath, 'utf-8');
      const parsed = JSON.parse(raw) as {
        name?: string;
        exports?: Record<string, PackageExportsEntry>;
      };
      const packageName = parsed.name;
      if (typeof packageName !== 'string' || !packageName) continue;

      // --- Root entry point ---
      // Candidate entry files in priority order (source files preferred)
      const rootCandidates = [
        `${pkgDir}/src/index.ts`,
        `${pkgDir}/index.ts`,
        `${pkgDir}/src/index.js`,
        `${pkgDir}/index.js`,
      ];

      for (const candidate of rootCandidates) {
        if (allFilePaths.has(candidate)) {
          result.set(packageName, candidate);
          break;
        }
      }

      // --- Sub-path exports (T617 barrel fix) ---
      // Register each `./subpath` export entry as `@scope/pkg/subpath`.
      // This ensures that `import X from '@scope/pkg/internal'` resolves
      // to the TypeScript source rather than returning null.
      if (parsed.exports && typeof parsed.exports === 'object') {
        for (const [subPath, entry] of Object.entries(parsed.exports)) {
          // Skip root export (already handled above)
          if (subPath === '.') continue;
          // Only handle `./subpath` style entries (skip patterns with `*`)
          if (!subPath.startsWith('./') || subPath.includes('*')) continue;

          // Derive the sub-path specifier: "./internal" → "@scope/pkg/internal"
          const subPathKey = subPath.slice(2); // strip leading "./"
          const specifier = `${packageName}/${subPathKey}`;

          // Skip if already registered (shouldn't happen, but be defensive)
          if (result.has(specifier)) continue;

          // Extract a dist path from the entry (prefer types > import > require > default)
          let distPath: string | null = null;
          if (typeof entry === 'string') {
            distPath = entry;
          } else if (entry && typeof entry === 'object') {
            distPath =
              (entry as { types?: string; import?: string; require?: string; default?: string })
                .types ??
              (entry as { types?: string; import?: string; require?: string; default?: string })
                .import ??
              (entry as { types?: string; import?: string; require?: string; default?: string })
                .require ??
              (entry as { types?: string; import?: string; require?: string; default?: string })
                .default ??
              null;
          }

          if (!distPath) continue;

          const sourcePath = distPathToSourcePath(distPath, pkgDir, allFilePaths);
          if (sourcePath) {
            result.set(specifier, sourcePath);
          }
        }
      }
    } catch {
      // Missing or invalid package.json — skip
    }
  }

  return result;
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

// ---------------------------------------------------------------------------
// Barrel export map types (T617)
// ---------------------------------------------------------------------------

/**
 * A single entry in the barrel export map.
 *
 * Describes where a symbol exported by a barrel file actually originates.
 * For `export { findTasks } from './tasks/find.js'` in `index.ts`:
 *   - `canonicalFile` = `"packages/core/src/tasks/find.ts"`
 *   - `canonicalName` = `"findTasks"`
 */
export interface BarrelExportEntry {
  /** Resolved canonical source file that defines the symbol. */
  canonicalFile: string;
  /** Name of the symbol as defined in the canonical source file. */
  canonicalName: string;
}

/**
 * Map of barrel file path → (exported name → canonical definition).
 *
 * Built by `buildBarrelExportMap` during the parse/import phase.
 *
 * Wildcard re-exports (`export * from '...'`) are stored under the sentinel
 * key `"*"` as a list of wildcard source files — the resolver will scan all
 * of them when a named lookup misses.
 *
 * Example:
 * ```
 * packages/core/src/index.ts exports { findTasks } from './tasks/find.ts'
 * → barrelMap.get('packages/core/src/index.ts')?.get('findTasks')
 *   === { canonicalFile: 'packages/core/src/tasks/find.ts', canonicalName: 'findTasks' }
 * ```
 */
export type BarrelExportMap = Map<string, Map<string, BarrelExportEntry>>;

/**
 * Sentinel key used in a barrel's inner map to record wildcard re-export sources.
 *
 * The value for this key is a `BarrelExportEntry` with `canonicalFile` set to
 * the resolved source file path and `canonicalName` set to `"*"`.
 * Multiple wildcard sources are stored as sequential keys:
 * `"*0"`, `"*1"`, etc.
 */
export const WILDCARD_EXPORT_KEY_PREFIX = '*';

/**
 * A pre-extracted re-export record from the AST parse phase (T617).
 *
 * Mirrors `ExtractedReExport` from the TypeScript extractor, defined here
 * to avoid a circular dependency between import-processor ← extractor.
 */
export interface ExtractedReExportRecord {
  /** Barrel file path (relative to repo root). */
  filePath: string;
  /** Raw source path from the re-export (e.g. `"./tasks/find.js"`). */
  rawSourcePath: string;
  /**
   * Exported name as seen by callers. `null` for wildcard `export *` records.
   */
  exportedName: string | null;
  /**
   * Name in the source module. `null` for wildcard records.
   */
  localName: string | null;
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
 * 4. Workspace package resolution — `@scope/pkg` → `packages/pkg/src/index.ts`
 *    (uses `workspacePackageMap` built by `loadWorkspacePackages`)
 * 5. Generic suffix matching via SuffixIndex (absolute/package imports)
 * 6. node_modules / external — return null
 *
 * @param currentFile - The file that contains the import statement
 * @param importPath - The raw import path string from the AST
 * @param allFiles - Set of all known file paths for membership checks
 * @param allFileList - Ordered list of all file paths
 * @param normalizedFileList - Forward-slash-normalized file paths
 * @param resolveCache - Mutable cache shared across calls
 * @param tsconfigPaths - Parsed tsconfig path alias config, if available
 * @param index - Pre-built SuffixIndex for O(1) lookups
 * @param workspacePackageMap - Workspace package name → entry file path map
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
  workspacePackageMap?: Map<string, string>,
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
    // Try as-is first (handles paths without extension or with correct extension)
    const directResult = tryResolveWithExtensions(basePath, allFiles);
    if (directResult) return cache(directResult);
    // ESM convention uses .js extensions in source imports that actually resolve
    // to .ts files. Strip the .js extension and retry so that
    // `./index.js` resolves to `./index.ts`.
    if (basePath.endsWith('.js')) {
      const stripped = basePath.slice(0, -3);
      const strippedResult = tryResolveWithExtensions(stripped, allFiles);
      if (strippedResult) return cache(strippedResult);
    }
    return cache(null);
  }

  // 3. Workspace package resolution for `@scope/package` style imports.
  // Bare and scoped imports that don't start with '.' are potential workspace
  // packages. Check the workspace map first (exact name match), then fall back
  // to suffix resolution, then give up (external npm package).
  if (!importPath.includes('/') || importPath.startsWith('@')) {
    // 3a. Exact workspace package name lookup (e.g. `@cleocode/core`)
    if (workspacePackageMap) {
      const pkgEntry = workspacePackageMap.get(importPath);
      if (pkgEntry) return cache(pkgEntry);
    }

    // 3b. Suffix resolution as fallback for non-standard workspace layouts
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

  const {
    allFilePaths,
    allFileList,
    normalizedFileList,
    index,
    resolveCache,
    workspacePackageMap,
  } = importCtx;

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
        workspacePackageMap,
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

// ---------------------------------------------------------------------------
// Barrel export map construction (T617)
// ---------------------------------------------------------------------------

/** Maximum chain depth when resolving barrel re-exports transitively. */
const MAX_BARREL_CHAIN_DEPTH = 10;

/**
 * Build a BarrelExportMap from pre-extracted re-export records.
 *
 * For each re-export record:
 * 1. Resolves the raw source path to a concrete file path (using the same
 *    import resolution logic as `resolveTypescriptImport`).
 * 2. Records the mapping in the barrel map.
 *
 * Wildcard re-exports (`export * from '...'`) are stored under sequential
 * keys `"*0"`, `"*1"`, etc. within the barrel's entry map. Named lookups
 * that miss the barrel map will fall through to scan wildcard sources.
 *
 * @param reExports - Pre-extracted re-export records from the parse phase
 * @param importCtx - Import resolution context (for path resolution)
 * @param tsconfigPaths - Parsed tsconfig path aliases, if available
 * @returns A populated BarrelExportMap
 */
export function buildBarrelExportMap(
  reExports: ExtractedReExportRecord[],
  importCtx: ImportResolutionContext,
  tsconfigPaths: TsconfigPaths | null,
): BarrelExportMap {
  const {
    allFilePaths,
    allFileList,
    normalizedFileList,
    index,
    resolveCache,
    workspacePackageMap,
  } = importCtx;
  const barrelMap: BarrelExportMap = new Map();

  for (const re of reExports) {
    const resolved = resolveTypescriptImport(
      re.filePath,
      re.rawSourcePath,
      allFilePaths,
      allFileList,
      normalizedFileList,
      resolveCache,
      tsconfigPaths,
      index,
      workspacePackageMap,
    );
    if (!resolved) continue;

    let barrelEntry = barrelMap.get(re.filePath);
    if (!barrelEntry) {
      barrelEntry = new Map();
      barrelMap.set(re.filePath, barrelEntry);
    }

    if (re.exportedName === null) {
      // Wildcard re-export — store with sequential key *0, *1, ...
      let wildcardIndex = 0;
      while (barrelEntry.has(`${WILDCARD_EXPORT_KEY_PREFIX}${wildcardIndex}`)) {
        wildcardIndex++;
      }
      barrelEntry.set(`${WILDCARD_EXPORT_KEY_PREFIX}${wildcardIndex}`, {
        canonicalFile: resolved,
        canonicalName: WILDCARD_EXPORT_KEY_PREFIX,
      });
    } else {
      // Named re-export — map exported name → canonical location
      // The localName in the source is what the canonical file defines.
      const canonicalName = re.localName ?? re.exportedName;
      barrelEntry.set(re.exportedName, {
        canonicalFile: resolved,
        canonicalName,
      });
    }
  }

  if (process.env['CLEO_BARREL_DEBUG']) {
    // Count re-export records from core files
    const coreInternalRecords = reExports.filter((re) => re.filePath.includes('core/src/internal'));
    const coreIndexRecords = reExports.filter(
      (re) => re.filePath.includes('core/src/index') && !re.filePath.includes('index.ts:'),
    );
    process.stderr.write(
      `[barrel-debug] core/src/internal.ts re-export records: ${coreInternalRecords.length}\n`,
    );
    process.stderr.write(
      `[barrel-debug] core/src/index.ts re-export records: ${coreIndexRecords.length}\n`,
    );
    for (const [file, entries] of barrelMap) {
      process.stderr.write(
        `[barrel-debug] ${file}: ${entries.size} entries (${[...entries.keys()].slice(0, 5).join(', ')})\n`,
      );
    }
  }

  return barrelMap;
}

/**
 * Resolve a named import binding through barrel re-export chains.
 *
 * Given that a caller imports `name` from `barrelFile` but the symbol is not
 * directly defined there, walk the barrel map to find the canonical source file
 * and symbol name.
 *
 * Supports transitive chains (barrel re-exporting from another barrel) up to
 * `MAX_BARREL_CHAIN_DEPTH` hops to prevent infinite loops on circular re-exports.
 *
 * @param barrelFile - The barrel file that was imported from
 * @param exportedName - The name being resolved
 * @param barrelMap - The pre-built barrel export map
 * @returns Canonical `{ canonicalFile, canonicalName }`, or null if not found
 */
export function resolveBarrelBinding(
  barrelFile: string,
  exportedName: string,
  barrelMap: BarrelExportMap,
): BarrelExportEntry | null {
  let currentFile = barrelFile;
  let currentName = exportedName;

  for (let depth = 0; depth < MAX_BARREL_CHAIN_DEPTH; depth++) {
    const barrelEntry = barrelMap.get(currentFile);
    if (!barrelEntry) return null;

    // Check exact named match first
    const namedMatch = barrelEntry.get(currentName);
    if (namedMatch) {
      // If the canonical file is itself a barrel, keep following the chain
      if (barrelMap.has(namedMatch.canonicalFile)) {
        currentFile = namedMatch.canonicalFile;
        currentName = namedMatch.canonicalName;
        continue;
      }
      return namedMatch;
    }

    // No named match — check wildcard re-exports
    // Collect all wildcard source files from this barrel
    let wildcardIndex = 0;
    while (barrelEntry.has(`${WILDCARD_EXPORT_KEY_PREFIX}${wildcardIndex}`)) {
      const wildcardEntry = barrelEntry.get(`${WILDCARD_EXPORT_KEY_PREFIX}${wildcardIndex}`)!;
      wildcardIndex++;

      const wildcardSourceFile = wildcardEntry.canonicalFile;

      // If the wildcard source is itself a barrel, check it recursively (via loop)
      if (barrelMap.has(wildcardSourceFile)) {
        const nested = resolveBarrelBinding(wildcardSourceFile, currentName, barrelMap);
        if (nested) return nested;
        continue;
      }

      // Wildcard from a non-barrel file: we can't know what it exports without
      // running the symbol table lookup. Return a candidate pointing to this file.
      // The caller (resolveSingleCall) will verify against the symbol table.
      return { canonicalFile: wildcardSourceFile, canonicalName: currentName };
    }

    // No match in this barrel at all
    return null;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Regex-based fallback extractors for oversized files (T617)
// ---------------------------------------------------------------------------

/**
 * Hard limit for tree-sitter 0.21.x: native code uses a 15-bit byte-offset
 * counter that overflows at 32768 characters. Files larger than this threshold
 * cannot be parsed by tree-sitter and should use the regex fallback.
 *
 * Exported for use in parse-loop.ts and parse-worker.ts.
 */
export const TREE_SITTER_MAX_CHARS = 32_767;

/**
 * Regex-based re-export extractor for files that exceed the tree-sitter 32K limit.
 *
 * Handles:
 * - `export { Foo, Bar as Baz } from './source'`  — named re-export
 * - `export * from './source'`                     — wildcard re-export
 * - `export type { ... } from '...'`               — type-only re-exports (skipped)
 *
 * This is intentionally conservative: it only extracts clearly-formed re-export
 * statements. False negatives are acceptable (they result in missing CALLS edges,
 * not incorrect ones). Dynamic or computed re-exports are not handled.
 *
 * Used as a fallback when tree-sitter cannot parse a file due to its 32K limit.
 *
 * @param content - Raw file content (non-ASCII chars are ignored by regex patterns)
 * @param filePath - File path relative to repo root
 * @returns Array of extracted re-export records
 */
export function extractReExportsViaRegex(
  content: string,
  filePath: string,
): ExtractedReExportRecord[] {
  const results: ExtractedReExportRecord[] = [];
  const lines = content.split('\n');

  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();

    // Wildcard re-export: `export * from '...'`
    const wildcardMatch = /^export\s+\*\s+from\s+['"]([^'"]+)['"]/m.exec(line);
    if (wildcardMatch) {
      results.push({
        filePath,
        rawSourcePath: wildcardMatch[1]!,
        exportedName: null,
        localName: null,
      });
      i++;
      continue;
    }

    // Named re-export: `export { Foo, Bar as Baz } from '...'`
    // Skip `export type { ... }` — type-only re-exports are not call targets
    if (/^export\s*\{/.test(line) && !/^export\s+type\s*\{/.test(line)) {
      // Gather continuation lines until we have the closing `}` and `from`
      let block = line;
      let j = i + 1;
      while ((!block.includes('}') || !block.includes('from')) && j < lines.length) {
        block += ' ' + lines[j].trim();
        j++;
      }

      const fromMatch = /from\s+['"]([^'"]+)['"]/m.exec(block);
      if (fromMatch) {
        const rawSourcePath = fromMatch[1]!;
        const innerMatch = /\{([^}]+)\}/.exec(block);
        if (innerMatch) {
          const specifiers = innerMatch[1]!
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
          for (const spec of specifiers) {
            const cleanSpec = spec.replace(/^type\s+/, '').trim();
            const asMatch = /^(\w+)\s+as\s+(\w+)$/.exec(cleanSpec);
            if (asMatch) {
              results.push({
                filePath,
                rawSourcePath,
                exportedName: asMatch[2]!,
                localName: asMatch[1]!,
              });
            } else if (/^\w+$/.test(cleanSpec)) {
              results.push({
                filePath,
                rawSourcePath,
                exportedName: cleanSpec,
                localName: cleanSpec,
              });
            }
          }
        }
      }
      i = j;
      continue;
    }

    i++;
  }

  return results;
}

/**
 * Regex-based import extractor for files that exceed the tree-sitter 32K limit.
 *
 * Extracts named import bindings from `import { ... } from '...'` statements.
 * Used to populate the namedImportMap so barrel tracing can fire for callers
 * in oversized files (e.g. large barrel consumers like `@cleocode/core/internal`).
 *
 * @param content - Raw file content
 * @param filePath - File path relative to repo root
 * @returns Array of extracted import records with named bindings
 */
export function extractImportsViaRegex(content: string, filePath: string): ExtractedImport[] {
  const results: ExtractedImport[] = [];
  const lines = content.split('\n');

  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();

    // Named import: `import { ... } from '...'` (also handles `import type { ... }`)
    if (/^import(\s+type)?\s*\{/.test(line)) {
      let block = line;
      let j = i + 1;
      while ((!block.includes('}') || !block.includes('from')) && j < lines.length) {
        block += ' ' + lines[j].trim();
        j++;
      }

      const fromMatch = /from\s+['"]([^'"]+)['"]/m.exec(block);
      if (fromMatch) {
        const rawImportPath = fromMatch[1]!;
        const namedBindings: NamedImportBinding[] = [];
        const innerMatch = /\{([^}]+)\}/.exec(block);
        if (innerMatch) {
          const specifiers = innerMatch[1]!
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
          for (const spec of specifiers) {
            const cleanSpec = spec.replace(/^type\s+/, '').trim();
            const asMatch = /^(\w+)\s+as\s+(\w+)$/.exec(cleanSpec);
            if (asMatch) {
              namedBindings.push({ local: asMatch[2]!, exported: asMatch[1]! });
            } else if (/^\w+$/.test(cleanSpec)) {
              namedBindings.push({ local: cleanSpec, exported: cleanSpec });
            }
          }
        }
        if (namedBindings.length > 0) {
          results.push({ filePath, rawImportPath, namedBindings });
        }
      }
      i = j;
      continue;
    }

    i++;
  }

  return results;
}
