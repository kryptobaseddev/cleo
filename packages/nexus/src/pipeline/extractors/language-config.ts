/**
 * LanguageConfig — declarative per-language AST extraction configuration.
 *
 * Mirrors the `LanguageConfig` dataclass pattern from Graphify v7
 * (`graphify/extract.py:147–192`, branch `v7`, HEAD `ee85bbfb`). Each language
 * is described by a small declarative record of tree-sitter node type sets and
 * optional callbacks, which is then driven by the single
 * {@link ./generic-extractor.ts | generic-extractor} walker.
 *
 * In Graphify, 13 of 26 languages share one 794-line `_extract_generic` walker
 * parametrized by this structure. This port adopts the same model:
 * one walker per language category (mainstream OO / C-family / scripting),
 * reducing per-language code to a 20–40 line config declaration.
 *
 * @arch See graphify v7 inspiration: https://github.com/safishamsi/graphify
 *       branch v7, `extract.py` lines 147–192 and `_JAVA_CONFIG` at line 717.
 *
 * @module pipeline/extractors/language-config
 */

import type { GraphNode, GraphNodeKind } from '@cleocode/contracts';
import type { ExtractedImport } from '../import-processor.js';
import type { ExtractedCall, ExtractedHeritage } from './typescript-extractor.js';

// ---------------------------------------------------------------------------
// Re-export SyntaxNode so callers do not need to redeclare it
// ---------------------------------------------------------------------------

/**
 * Minimal tree-sitter SyntaxNode shape required by all extractors.
 * Avoids a hard dependency on any particular tree-sitter type package.
 */
export interface SyntaxNode {
  type: string;
  text: string;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  children: SyntaxNode[];
  namedChildren: SyntaxNode[];
  namedChildCount: number;
  isNamed: boolean;
  parent: SyntaxNode | null;
  previousSibling: SyntaxNode | null;
  childForFieldName(fieldName: string): SyntaxNode | null;
  namedChild(index: number): SyntaxNode | null;
}

// ---------------------------------------------------------------------------
// GenericExtractionResult — the uniform contract for all generic extractors
// ---------------------------------------------------------------------------

/**
 * Full extraction result for one source file.
 *
 * Matches the shape returned by the language-specific extractors
 * ({@link TypeScriptExtractionResult}, {@link PythonExtractionResult}, etc.)
 * minus the TS-only `reExports` field, which is not part of the generic path.
 *
 * @see {@link ./generic-extractor.ts | extractGeneric}
 */
export interface GenericExtractionResult {
  /** Symbol definition nodes extracted from the file. */
  definitions: GraphNode[];
  /** Raw import records for the import-processor fast-path. */
  imports: ExtractedImport[];
  /** Heritage clauses (extends / implements) for heritage edge emission. */
  heritage: ExtractedHeritage[];
  /** Call expressions for CALLS edge emission. */
  calls: ExtractedCall[];
}

// ---------------------------------------------------------------------------
// ImportHandlerContext — argument bag passed to import_handler callbacks
// ---------------------------------------------------------------------------

/**
 * Context bag passed to {@link LanguageConfig.importHandler} when the generic
 * walker encounters an import-bearing node.
 *
 * Mirrors graphify's pattern of passing the raw node plus accumulated context
 * to allow language-specific resolution (e.g. tsconfig alias expansion for JS,
 * package prefix for Java).
 */
export interface ImportHandlerContext {
  /** The AST node that triggered the import handler (e.g. `import_declaration`). */
  node: SyntaxNode;
  /** File path relative to repo root. */
  filePath: string;
  /** Raw import path string before any resolution. */
  rawPath: string;
}

// ---------------------------------------------------------------------------
// ExtraWalkContext — argument bag passed to extra_walk_fn callbacks
// ---------------------------------------------------------------------------

/**
 * Context bag passed to {@link LanguageConfig.extraWalkFn} for each AST node
 * visited during the generic walker's post-pass.
 *
 * The callback may push additional {@link GraphNode}, {@link ExtractedImport},
 * {@link ExtractedHeritage}, or {@link ExtractedCall} records into the
 * corresponding result arrays.
 *
 * Mirrors graphify's `extra_walk_fn` escape hatch used for JS arrow functions,
 * C# namespace traversal, and Swift enum cases (`extract.py:191`).
 */
export interface ExtraWalkContext {
  /** The current AST node being visited. */
  node: SyntaxNode;
  /** File path relative to repo root. */
  filePath: string;
  /** Language string (e.g. `'java'`). */
  language: string;
  /** Mutable accumulator for additional definition nodes. */
  definitions: GraphNode[];
  /** Mutable accumulator for additional import records. */
  imports: ExtractedImport[];
  /** Mutable accumulator for additional heritage records. */
  heritage: ExtractedHeritage[];
  /** Mutable accumulator for additional call records. */
  calls: ExtractedCall[];
}

// ---------------------------------------------------------------------------
// LanguageConfig — the 18-field declarative config dataclass
// ---------------------------------------------------------------------------

/**
 * Declarative configuration that parametrizes the generic AST walker for one
 * source language.
 *
 * Fields mirror Graphify v7's `LanguageConfig` dataclass
 * (`extract.py:147–192`) with TypeScript idioms:
 * - Python `frozenset` → `ReadonlySet<string>`
 * - Python `Callable | None` → optional function type
 * - Python `str` field paths → string literals (used by `childForFieldName`)
 *
 * Not every field is required — optional fields default to safe no-ops in the
 * generic walker.
 *
 * @example Minimal config for a hypothetical language:
 * ```ts
 * const MY_LANG_CONFIG: LanguageConfig = {
 *   language: 'mylang',
 *   functionNodeTypes: new Set(['function_definition']),
 *   classNodeTypes: new Set(['class_definition']),
 *   methodNodeTypes: new Set(['method_definition']),
 *   nameFieldPath: 'name',
 *   bodyFieldPath: 'body',
 *   parametersFieldPath: 'parameters',
 * };
 * ```
 *
 * @arch See graphify v7 inspiration — `LanguageConfig` dataclass at
 *       `extract.py:147–192` and `_JAVA_CONFIG` at `extract.py:717`.
 */
export interface LanguageConfig {
  // -------------------------------------------------------------------------
  // Identity
  // -------------------------------------------------------------------------

  /**
   * Language string stored on every emitted {@link GraphNode}.
   * Examples: `'java'`, `'kotlin'`, `'c_sharp'`.
   */
  language: string;

  // -------------------------------------------------------------------------
  // Definition node types (field 1–6 in graphify's dataclass)
  // -------------------------------------------------------------------------

  /**
   * AST node types that represent top-level or nested function definitions.
   *
   * graphify equivalent: `function_types`
   * @example `new Set(['method_declaration', 'constructor_declaration'])` for Java
   */
  functionNodeTypes: ReadonlySet<string>;

  /**
   * AST node types that represent class or class-like declarations.
   *
   * graphify equivalent: `class_types`
   * @example `new Set(['class_declaration', 'interface_declaration', 'enum_declaration'])` for Java
   */
  classNodeTypes: ReadonlySet<string>;

  /**
   * AST node types that represent methods defined inside a class body.
   * Often overlaps with {@link functionNodeTypes} in languages like Java.
   *
   * graphify equivalent: `method_node_types`
   * @example `new Set(['method_declaration'])` for Java
   */
  methodNodeTypes: ReadonlySet<string>;

  // -------------------------------------------------------------------------
  // Field paths (field 7–10)
  // -------------------------------------------------------------------------

  /**
   * Tree-sitter field name used to extract the symbol's identifier node.
   * Passed directly to `node.childForFieldName(nameFieldPath)`.
   *
   * graphify equivalent: `name_field`
   * @example `'name'` for most languages
   */
  nameFieldPath: string;

  /**
   * Tree-sitter field name used to locate the class/function body.
   * Passed to `node.childForFieldName(bodyFieldPath)`.
   *
   * graphify equivalent: `body_field`
   * @example `'body'` for most languages
   */
  bodyFieldPath: string;

  /**
   * Tree-sitter field name used to locate the parameter list.
   * Passed to `node.childForFieldName(parametersFieldPath)`.
   *
   * graphify equivalent: implicit in `function_types` handling
   * @example `'parameters'` for Java, Python; `'formal_parameters'` for some grammars
   */
  parametersFieldPath: string;

  // -------------------------------------------------------------------------
  // Inheritance / heritage (field 11–12)
  // -------------------------------------------------------------------------

  /**
   * Tree-sitter field name(s) on the class node that hold the superclass /
   * interface list. Used to emit {@link ExtractedHeritage} records.
   *
   * In Java: `'superclass'` → `extends Foo`; `'interfaces'` → `implements Bar, Baz`.
   * Set to an empty array if the language has no nominal inheritance (e.g. Go).
   *
   * graphify equivalent: `inheritance_specifier_search`
   */
  inheritanceFieldPaths: ReadonlyArray<{
    /** Tree-sitter field name on the class node. */
    fieldName: string;
    /** Heritage kind to emit for nodes found under this field. */
    kind: 'extends' | 'implements';
  }>;

  /**
   * AST node types within an inheritance specifier list that hold the actual
   * parent type name. Used alongside {@link inheritanceFieldPaths}.
   *
   * graphify equivalent: `field_specifier_search`
   * @example `new Set(['type_identifier'])` for Java
   */
  inheritanceNameNodeTypes: ReadonlySet<string>;

  // -------------------------------------------------------------------------
  // Call site extraction (field 13–14)
  // -------------------------------------------------------------------------

  /**
   * AST node types that represent a call expression.
   *
   * graphify equivalent: `call_node_types`
   * @example `new Set(['method_invocation', 'object_creation_expression'])` for Java
   */
  callNodeTypes: ReadonlySet<string>;

  /**
   * Tree-sitter field path on a call node to reach the callee identifier.
   * May be a dot-path like `'name'` or `'function.name'` (resolved by the
   * generic walker as a sequence of `childForFieldName` calls).
   *
   * graphify equivalent: `call_function_path`
   * @example `'name'` for Java `method_invocation`
   */
  callFunctionPath: string;

  // -------------------------------------------------------------------------
  // Import extraction (field 15)
  // -------------------------------------------------------------------------

  /**
   * AST node types that represent import/use/include statements at the top of
   * a file.
   *
   * graphify equivalent: `import_types`
   * @example `new Set(['import_declaration'])` for Java
   */
  importNodeTypes: ReadonlySet<string>;

  /**
   * Optional language-specific import handler callback.
   *
   * When present, invoked for each node whose type is in {@link importNodeTypes}.
   * The callback MUST push zero or more {@link ExtractedImport} records into the
   * provided results array. If absent, the generic walker applies a default
   * text-extraction strategy.
   *
   * Mirrors graphify's `import_handler: Callable | None` pattern
   * (`extract.py:189`) — the escape hatch for complex import semantics (tsconfig
   * aliases, namespace prefixes, Java package paths).
   *
   * @param ctx - Import handler context
   * @param results - Mutable results array; push records here
   */
  importHandler?: (ctx: ImportHandlerContext, results: ExtractedImport[]) => void;

  // -------------------------------------------------------------------------
  // Reference / use extraction (field 16–17)
  // -------------------------------------------------------------------------

  /**
   * AST node types that represent "uses" or "references" to a symbol (e.g.
   * `identifier` in an expression context). Used for potential future ACCESSES
   * edge extraction. Optional; set to empty if not needed.
   *
   * graphify equivalent: `use_node_types`
   */
  useNodeTypes?: ReadonlySet<string>;

  /**
   * AST node types that represent explicit references (e.g. a type annotation
   * or qualified name reference). Optional.
   *
   * graphify equivalent: `reference_node_types`
   */
  referenceNodeTypes?: ReadonlySet<string>;

  // -------------------------------------------------------------------------
  // Post-pass escape hatch (field 18)
  // -------------------------------------------------------------------------

  /**
   * Optional post-pass callback invoked for every AST node after the primary
   * walker has finished.
   *
   * Used for language quirks that don't fit the generic model:
   * - JS: arrow-function constants (`const foo = () => {}`)
   * - C#: namespace traversal
   * - Swift: enum `case_of` edges and extension declarations
   *
   * Mirrors graphify's `extra_walk_fn` field (`extract.py:191`).
   *
   * @param ctx - Extra walk context with mutable result arrays
   */
  extraWalkFn?: (ctx: ExtraWalkContext) => void;

  // -------------------------------------------------------------------------
  // Export detection (language-specific predicate)
  // -------------------------------------------------------------------------

  /**
   * Optional predicate to determine whether a given node or name should be
   * marked `exported: true` on the emitted {@link GraphNode}.
   *
   * If absent, the generic walker defaults to `true` for all top-level symbols
   * (consistent with Python's convention that all public names are exported).
   *
   * @param node - The AST node representing the symbol declaration
   * @param name - The symbol's extracted name
   * @returns `true` if the symbol should be considered exported
   */
  isExported?: (node: SyntaxNode, name: string) => boolean;

  // -------------------------------------------------------------------------
  // GraphNodeKind overrides (optional — lets configs specify non-default kinds)
  // -------------------------------------------------------------------------

  /**
   * Optional map from a class-level AST node type to the {@link GraphNodeKind}
   * that should be emitted for that node.
   *
   * When absent, the generic walker defaults to:
   * - nodes in {@link classNodeTypes} → `'class'`
   * - nodes in {@link methodNodeTypes} → `'method'` (or `'constructor'` for `<init>`)
   * - nodes in {@link functionNodeTypes} → `'function'`
   *
   * @example
   * ```ts
   * kindOverrides: new Map([
   *   ['interface_declaration', 'interface'],
   *   ['enum_declaration', 'enum'],
   * ])
   * ```
   */
  kindOverrides?: ReadonlyMap<string, GraphNodeKind>;

  /**
   * Optional set of method names that should be emitted with kind `'constructor'`
   * instead of `'method'`.
   *
   * Defaults to `new Set(['<init>', 'constructor'])` if absent.
   *
   * @example `new Set(['<init>'])` for Java
   */
  constructorNames?: ReadonlySet<string>;

  /**
   * Optional set of AST node types that always emit as kind `'constructor'`,
   * regardless of the method name.
   *
   * Useful for languages like Java where constructor nodes have a distinct
   * tree-sitter node type (`constructor_declaration`) but use the class name
   * as the method name (not `<init>` or `constructor`).
   *
   * @example `new Set(['constructor_declaration'])` for Java
   */
  constructorNodeTypes?: ReadonlySet<string>;
}
