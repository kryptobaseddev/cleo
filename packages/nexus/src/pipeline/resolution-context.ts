/**
 * ResolutionContext — tiered name resolution for call/import analysis.
 *
 * Implements three confidence tiers for resolving a symbol name encountered
 * in a source file to a concrete SymbolDefinition from the SymbolTable:
 *
 * - **Tier 1** (same-file, confidence 0.95): The symbol is defined in the
 *   same file that references it. Uses `lookupExactAll` for full overload set.
 *
 * - **Tier 2a** (import-scoped, confidence 0.90): The symbol is imported from
 *   another file in the repository. The named import map is checked first
 *   (handles aliased/re-exported imports), then the full import set is scanned.
 *
 * - **Tier 3** (global, confidence 0.50): Fallback O(1) index lookups across
 *   the entire repository. Combines `lookupClassByName`, `lookupImplByName`,
 *   and `lookupCallableByName`. Consumers must check `candidates.length` and
 *   refuse ambiguous matches.
 *
 * A per-file LRU-style cache is maintained to avoid repeated tier traversal
 * for the same (name, file) pair within a single file's processing pass.
 *
 * Ported from GitNexus `src/core/ingestion/resolution-context.ts` and
 * adapted to:
 * - Remove Tier 2b (package-scoped) resolution (Go/C# specific)
 * - Remove named binding chain walker (walkBindingChain — T535+)
 * - Use CLEO's `SymbolDefinition` + `SymbolTable` from `./symbol-table.ts`
 *
 * @task T533
 * @module pipeline/resolution-context
 */

import type { ModuleAliasMap, NamedImportMap } from './import-processor.js';
import type { SymbolDefinition } from './symbol-table.js';
import { createSymbolTable, type SymbolTable } from './symbol-table.js';

// ---------------------------------------------------------------------------
// Resolution tier types
// ---------------------------------------------------------------------------

/**
 * Resolution tier identifier.
 *
 * Ordered from highest to lowest confidence:
 * - `"same-file"` — authoritative (symbol is in the same file)
 * - `"import-scoped"` — high confidence (symbol is in a directly imported file)
 * - `"global"` — low confidence (symbol found anywhere in the repository)
 */
export type ResolutionTier = 'same-file' | 'import-scoped' | 'global';

/**
 * Confidence scores associated with each resolution tier.
 * Used when emitting relation edges in the call graph.
 */
export const TIER_CONFIDENCE: Record<ResolutionTier, number> = {
  'same-file': 0.95,
  'import-scoped': 0.9,
  global: 0.5,
};

/**
 * The result of a successful tiered resolution.
 *
 * `candidates` contains all matching definitions at the winning tier.
 * Consumers should check `candidates.length` before assuming a unique match —
 * Tier 3 in particular may return many candidates for common names.
 */
export interface TieredCandidates {
  /** All symbol definitions found at the winning tier. */
  readonly candidates: readonly SymbolDefinition[];
  /** The tier at which candidates were found. */
  readonly tier: ResolutionTier;
}

// ---------------------------------------------------------------------------
// Import map alias types (re-exported for pipeline wiring)
// ---------------------------------------------------------------------------

/** Map of importing file → set of directly imported file paths. */
export type ImportMap = Map<string, Set<string>>;

// ---------------------------------------------------------------------------
// ResolutionContext interface
// ---------------------------------------------------------------------------

/**
 * Tiered name resolution context for a single pipeline run.
 *
 * The context is populated during the parse and import phases, then queried
 * during the call/reference resolution phase (T535+).
 */
export interface ResolutionContext {
  /**
   * Resolve a symbol name to its definition(s) at the highest available tier.
   *
   * Returns null when the name cannot be resolved at any tier.
   * Tier 3 ('global') returns ALL candidates — consumers must check length
   * and refuse ambiguous matches when count > 1.
   *
   * @param name - Symbol name to resolve
   * @param fromFile - File path where the reference appears
   */
  resolve(name: string, fromFile: string): TieredCandidates | null;

  // --- Data stores (populated by upstream pipeline phases) ---

  /** Symbol table populated by the parse phase (T534). */
  readonly symbols: SymbolTable;

  /** ImportMap populated by the import processor. */
  readonly importMap: ImportMap;

  /** Named import map for precise Tier 2a resolution. */
  readonly namedImportMap: NamedImportMap;

  /** Module alias map for namespace imports (`import * as X from './foo'`). */
  readonly moduleAliasMap: ModuleAliasMap;

  // --- Cache lifecycle ---

  /**
   * Enable per-file caching for `filePath`.
   * Should be called once before processing each file in the resolution phase.
   * Clears any existing cache entries from the previous file.
   */
  enableCache(filePath: string): void;

  /**
   * Clear per-file cache without resetting statistics.
   * Called between files during the resolution phase.
   */
  clearCache(): void;

  // --- Statistics ---

  /**
   * Return resolution statistics for diagnostics and logging.
   */
  getStats(): {
    fileCount: number;
    cacheHits: number;
    cacheMisses: number;
    tierSameFile: number;
    tierImportScoped: number;
    tierGlobal: number;
    tierMiss: number;
  };

  /**
   * Reset all state: symbol table, import maps, caches, and statistics.
   * Called between pipeline runs for context reuse.
   */
  clear(): void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a new ResolutionContext with empty state.
 *
 * The returned context is populated by:
 * 1. Parse phase (T534): calls `ctx.symbols.add(...)` for each extracted symbol
 * 2. Import phase (T533): calls `processExtractedImports(...)` which populates
 *    `ctx.importMap` and `ctx.namedImportMap`
 * 3. Resolution phase (T535+): calls `ctx.resolve(name, fromFile)` for each
 *    call site / reference
 *
 * @returns A fresh ResolutionContext
 *
 * @example
 * ```typescript
 * const ctx = createResolutionContext();
 *
 * // Phase: populate symbols
 * ctx.symbols.add('src/foo.ts', 'parseFile', 'src/foo.ts::parseFile', 'function');
 *
 * // Phase: resolve
 * const result = ctx.resolve('parseFile', 'src/bar.ts');
 * if (result) {
 *   console.log(result.tier, result.candidates[0].nodeId);
 * }
 * ```
 */
export function createResolutionContext(): ResolutionContext {
  const symbols = createSymbolTable();
  const importMap: ImportMap = new Map();
  const namedImportMap: NamedImportMap = new Map();
  const moduleAliasMap: ModuleAliasMap = new Map();

  // Per-file cache state (enabled/cleared per file during resolution phase)
  let cacheFile: string | null = null;
  let cache: Map<string, TieredCandidates | null> | null = null;

  // Statistics counters
  let cacheHits = 0;
  let cacheMisses = 0;
  let tierSameFile = 0;
  let tierImportScoped = 0;
  let tierGlobal = 0;
  let tierMiss = 0;

  // ---------------------------------------------------------------------------
  // Core tiered resolution (uncached)
  // ---------------------------------------------------------------------------

  function resolveUncached(name: string, fromFile: string): TieredCandidates | null {
    // Tier 1: Same file — authoritative. Returns all overloads.
    const localDefs = symbols.lookupExactAll(fromFile, name);
    if (localDefs.length > 0) {
      tierSameFile++;
      return { candidates: localDefs, tier: 'same-file' };
    }

    // Tier 2a-named: Named binding map lookup.
    // Handles `import { User as U } from './models'` where the local alias 'U'
    // would not match a `lookupExactAll` call for 'User' in the source file.
    const fileBindings = namedImportMap.get(fromFile);
    if (fileBindings) {
      const binding = fileBindings.get(name);
      if (binding) {
        // Look up the exported name in the source file (not the local alias)
        const sourceDefs = symbols.lookupExactAll(binding.sourcePath, binding.exportedName);
        if (sourceDefs.length > 0) {
          tierImportScoped++;
          return { candidates: sourceDefs, tier: 'import-scoped' };
        }
      }
    }

    // Tier 2a: Import-scoped — iterate the caller's directly imported files.
    // O(importedFiles) × O(1) lookupExactAll — no global name scan.
    const importedFiles = importMap.get(fromFile);
    if (importedFiles) {
      const importedDefs: SymbolDefinition[] = [];
      for (const file of importedFiles) {
        importedDefs.push(...symbols.lookupExactAll(file, name));
      }
      if (importedDefs.length > 0) {
        tierImportScoped++;
        return { candidates: importedDefs, tier: 'import-scoped' };
      }
    }

    // Tier 3: Global — O(1) index lookups, three disjoint symbol categories.
    // - classByName: class/struct/interface/enum/record/trait
    // - implByName:  impl (Rust)
    // - callableByName: function/method/constructor/macro/delegate
    //
    // Known exclusion: TypeAlias/Const/Variable are NOT reachable at Tier 3 —
    // they are resolved via same-file or import-scoped tiers in practice.
    const classDefs = symbols.lookupClassByName(name);
    const implDefs = symbols.lookupImplByName(name);
    const callableDefs = symbols.lookupCallableByName(name);

    if (classDefs.length === 0 && implDefs.length === 0 && callableDefs.length === 0) {
      tierMiss++;
      return null;
    }

    const globalDefs = [...classDefs, ...implDefs, ...callableDefs];
    tierGlobal++;
    return { candidates: globalDefs, tier: 'global' };
  }

  // ---------------------------------------------------------------------------
  // Cached resolve
  // ---------------------------------------------------------------------------

  function resolve(name: string, fromFile: string): TieredCandidates | null {
    if (cache && cacheFile === fromFile) {
      if (cache.has(name)) {
        cacheHits++;
        return cache.get(name) ?? null;
      }
      cacheMisses++;
    }

    const result = resolveUncached(name, fromFile);

    if (cache && cacheFile === fromFile) {
      cache.set(name, result);
    }

    return result;
  }

  // ---------------------------------------------------------------------------
  // Cache lifecycle
  // ---------------------------------------------------------------------------

  function enableCache(filePath: string): void {
    cacheFile = filePath;
    if (!cache) {
      cache = new Map();
    } else {
      cache.clear();
    }
  }

  function clearCache(): void {
    cacheFile = null;
    cache?.clear();
  }

  // ---------------------------------------------------------------------------
  // Statistics + reset
  // ---------------------------------------------------------------------------

  function getStats() {
    return {
      ...symbols.getStats(),
      cacheHits,
      cacheMisses,
      tierSameFile,
      tierImportScoped,
      tierGlobal,
      tierMiss,
    };
  }

  function clear(): void {
    symbols.clear();
    importMap.clear();
    namedImportMap.clear();
    moduleAliasMap.clear();
    clearCache();
    cacheHits = 0;
    cacheMisses = 0;
    tierSameFile = 0;
    tierImportScoped = 0;
    tierGlobal = 0;
    tierMiss = 0;
  }

  return {
    resolve,
    symbols,
    importMap,
    namedImportMap,
    moduleAliasMap,
    enableCache,
    clearCache,
    getStats,
    clear,
  };
}
