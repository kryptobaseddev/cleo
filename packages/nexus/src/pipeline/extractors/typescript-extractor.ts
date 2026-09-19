/**
 * TypeScript/JavaScript AST extractor for the parse-loop pipeline.
 *
 * Extracts from a tree-sitter AST:
 *
 * - **Definitions**: functions, classes (with methods/properties), interfaces,
 *   type aliases, enums, and `const foo = () => {}` arrow-function constants.
 * - **Imports**: ES module `import` statements — named, default, namespace,
 *   and side-effect — returned as {@link ExtractedImport} records for the
 *   import-processor's fast-path.
 * - **Heritage**: `extends` and `implements` clauses from class and interface
 *   declarations, returned as {@link ExtractedHeritage} records for the
 *   heritage-processor.
 *
 * Adapted from the existing CLEO TypeScript intelligence provider
 * (`packages/nexus/src/intelligence/providers/typescript.ts`) and extended
 * with import/heritage extraction aligned to the pipeline fast-path contract
 * established by the import-processor (T533).
 *
 * Tree-sitter query patterns are ported from GitNexus
 * `src/core/ingestion/languages/typescript.ts` and adapted for the CLEO
 * node type system.
 *
 * @task T534
 * @module pipeline/extractors/typescript-extractor
 */

import { createHash } from 'node:crypto';
import type { GraphNode, GraphNodeKind } from '@cleocode/contracts';
import type { GraphLexicalResolution, GraphSourceSpan } from '@cleocode/contracts/graph';
import type Parser from 'tree-sitter';
import type { ExtractedImport, NamedImportBinding } from '../import-processor.js';
import { buildLexicalScopeModel, type LexicalScopeModel } from '../lexical-scope.js';

// ---------------------------------------------------------------------------
// Re-exported types consumed by the parse loop
// ---------------------------------------------------------------------------

/**
 * A heritage relationship extracted from a class or interface declaration.
 *
 * Used to emit EXTENDS and IMPLEMENTS edges after all files have been parsed
 * (so the implementor map is complete).
 */
export interface ExtractedHeritage {
  /** Relative file path of the declaring type. */
  filePath: string;
  /** Name of the class or interface that extends/implements. */
  typeName: string;
  /** Node ID of the declaring type (for graph edge creation). */
  typeNodeId: string;
  /** Type of heritage relationship. */
  kind: 'extends' | 'implements';
  /** Name of the parent type or interface being extended/implemented. */
  parentName: string;
}

// ---------------------------------------------------------------------------
// Minimal SyntaxNode interface (mirrors intelligence/language-provider.ts)
// ---------------------------------------------------------------------------

/**
 * Minimal tree-sitter SyntaxNode shape required by this extractor.
 * Avoids a hard dependency on any particular tree-sitter type package.
 */
type SyntaxNode = Parser.SyntaxNode;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert 0-based tree-sitter row to 1-based line number. */
function toLine(row: number): number {
  return row + 1;
}

/** Derive a stable node ID from file path and symbol name. */
function nodeId(filePath: string, name: string): string {
  return `${filePath}::${name}`;
}

/**
 * Check whether a node carries an `export` keyword or has an export_statement
 * parent.
 */
function isExported(node: SyntaxNode): boolean {
  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i];
    if (child && !child.isNamed && child.text === 'export') return true;
  }
  return node.parent?.type === 'export_statement';
}

/** Extract the first JSDoc/line comment preceding a node. */
function extractDocSummary(node: SyntaxNode): string | undefined {
  let sibling = node.previousSibling;
  while (sibling?.type === 'decorator') {
    sibling = sibling.previousSibling;
  }
  if (!sibling || sibling.type !== 'comment') return undefined;
  const raw = sibling.text;
  if (!raw.startsWith('/**') && !raw.startsWith('//')) return undefined;
  const lines = raw
    .replace(/^\/\*\*/, '')
    .replace(/\*\/$/, '')
    .split('\n')
    .map((l) => l.replace(/^\s*\*\s?/, '').trim())
    .filter((l) => l.length > 0 && !l.startsWith('@'));
  return lines[0];
}

/** Extract parameter names from a `formal_parameters` or `parameters` node. */
function extractParamNames(paramsNode: SyntaxNode): string[] {
  const names: string[] = [];
  for (let i = 0; i < paramsNode.namedChildCount; i++) {
    const param = paramsNode.namedChild(i);
    if (!param) continue;
    const patternNode =
      param.childForFieldName('pattern') ?? param.childForFieldName('name') ?? param;
    const text = patternNode.text;
    if (text) names.push(text);
  }
  return names;
}

/** Read a return type annotation from a function or method node. */
function extractReturnType(funcNode: SyntaxNode): string | undefined {
  const retTypeNode = funcNode.childForFieldName('return_type');
  if (!retTypeNode) return undefined;
  const text = retTypeNode.text.replace(/^:\s*/, '').trim();
  return text || undefined;
}

// ---------------------------------------------------------------------------
// Definition extraction
// ---------------------------------------------------------------------------

/** AST node types that can carry top-level declarations. */
const CONTAINER_TYPES: ReadonlySet<string> = new Set([
  'program',
  'module',
  'namespace',
  'internal_module',
  'module_declaration',
]);

/** Declaration types that can appear inside an export_statement. */
const EXPORTABLE_DECLARATION_TYPES: ReadonlySet<string> = new Set([
  'function_declaration',
  'generator_function_declaration',
  'class_declaration',
  'abstract_class_declaration',
  'interface_declaration',
  'type_alias_declaration',
  'enum_declaration',
  'lexical_declaration',
  'variable_declaration',
]);

/**
 * Walk the AST to extract documentary/type declarations; the lexical model supplies callables.
 *
 * @param node - Current AST node
 * @param filePath - File path relative to repo root
 * @param language - Language string (typescript or javascript)
 * @param results - Accumulator for extracted GraphNodes (mutated in place)
 */
function walkDefinitions(
  node: SyntaxNode,
  filePath: string,
  language: string,
  results: GraphNode[],
): void {
  switch (node.type) {
    case 'interface_declaration': {
      for (const n of buildInterfaceNodes(node, filePath, language)) results.push(n);
      break;
    }
    case 'type_alias_declaration': {
      const alias = buildTypeAliasNode(node, filePath, language);
      if (alias) results.push(alias);
      break;
    }
    case 'enum_declaration': {
      const en = buildEnumNode(node, filePath, language);
      if (en) results.push(en);
      break;
    }
    case 'export_statement': {
      // Recurse into the exported declaration
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child && EXPORTABLE_DECLARATION_TYPES.has(child.type)) {
          walkDefinitions(child, filePath, language, results);
        }
      }
      break;
    }
    default:
      break;
  }

  // Only recurse into container nodes — avoids descending into function bodies
  if (CONTAINER_TYPES.has(node.type)) {
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child) walkDefinitions(child, filePath, language, results);
    }
  }
}

/** Build GraphNodes for a class_declaration (class + methods + fields). */
function buildClassNodes(node: SyntaxNode, filePath: string, language: string): GraphNode[] {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return [];
  const className = nameNode.text;
  if (!className) return [];

  const classExported = isExported(node);
  const classNode: GraphNode = {
    id: nodeId(filePath, className),
    kind: 'class' as GraphNodeKind,
    name: className,
    filePath,
    startLine: toLine(node.startPosition.row),
    endLine: toLine(node.endPosition.row),
    language,
    exported: classExported,
    docSummary: extractDocSummary(node),
  };

  const results: GraphNode[] = [classNode];

  const bodyNode = node.childForFieldName('body');
  if (!bodyNode) return results;

  for (let i = 0; i < bodyNode.namedChildCount; i++) {
    const member = bodyNode.namedChild(i);
    if (!member) continue;

    if (member.type === 'method_definition') {
      const methodNameNode = member.childForFieldName('name');
      if (!methodNameNode) continue;
      const methodName = methodNameNode.text;
      if (!methodName) continue;

      const kind: GraphNodeKind = methodName === 'constructor' ? 'constructor' : 'method';

      const paramsNode =
        member.childForFieldName('parameters') ?? member.childForFieldName('formal_parameters');
      const parameters = paramsNode ? extractParamNames(paramsNode) : [];

      results.push({
        id: nodeId(filePath, `${className}.${methodName}`),
        kind,
        name: methodName,
        filePath,
        startLine: toLine(member.startPosition.row),
        endLine: toLine(member.endPosition.row),
        language,
        exported: false,
        parent: nodeId(filePath, className),
        parameters,
        returnType: extractReturnType(member),
        docSummary: extractDocSummary(member),
      });
    }

    if (member.type === 'public_field_definition') {
      const fieldNameNode = member.childForFieldName('name');
      if (!fieldNameNode) continue;
      const fieldName = fieldNameNode.text;
      if (!fieldName) continue;

      results.push({
        id: nodeId(filePath, `${className}.${fieldName}`),
        kind: 'property' as GraphNodeKind,
        name: fieldName,
        filePath,
        startLine: toLine(member.startPosition.row),
        endLine: toLine(member.endPosition.row),
        language,
        exported: false,
        parent: nodeId(filePath, className),
      });
    }
  }

  return results;
}

/**
 * Build GraphNodes for an interface_declaration (interface + method signatures).
 *
 * Extracts both the interface node itself and its method signature members
 * so that METHOD_IMPLEMENTS edges can be emitted (T1847).
 */
function buildInterfaceNodes(node: SyntaxNode, filePath: string, language: string): GraphNode[] {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return [];
  const name = nameNode.text;
  if (!name) return [];

  const ifaceExported = isExported(node);
  const ifaceNode: GraphNode = {
    id: nodeId(filePath, name),
    kind: 'interface' as GraphNodeKind,
    name,
    filePath,
    startLine: toLine(node.startPosition.row),
    endLine: toLine(node.endPosition.row),
    language,
    exported: ifaceExported,
    docSummary: extractDocSummary(node),
  };

  const results: GraphNode[] = [ifaceNode];

  const bodyNode = node.childForFieldName('body');
  if (!bodyNode) return results;

  for (let i = 0; i < bodyNode.namedChildCount; i++) {
    const member = bodyNode.namedChild(i);
    if (!member) continue;
    if (member.type !== 'method_signature') continue;

    const methodNameNode = member.childForFieldName('name');
    if (!methodNameNode) continue;
    const methodName = methodNameNode.text;
    if (!methodName) continue;

    const paramsNode =
      member.childForFieldName('parameters') ?? member.childForFieldName('formal_parameters');
    const parameters = paramsNode ? extractParamNames(paramsNode) : [];

    results.push({
      id: nodeId(filePath, `${name}.${methodName}`),
      kind: 'method' as GraphNodeKind,
      name: methodName,
      filePath,
      startLine: toLine(member.startPosition.row),
      endLine: toLine(member.endPosition.row),
      language,
      exported: false,
      parent: nodeId(filePath, name),
      parameters,
      returnType: extractReturnType(member),
      docSummary: extractDocSummary(member),
    });
  }

  return results;
}

/** Build a GraphNode for a type_alias_declaration. */
function buildTypeAliasNode(
  node: SyntaxNode,
  filePath: string,
  language: string,
): GraphNode | null {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return null;
  const name = nameNode.text;
  if (!name) return null;

  return {
    id: nodeId(filePath, name),
    kind: 'type' as GraphNodeKind,
    name,
    filePath,
    startLine: toLine(node.startPosition.row),
    endLine: toLine(node.endPosition.row),
    language,
    exported: isExported(node),
    docSummary: extractDocSummary(node),
  };
}

/** Build a GraphNode for an enum_declaration. */
function buildEnumNode(node: SyntaxNode, filePath: string, language: string): GraphNode | null {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return null;
  const name = nameNode.text;
  if (!name) return null;

  return {
    id: nodeId(filePath, name),
    kind: 'enum' as GraphNodeKind,
    name,
    filePath,
    startLine: toLine(node.startPosition.row),
    endLine: toLine(node.endPosition.row),
    language,
    exported: isExported(node),
    docSummary: extractDocSummary(node),
  };
}

// ---------------------------------------------------------------------------
// Re-export extraction (barrel files)
// ---------------------------------------------------------------------------

/**
 * A re-export record extracted from a barrel/index file.
 *
 * Represents one of:
 * - `export { Foo } from './foo'`  → named: exportedName='Foo', localName='Foo'
 * - `export { Foo as Bar } from './foo'` → exportedName='Bar', localName='Foo'
 * - `export * from './foo'`         → wildcard: exportedName=null (re-exports all)
 * - `export * as ns from './foo'`   → namespace re-export, skipped (not traceable)
 *
 * Used to build a BarrelExportMap that lets Tier 2a resolution follow re-export
 * chains from barrel index files to canonical symbol source files.
 */
export interface ExtractedReExport {
  /** Relative file path of the barrel file containing the re-export. */
  filePath: string;
  /** Raw import path string as it appears in source (e.g. `'./tasks/find.js'`). */
  rawSourcePath: string;
  /**
   * The name as exported by this barrel (the external name callers import).
   * `null` for wildcard `export * from '...'` re-exports.
   */
  exportedName: string | null;
  /**
   * The name as imported from the source module (the internal name).
   * Equal to `exportedName` for un-aliased re-exports.
   * `null` for wildcard `export * from '...'` re-exports.
   */
  localName: string | null;
}

/**
 * Extract all re-export statements from a TypeScript/JavaScript file.
 *
 * Handles:
 * - `export { Foo, Bar } from './source'`
 * - `export { Foo as PublicFoo } from './source'`
 * - `export * from './source'`
 *
 * Namespace re-exports (`export * as ns from '...'`) are skipped because
 * the caller would need type inference to resolve `ns.Foo` references.
 *
 * @param root - AST root node (program node)
 * @param filePath - File path relative to repo root
 * @returns Array of extracted re-export records
 */
export function extractReExports(root: SyntaxNode, filePath: string): ExtractedReExport[] {
  const results: ExtractedReExport[] = [];

  for (let i = 0; i < root.namedChildCount; i++) {
    const stmt = root.namedChild(i);
    if (!stmt) continue;

    // Tree-sitter represents `export ... from '...'` as export_statement nodes.
    // We only care about those with a source (re-exports), not plain exports.
    if (stmt.type !== 'export_statement') continue;

    // Find the source string node (the `from '...'` part)
    const sourceNode = stmt.childForFieldName('source');
    if (!sourceNode) continue;

    const rawSource = sourceNode.text.replace(/^['"]|['"]$/g, '');
    if (!rawSource) continue;

    // Check for `export * from '...'`
    // Tree-sitter represents this with a '*' text child (non-named) and no
    // named_exports child. We detect it by looking for a '*' keyword child.
    let isWildcard = false;
    let hasNamespace = false;
    for (let j = 0; j < stmt.children.length; j++) {
      const child = stmt.children[j];
      if (!child) continue;
      if (!child.isNamed && child.text === '*') {
        isWildcard = true;
      }
      // `export * as ns from '...'` has a namespace_export child
      if (child.type === 'namespace_export') {
        hasNamespace = true;
      }
    }

    if (isWildcard && !hasNamespace) {
      // Plain `export * from '...'` — wildcard re-export
      results.push({
        filePath,
        rawSourcePath: rawSource,
        exportedName: null,
        localName: null,
      });
      continue;
    }

    if (hasNamespace) {
      // `export * as ns from '...'` — namespace re-export, skip
      continue;
    }

    // Named re-exports: `export { Foo, Bar as Baz } from '...'`
    // Look for export_clause child (named_exports or export_clause depending on grammar)
    for (let j = 0; j < stmt.namedChildCount; j++) {
      const child = stmt.namedChild(j);
      if (!child) continue;

      // export_clause or named_exports contains export_specifier children
      if (child.type === 'export_clause' || child.type === 'named_exports') {
        for (let k = 0; k < child.namedChildCount; k++) {
          const specifier = child.namedChild(k);
          if (!specifier) continue;
          if (specifier.type !== 'export_specifier') continue;

          const nameNode = specifier.childForFieldName('name');
          const aliasNode = specifier.childForFieldName('alias');

          if (!nameNode) continue;
          const localName = nameNode.text;
          const exportedName = aliasNode?.text ?? localName;

          if (localName && exportedName) {
            results.push({
              filePath,
              rawSourcePath: rawSource,
              exportedName,
              localName,
            });
          }
        }
      }
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Import extraction
// ---------------------------------------------------------------------------

/**
 * Extract all ES module import statements from the AST root.
 *
 * Handles named, default, namespace, and side-effect imports.
 * Returns {@link ExtractedImport} records for the import-processor fast-path.
 *
 * @param root - AST root node (program node)
 * @param filePath - File path relative to repo root
 * @returns Array of extracted import records
 */
export function extractImports(root: SyntaxNode, filePath: string): ExtractedImport[] {
  const results: ExtractedImport[] = [];

  for (let i = 0; i < root.namedChildCount; i++) {
    const stmt = root.namedChild(i);
    if (!stmt || stmt.type !== 'import_statement') continue;

    const sourceNode = stmt.childForFieldName('source');
    if (!sourceNode) continue;

    // Strip surrounding quotes
    const rawSource = sourceNode.text;
    const rawImportPath = rawSource.replace(/^['"]|['"]$/g, '');
    if (!rawImportPath) continue;

    const namedBindings: NamedImportBinding[] = [];

    // Walk import clauses to extract named bindings.
    // In the tree-sitter TypeScript grammar, `import_clause` is a regular
    // (unnamed field) child of `import_statement` — NOT a named field —
    // so `childForFieldName('clause')` always returns null. Find it by type.
    const importClause = stmt.children.find((c) => c.type === 'import_clause') ?? null;
    if (importClause) {
      // Check for named imports: { foo, bar as baz }
      for (let j = 0; j < importClause.namedChildCount; j++) {
        const clauseChild = importClause.namedChild(j);
        if (!clauseChild) continue;

        if (clauseChild.type === 'named_imports') {
          // Walk import_specifier children
          for (let k = 0; k < clauseChild.namedChildCount; k++) {
            const specifier = clauseChild.namedChild(k);
            if (!specifier || specifier.type !== 'import_specifier') continue;

            const nameNode = specifier.childForFieldName('name');
            const aliasNode = specifier.childForFieldName('alias');

            if (nameNode) {
              const exported = nameNode.text;
              const local = aliasNode?.text ?? exported;
              if (exported) {
                namedBindings.push({ local, exported });
              }
            }
          }
        }

        // Namespace import: import * as X from '...'
        if (clauseChild.type === 'namespace_import') {
          const aliasNode = clauseChild.namedChild(0);
          if (aliasNode) {
            // Record as a wildcard marker using the alias name
            namedBindings.push({ local: aliasNode.text, exported: '*' });
          }
        }

        // Default import: import Foo from '...' — record local as 'default'
        if (clauseChild.type === 'identifier') {
          const local = clauseChild.text;
          if (local) {
            namedBindings.push({ local, exported: 'default' });
          }
        }
      }
    }

    results.push({
      filePath,
      rawImportPath,
      namedBindings: namedBindings.length > 0 ? namedBindings : undefined,
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Heritage extraction
// ---------------------------------------------------------------------------

/**
 * Extract heritage clauses (extends / implements) from class and interface
 * declarations at the top level of the AST.
 *
 * @param root - AST root node (program node)
 * @param filePath - File path relative to repo root
 * @returns Array of heritage records
 */
export function extractHeritage(root: SyntaxNode, filePath: string): ExtractedHeritage[] {
  const results: ExtractedHeritage[] = [];

  function walkForHeritage(node: SyntaxNode): void {
    if (
      node.type === 'class_declaration' ||
      node.type === 'abstract_class_declaration' ||
      node.type === 'interface_declaration'
    ) {
      const nameNode = node.childForFieldName('name');
      if (!nameNode) return;
      const typeName = nameNode.text;
      if (!typeName) return;

      const typeNodeIdStr = nodeId(filePath, typeName);

      // Walk children for `extends_clause` and `implements_clause`.
      // tree-sitter TypeScript grammar sometimes wraps extends/implements clauses
      // inside a nested `class_heritage` node (grammar version dependent). We
      // flatten one level of nesting so both layouts are handled uniformly.
      const directChildren: SyntaxNode[] = [];
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (!child) continue;
        if (child.type === 'class_heritage') {
          // Flatten: collect grandchildren so extends_clause / implements_clause
          // are visible at the same iteration depth regardless of nesting.
          for (let k = 0; k < child.namedChildCount; k++) {
            const gc = child.namedChild(k);
            if (gc) directChildren.push(gc);
          }
        } else {
          directChildren.push(child);
        }
      }

      for (const child of directChildren) {
        if (child.type === 'extends_clause') {
          // class A extends B — extract parent class name(s)
          for (let j = 0; j < child.namedChildCount; j++) {
            const parent = child.namedChild(j);
            if (!parent) continue;
            // May be an `expression_with_type_arguments` or direct `identifier`
            const identNode =
              parent.type === 'expression_with_type_arguments'
                ? parent.namedChild(0)
                : parent.type === 'identifier' || parent.type === 'type_identifier'
                  ? parent
                  : null;
            if (!identNode) continue;
            const parentName = identNode.text;
            if (parentName) {
              results.push({
                filePath,
                typeName,
                typeNodeId: typeNodeIdStr,
                kind: 'extends',
                parentName,
              });
            }
          }
        }

        if (child.type === 'implements_clause') {
          // class A implements B, C
          for (let j = 0; j < child.namedChildCount; j++) {
            const impl = child.namedChild(j);
            if (!impl) continue;
            const identNode =
              impl.type === 'expression_with_type_arguments'
                ? impl.namedChild(0)
                : impl.type === 'identifier' || impl.type === 'type_identifier'
                  ? impl
                  : null;
            if (!identNode) continue;
            const parentName = identNode.text;
            if (parentName) {
              results.push({
                filePath,
                typeName,
                typeNodeId: typeNodeIdStr,
                kind: 'implements',
                parentName,
              });
            }
          }
        }
      }
    }

    // Recurse into container nodes and export_statements only
    if (CONTAINER_TYPES.has(node.type) || node.type === 'export_statement') {
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child) walkForHeritage(child);
      }
    }
  }

  walkForHeritage(root);
  return results;
}

// ---------------------------------------------------------------------------
// Main extraction entry point
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Call expression extraction
// ---------------------------------------------------------------------------

/**
 * A call site extracted from the AST, ready for Tier 1 / 2a resolution.
 *
 * Covers free function calls (`foo()`), method calls (`obj.foo()`), and
 * constructor calls (`new Foo()`). Virtual-dispatch and MRO resolution are
 * deferred to future waves.
 */
export interface ExtractedCall {
  /** File where the call appears (relative to repo root). */
  filePath: string;
  /** Name of the callee function, method, or constructor being called. */
  calledName: string;
  /**
   * Node ID of the enclosing function/method, or `<filePath>::<file>` for
   * top-level (module-level) calls.
   */
  sourceId: string;
  /**
   * Number of arguments passed at the call site.
   * Omitted when not extractable (e.g., spread arguments).
   */
  argCount?: number;
  /**
   * Call form discriminator:
   * - `'free'` — plain function call: `foo()`
   * - `'member'` — method call: `obj.foo()`
   * - `'constructor'` — constructor call: `new Foo()`
   */
  callForm: 'free' | 'member' | 'constructor';
  /**
   * For member calls: the simple receiver identifier.
   * E.g. `'user'` for `user.save()`.
   */
  receiverName?: string;
  /** Original call range, when the language has the shared lexical capability. */
  span?: GraphSourceSpan;
  /** Source content generation used for lexical/anonymous identities. */
  generation?: string;
  /** Nearest callee binding for free calls, or receiver binding for member calls. */
  lexical?: GraphLexicalResolution;
  /** True when the original callee cannot be statically named; never silently discard it. */
  dynamic?: boolean;
}

/**
 * Count the direct argument nodes inside a `arguments` node.
 * Spread elements (e.g., `...args`) are included in the count.
 */
function countArgs(argsNode: SyntaxNode): number {
  // Named children of `arguments` include individual argument expressions.
  // We count them, skipping the parentheses themselves (which are unnamed).
  return argsNode.namedChildCount;
}

/**
 * Retain every call expression with shared lexical ownership and binding evidence.
 * @param root - Original native AST root.
 * @param filePath - Repository-relative source identity.
 * @param model - Shared model, or a standalone TS/JS model when omitted.
 * @returns Static call records, including explicit dynamic expressions.
 * @remarks Lexical identity does not prove runtime dispatch or invocation.
 * @example
 * ```ts
 * const calls = extractCalls(tree.rootNode, 'src/auth.ts', model);
 * ```
 */
export function extractCalls(
  root: SyntaxNode,
  filePath: string,
  model = buildLexicalScopeModel(
    root,
    filePath,
    createHash('sha256').update(root.text).digest('hex'),
    'typescript',
  ),
): ExtractedCall[] {
  const results: ExtractedCall[] = [];
  function walk(node: SyntaxNode): void {
    if (node.type === 'call_expression' || node.type === 'new_expression') {
      const isConstructor = node.type === 'new_expression';
      const callee = node.childForFieldName(isConstructor ? 'constructor' : 'function');
      const args = node.childForFieldName('arguments');
      if (callee) {
        const member = callee.type === 'member_expression';
        const receiver = member ? callee.childForFieldName('object') : null;
        const property = member ? callee.childForFieldName('property') : null;
        const receiverName =
          receiver?.type === 'identifier' || receiver?.type === 'this' ? receiver.text : undefined;
        const named =
          callee.type === 'identifier' || (member && property?.type === 'property_identifier');
        const calledName = member && property ? property.text : callee.text;
        const bindingName = member
          ? receiverName
          : callee.type === 'identifier'
            ? calledName
            : undefined;
        results.push({
          filePath,
          calledName,
          sourceId: model.ownerAt(node.startIndex),
          argCount: args ? countArgs(args) : undefined,
          callForm: isConstructor ? 'constructor' : member ? 'member' : 'free',
          receiverName,
          span: model.spanOf(node),
          generation: model.generation,
          lexical: bindingName ? model.resolve(bindingName, node.startIndex) : undefined,
          dynamic: !named || (member && !receiverName),
        });
      }
    }
    for (const child of node.namedChildren) walk(child);
  }
  walk(root);
  return results;
}

// ---------------------------------------------------------------------------
// Main extraction entry point
// ---------------------------------------------------------------------------

/**
 * Full extraction result for one file.
 *
 * Contains all definitions (GraphNodes), raw import records (for import
 * processor), heritage clauses (for heritage edge emission), call expressions
 * (for Tier 1 + 2a call resolution), and re-export records (for barrel
 * export chain tracing — T617).
 */
export interface TypeScriptExtractionResult {
  /** Symbol definition nodes extracted from the file. */
  definitions: GraphNode[];
  /** Raw import records for the import-processor fast-path. */
  imports: ExtractedImport[];
  /** Heritage clauses for EXTENDS/IMPLEMENTS edge emission. */
  heritage: ExtractedHeritage[];
  /** Call expressions for CALLS edge emission (Phase 3e). */
  calls: ExtractedCall[];
  /** Re-export records for barrel export chain tracing (T617). */
  reExports: ExtractedReExport[];
}

/**
 * Extract all intelligence data from a TypeScript/JavaScript AST.
 *
 * Combines definition extraction, import extraction, heritage extraction,
 * call expression extraction, and re-export extraction (barrel tracing — T617)
 * in a single AST traversal pass.
 *
 * @param rootNode - The root (program) node of the parsed AST
 * @param filePath - File path relative to the repository root
 * @param language - Language string (`typescript` or `javascript`)
 * @param model - One shared original-source scope model, reused by access extraction.
 * @returns Full extraction result for the file
 */
export function extractTypeScript(
  rootNode: SyntaxNode,
  filePath: string,
  language: string,
  model: LexicalScopeModel = buildLexicalScopeModel(
    rootNode,
    filePath,
    createHash('sha256').update(rootNode.text).digest('hex'),
    language,
  ),
): TypeScriptExtractionResult {
  const definitions: GraphNode[] = [];

  // Walk top-level children for definitions
  for (let i = 0; i < rootNode.namedChildCount; i++) {
    const child = rootNode.namedChild(i);
    if (child) walkDefinitions(child, filePath, language, definitions);
  }

  // Preserve documentary/type declarations. Callable identities come exclusively
  // from the shared model, including nested functions and object callbacks.
  const scopeOwners = new Map(model.scopes.map((scope) => [scope.id, scope.ownerId]));
  const parametersByOwner = new Map<string, string[]>();
  for (const binding of model.bindings) {
    if (binding.kind !== 'parameter') continue;
    const owner = scopeOwners.get(binding.scopeId);
    if (!owner) continue;
    const parameters = parametersByOwner.get(owner) ?? [];
    parameters.push(binding.name);
    parametersByOwner.set(owner, parameters);
  }
  for (const declaration of model.declarations) {
    const node = declaration.node;
    let exportNode = node;
    while (
      exportNode.parent &&
      ['variable_declarator', 'lexical_declaration', 'variable_declaration'].includes(
        exportNode.parent.type,
      )
    )
      exportNode = exportNode.parent;
    const parameters = parametersByOwner.get(declaration.id) ?? [];
    definitions.push({
      id: declaration.id,
      name: declaration.name,
      kind:
        declaration.kind === 'method' && declaration.name === 'constructor'
          ? 'constructor'
          : declaration.kind,
      filePath,
      language,
      startLine: declaration.span.startLine,
      endLine: declaration.span.endLine,
      exported: declaration.parentId === undefined && isExported(exportNode),
      parent: declaration.parentId,
      parameters: declaration.kind === 'class' ? undefined : parameters,
      returnType: extractReturnType(node),
      docSummary: extractDocSummary(exportNode),
      meta: {
        lexicalCapability: 'typescript-javascript',
        sourceGeneration: model.generation,
        sourceSpan: declaration.span,
      },
    });
    if (declaration.kind === 'class') {
      for (const field of buildClassNodes(node, filePath, language).filter(
        (item) => item.kind === 'property',
      ))
        definitions.push({
          ...field,
          id: `${declaration.id}.${field.name}`,
          parent: declaration.id,
        });
    }
  }
  const imports = extractImports(rootNode, filePath);
  const heritage = extractHeritage(rootNode, filePath);
  const calls = extractCalls(rootNode, filePath, model);
  const reExports = extractReExports(rootNode, filePath);

  return { definitions, imports, heritage, calls, reExports };
}
