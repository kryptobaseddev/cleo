/**
 * SymbolTable — 5-index in-memory symbol registry for code intelligence.
 *
 * Maintains five eagerly-populated Map-based indexes that give O(1) lookup
 * access to symbols extracted from source files:
 *
 * 1. `fileIndex`      — per-file symbol lookup (Tier 1 same-file resolution)
 * 2. `callableByName` — Function/Method/Constructor symbols by name (Tier 3)
 * 3. `fieldByOwner`   — Property lookup by `ownerNodeId\0fieldName`
 * 4. `methodByOwner`  — Method lookup by `ownerNodeId\0methodName`
 * 5. `classByName`    — Class/Struct/Interface/Enum/Trait symbols by name
 *
 * Ported from GitNexus `src/core/ingestion/symbol-table.ts` and adapted to
 * use CLEO's `GraphNodeKind` type instead of GitNexus's `NodeLabel`.
 *
 * @task T533
 * @module pipeline/symbol-table
 */

import type { GraphNodeKind } from '@cleocode/contracts';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Class-like node kinds indexed in `classByName`.
 * Used to determine whether a symbol goes into the class/type index.
 */
export const CLASS_KINDS = new Set<GraphNodeKind>([
  'class',
  'struct',
  'interface',
  'enum',
  'record',
  'trait',
]);

/**
 * Callable node kinds indexed in `callableByName`.
 * Single source of truth — do not duplicate this set elsewhere.
 */
export const CALLABLE_KINDS = new Set<GraphNodeKind>([
  'function',
  'method',
  'constructor',
  'macro',
  'delegate',
]);

// ---------------------------------------------------------------------------
// SymbolDefinition
// ---------------------------------------------------------------------------

/**
 * Full definition of a symbol as registered in the SymbolTable.
 *
 * The `nodeId` and `filePath` together uniquely identify a symbol instance.
 * For overloaded methods, multiple definitions may share the same name
 * within the same file.
 */
export interface SymbolDefinition {
  /** Stable node ID for this symbol (used to link relations in the graph). */
  nodeId: string;
  /** File path (relative to repo root) where this symbol is defined. */
  filePath: string;
  /** Kind of code element this symbol represents. */
  kind: GraphNodeKind;
  /**
   * Canonical dot-separated qualified name for class-like symbols
   * (e.g. `App.Models.User`). Falls back to the simple symbol name when no
   * package/namespace/module scope is available.
   */
  qualifiedName?: string;
  /** Total parameter count (including optional). */
  parameterCount?: number;
  /**
   * Number of required (non-optional, non-default) parameters.
   * Enables range-based arity filtering:
   *   `argCount >= requiredParameterCount && argCount <= parameterCount`
   */
  requiredParameterCount?: number;
  /**
   * Per-parameter type names for overload disambiguation (e.g. `['int', 'String']`).
   * Populated when parameter types are resolvable from AST (typed languages).
   */
  parameterTypes?: string[];
  /** Raw return type text extracted from AST (e.g. `'User'`, `'Promise<User>'`). */
  returnType?: string;
  /** Declared type for non-callable symbols — fields/properties (e.g. `'Address'`). */
  declaredType?: string;
  /** Links Method/Constructor/Property to owning Class/Struct/Trait nodeId. */
  ownerId?: string;
}

// ---------------------------------------------------------------------------
// SymbolTable interface
// ---------------------------------------------------------------------------

/**
 * In-memory symbol registry with five dedicated indexes for O(1) lookup.
 *
 * All registration happens via `add()`. All lookups are read-only. The table
 * is append-only during the parse phase and is cleared via `clear()` for
 * pipeline reuse.
 */
export interface SymbolTable {
  /**
   * Register a symbol definition in all applicable indexes.
   *
   * @param filePath - Relative path to the file defining this symbol
   * @param name - Symbol name as it appears in source
   * @param nodeId - Stable graph node ID for this symbol
   * @param kind - Kind of code element (function, class, method, etc.)
   * @param metadata - Optional arity, type, ownership metadata
   */
  add(
    filePath: string,
    name: string,
    nodeId: string,
    kind: GraphNodeKind,
    metadata?: {
      parameterCount?: number;
      requiredParameterCount?: number;
      parameterTypes?: string[];
      returnType?: string;
      declaredType?: string;
      ownerId?: string;
      qualifiedName?: string;
    },
  ): void;

  /**
   * Tier 1 — Look up a symbol by file path and name.
   * Returns the node ID of the first matching definition, or undefined.
   */
  lookupExact(filePath: string, name: string): string | undefined;

  /**
   * Tier 1 — Look up a symbol by file path and name, returning the full definition.
   * Returns first matching definition. Use `lookupExactAll` for overloads.
   */
  lookupExactFull(filePath: string, name: string): SymbolDefinition | undefined;

  /**
   * Tier 1 — Look up ALL symbols with this name in a specific file.
   * Returns all definitions including overloaded methods with the same name.
   */
  lookupExactAll(filePath: string, name: string): SymbolDefinition[];

  /**
   * Tier 3 — Look up callable symbols (function/method/constructor) by name.
   * O(1) via the dedicated `callableByName` index.
   */
  lookupCallableByName(name: string): SymbolDefinition[];

  /**
   * Look up a field/property by its owning class nodeId and field name.
   * O(1) via `fieldByOwner` index keyed by `ownerNodeId\0fieldName`.
   */
  lookupFieldByOwner(ownerNodeId: string, fieldName: string): SymbolDefinition | undefined;

  /**
   * Look up a method by its owning class nodeId and method name.
   * O(1) via `methodByOwner` index. Supports arity narrowing when `argCount` is provided.
   *
   * When `argCount` is provided and multiple overloads exist, filters to those
   * whose parameter range accommodates the call. Overloads with undefined
   * parameterCount are retained conservatively.
   */
  lookupMethodByOwner(
    ownerNodeId: string,
    methodName: string,
    argCount?: number,
  ): SymbolDefinition | undefined;

  /**
   * Look up class-like definitions (class/struct/interface/enum/trait) by name.
   * O(1) via `classByName` index. Returns all matching definitions across files.
   */
  lookupClassByName(name: string): SymbolDefinition[];

  /**
   * Look up class-like definitions by canonical qualified name.
   * Qualified names are normalized to dot-separated scope segments across languages,
   * e.g. `App.Models.User`, `com.example.User`.
   */
  lookupClassByQualifiedName(qualifiedName: string): SymbolDefinition[];

  /**
   * Look up Impl nodes by name.
   * O(1) via `implByName` index. Used by Tier 3 resolution for Rust impl blocks.
   */
  lookupImplByName(name: string): SymbolDefinition[];

  /**
   * Iterate all indexed file paths.
   * Used by Tier 2b package-scoped resolution.
   */
  getFiles(): IterableIterator<string>;

  /**
   * Return basic statistics about the current symbol table state.
   */
  getStats(): { fileCount: number };

  /**
   * Clear all five indexes. Allows the table to be reused across pipeline runs.
   */
  clear(): void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a new empty SymbolTable with five eagerly-populated Map indexes.
 *
 * @returns A fresh SymbolTable ready for registration.
 *
 * @example
 * ```typescript
 * const table = createSymbolTable();
 * table.add('src/foo.ts', 'parseFile', 'src/foo.ts::parseFile', 'function');
 * const nodeId = table.lookupExact('src/foo.ts', 'parseFile');
 * ```
 */
export function createSymbolTable(): SymbolTable {
  // 1. File-Specific Index — stores full SymbolDefinition(s) for O(1) lookup.
  // Structure: FilePath -> (SymbolName -> SymbolDefinition[])
  // Array allows overloaded methods (same name, different signatures) to coexist.
  const fileIndex = new Map<string, Map<string, SymbolDefinition[]>>();

  // 2. Eagerly-populated Callable Index — maintained on add().
  // Structure: SymbolName -> [Callable Definitions]
  // Only function/method/constructor/macro/delegate symbols are indexed.
  const callableByName = new Map<string, SymbolDefinition[]>();

  // 3. Eagerly-populated Field/Property Index — keyed by "ownerNodeId\0fieldName".
  // Only property symbols with ownerId are indexed.
  const fieldByOwner = new Map<string, SymbolDefinition>();

  // 4. Eagerly-populated Method Index — keyed by "ownerNodeId\0methodName".
  // Method/constructor symbols with ownerId are indexed. Supports overloads.
  const methodByOwner = new Map<string, SymbolDefinition[]>();

  // 5. Eagerly-populated Class-type Index — keyed by symbol name.
  // Only class/struct/interface/enum/record/trait symbols are indexed.
  const classByName = new Map<string, SymbolDefinition[]>();
  const classByQualifiedName = new Map<string, SymbolDefinition[]>();

  // 6. Rust Impl Index — separate from classByName to avoid polluting heritage
  // resolution with Impl nodes as parent candidates.
  const implByName = new Map<string, SymbolDefinition[]>();

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  function pushToMap<V>(map: Map<string, V[]>, key: string, value: V): void {
    const existing = map.get(key);
    if (existing) {
      existing.push(value);
    } else {
      map.set(key, [value]);
    }
  }

  // ---------------------------------------------------------------------------
  // add()
  // ---------------------------------------------------------------------------

  function add(
    filePath: string,
    name: string,
    nodeId: string,
    kind: GraphNodeKind,
    metadata?: {
      parameterCount?: number;
      requiredParameterCount?: number;
      parameterTypes?: string[];
      returnType?: string;
      declaredType?: string;
      ownerId?: string;
      qualifiedName?: string;
    },
  ): void {
    const qualifiedName = CLASS_KINDS.has(kind)
      ? (metadata?.qualifiedName ?? name)
      : metadata?.qualifiedName;

    const def: SymbolDefinition = {
      nodeId,
      filePath,
      kind,
      ...(qualifiedName !== undefined ? { qualifiedName } : {}),
      ...(metadata?.parameterCount !== undefined
        ? { parameterCount: metadata.parameterCount }
        : {}),
      ...(metadata?.requiredParameterCount !== undefined
        ? { requiredParameterCount: metadata.requiredParameterCount }
        : {}),
      ...(metadata?.parameterTypes !== undefined
        ? { parameterTypes: metadata.parameterTypes }
        : {}),
      ...(metadata?.returnType !== undefined ? { returnType: metadata.returnType } : {}),
      ...(metadata?.declaredType !== undefined ? { declaredType: metadata.declaredType } : {}),
      ...(metadata?.ownerId !== undefined ? { ownerId: metadata.ownerId } : {}),
    };

    // A. Add to File Index (shared reference — zero additional memory per index)
    if (!fileIndex.has(filePath)) {
      fileIndex.set(filePath, new Map());
    }
    const fileMap = fileIndex.get(filePath)!;
    if (!fileMap.has(name)) {
      fileMap.set(name, [def]);
    } else {
      fileMap.get(name)!.push(def);
    }

    // B. Properties go to fieldByOwner index only — skip other indexes to
    // prevent namespace pollution for common names like 'id', 'name', 'type'.
    // Index ALL properties (even without declaredType) so write-access tracking
    // can resolve field ownership for dynamically-typed languages.
    if (kind === 'property' && metadata?.ownerId) {
      fieldByOwner.set(`${metadata.ownerId}\0${name}`, def);
      return; // still added to fileIndex above
    }

    // C. Methods, constructors, and ownerId-bound functions go to methodByOwner.
    // Some language extractors emit class methods as `function` with an ownerId
    // (Python `def method(self):`, Rust trait methods, Kotlin companion objects).
    // Treating them the same as `method` makes member-call resolution uniform.
    if ((kind === 'method' || kind === 'constructor' || kind === 'function') && metadata?.ownerId) {
      const key = `${metadata.ownerId}\0${name}`;
      const existing = methodByOwner.get(key);
      if (existing) {
        existing.push(def);
      } else {
        methodByOwner.set(key, [def]);
      }
    }

    // C2. Class-like types go to classByName + classByQualifiedName.
    if (CLASS_KINDS.has(kind)) {
      pushToMap(classByName, name, def);
      const qualifiedKey = qualifiedName ?? name;
      pushToMap(classByQualifiedName, qualifiedKey, def);
    }

    // C3. Rust Impl blocks go to implByName (separate from classByName).
    if (kind === 'impl') {
      pushToMap(implByName, name, def);
    }

    // D. Eagerly maintain callable index (function/method/constructor/macro/delegate).
    if (CALLABLE_KINDS.has(kind)) {
      pushToMap(callableByName, name, def);
    }
  }

  // ---------------------------------------------------------------------------
  // Lookup methods
  // ---------------------------------------------------------------------------

  function lookupExact(filePath: string, name: string): string | undefined {
    return fileIndex.get(filePath)?.get(name)?.[0]?.nodeId;
  }

  function lookupExactFull(filePath: string, name: string): SymbolDefinition | undefined {
    return fileIndex.get(filePath)?.get(name)?.[0];
  }

  function lookupExactAll(filePath: string, name: string): SymbolDefinition[] {
    return fileIndex.get(filePath)?.get(name) ?? [];
  }

  function lookupCallableByName(name: string): SymbolDefinition[] {
    return callableByName.get(name) ?? [];
  }

  function lookupFieldByOwner(
    ownerNodeId: string,
    fieldName: string,
  ): SymbolDefinition | undefined {
    return fieldByOwner.get(`${ownerNodeId}\0${fieldName}`);
  }

  function lookupMethodByOwner(
    ownerNodeId: string,
    methodName: string,
    argCount?: number,
  ): SymbolDefinition | undefined {
    const defs = methodByOwner.get(`${ownerNodeId}\0${methodName}`);
    if (!defs || defs.length === 0) return undefined;

    // Arity narrowing: when argCount is provided and multiple overloads exist,
    // keep only those whose parameter range can accommodate the call.
    // Definitions with undefined parameterCount (variadic/unknown) are retained
    // conservatively so legitimate variadic matches still resolve.
    let pool = defs;
    if (argCount !== undefined && defs.length > 1) {
      const arityMatched = defs.filter((d) => {
        if (d.parameterCount === undefined) return true;
        const min = d.requiredParameterCount ?? d.parameterCount;
        return argCount >= min && argCount <= d.parameterCount;
      });
      // Only adopt arity-narrowed pool when it found matches; if arity rules out
      // every candidate, fall back to unfiltered set so callers still have candidates.
      if (arityMatched.length > 0) pool = arityMatched;
    }

    if (pool.length === 1) return pool[0];

    // Multiple overloads after arity narrowing: return first if all share
    // the same defined returnType (safe for chain resolution), undefined if
    // return types differ (truly ambiguous).
    const firstReturnType = pool[0].returnType;
    if (firstReturnType === undefined) return undefined;
    for (let i = 1; i < pool.length; i++) {
      if (pool[i].returnType !== firstReturnType) return undefined;
    }
    return pool[0];
  }

  function lookupClassByName(name: string): SymbolDefinition[] {
    return classByName.get(name) ?? [];
  }

  function lookupClassByQualifiedName(qualifiedName: string): SymbolDefinition[] {
    return classByQualifiedName.get(qualifiedName) ?? [];
  }

  function lookupImplByName(name: string): SymbolDefinition[] {
    return implByName.get(name) ?? [];
  }

  /** Returns a live iterator over all indexed file paths (fileIndex.keys()).
   *  Safe in the current pipeline because all symbols are added before
   *  resolution begins (append-only during parse phase). */
  function getFiles(): IterableIterator<string> {
    return fileIndex.keys();
  }

  function getStats(): { fileCount: number } {
    return { fileCount: fileIndex.size };
  }

  function clear(): void {
    fileIndex.clear();
    callableByName.clear();
    fieldByOwner.clear();
    methodByOwner.clear();
    classByName.clear();
    classByQualifiedName.clear();
    implByName.clear();
  }

  return {
    add,
    lookupExact,
    lookupExactFull,
    lookupExactAll,
    lookupCallableByName,
    lookupFieldByOwner,
    lookupMethodByOwner,
    lookupClassByName,
    lookupClassByQualifiedName,
    lookupImplByName,
    getFiles,
    getStats,
    clear,
  };
}
