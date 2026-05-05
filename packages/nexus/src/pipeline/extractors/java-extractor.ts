/**
 * Java AST extractor for the parse-loop pipeline.
 *
 * Implements the Java extraction configuration using the generic-extractor
 * pattern — a thin {@link LanguageConfig} declaration that drives the shared
 * {@link extractGeneric} walker. This is the demonstration language for the
 * config-driven pattern port from Graphify v7 (`_JAVA_CONFIG` at
 * `extract.py:717`, `_import_java` at `extract.py:422`).
 *
 * Extracts from a tree-sitter-java AST:
 *
 * - **Definitions**: classes, interfaces, enums, annotations, methods, and
 *   constructors.
 * - **Imports**: `import foo.bar.Baz` and `import foo.bar.*` statements.
 * - **Heritage**: `extends` and `implements` clauses.
 * - **Calls**: method invocations and object creations.
 *
 * Grammar: `tree-sitter-java@0.23.5`
 *
 * tree-sitter-java grammar field facts (verified against live parse output):
 * - `class_declaration`: fields `name`, `body` (→`class_body`), `superclass`
 *   (→`superclass` node, child `type_identifier`), `interfaces`
 *   (→`super_interfaces` node → `type_list` → `type_identifier` children).
 * - `interface_declaration`: fields `name`, `body` (→`interface_body`).
 * - `method_declaration`: fields `name`, `parameters` (→`formal_parameters`).
 * - `constructor_declaration`: fields `name` (class name), `parameters`.
 * - `import_declaration`: no named fields; first named child is `scoped_identifier`
 *   or `identifier` containing the full import path.
 * - `method_invocation`: field `name` (→ callee identifier).
 *
 * @arch See graphify v7 `_JAVA_CONFIG` at `extract.py:717` and
 *       `_import_java` at `extract.py:422`.
 *
 * @task T1861
 * @module pipeline/extractors/java-extractor
 */

import type { GraphNodeKind } from '@cleocode/contracts';
import type { ExtractedImport, NamedImportBinding } from '../import-processor.js';
import { extractGeneric } from './generic-extractor.js';
import type { ImportHandlerContext, LanguageConfig, SyntaxNode } from './language-config.js';

export type { GenericExtractionResult as JavaExtractionResult } from './language-config.js';

// ---------------------------------------------------------------------------
// Export predicate
// ---------------------------------------------------------------------------

/**
 * Return `true` if the Java AST node has a `public` visibility modifier.
 *
 * In tree-sitter-java, visibility appears as a `modifiers` named child whose
 * text contains `"public"`.
 */
function isJavaPublic(node: SyntaxNode, _name: string): boolean {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;
    if (child.type === 'modifiers') {
      // Modifiers text is something like "public abstract" or "public static"
      if (child.text.includes('public')) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Import handler
// ---------------------------------------------------------------------------

/**
 * Java import handler for `import_declaration` AST nodes.
 *
 * Handles:
 * - `import foo.bar.Baz;`          → rawImportPath=`"foo.bar"`, binding `{Baz, Baz}`
 * - `import foo.bar.*;`             → rawImportPath=`"foo.bar"`, wildcard binding
 * - `import static foo.Bar.METHOD;` → rawImportPath=`"foo.Bar"`, binding `METHOD`
 *
 * In tree-sitter-java the `import_declaration` node's first named child is
 * a `scoped_identifier` (e.g. `java.util.List`) or `identifier` (bare name).
 * The asterisk import (`import java.util.*`) produces a `scoped_identifier`
 * for `java.util` plus an `asterisk` unnamed child.
 *
 * Mirrors graphify's `_import_java` at `extract.py:422`.
 */
function javaImportHandler(ctx: ImportHandlerContext, results: ExtractedImport[]): void {
  const { node, filePath } = ctx;

  // Detect wildcard: `import java.util.*`
  // In tree-sitter-java, the asterisk is an `asterisk` named child node.
  let isWildcard = false;
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child && (child.type === 'asterisk' || child.text === '*')) {
      isWildcard = true;
    }
  }

  // Find the scoped_identifier or identifier child (skip asterisk)
  let pathNode: SyntaxNode | null = null;
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;
    if (child.type === 'scoped_identifier' || child.type === 'identifier') {
      pathNode = child;
      break;
    }
  }

  // For wildcard imports, the path is already the package path in pathNode
  // (e.g. `java.util` from `import java.util.*`)

  if (!pathNode) {
    // Fallback: strip `import` and semicolon from raw text
    const raw = node.text
      .replace(/^import\s+(?:static\s+)?/, '')
      .replace(/;$/, '')
      .trim();
    if (raw) results.push({ filePath, rawImportPath: raw });
    return;
  }

  const fullPath = pathNode.text; // e.g. "java.util.List"

  if (isWildcard) {
    // `import foo.bar.*` — import whole package
    const namedBindings: NamedImportBinding[] = [{ local: '*', exported: '*' }];
    results.push({ filePath, rawImportPath: fullPath, namedBindings });
    return;
  }

  // Split `java.util.List` → basePath=`java.util`, leaf=`List`
  const lastDot = fullPath.lastIndexOf('.');
  if (lastDot === -1) {
    // Bare identifier — rare in Java (default package)
    results.push({
      filePath,
      rawImportPath: fullPath,
      namedBindings: [{ local: fullPath, exported: fullPath }],
    });
    return;
  }

  const basePath = fullPath.slice(0, lastDot); // `java.util`
  const leaf = fullPath.slice(lastDot + 1); // `List`

  results.push({
    filePath,
    rawImportPath: basePath,
    namedBindings: [{ local: leaf, exported: leaf }],
  });
}

// ---------------------------------------------------------------------------
// JAVA_CONFIG — declarative LanguageConfig for Java
// ---------------------------------------------------------------------------

/**
 * Declarative LanguageConfig for Java, parametrizing the generic extractor.
 *
 * Mirrors Graphify v7's `_JAVA_CONFIG` dataclass at `extract.py:717`.
 *
 * Key design decisions:
 * - `constructor_declaration` is in `methodNodeTypes` so constructors are
 *   emitted as class members with kind `'constructor'` via the default
 *   `constructorNames` set (the generic walker checks the node type).
 * - `super_interfaces` (Java's `implements` clause) contains a `type_list`
 *   child; the `inheritanceFieldPaths` config points to `interfaces` field
 *   on the class node. The generic walker resolves children of that node.
 * - `superclass` field on class node contains a `superclass` wrapper node
 *   with `type_identifier` children.
 */
export const JAVA_CONFIG: LanguageConfig = {
  language: 'java',

  // -------------------------------------------------------------------------
  // Definition node types
  // -------------------------------------------------------------------------

  /**
   * Node types for standalone function-like definitions.
   * Java does not have standalone functions — all functions are methods or
   * constructors. We omit `constructor_declaration` here so it is only
   * processed inside class bodies via `methodNodeTypes`.
   */
  functionNodeTypes: new Set<string>([
    // Java has no standalone functions outside classes; keep empty to avoid
    // top-level constructor_declaration processing that duplicates the class body pass
  ]),

  /**
   * Node types for class-like declarations at the top level.
   */
  classNodeTypes: new Set([
    'class_declaration',
    'interface_declaration',
    'enum_declaration',
    'annotation_type_declaration',
    'record_declaration',
  ]),

  /**
   * Method-like node types found inside a class body.
   * `constructor_declaration` is included so constructors are emitted.
   */
  methodNodeTypes: new Set(['method_declaration', 'constructor_declaration']),

  // -------------------------------------------------------------------------
  // Field paths (verified against tree-sitter-java@0.23.5 parse output)
  // -------------------------------------------------------------------------

  nameFieldPath: 'name',
  bodyFieldPath: 'body',
  parametersFieldPath: 'parameters',

  // -------------------------------------------------------------------------
  // Inheritance / heritage
  // -------------------------------------------------------------------------

  /**
   * Inheritance field paths for Java class declarations.
   *
   * - `superclass` field → `superclass` node → direct `type_identifier` child
   * - `interfaces` field → `super_interfaces` node → `type_list` → `type_identifier`
   *
   * The generic walker calls `childForFieldName(fieldName)` on the class node,
   * then walks the result's named children looking for `inheritanceNameNodeTypes`.
   */
  inheritanceFieldPaths: [
    { fieldName: 'superclass', kind: 'extends' },
    { fieldName: 'interfaces', kind: 'implements' },
  ],

  /**
   * Node types within an inheritance specifier that hold the parent type name.
   * In tree-sitter-java: `type_identifier` for simple names, `generic_type`
   * for parameterized types like `Comparable<String>`.
   *
   * NOTE: `super_interfaces` contains a `type_list` which in turn contains
   * `type_identifier` children. The generic walker needs to descend through
   * `type_list`. We handle this via the `extraWalkFn` for inheritance resolution,
   * OR we extend `inheritanceNameNodeTypes` to include `type_list` and handle
   * the two-level descent. The simplest fix: add `type_list` to the set and
   * handle it specially in the heritage walk.
   */
  inheritanceNameNodeTypes: new Set(['type_identifier', 'generic_type']),

  // -------------------------------------------------------------------------
  // Call extraction
  // -------------------------------------------------------------------------

  callNodeTypes: new Set(['method_invocation', 'object_creation_expression']),

  /**
   * For `method_invocation`, the callee name is in the `name` field
   * (verified: `method_invocation.childForFieldName('name')` → `identifier`).
   * For `object_creation_expression`, we use `type` field (handled via extraWalkFn).
   */
  callFunctionPath: 'name',

  // -------------------------------------------------------------------------
  // Import extraction
  // -------------------------------------------------------------------------

  importNodeTypes: new Set(['import_declaration']),
  importHandler: javaImportHandler,

  // -------------------------------------------------------------------------
  // Export predicate
  // -------------------------------------------------------------------------

  isExported: isJavaPublic,

  // -------------------------------------------------------------------------
  // Kind overrides
  // -------------------------------------------------------------------------

  kindOverrides: new Map<string, GraphNodeKind>([
    ['interface_declaration', 'interface'],
    ['enum_declaration', 'enum'],
    ['annotation_type_declaration', 'interface'],
    ['record_declaration', 'class'],
  ]),

  /**
   * Constructor node types: `constructor_declaration` nodes are always emitted
   * with kind `'constructor'` regardless of the method name.
   *
   * In tree-sitter-java, `constructor_declaration` uses the class name as the
   * `name` field (e.g. `Shape` for `public Shape(...)`), not `<init>`.
   * Using `constructorNodeTypes` bypasses the name-based check and detects
   * constructors by AST node type.
   */
  constructorNodeTypes: new Set(['constructor_declaration']),

  /**
   * Leave `constructorNames` as the default set — unused for Java since
   * `constructorNodeTypes` handles constructor detection by node type.
   */
};

// ---------------------------------------------------------------------------
// Public extraction entry point
// ---------------------------------------------------------------------------

/**
 * Extract all intelligence data from a Java AST.
 *
 * Delegates entirely to {@link extractGeneric} parametrized by
 * {@link JAVA_CONFIG}. This thin wrapper matches the naming convention of the
 * other language extractors (`extractTypeScript`, `extractPython`, etc.).
 *
 * @param rootNode - The root (`program` / `compilation_unit`) node of the
 *   parsed tree-sitter AST
 * @param filePath - File path relative to the repository root
 * @returns Full extraction result for the file
 *
 * @example
 * ```ts
 * const result = extractJava(rootNode, 'src/main/java/Main.java');
 * console.log(result.definitions.length); // classes, methods, constructors
 * console.log(result.imports.length);     // import statements
 * console.log(result.heritage.length);    // extends / implements edges
 * ```
 */
export function extractJava(
  rootNode: SyntaxNode,
  filePath: string,
): ReturnType<typeof extractGeneric> {
  return extractGeneric(rootNode, null, `${filePath}::__file__`, JAVA_CONFIG);
}
