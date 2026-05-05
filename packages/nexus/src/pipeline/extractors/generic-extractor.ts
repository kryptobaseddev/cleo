/**
 * Generic AST extractor — single walker parametrized by LanguageConfig.
 *
 * Implements the core insight from Graphify v7's `_extract_generic` function
 * (`extract.py:933`, 794 lines) that drives 13 of 26 supported languages from
 * one walker by accepting a {@link LanguageConfig} dataclass per language.
 *
 * In Graphify, the config-driven path drastically reduces per-language code:
 * each new language requires only a 12–20 line declarative config block rather
 * than a 200–600 line hand-written extractor. This module ports that pattern to
 * TypeScript for the CLEO nexus pipeline.
 *
 * Extracted artefacts:
 * - **Definitions**: functions, classes, methods, constructors (via
 *   {@link LanguageConfig.functionNodeTypes}, {@link LanguageConfig.classNodeTypes},
 *   {@link LanguageConfig.methodNodeTypes})
 * - **Imports**: import/use/include statements (via
 *   {@link LanguageConfig.importNodeTypes} + optional
 *   {@link LanguageConfig.importHandler} callback)
 * - **Heritage**: extends / implements relationships (via
 *   {@link LanguageConfig.inheritanceFieldPaths})
 * - **Calls**: method and free-function call sites (via
 *   {@link LanguageConfig.callNodeTypes})
 * - **Post-pass**: optional {@link LanguageConfig.extraWalkFn} for language
 *   quirks that don't fit the primary model (arrow functions, enum cases, etc.)
 *
 * @arch See graphify v7 inspiration: https://github.com/safishamsi/graphify
 *       branch v7, `_extract_generic` at `extract.py:933`.
 *
 * @module pipeline/extractors/generic-extractor
 */

import type { GraphNode, GraphNodeKind } from '@cleocode/contracts';
import type { ExtractedImport } from '../import-processor.js';
import type {
  ExtraWalkContext,
  GenericExtractionResult,
  LanguageConfig,
  SyntaxNode,
} from './language-config.js';
import type { ExtractedCall, ExtractedHeritage } from './typescript-extractor.js';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Convert 0-based tree-sitter row to 1-based line number. */
function toLine(row: number): number {
  return row + 1;
}

/** Derive a stable node ID from file path and symbol name. */
function nodeId(filePath: string, name: string): string {
  return `${filePath}::${name}`;
}

/** Default method names treated as constructors. */
const DEFAULT_CONSTRUCTOR_NAMES: ReadonlySet<string> = new Set(['<init>', 'constructor']);

/**
 * Resolve a dot-separated field path against an AST node.
 *
 * Single-segment paths (no dot) call `childForFieldName` directly.
 *
 * @example
 * ```ts
 * resolveFieldPath(node, 'name') // equivalent to node.childForFieldName('name')
 * ```
 */
function resolveFieldPath(node: SyntaxNode, path: string): SyntaxNode | null {
  const parts = path.split('.');
  let current: SyntaxNode | null = node;
  for (const part of parts) {
    current = current.childForFieldName(part);
    if (!current) return null;
  }
  return current;
}

/**
 * Extract parameter names from a parameter-list node.
 *
 * Handles the common pattern where each parameter node exposes a `name` field
 * or is an `identifier` node directly. Skips conventional receiver names
 * (`this`, `self`, `cls`).
 */
function extractParamNames(paramsNode: SyntaxNode): string[] {
  const names: string[] = [];
  const SKIP = new Set(['this', 'self', 'cls']);

  for (let i = 0; i < paramsNode.namedChildCount; i++) {
    const param = paramsNode.namedChild(i);
    if (!param) continue;

    const nameNode =
      param.childForFieldName('name') ?? (param.type === 'identifier' ? param : null);

    if (nameNode?.text && !SKIP.has(nameNode.text)) {
      names.push(nameNode.text);
    }
  }
  return names;
}

// ---------------------------------------------------------------------------
// Definition extraction helpers
// ---------------------------------------------------------------------------

/**
 * Emit a function / method / constructor node from a function-like AST node.
 *
 * @param node - The function declaration AST node
 * @param filePath - File path relative to repo root
 * @param config - Language configuration
 * @param parentName - Qualified parent class name, or undefined for top-level
 * @param results - Accumulator (mutated in place)
 */
function emitFunction(
  node: SyntaxNode,
  filePath: string,
  config: LanguageConfig,
  parentName: string | undefined,
  results: GraphNode[],
): void {
  const nameNode = resolveFieldPath(node, config.nameFieldPath);
  if (!nameNode) return;
  const name = nameNode.text;
  if (!name) return;

  const constructorNames = config.constructorNames ?? DEFAULT_CONSTRUCTOR_NAMES;
  const kind: GraphNodeKind = constructorNames.has(name) ? 'constructor' : 'function';

  const paramsNode = node.childForFieldName(config.parametersFieldPath);
  const parameters = paramsNode ? extractParamNames(paramsNode) : [];

  const qualifiedName = parentName ? `${parentName}.${name}` : name;
  const isExported = config.isExported ? config.isExported(node, name) : true;

  results.push({
    id: nodeId(filePath, qualifiedName),
    kind,
    name,
    filePath,
    startLine: toLine(node.startPosition.row),
    endLine: toLine(node.endPosition.row),
    language: config.language,
    exported: parentName ? false : isExported,
    parent: parentName ? nodeId(filePath, parentName) : undefined,
    parameters,
  });
}

/**
 * Emit a method node from a method declaration inside a class body.
 *
 * Sets kind to `'method'` unless the name matches a constructor name, in
 * which case kind is `'constructor'`.
 */
function emitMethod(
  node: SyntaxNode,
  filePath: string,
  config: LanguageConfig,
  parentName: string,
  results: GraphNode[],
): void {
  const nameNode = resolveFieldPath(node, config.nameFieldPath);
  if (!nameNode) return;
  const name = nameNode.text;
  if (!name) return;

  const constructorNames = config.constructorNames ?? DEFAULT_CONSTRUCTOR_NAMES;
  const isConstructorByType = config.constructorNodeTypes?.has(node.type) ?? false;
  const kind: GraphNodeKind =
    isConstructorByType || constructorNames.has(name) ? 'constructor' : 'method';

  const paramsNode = node.childForFieldName(config.parametersFieldPath);
  const parameters = paramsNode ? extractParamNames(paramsNode) : [];

  results.push({
    id: nodeId(filePath, `${parentName}.${name}`),
    kind,
    name,
    filePath,
    startLine: toLine(node.startPosition.row),
    endLine: toLine(node.endPosition.row),
    language: config.language,
    exported: false,
    parent: nodeId(filePath, parentName),
    parameters,
  });
}

/**
 * Collect all type names from an inheritance specifier node (possibly nested).
 *
 * Handles:
 * - Direct `type_identifier` → one name
 * - `generic_type` (`List<String>`) → base name only (e.g. `List`)
 * - `type_list` (Java `super_interfaces` child) → multiple names (recurse)
 * - Any other container → recurse into named children up to depth 3
 *
 * Returns all found type names so callers can emit one heritage record each.
 */
function collectTypeNames(node: SyntaxNode, config: LanguageConfig, depth: number = 0): string[] {
  if (depth > 3) return [];

  // Direct match: type_identifier or any node in inheritanceNameNodeTypes
  if (config.inheritanceNameNodeTypes.has(node.type)) {
    const text = node.text.trim();
    return text ? [text] : [];
  }

  // Generic type: `Comparable<String>` → just `Comparable`
  if (node.type === 'generic_type') {
    const inner = node.namedChild(0);
    if (inner) {
      if (config.inheritanceNameNodeTypes.has(inner.type)) {
        const text = inner.text.trim();
        return text ? [text] : [];
      }
    }
  }

  // Container node (e.g. `type_list`, `superclass`, `super_interfaces`,
  // `interface_type_list`): recurse into all named children
  const names: string[] = [];
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;
    const found = collectTypeNames(child, config, depth + 1);
    for (const n of found) names.push(n);
  }
  return names;
}

/**
 * Emit a class node and all methods in its body, plus heritage records.
 *
 * @param node - The class declaration AST node
 * @param filePath - File path relative to repo root
 * @param config - Language configuration
 * @param definitions - Accumulator for definition nodes (mutated in place)
 * @param heritage - Accumulator for heritage records (mutated in place)
 */
function emitClass(
  node: SyntaxNode,
  filePath: string,
  config: LanguageConfig,
  definitions: GraphNode[],
  heritage: ExtractedHeritage[],
): void {
  const nameNode = resolveFieldPath(node, config.nameFieldPath);
  if (!nameNode) return;
  const className = nameNode.text;
  if (!className) return;

  const isExported = config.isExported ? config.isExported(node, className) : true;
  const kind: GraphNodeKind = config.kindOverrides?.get(node.type) ?? 'class';

  definitions.push({
    id: nodeId(filePath, className),
    kind,
    name: className,
    filePath,
    startLine: toLine(node.startPosition.row),
    endLine: toLine(node.endPosition.row),
    language: config.language,
    exported: isExported,
  });

  // Emit heritage (extends / implements)
  for (const { fieldName, kind: heritageKind } of config.inheritanceFieldPaths) {
    const heritageNode = node.childForFieldName(fieldName);
    if (!heritageNode) continue;

    // Collect all type names from the heritage node (handles nested type_list)
    const parentTypeNames = collectTypeNames(heritageNode, config);
    for (const parentTypeName of parentTypeNames) {
      heritage.push({
        filePath,
        typeName: className,
        typeNodeId: nodeId(filePath, className),
        kind: heritageKind,
        parentName: parentTypeName,
      });
    }
  }

  // Emit methods inside the class body
  const bodyNode = node.childForFieldName(config.bodyFieldPath);
  if (!bodyNode) return;

  for (let i = 0; i < bodyNode.namedChildCount; i++) {
    const member = bodyNode.namedChild(i);
    if (!member) continue;

    if (config.methodNodeTypes.has(member.type)) {
      emitMethod(member, filePath, config, className, definitions);
    }
  }
}

// ---------------------------------------------------------------------------
// Call site extraction
// ---------------------------------------------------------------------------

/**
 * Emit a call record from a call expression node.
 *
 * Uses {@link LanguageConfig.callFunctionPath} to locate the callee identifier.
 */
function emitCall(
  node: SyntaxNode,
  filePath: string,
  config: LanguageConfig,
  results: ExtractedCall[],
): void {
  const calleeNode = resolveFieldPath(node, config.callFunctionPath);
  if (!calleeNode) return;

  const calledName = calleeNode.text;
  if (!calledName) return;

  results.push({
    filePath,
    calledName,
    sourceId: `${filePath}::__file__`,
    callForm: 'free',
  });
}

// ---------------------------------------------------------------------------
// Import extraction
// ---------------------------------------------------------------------------

/**
 * Process a single import-bearing AST node.
 *
 * Delegates to {@link LanguageConfig.importHandler} when set; otherwise
 * applies a default text-extraction strategy.
 */
function processImport(
  node: SyntaxNode,
  filePath: string,
  config: LanguageConfig,
  results: ExtractedImport[],
): void {
  if (config.importHandler) {
    const rawPath = node.text;
    config.importHandler({ node, filePath, rawPath }, results);
    return;
  }

  // Default: strip quotes and use raw text
  const rawImportPath = node.text.replace(/^['"`]|['"`]$/g, '').trim();
  if (rawImportPath) {
    results.push({ filePath, rawImportPath });
  }
}

// ---------------------------------------------------------------------------
// Post-pass extra walk
// ---------------------------------------------------------------------------

/**
 * Run {@link LanguageConfig.extraWalkFn} on every node in the subtree.
 *
 * Mirrors graphify's `_apply_extra_walk` helper. The callback receives a
 * shared mutable context so it can push records into any of the result arrays.
 */
function runExtraWalk(
  node: SyntaxNode,
  ctx: Omit<ExtraWalkContext, 'node'>,
  config: LanguageConfig,
): void {
  config.extraWalkFn!({ ...ctx, node });
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child) runExtraWalk(child, ctx, config);
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Extract all intelligence from a source file AST using a declarative
 * {@link LanguageConfig}.
 *
 * This is the TypeScript port of Graphify v7's `_extract_generic` walker
 * (`extract.py:933`). It performs a single-pass traversal of the AST,
 * emitting definitions, imports, heritage records, and call records based
 * on the configuration provided.
 *
 * The `tree` parameter is kept for API parity with future incremental-walk
 * support (tree-sitter's `Tree` object). It is currently unused.
 *
 * @param rootNode - The root node of the parsed tree-sitter AST
 * @param tree - Reserved for future incremental-walk support (currently unused)
 * @param fileNodeId - Node ID of the file, format `<filePath>::__file__`
 * @param config - Language-specific configuration record
 * @returns Full extraction result for the file
 *
 * @example
 * ```ts
 * import { extractGeneric } from './generic-extractor.js';
 * import { JAVA_CONFIG } from './java-extractor.js';
 *
 * const result = extractGeneric(
 *   rootNode,
 *   tree,
 *   'src/Main.java::__file__',
 *   JAVA_CONFIG,
 * );
 * ```
 *
 * @arch See graphify v7 `_extract_generic` at `extract.py:933` (794 lines).
 *       This implementation covers: function/class/method/import/heritage/call
 *       extraction plus an `extraWalkFn` escape hatch for language quirks.
 */
export function extractGeneric(
  rootNode: SyntaxNode,
  tree: unknown,
  fileNodeId: string,
  config: LanguageConfig,
): GenericExtractionResult {
  void tree; // reserved for future incremental-walk support

  // Derive file path from the node ID convention `<filePath>::__file__`
  const SUFFIX = '::__file__';
  const filePath = fileNodeId.endsWith(SUFFIX) ? fileNodeId.slice(0, -SUFFIX.length) : fileNodeId;

  const definitions: GraphNode[] = [];
  const imports: ExtractedImport[] = [];
  const heritage: ExtractedHeritage[] = [];
  const calls: ExtractedCall[] = [];

  /**
   * Primary scoped walker — single pass over the AST.
   *
   * - Classes: emit class + methods, then return (avoid double-visiting bodies)
   * - Top-level functions: emit immediately
   * - Imports: delegate to processImport
   * - Calls: delegate to emitCall
   * - Everything else: recurse into named children
   */
  function walk(node: SyntaxNode): void {
    const { type } = node;

    // Class-like: emit class + methods (class body is handled by emitClass)
    if (config.classNodeTypes.has(type)) {
      emitClass(node, filePath, config, definitions, heritage);
      return; // Do NOT recurse further — emitClass owns the body
    }

    // Top-level function (methods are handled inside emitClass above)
    if (config.functionNodeTypes.has(type)) {
      emitFunction(node, filePath, config, undefined, definitions);
    }

    // Import statement
    if (config.importNodeTypes.has(type)) {
      processImport(node, filePath, config, imports);
    }

    // Call expression
    if (config.callNodeTypes.has(type)) {
      emitCall(node, filePath, config, calls);
    }

    // Recurse into named children
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child) walk(child);
    }
  }

  // Run the primary walker over all root-level children
  for (let i = 0; i < rootNode.namedChildCount; i++) {
    const child = rootNode.namedChild(i);
    if (child) walk(child);
  }

  // Post-pass: optional language-specific extra walk
  if (config.extraWalkFn) {
    const ctx = { filePath, language: config.language, definitions, imports, heritage, calls };
    runExtraWalk(rootNode, ctx, config);
  }

  return { definitions, imports, heritage, calls };
}
