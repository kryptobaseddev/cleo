/**
 * Go AST extractor for the parse-loop pipeline.
 *
 * Extracts from a tree-sitter-go AST:
 *
 * - **Definitions**: top-level functions (`func`), methods with receivers
 *   (`func (s *Server) Handle()`), struct and interface type declarations,
 *   and struct fields.
 * - **Imports**: `import "fmt"` and grouped `import ("fmt"; "os")`.
 *   Returns {@link ExtractedImport} records for the import-processor fast-path.
 * - **Heritage**: struct embedding (anonymous fields) — treated as `extends`
 *   relationships for the heritage processor.
 * - **Calls**: free function calls (`foo()`), method calls (`obj.Method()`),
 *   and struct literal construction (`User{}`).
 *
 * Go-specific notes:
 * - Exported symbols have an uppercase first letter (Go convention).
 * - Import semantics are "wildcard" — importing `"fmt"` makes all exported
 *   symbols of `fmt` available under the `fmt.` prefix.
 * - Methods with receivers are emitted as `method` nodes with a `parent`
 *   pointing to the receiver type.
 * - Interface implementation is implicit in Go (no `implements` keyword);
 *   this extractor does not emit interface-heritage edges.
 *
 * Tree-sitter query patterns ported from GitNexus
 * `src/core/ingestion/tree-sitter-queries.ts` (GO_QUERIES section).
 *
 * @task T541
 * @module pipeline/extractors/go-extractor
 */

import type { GraphNode, GraphNodeKind } from '@cleocode/contracts';
import type { ExtractedImport } from '../import-processor.js';
import type { ExtractedCall, ExtractedHeritage } from './typescript-extractor.js';

// ---------------------------------------------------------------------------
// Minimal SyntaxNode interface (mirrors typescript-extractor.ts)
// ---------------------------------------------------------------------------

/**
 * Minimal tree-sitter SyntaxNode shape required by this extractor.
 */
interface SyntaxNode {
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
 * Go export rule: a name is exported if its first character is uppercase.
 */
function isGoExported(name: string): boolean {
  if (!name) return false;
  const first = name.charCodeAt(0);
  return first >= 65 && first <= 90; // A-Z
}

/** Extract a brief doc comment from the line comment preceding a node. */
function extractDocSummary(node: SyntaxNode): string | undefined {
  const sibling = node.previousSibling;
  if (!sibling || sibling.type !== 'comment') return undefined;
  const raw = sibling.text;
  if (!raw.startsWith('//')) return undefined;
  return raw.replace(/^\/\/\s*/, '').trim() || undefined;
}

/** Extract parameter names from a `parameter_list` node. */
function extractParamNames(paramsNode: SyntaxNode): string[] {
  const names: string[] = [];
  for (let i = 0; i < paramsNode.namedChildCount; i++) {
    const param = paramsNode.namedChild(i);
    if (!param) continue;
    // parameter_declaration: name (identifier) type (...)
    // variadic_parameter_declaration: name? (identifier)? type ...
    const nameNode = param.childForFieldName('name') ?? param.namedChild(0);
    if (nameNode?.type === 'identifier' && nameNode.text) {
      names.push(nameNode.text);
    }
  }
  return names;
}

/**
 * Extract the receiver type name from a `parameter_list` node used in
 * method declarations (e.g. `(s *Server)` → `"Server"`).
 */
function extractReceiverTypeName(receiverNode: SyntaxNode): string | null {
  for (let i = 0; i < receiverNode.namedChildCount; i++) {
    const param = receiverNode.namedChild(i);
    if (!param) continue;
    // parameter_declaration: name identifier, type pointer_type|type_identifier
    const typeNode = param.childForFieldName('type') ?? param.namedChild(1);
    if (!typeNode) continue;
    // Could be a pointer_type: * type_identifier
    const typeId =
      typeNode.type === 'pointer_type'
        ? typeNode.namedChild(0)
        : typeNode.type === 'type_identifier'
          ? typeNode
          : null;
    if (typeId?.text) return typeId.text;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Definition extraction
// ---------------------------------------------------------------------------

/**
 * Walk the top-level AST to extract definitions.
 *
 * Emits function declarations, method declarations, and type declarations
 * (struct/interface) from the source_file root.
 *
 * @param root - AST root (source_file) node
 * @param filePath - File path relative to repo root
 * @param results - Accumulator (mutated in place)
 */
function walkDefinitions(root: SyntaxNode, filePath: string, results: GraphNode[]): void {
  const language = 'go';

  for (let i = 0; i < root.namedChildCount; i++) {
    const node = root.namedChild(i);
    if (!node) continue;

    switch (node.type) {
      case 'function_declaration': {
        const nameNode = node.childForFieldName('name');
        if (!nameNode) continue;
        const name = nameNode.text;
        if (!name) continue;

        const paramsNode = node.childForFieldName('parameters');
        const parameters = paramsNode ? extractParamNames(paramsNode) : [];

        results.push({
          id: nodeId(filePath, name),
          kind: 'function' as GraphNodeKind,
          name,
          filePath,
          startLine: toLine(node.startPosition.row),
          endLine: toLine(node.endPosition.row),
          language,
          exported: isGoExported(name),
          parameters,
          docSummary: extractDocSummary(node),
        });
        break;
      }

      case 'method_declaration': {
        // func (receiver ReceiverType) MethodName(params) ...
        const nameNode = node.childForFieldName('name');
        if (!nameNode) continue;
        const methodName = nameNode.text;
        if (!methodName) continue;

        const receiverNode = node.childForFieldName('receiver');
        const receiverType = receiverNode ? extractReceiverTypeName(receiverNode) : null;

        const paramsNode = node.childForFieldName('parameters');
        const parameters = paramsNode ? extractParamNames(paramsNode) : [];

        const qualifiedName = receiverType ? `${receiverType}.${methodName}` : methodName;

        results.push({
          id: nodeId(filePath, qualifiedName),
          kind: 'method' as GraphNodeKind,
          name: methodName,
          filePath,
          startLine: toLine(node.startPosition.row),
          endLine: toLine(node.endPosition.row),
          language,
          exported: isGoExported(methodName),
          parent: receiverType ? nodeId(filePath, receiverType) : undefined,
          parameters,
          docSummary: extractDocSummary(node),
        });
        break;
      }

      case 'type_declaration': {
        // type Foo struct { ... } or type Bar interface { ... }
        for (let j = 0; j < node.namedChildCount; j++) {
          const typeSpec = node.namedChild(j);
          if (!typeSpec || typeSpec.type !== 'type_spec') continue;

          const nameNode = typeSpec.childForFieldName('name');
          if (!nameNode) continue;
          const name = nameNode.text;
          if (!name) continue;

          const typeNode = typeSpec.childForFieldName('type');
          if (!typeNode) continue;

          let kind: GraphNodeKind;
          if (typeNode.type === 'struct_type') {
            kind = 'struct';
          } else if (typeNode.type === 'interface_type') {
            kind = 'interface';
          } else {
            kind = 'type_alias';
          }

          results.push({
            id: nodeId(filePath, name),
            kind,
            name,
            filePath,
            startLine: toLine(node.startPosition.row),
            endLine: toLine(node.endPosition.row),
            language,
            exported: isGoExported(name),
            docSummary: extractDocSummary(node),
          });

          // Emit struct fields as property nodes
          if (typeNode.type === 'struct_type') {
            const fieldListNode = typeNode.namedChild(0);
            if (fieldListNode) {
              extractStructFields(fieldListNode, filePath, name, language, results);
            }
          }
        }
        break;
      }

      default:
        break;
    }
  }
}

/**
 * Emit field nodes from a `field_declaration_list` inside a struct.
 */
function extractStructFields(
  fieldListNode: SyntaxNode,
  filePath: string,
  structName: string,
  language: string,
  results: GraphNode[],
): void {
  for (let i = 0; i < fieldListNode.namedChildCount; i++) {
    const field = fieldListNode.namedChild(i);
    if (!field || field.type !== 'field_declaration') continue;

    // Named field: the `name` field in field_declaration holds field_identifier(s)
    const nameNode = field.childForFieldName('name');
    if (!nameNode) continue;
    const fieldName = nameNode.text;
    if (!fieldName) continue;

    results.push({
      id: nodeId(filePath, `${structName}.${fieldName}`),
      kind: 'property' as GraphNodeKind,
      name: fieldName,
      filePath,
      startLine: toLine(field.startPosition.row),
      endLine: toLine(field.endPosition.row),
      language,
      exported: isGoExported(fieldName),
      parent: nodeId(filePath, structName),
    });
  }
}

// ---------------------------------------------------------------------------
// Import extraction
// ---------------------------------------------------------------------------

/**
 * Extract Go import statements from the source file root.
 *
 * Handles:
 * - Single import: `import "fmt"` → rawImportPath = `"fmt"` (quotes stripped)
 * - Grouped import: `import ("fmt"; "os")` → one record per path
 * - Named import alias: `import f "fmt"` → namedBinding local=`"f"` exported=`"*"`
 * - Blank import: `import _ "pkg"` → rawImportPath only, no binding
 * - Dot import: `import . "pkg"` → rawImportPath only
 *
 * @param root - AST root (source_file) node
 * @param filePath - File path relative to repo root
 * @returns Array of extracted import records
 */
export function extractImports(root: SyntaxNode, filePath: string): ExtractedImport[] {
  const results: ExtractedImport[] = [];

  for (let i = 0; i < root.namedChildCount; i++) {
    const stmt = root.namedChild(i);
    if (!stmt || stmt.type !== 'import_declaration') continue;

    // Walk all import_spec children (either direct or inside import_spec_list)
    collectImportSpecs(stmt, filePath, results);
  }

  return results;
}

/** Recursively collect import_spec nodes from an import_declaration. */
function collectImportSpecs(node: SyntaxNode, filePath: string, results: ExtractedImport[]): void {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;

    if (child.type === 'import_spec') {
      const pathNode = child.childForFieldName('path');
      if (!pathNode) continue;
      // Strip surrounding quotes from the interpreted_string_literal
      const rawImportPath = pathNode.text.replace(/^"|"$/g, '');
      if (!rawImportPath) continue;

      // Check for alias: `alias name path`
      const aliasNode = child.childForFieldName('name');
      if (aliasNode?.text && aliasNode.text !== '_' && aliasNode.text !== '.') {
        results.push({
          filePath,
          rawImportPath,
          namedBindings: [{ local: aliasNode.text, exported: '*' }],
        });
      } else {
        results.push({ filePath, rawImportPath });
      }
    } else if (child.type === 'import_spec_list') {
      // Grouped import block: recurse
      collectImportSpecs(child, filePath, results);
    }
  }
}

// ---------------------------------------------------------------------------
// Heritage extraction
// ---------------------------------------------------------------------------

/**
 * Extract struct embedding relationships from type declarations.
 *
 * In Go, embedding a type as an anonymous field (`type Foo struct { Bar }`)
 * creates an implicit delegation relationship, modelled here as `extends`.
 *
 * @param root - AST root (source_file) node
 * @param filePath - File path relative to repo root
 * @returns Array of heritage records
 */
export function extractHeritage(root: SyntaxNode, filePath: string): ExtractedHeritage[] {
  const results: ExtractedHeritage[] = [];

  for (let i = 0; i < root.namedChildCount; i++) {
    const node = root.namedChild(i);
    if (!node || node.type !== 'type_declaration') continue;

    for (let j = 0; j < node.namedChildCount; j++) {
      const typeSpec = node.namedChild(j);
      if (!typeSpec || typeSpec.type !== 'type_spec') continue;

      const nameNode = typeSpec.childForFieldName('name');
      if (!nameNode) continue;
      const typeName = nameNode.text;
      if (!typeName) continue;

      const typeNode = typeSpec.childForFieldName('type');
      if (!typeNode || typeNode.type !== 'struct_type') continue;

      // field_declaration_list is the first child of struct_type
      const fieldListNode = typeNode.namedChild(0);
      if (!fieldListNode) continue;

      const typeNodeId = nodeId(filePath, typeName);

      for (let k = 0; k < fieldListNode.namedChildCount; k++) {
        const field = fieldListNode.namedChild(k);
        if (!field || field.type !== 'field_declaration') continue;

        // An anonymous field (embedding) has no `name` field — only a `type` field
        const fieldNameNode = field.childForFieldName('name');
        if (fieldNameNode) continue; // Named field — not an embedding

        // The type itself is the embedded type
        const embeddedTypeNode = field.childForFieldName('type') ?? field.namedChild(0);
        if (!embeddedTypeNode) continue;

        const embeddedName =
          embeddedTypeNode.type === 'pointer_type'
            ? (embeddedTypeNode.namedChild(0)?.text ?? embeddedTypeNode.text)
            : embeddedTypeNode.type === 'type_identifier'
              ? embeddedTypeNode.text
              : embeddedTypeNode.text;

        if (embeddedName) {
          results.push({
            filePath,
            typeName,
            typeNodeId,
            kind: 'extends',
            parentName: embeddedName,
          });
        }
      }
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Call extraction
// ---------------------------------------------------------------------------

/** AST node types that begin a function/method scope boundary in Go. */
const ENCLOSING_GO_FUNCTION_TYPES = new Set(['function_declaration', 'method_declaration']);

/**
 * Build the source node ID for a call expression in Go.
 * Walks up the AST to find the nearest enclosing function or method.
 */
function buildSourceId(callNode: SyntaxNode, filePath: string): string {
  let current = callNode.parent;

  while (current) {
    if (ENCLOSING_GO_FUNCTION_TYPES.has(current.type)) {
      const nameNode = current.childForFieldName('name');
      if (nameNode?.text) {
        if (current.type === 'method_declaration') {
          const receiverNode = current.childForFieldName('receiver');
          const receiverType = receiverNode ? extractReceiverTypeName(receiverNode) : null;
          if (receiverType) {
            return `${filePath}::${receiverType}.${nameNode.text}`;
          }
        }
        return `${filePath}::${nameNode.text}`;
      }
    }
    current = current.parent;
  }

  return `${filePath}::__file__`;
}

/**
 * Walk the full AST to collect all call expressions.
 *
 * Handles:
 * - Free calls: `foo(args)` → callForm `'free'`
 * - Method/selector calls: `obj.Method(args)` → callForm `'member'`
 * - Struct literal: `User{Name: "Alice"}` → callForm `'constructor'`
 *
 * @param root - AST root (source_file) node
 * @param filePath - File path relative to repo root
 * @returns Array of extracted call records
 */
export function extractCalls(root: SyntaxNode, filePath: string): ExtractedCall[] {
  const results: ExtractedCall[] = [];

  function walk(node: SyntaxNode): void {
    if (node.type === 'call_expression') {
      const functionNode = node.childForFieldName('function');
      const argsNode = node.childForFieldName('arguments');
      const argCount = argsNode ? argsNode.namedChildCount : undefined;

      if (functionNode) {
        if (functionNode.type === 'identifier') {
          const calledName = functionNode.text;
          if (calledName) {
            results.push({
              filePath,
              calledName,
              sourceId: buildSourceId(node, filePath),
              argCount,
              callForm: 'free',
            });
          }
        } else if (functionNode.type === 'selector_expression') {
          // obj.Method(args)
          const fieldNode = functionNode.childForFieldName('field');
          const operandNode = functionNode.childForFieldName('operand');
          if (fieldNode?.text) {
            results.push({
              filePath,
              calledName: fieldNode.text,
              sourceId: buildSourceId(node, filePath),
              argCount,
              callForm: 'member',
              receiverName: operandNode?.type === 'identifier' ? operandNode.text : undefined,
            });
          }
        }
      }
    } else if (node.type === 'composite_literal') {
      // Struct literal: User{Name: "Alice"}
      const typeNode = node.childForFieldName('type');
      if (typeNode?.type === 'type_identifier') {
        results.push({
          filePath,
          calledName: typeNode.text,
          sourceId: buildSourceId(node, filePath),
          callForm: 'constructor',
        });
      }
    }

    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child) walk(child);
    }
  }

  walk(root);
  return results;
}

// ---------------------------------------------------------------------------
// Full extraction result type
// ---------------------------------------------------------------------------

/**
 * Full extraction result for one Go file.
 */
export interface GoExtractionResult {
  /** Symbol definition nodes extracted from the file. */
  definitions: GraphNode[];
  /** Raw import records for the import-processor fast-path. */
  imports: ExtractedImport[];
  /** Heritage clauses for EXTENDS edge emission (struct embedding). */
  heritage: ExtractedHeritage[];
  /** Call expressions for CALLS edge emission. */
  calls: ExtractedCall[];
}

// ---------------------------------------------------------------------------
// Main extraction entry point
// ---------------------------------------------------------------------------

/**
 * Extract all intelligence data from a Go AST.
 *
 * @param rootNode - The root (source_file) node of the parsed AST
 * @param filePath - File path relative to the repository root
 * @returns Full extraction result for the file
 */
export function extractGo(rootNode: SyntaxNode, filePath: string): GoExtractionResult {
  const definitions: GraphNode[] = [];
  walkDefinitions(rootNode, filePath, definitions);

  const imports = extractImports(rootNode, filePath);
  const heritage = extractHeritage(rootNode, filePath);
  const calls = extractCalls(rootNode, filePath);

  return { definitions, imports, heritage, calls };
}
