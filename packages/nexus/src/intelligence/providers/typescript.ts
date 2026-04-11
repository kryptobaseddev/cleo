/**
 * TypeScript and JavaScript language provider.
 *
 * Implements {@link LanguageProvider} for `.ts`, `.tsx`, `.js`, and `.jsx`
 * files by walking the tree-sitter AST to extract:
 *
 * - **Definitions**: function declarations, arrow functions, class declarations
 *   with their methods and properties, interface declarations, type aliases,
 *   enum declarations, and named exported symbols.
 * - **Imports**: ES module `import` statements (named, default, namespace).
 * - **Calls**: function call and method call expressions found inside
 *   function/method bodies.
 *
 * Ported and adapted from GitNexus TypeScript type extractor for CLEO's
 * lightweight in-process intelligence pipeline.
 *
 * @task T512
 * @module intelligence/providers/typescript
 */

import type { GraphNode, GraphNodeKind, GraphRelation } from '@cleocode/contracts';
import type { LanguageProvider, SyntaxNode, SyntaxTree } from '../language-provider.js';

// ---------------------------------------------------------------------------
// Node-type sets
// ---------------------------------------------------------------------------

/** AST node types that declare a callable unit (function body carriers). */
const FUNCTION_NODE_TYPES: ReadonlySet<string> = new Set([
  'function_declaration',
  'function_expression',
  'arrow_function',
  'method_definition',
  'generator_function',
  'generator_function_declaration',
]);

/** AST node types that may carry an `export` keyword as a direct parent. */
const EXPORTABLE_DECLARATION_TYPES: ReadonlySet<string> = new Set([
  'function_declaration',
  'class_declaration',
  'interface_declaration',
  'type_alias_declaration',
  'enum_declaration',
  'lexical_declaration',
  'variable_declaration',
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert a 0-based tree-sitter row to a 1-based line number.
 *
 * @param row - Zero-based row from tree-sitter position
 * @returns One-based line number for graph nodes
 */
function toLine(row: number): number {
  return row + 1;
}

/**
 * Derive a stable node ID from a file path and symbol name.
 *
 * @param filePath - File path relative to project root
 * @param name - Symbol name
 * @returns Stable ID string in the form `filePath::name`
 */
function nodeId(filePath: string, name: string): string {
  return `${filePath}::${name}`;
}

/**
 * Check whether a node has an `export` keyword among its unnamed children,
 * or whether its parent is an `export_statement`.
 *
 * @param node - The declaration node to inspect
 * @returns True if the node appears to be exported
 */
function isExported(node: SyntaxNode): boolean {
  // Direct export keyword on the node (e.g., `export function foo()`)
  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i];
    if (child && !child.isNamed && child.text === 'export') return true;
  }
  // Parent is an export_statement wrapping this declaration
  if (node.parent?.type === 'export_statement') return true;
  return false;
}

/**
 * Extract the text of the first single-line JSDoc/TSDoc comment block
 * immediately preceding a node, trimmed to the first sentence.
 *
 * @param node - The declaration node
 * @returns First line of the doc comment, or undefined if none
 */
function extractDocSummary(node: SyntaxNode): string | undefined {
  let sibling = node.previousSibling;
  // Skip decorators
  while (sibling?.type === 'decorator') {
    sibling = sibling.previousSibling;
  }
  if (!sibling || sibling.type !== 'comment') return undefined;
  const raw = sibling.text;
  if (!raw.startsWith('/**') && !raw.startsWith('//')) return undefined;
  // Strip comment markers and grab the first meaningful line
  const lines = raw
    .replace(/^\/\*\*/, '')
    .replace(/\*\/$/, '')
    .split('\n')
    .map((l) => l.replace(/^\s*\*\s?/, '').trim())
    .filter((l) => l.length > 0 && !l.startsWith('@'));
  return lines[0];
}

/**
 * Extract parameter name strings from a `formal_parameters` or `parameters`
 * AST node.
 *
 * @param paramsNode - The parameters node from the AST
 * @returns Array of parameter names (identifiers only; destructured params
 *   are represented as a placeholder)
 */
function extractParamNames(paramsNode: SyntaxNode): string[] {
  const names: string[] = [];
  for (let i = 0; i < paramsNode.namedChildCount; i++) {
    const param = paramsNode.namedChild(i);
    if (!param) continue;
    // required_parameter / optional_parameter have a pattern/name field
    const patternNode =
      param.childForFieldName('pattern') ?? param.childForFieldName('name') ?? param;
    const text = patternNode.text;
    if (text) names.push(text);
  }
  return names;
}

/**
 * Attempt to read a return type annotation from a function/method node.
 *
 * @param funcNode - Function declaration or method definition node
 * @returns Return type text (e.g., "string", "Promise<void>"), or undefined
 */
function extractReturnType(funcNode: SyntaxNode): string | undefined {
  const retTypeNode = funcNode.childForFieldName('return_type');
  if (!retTypeNode) return undefined;
  // Strip the leading colon from `: string`
  const text = retTypeNode.text.replace(/^:\s*/, '').trim();
  return text || undefined;
}

// ---------------------------------------------------------------------------
// Definition extraction
// ---------------------------------------------------------------------------

/**
 * Build a {@link GraphNode} for a named function declaration.
 *
 * @param node - The `function_declaration` AST node
 * @param filePath - File path for the node record
 * @param language - Language string for the node record
 * @returns GraphNode, or null if the node has no usable name
 */
function buildFunctionNode(node: SyntaxNode, filePath: string, language: string): GraphNode | null {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return null;
  const name = nameNode.text;
  if (!name) return null;

  const paramsNode =
    node.childForFieldName('parameters') ?? node.childForFieldName('formal_parameters');
  const parameters = paramsNode ? extractParamNames(paramsNode) : [];

  return {
    id: nodeId(filePath, name),
    kind: 'function',
    name,
    filePath,
    startLine: toLine(node.startPosition.row),
    endLine: toLine(node.endPosition.row),
    language,
    exported: isExported(node),
    parameters,
    returnType: extractReturnType(node),
    docSummary: extractDocSummary(node),
  };
}

/**
 * Build a {@link GraphNode} for a class declaration, then recursively emit
 * child nodes for each method and public field defined in the class body.
 *
 * @param node - The `class_declaration` AST node
 * @param filePath - File path for the node record
 * @param language - Language string for the node record
 * @returns Array of GraphNodes (class node + method/property children)
 */
function buildClassNodes(node: SyntaxNode, filePath: string, language: string): GraphNode[] {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return [];
  const className = nameNode.text;
  if (!className) return [];

  const classExported = isExported(node);
  const classNodeResult: GraphNode = {
    id: nodeId(filePath, className),
    kind: 'class',
    name: className,
    filePath,
    startLine: toLine(node.startPosition.row),
    endLine: toLine(node.endPosition.row),
    language,
    exported: classExported,
    docSummary: extractDocSummary(node),
  };

  const results: GraphNode[] = [classNodeResult];

  // Walk the class body for methods and fields
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
        exported: false, // methods are not individually exported
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
        kind: 'property',
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
 * Build a {@link GraphNode} for an interface declaration.
 *
 * @param node - The `interface_declaration` AST node
 * @param filePath - File path for the node record
 * @param language - Language string for the node record
 * @returns GraphNode, or null if the node has no usable name
 */
function buildInterfaceNode(
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
    kind: 'interface',
    name,
    filePath,
    startLine: toLine(node.startPosition.row),
    endLine: toLine(node.endPosition.row),
    language,
    exported: isExported(node),
    docSummary: extractDocSummary(node),
  };
}

/**
 * Build a {@link GraphNode} for a type alias declaration (`type Foo = ...`).
 *
 * @param node - The `type_alias_declaration` AST node
 * @param filePath - File path for the node record
 * @param language - Language string for the node record
 * @returns GraphNode, or null if the node has no usable name
 */
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
    kind: 'type',
    name,
    filePath,
    startLine: toLine(node.startPosition.row),
    endLine: toLine(node.endPosition.row),
    language,
    exported: isExported(node),
    docSummary: extractDocSummary(node),
  };
}

/**
 * Build a {@link GraphNode} for an enum declaration.
 *
 * @param node - The `enum_declaration` AST node
 * @param filePath - File path for the node record
 * @param language - Language string for the node record
 * @returns GraphNode, or null if the node has no usable name
 */
function buildEnumNode(node: SyntaxNode, filePath: string, language: string): GraphNode | null {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return null;
  const name = nameNode.text;
  if (!name) return null;

  return {
    id: nodeId(filePath, name),
    kind: 'enum',
    name,
    filePath,
    startLine: toLine(node.startPosition.row),
    endLine: toLine(node.endPosition.row),
    language,
    exported: isExported(node),
    docSummary: extractDocSummary(node),
  };
}

/**
 * Recursively walk the AST rooted at `node` and extract all definition nodes.
 *
 * Handles:
 * - `function_declaration` → function node
 * - `class_declaration` → class node + method/property children
 * - `interface_declaration` → interface node
 * - `type_alias_declaration` → type node
 * - `enum_declaration` → enum node
 * - `export_statement` → unwrap and recurse into the exported declaration
 * - `lexical_declaration` with arrow function value → function node
 *
 * @param node - Current AST node to inspect
 * @param filePath - File path for generated graph nodes
 * @param language - Language string for generated graph nodes
 * @param results - Accumulator for extracted nodes (mutated in place)
 */
function walkDefinitions(
  node: SyntaxNode,
  filePath: string,
  language: string,
  results: GraphNode[],
): void {
  switch (node.type) {
    case 'function_declaration':
    case 'generator_function_declaration': {
      const fn = buildFunctionNode(node, filePath, language);
      if (fn) results.push(fn);
      break;
    }
    case 'class_declaration': {
      const nodes = buildClassNodes(node, filePath, language);
      for (const n of nodes) results.push(n);
      break;
    }
    case 'interface_declaration': {
      const iface = buildInterfaceNode(node, filePath, language);
      if (iface) results.push(iface);
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
    case 'lexical_declaration':
    case 'variable_declaration': {
      // Detect `const foo = () => { ... }` patterns
      for (let i = 0; i < node.namedChildCount; i++) {
        const declarator = node.namedChild(i);
        if (!declarator || declarator.type !== 'variable_declarator') continue;
        const nameNode = declarator.childForFieldName('name');
        const valueNode = declarator.childForFieldName('value');
        if (!nameNode || !valueNode) continue;
        if (valueNode.type !== 'arrow_function' && valueNode.type !== 'function_expression')
          continue;
        const name = nameNode.text;
        if (!name) continue;

        const paramsNode =
          valueNode.childForFieldName('parameters') ??
          valueNode.childForFieldName('formal_parameters');
        const parameters = paramsNode ? extractParamNames(paramsNode) : [];

        results.push({
          id: nodeId(filePath, name),
          kind: 'function',
          name,
          filePath,
          startLine: toLine(node.startPosition.row),
          endLine: toLine(node.endPosition.row),
          language,
          exported: isExported(node),
          parameters,
          returnType: extractReturnType(valueNode),
          docSummary: extractDocSummary(node),
        });
      }
      break;
    }
    default:
      break;
  }

  // Recurse into children — only for top-level nodes (program, module, namespace)
  // to avoid descending into function bodies and re-extracting local declarations.
  const CONTAINER_TYPES: ReadonlySet<string> = new Set([
    'program',
    'module',
    'namespace',
    'internal_module',
    'module_declaration',
  ]);
  if (CONTAINER_TYPES.has(node.type)) {
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child) walkDefinitions(child, filePath, language, results);
    }
  }
}

// ---------------------------------------------------------------------------
// Import extraction
// ---------------------------------------------------------------------------

/**
 * Extract all ES module import statements from the AST root.
 *
 * Supports:
 * - `import { foo } from './foo'` (named imports)
 * - `import foo from './foo'` (default import)
 * - `import * as foo from './foo'` (namespace import)
 * - `import './foo'` (side-effect import)
 *
 * Each import becomes a {@link GraphRelation} of type `imports` from the
 * current file ID to the module specifier string (resolved path is left
 * for the caller since providers are source-only).
 *
 * @param root - The root (program) AST node
 * @param filePath - File path relative to project root
 * @returns Array of import relations
 */
function extractImportsFromRoot(root: SyntaxNode, filePath: string): GraphRelation[] {
  const relations: GraphRelation[] = [];
  const fileNodeId = `${filePath}::*`;

  for (let i = 0; i < root.namedChildCount; i++) {
    const stmt = root.namedChild(i);
    if (!stmt || stmt.type !== 'import_statement') continue;

    const sourceNode = stmt.childForFieldName('source');
    if (!sourceNode) continue;

    // Strip surrounding quotes from the module specifier
    const rawSource = sourceNode.text;
    const moduleSpecifier = rawSource.replace(/^['"]|['"]$/g, '');
    if (!moduleSpecifier) continue;

    relations.push({
      source: fileNodeId,
      target: moduleSpecifier,
      type: 'imports',
      confidence: 0.9,
      reason: `import statement in ${filePath}`,
    });
  }

  return relations;
}

// ---------------------------------------------------------------------------
// Call extraction
// ---------------------------------------------------------------------------

/**
 * Context passed through the call-extraction recursive walk to track the
 * enclosing function scope for source attribution.
 */
interface CallContext {
  /** ID of the enclosing function/method node, or the file node if top-level. */
  enclosingId: string;
}

/**
 * Recursively walk `node` to find call expressions and emit call relations.
 *
 * Only descends into function/method bodies to avoid attributing calls to
 * the wrong scope. Each `call_expression` or `new_expression` becomes a
 * {@link GraphRelation} of type `calls` from the enclosing symbol to the
 * callee name.
 *
 * @param node - Current AST node
 * @param filePath - File path relative to project root
 * @param ctx - Current call context (enclosing function ID)
 * @param results - Accumulator for emitted relations (mutated in place)
 */
function walkCalls(
  node: SyntaxNode,
  filePath: string,
  ctx: CallContext,
  results: GraphRelation[],
): void {
  if (node.type === 'call_expression') {
    const funcNode = node.childForFieldName('function');
    if (funcNode) {
      let calleeName: string | undefined;
      if (funcNode.type === 'identifier') {
        calleeName = funcNode.text;
      } else if (funcNode.type === 'member_expression') {
        const prop = funcNode.childForFieldName('property');
        if (prop) calleeName = prop.text;
      }
      if (calleeName) {
        results.push({
          source: ctx.enclosingId,
          target: calleeName,
          type: 'calls',
          confidence: 0.9,
          reason: `call expression in ${filePath}`,
        });
      }
    }
  }

  if (node.type === 'new_expression') {
    const constructorNode = node.childForFieldName('constructor');
    if (constructorNode) {
      const calleeName = constructorNode.text;
      if (calleeName) {
        results.push({
          source: ctx.enclosingId,
          target: calleeName,
          type: 'calls',
          confidence: 0.85,
          reason: `new expression in ${filePath}`,
        });
      }
    }
  }

  // Determine if entering a new function scope
  if (FUNCTION_NODE_TYPES.has(node.type)) {
    const nameNode = node.childForFieldName('name');
    const methodNameNode = node.childForFieldName('name'); // same field for method_definition

    let scopeName: string | undefined;
    if (nameNode) {
      scopeName = nameNode.text;
    } else if (methodNameNode) {
      scopeName = methodNameNode.text;
    }

    const newEnclosingId = scopeName ? nodeId(filePath, scopeName) : ctx.enclosingId;

    const newCtx: CallContext = { enclosingId: newEnclosingId };
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child) walkCalls(child, filePath, newCtx, results);
    }
    return; // Handled children above — don't fall through
  }

  // Recurse into all other node types
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child) walkCalls(child, filePath, ctx, results);
  }
}

// ---------------------------------------------------------------------------
// Provider implementation
// ---------------------------------------------------------------------------

/**
 * TypeScript/JavaScript language provider.
 *
 * Handles `.ts`, `.tsx`, `.js`, and `.jsx` files using tree-sitter AST
 * traversal to extract definitions, imports, and call relationships.
 *
 * @example
 * ```typescript
 * import { typescriptProvider } from './providers/typescript.js';
 *
 * const nodes = typescriptProvider.extractDefinitions(tree, source, 'src/foo.ts');
 * const imports = typescriptProvider.extractImports(tree, source, 'src/foo.ts');
 * const calls = typescriptProvider.extractCalls(tree, source, 'src/foo.ts');
 * ```
 */
export const typescriptProvider: LanguageProvider = {
  language: 'typescript',
  fileExtensions: ['.ts', '.tsx', '.js', '.jsx'],
  parseStrategy: 'tree-sitter',

  extractDefinitions(tree: SyntaxTree, _source: string, filePath: string): GraphNode[] {
    const results: GraphNode[] = [];
    const root = tree.rootNode;

    // Walk all top-level children — walkDefinitions handles the recursion into
    // export_statement and container nodes only.
    for (let i = 0; i < root.namedChildCount; i++) {
      const child = root.namedChild(i);
      if (child) walkDefinitions(child, filePath, 'typescript', results);
    }

    return results;
  },

  extractImports(tree: SyntaxTree, _source: string, filePath: string): GraphRelation[] {
    return extractImportsFromRoot(tree.rootNode, filePath);
  },

  extractCalls(tree: SyntaxTree, _source: string, filePath: string): GraphRelation[] {
    const results: GraphRelation[] = [];
    const fileNodeId = `${filePath}::*`;
    walkCalls(tree.rootNode, filePath, { enclosingId: fileNodeId }, results);
    return results;
  },
};
