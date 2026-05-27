/**
 * Rust AST extractor for the parse-loop pipeline.
 *
 * Extracts from a tree-sitter-rust AST:
 *
 * - **Definitions**: `fn` (functions), `struct`, `enum`, `trait`, `impl`,
 *   `type` (aliases), `const`, `static`, `mod` (modules), and `macro_definition`.
 *   Methods inside `impl` blocks are emitted as `method` nodes with a `parent`
 *   pointing to the implementing type.
 * - **Imports**: `use` statements — `use crate::foo::Bar`, `use super::Baz`,
 *   `use std::collections::HashMap`, `use foo::{A, B}`. Returns
 *   {@link ExtractedImport} records for the import-processor fast-path.
 * - **Heritage**: trait implementations — `impl Trait for Struct` emits an
 *   `implements` record; `impl Struct` emits nothing (no heritage).
 * - **Calls**: free function calls (`foo()`), method calls (`obj.method()`),
 *   associated function calls (`Foo::new()`), and struct literal construction.
 *
 * Rust-specific notes:
 * - Visibility: `pub` items are exported; others are module-private.
 * - Module system: `use crate::`, `use super::`, `use self::` prefixes are
 *   preserved in rawImportPath for the import-processor.
 * - Trait impl acts as the heritage record for `implements` edges.
 * - Generic types are unwrapped to extract the base type name.
 *
 * Tree-sitter query patterns ported from GitNexus
 * `src/core/ingestion/tree-sitter-queries.ts` (RUST_QUERIES section).
 *
 * @task T541
 * @module pipeline/extractors/rust-extractor
 */

import type { GraphNode, GraphNodeKind } from '@cleocode/contracts';
import type { ExtractedImport, NamedImportBinding } from '../import-processor.js';
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
 * Check whether a Rust item node has a `pub` visibility modifier.
 * In tree-sitter-rust, visibility is a `visibility_modifier` child.
 */
function isRustPublic(node: SyntaxNode): boolean {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child?.type === 'visibility_modifier') return true;
  }
  return false;
}

/** Extract the first line comment preceding a node. */
function extractDocSummary(node: SyntaxNode): string | undefined {
  let sibling = node.previousSibling;
  // Skip attribute macros (#[...])
  while (sibling?.type === 'attribute_item') {
    sibling = sibling.previousSibling;
  }
  if (!sibling || sibling.type !== 'line_comment') return undefined;
  return sibling.text.replace(/^\/\/\/?\s*/, '').trim() || undefined;
}

/** Extract parameter names from a `parameters` node in a Rust function. */
function extractParamNames(paramsNode: SyntaxNode): string[] {
  const names: string[] = [];
  for (let i = 0; i < paramsNode.namedChildCount; i++) {
    const param = paramsNode.namedChild(i);
    if (!param) continue;
    // parameter: pattern: (identifier) type: ...
    // self_parameter / variadic_parameter: special
    if (param.type === 'parameter') {
      const patternNode = param.childForFieldName('pattern');
      if (patternNode?.type === 'identifier' && patternNode.text !== 'self') {
        names.push(patternNode.text);
      }
    }
  }
  return names;
}

/**
 * Extract the base type name from a possibly-generic type node.
 * e.g. `Option<String>` → `Option`, `Vec<u8>` → `Vec`, `MyStruct` → `MyStruct`
 */
function extractBaseTypeName(typeNode: SyntaxNode): string | null {
  if (typeNode.type === 'type_identifier') return typeNode.text;
  if (typeNode.type === 'generic_type') {
    const inner = typeNode.childForFieldName('type') ?? typeNode.namedChild(0);
    if (inner?.type === 'type_identifier') return inner.text;
  }
  if (typeNode.type === 'scoped_type_identifier') {
    // e.g. `std::fmt::Display` — return the last segment
    const segments = typeNode.text.split('::');
    return segments[segments.length - 1] ?? null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Definition extraction — top-level items
// ---------------------------------------------------------------------------

/** Walk a list of child nodes (module body or source_file) for definitions. */
function walkItems(
  parent: SyntaxNode,
  filePath: string,
  language: string,
  results: GraphNode[],
  modulePath?: string,
): void {
  for (let i = 0; i < parent.namedChildCount; i++) {
    const node = parent.namedChild(i);
    if (!node) continue;
    processItem(node, filePath, language, results, modulePath);
  }
}

/** Process a single top-level (or module-level) Rust item. */
function processItem(
  node: SyntaxNode,
  filePath: string,
  language: string,
  results: GraphNode[],
  modulePath?: string,
): void {
  const qualify = (name: string): string => (modulePath ? `${modulePath}::${name}` : name);

  switch (node.type) {
    case 'function_item': {
      const nameNode = node.childForFieldName('name');
      if (!nameNode) break;
      const name = nameNode.text;
      if (!name) break;

      const paramsNode = node.childForFieldName('parameters');
      const parameters = paramsNode ? extractParamNames(paramsNode) : [];

      results.push({
        id: nodeId(filePath, qualify(name)),
        kind: 'function' as GraphNodeKind,
        name,
        filePath,
        startLine: toLine(node.startPosition.row),
        endLine: toLine(node.endPosition.row),
        language,
        exported: isRustPublic(node),
        parameters,
        docSummary: extractDocSummary(node),
      });
      break;
    }

    case 'struct_item': {
      const nameNode = node.childForFieldName('name');
      if (!nameNode) break;
      const name = nameNode.text;
      if (!name) break;

      results.push({
        id: nodeId(filePath, qualify(name)),
        kind: 'struct' as GraphNodeKind,
        name,
        filePath,
        startLine: toLine(node.startPosition.row),
        endLine: toLine(node.endPosition.row),
        language,
        exported: isRustPublic(node),
        docSummary: extractDocSummary(node),
      });

      // Emit struct fields
      const fieldListNode = node.childForFieldName('body');
      if (fieldListNode) {
        extractStructFields(fieldListNode, filePath, qualify(name), language, results);
      }
      break;
    }

    case 'enum_item': {
      const nameNode = node.childForFieldName('name');
      if (!nameNode) break;
      const name = nameNode.text;
      if (!name) break;

      results.push({
        id: nodeId(filePath, qualify(name)),
        kind: 'enum' as GraphNodeKind,
        name,
        filePath,
        startLine: toLine(node.startPosition.row),
        endLine: toLine(node.endPosition.row),
        language,
        exported: isRustPublic(node),
        docSummary: extractDocSummary(node),
      });
      break;
    }

    case 'trait_item': {
      const nameNode = node.childForFieldName('name');
      if (!nameNode) break;
      const name = nameNode.text;
      if (!name) break;

      results.push({
        id: nodeId(filePath, qualify(name)),
        kind: 'trait' as GraphNodeKind,
        name,
        filePath,
        startLine: toLine(node.startPosition.row),
        endLine: toLine(node.endPosition.row),
        language,
        exported: isRustPublic(node),
        docSummary: extractDocSummary(node),
      });
      break;
    }

    case 'impl_item': {
      // `impl Struct` or `impl Trait for Struct`
      const typeNode = node.childForFieldName('type');
      if (!typeNode) break;
      const implTypeName = extractBaseTypeName(typeNode);
      if (!implTypeName) break;

      const traitNode = node.childForFieldName('trait');
      const implName = traitNode
        ? `impl ${extractBaseTypeName(traitNode) ?? traitNode.text} for ${implTypeName}`
        : `impl ${implTypeName}`;

      results.push({
        id: nodeId(filePath, qualify(implName)),
        kind: 'impl' as GraphNodeKind,
        name: implName,
        filePath,
        startLine: toLine(node.startPosition.row),
        endLine: toLine(node.endPosition.row),
        language,
        exported: false,
        docSummary: extractDocSummary(node),
      });

      // Emit methods inside the impl block
      const bodyNode = node.childForFieldName('body');
      if (bodyNode) {
        extractImplMethods(bodyNode, filePath, qualify(implTypeName), language, results);
      }
      break;
    }

    case 'type_item': {
      const nameNode = node.childForFieldName('name');
      if (!nameNode) break;
      const name = nameNode.text;
      if (!name) break;

      results.push({
        id: nodeId(filePath, qualify(name)),
        kind: 'type_alias' as GraphNodeKind,
        name,
        filePath,
        startLine: toLine(node.startPosition.row),
        endLine: toLine(node.endPosition.row),
        language,
        exported: isRustPublic(node),
        docSummary: extractDocSummary(node),
      });
      break;
    }

    case 'const_item': {
      const nameNode = node.childForFieldName('name');
      if (!nameNode) break;
      const name = nameNode.text;
      if (!name) break;

      results.push({
        id: nodeId(filePath, qualify(name)),
        kind: 'constant' as GraphNodeKind,
        name,
        filePath,
        startLine: toLine(node.startPosition.row),
        endLine: toLine(node.endPosition.row),
        language,
        exported: isRustPublic(node),
      });
      break;
    }

    case 'static_item': {
      const nameNode = node.childForFieldName('name');
      if (!nameNode) break;
      const name = nameNode.text;
      if (!name) break;

      results.push({
        id: nodeId(filePath, qualify(name)),
        kind: 'static' as GraphNodeKind,
        name,
        filePath,
        startLine: toLine(node.startPosition.row),
        endLine: toLine(node.endPosition.row),
        language,
        exported: isRustPublic(node),
      });
      break;
    }

    case 'mod_item': {
      const nameNode = node.childForFieldName('name');
      if (!nameNode) break;
      const name = nameNode.text;
      if (!name) break;

      results.push({
        id: nodeId(filePath, qualify(name)),
        kind: 'module' as GraphNodeKind,
        name,
        filePath,
        startLine: toLine(node.startPosition.row),
        endLine: toLine(node.endPosition.row),
        language,
        exported: isRustPublic(node),
        docSummary: extractDocSummary(node),
      });

      // Recurse into inline module body
      const bodyNode = node.childForFieldName('body');
      if (bodyNode) {
        walkItems(bodyNode, filePath, language, results, qualify(name));
      }
      break;
    }

    case 'macro_definition': {
      const nameNode = node.childForFieldName('name');
      if (!nameNode) break;
      const name = nameNode.text;
      if (!name) break;

      results.push({
        id: nodeId(filePath, qualify(name)),
        kind: 'macro' as GraphNodeKind,
        name,
        filePath,
        startLine: toLine(node.startPosition.row),
        endLine: toLine(node.endPosition.row),
        language,
        exported: false,
      });
      break;
    }

    default:
      break;
  }
}

/** Extract field declarations from a struct body (field_declaration_list). */
function extractStructFields(
  bodyNode: SyntaxNode,
  filePath: string,
  structName: string,
  language: string,
  results: GraphNode[],
): void {
  for (let i = 0; i < bodyNode.namedChildCount; i++) {
    const field = bodyNode.namedChild(i);
    if (!field || field.type !== 'field_declaration') continue;

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
      exported: isRustPublic(field),
      parent: nodeId(filePath, structName),
    });
  }
}

/** Extract method items from an impl block body. */
function extractImplMethods(
  bodyNode: SyntaxNode,
  filePath: string,
  implTypeName: string,
  language: string,
  results: GraphNode[],
): void {
  for (let i = 0; i < bodyNode.namedChildCount; i++) {
    const item = bodyNode.namedChild(i);
    if (!item) continue;

    if (item.type === 'function_item') {
      const nameNode = item.childForFieldName('name');
      if (!nameNode) continue;
      const methodName = nameNode.text;
      if (!methodName) continue;

      const paramsNode = item.childForFieldName('parameters');
      const parameters = paramsNode ? extractParamNames(paramsNode) : [];

      // Distinguish `new` / constructors from regular methods by convention
      const kind: GraphNodeKind = methodName === 'new' ? 'constructor' : 'method';

      results.push({
        id: nodeId(filePath, `${implTypeName}.${methodName}`),
        kind,
        name: methodName,
        filePath,
        startLine: toLine(item.startPosition.row),
        endLine: toLine(item.endPosition.row),
        language,
        exported: isRustPublic(item),
        parent: nodeId(filePath, implTypeName),
        parameters,
        docSummary: extractDocSummary(item),
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Import extraction
// ---------------------------------------------------------------------------

/**
 * Extract Rust `use` declarations from the source file root.
 *
 * Handles:
 * - Simple: `use std::collections::HashMap` → rawImportPath = `"std::collections::HashMap"`,
 *   namedBinding = `{ local: "HashMap", exported: "HashMap" }`
 * - Glob: `use std::io::*` → rawImportPath = `"std::io"`, namedBinding = `{ local: "*", exported: "*" }`
 * - Grouped: `use std::collections::{HashMap, BTreeMap}` → one record per binding
 * - Aliased: `use std::io::Read as IoRead` → namedBinding = `{ local: "IoRead", exported: "Read" }`
 * - Crate-relative: `use crate::foo::Bar` → preserved as-is
 *
 * @param root - AST root (source_file) node
 * @param filePath - File path relative to repo root
 * @returns Array of extracted import records
 */
export function extractImports(root: SyntaxNode, filePath: string): ExtractedImport[] {
  const results: ExtractedImport[] = [];

  for (let i = 0; i < root.namedChildCount; i++) {
    const stmt = root.namedChild(i);
    if (!stmt) continue;
    if (stmt.type === 'use_declaration') {
      const argNode = stmt.childForFieldName('argument');
      if (argNode) {
        collectUseArgument(argNode, '', filePath, results);
      }
    }
    // Also handle use_declaration inside mod_items (inline modules)
    if (stmt.type === 'mod_item') {
      const bodyNode = stmt.childForFieldName('body');
      if (bodyNode) {
        collectModuleUseDeclarations(bodyNode, filePath, results);
      }
    }
  }

  return results;
}

/** Recursively collect use_declarations from an inline mod body. */
function collectModuleUseDeclarations(
  bodyNode: SyntaxNode,
  filePath: string,
  results: ExtractedImport[],
): void {
  for (let i = 0; i < bodyNode.namedChildCount; i++) {
    const item = bodyNode.namedChild(i);
    if (!item) continue;
    if (item.type === 'use_declaration') {
      const argNode = item.childForFieldName('argument');
      if (argNode) {
        collectUseArgument(argNode, '', filePath, results);
      }
    }
  }
}

/**
 * Recursively process a `use` argument node, building up rawImportPath.
 *
 * Tree-sitter-rust use argument node types:
 * - `scoped_identifier` — `foo::bar::Baz`
 * - `scoped_use_list` — `foo::bar::{A, B}`
 * - `use_list` — `{A, B}` (top-level or nested brace group)
 * - `use_wildcard` — `*`
 * - `use_as_clause` — `foo::Bar as Alias`
 * - `identifier` — `Foo`
 * - `crate`, `super`, `self` — path segments
 */
function collectUseArgument(
  node: SyntaxNode,
  prefix: string,
  filePath: string,
  results: ExtractedImport[],
): void {
  switch (node.type) {
    case 'scoped_identifier': {
      // path: foo::bar  — emit as a complete path
      const text = node.text;
      const lastSep = text.lastIndexOf('::');
      if (lastSep === -1) {
        results.push({
          filePath,
          rawImportPath: prefix ? `${prefix}::${text}` : text,
          namedBindings: [{ local: text, exported: text }],
        });
      } else {
        const basePath = prefix ? `${prefix}::${text.slice(0, lastSep)}` : text.slice(0, lastSep);
        const leaf = text.slice(lastSep + 2);
        results.push({
          filePath,
          rawImportPath: basePath,
          namedBindings: [{ local: leaf, exported: leaf }],
        });
      }
      break;
    }

    case 'scoped_use_list': {
      // foo::bar::{A, B}  — path is the prefix of the scoped_use_list
      const pathNode = node.childForFieldName('path');
      const listNode = node.childForFieldName('list');
      const newPrefix = pathNode
        ? prefix
          ? `${prefix}::${pathNode.text}`
          : pathNode.text
        : prefix;
      if (listNode) {
        collectUseArgument(listNode, newPrefix, filePath, results);
      }
      break;
    }

    case 'use_list': {
      // {A, B, C} — expand each child
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child) collectUseArgument(child, prefix, filePath, results);
      }
      break;
    }

    case 'use_wildcard': {
      // foo::* — wildcard import
      results.push({
        filePath,
        rawImportPath: prefix,
        namedBindings: [{ local: '*', exported: '*' }],
      });
      break;
    }

    case 'use_as_clause': {
      // foo::Bar as Alias
      const pathNode = node.childForFieldName('path');
      const aliasNode = node.childForFieldName('alias');
      if (pathNode) {
        const pathText = pathNode.text;
        const lastSep = pathText.lastIndexOf('::');
        const basePath =
          lastSep === -1
            ? prefix
            : prefix
              ? `${prefix}::${pathText.slice(0, lastSep)}`
              : pathText.slice(0, lastSep);
        const exported = lastSep === -1 ? pathText : pathText.slice(lastSep + 2);
        const local = aliasNode?.text ?? exported;
        const namedBindings: NamedImportBinding[] = [{ local, exported }];
        results.push({
          filePath,
          rawImportPath: basePath || pathText,
          namedBindings,
        });
      }
      break;
    }

    case 'identifier': {
      // bare name in use list: `use {Foo}` after expansion
      const name = node.text;
      if (name) {
        results.push({
          filePath,
          rawImportPath: prefix,
          namedBindings: [{ local: name, exported: name }],
        });
      }
      break;
    }

    default:
      // crate, super, self, or other path segment — handled as part of parent
      break;
  }
}

// ---------------------------------------------------------------------------
// Heritage extraction
// ---------------------------------------------------------------------------

/**
 * Extract trait implementations from the source file.
 *
 * `impl Trait for Struct` → heritage record with kind `'implements'`.
 * `impl Struct` (no trait) → no heritage record emitted.
 *
 * @param root - AST root (source_file) node
 * @param filePath - File path relative to repo root
 * @returns Array of heritage records
 */
export function extractHeritage(root: SyntaxNode, filePath: string): ExtractedHeritage[] {
  const results: ExtractedHeritage[] = [];
  collectImplHeritage(root, filePath, results);
  return results;
}

/** Recursively collect impl_item heritage from a node's children. */
function collectImplHeritage(
  parent: SyntaxNode,
  filePath: string,
  results: ExtractedHeritage[],
): void {
  for (let i = 0; i < parent.namedChildCount; i++) {
    const node = parent.namedChild(i);
    if (!node) continue;

    if (node.type === 'impl_item') {
      const traitNode = node.childForFieldName('trait');
      const typeNode = node.childForFieldName('type');

      if (traitNode && typeNode) {
        const traitName = extractBaseTypeName(traitNode);
        const typeName = extractBaseTypeName(typeNode);

        if (traitName && typeName) {
          results.push({
            filePath,
            typeName,
            typeNodeId: nodeId(filePath, typeName),
            kind: 'implements',
            parentName: traitName,
          });
        }
      }
    }

    // Recurse into mod_item bodies
    if (node.type === 'mod_item') {
      const bodyNode = node.childForFieldName('body');
      if (bodyNode) {
        collectImplHeritage(bodyNode, filePath, results);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Call extraction
// ---------------------------------------------------------------------------

/** Node types that define a function scope boundary in Rust. */
const ENCLOSING_RUST_FUNCTION_TYPES = new Set(['function_item']);

/**
 * Build the source node ID for a call expression in Rust.
 */
function buildSourceId(callNode: SyntaxNode, filePath: string): string {
  let current = callNode.parent;

  while (current) {
    if (current.type === 'function_item') {
      const nameNode = current.childForFieldName('name');
      if (nameNode?.text) {
        // Check if inside an impl block to qualify the name
        const implBlock = findAncestorImplItem(current);
        if (implBlock) {
          const typeNode = implBlock.childForFieldName('type');
          const typeName = typeNode ? extractBaseTypeName(typeNode) : null;
          if (typeName) {
            return `${filePath}::${typeName}.${nameNode.text}`;
          }
        }
        return `${filePath}::${nameNode.text}`;
      }
    }
    current = current.parent;
  }

  return `${filePath}::__file__`;
}

/** Walk up the parent chain to find an enclosing `impl_item`. */
function findAncestorImplItem(node: SyntaxNode): SyntaxNode | null {
  let current = node.parent;
  while (current) {
    if (current.type === 'impl_item') return current;
    if (current.type === 'source_file') return null;
    current = current.parent;
  }
  return null;
}

void ENCLOSING_RUST_FUNCTION_TYPES; // used conceptually via parent chain walk

/**
 * Walk the full AST to collect all call expressions.
 *
 * Handles:
 * - Free calls: `foo(args)` → callForm `'free'`
 * - Method calls: `obj.method(args)` → callForm `'member'`
 * - Associated function calls: `Foo::new(args)` → callForm `'free'` (calledName = `new`)
 * - Struct literals: `User { name: value }` → callForm `'constructor'`
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
        } else if (functionNode.type === 'field_expression') {
          // obj.method()
          const fieldNode = functionNode.childForFieldName('field');
          const valueNode = functionNode.childForFieldName('value');
          if (fieldNode?.text) {
            results.push({
              filePath,
              calledName: fieldNode.text,
              sourceId: buildSourceId(node, filePath),
              argCount,
              callForm: 'member',
              receiverName: valueNode?.type === 'identifier' ? valueNode.text : undefined,
            });
          }
        } else if (functionNode.type === 'scoped_identifier') {
          // Foo::new() or std::mem::drop()
          const nameNode = functionNode.childForFieldName('name');
          const pathNode = functionNode.childForFieldName('path');
          if (nameNode?.text) {
            results.push({
              filePath,
              calledName: nameNode.text,
              sourceId: buildSourceId(node, filePath),
              argCount,
              callForm: 'free',
              // path can be type_identifier (MyStruct) or plain identifier (std, self, etc.)
              receiverName:
                pathNode?.type === 'type_identifier' || pathNode?.type === 'identifier'
                  ? pathNode.text
                  : undefined,
            });
          }
        } else if (functionNode.type === 'generic_function') {
          // foo::<T>() or Foo::new::<T>()
          const innerFunc = functionNode.childForFieldName('function');
          if (innerFunc?.type === 'identifier') {
            results.push({
              filePath,
              calledName: innerFunc.text,
              sourceId: buildSourceId(node, filePath),
              argCount,
              callForm: 'free',
            });
          } else if (innerFunc?.type === 'scoped_identifier') {
            const nameNode = innerFunc.childForFieldName('name');
            if (nameNode?.text) {
              results.push({
                filePath,
                calledName: nameNode.text,
                sourceId: buildSourceId(node, filePath),
                argCount,
                callForm: 'free',
              });
            }
          }
        }
      }
    } else if (node.type === 'struct_expression') {
      // User { name: value }
      const nameNode = node.childForFieldName('name');
      if (nameNode?.type === 'type_identifier') {
        results.push({
          filePath,
          calledName: nameNode.text,
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
 * Full extraction result for one Rust file.
 */
export interface RustExtractionResult {
  /** Symbol definition nodes extracted from the file. */
  definitions: GraphNode[];
  /** Raw import records for the import-processor fast-path. */
  imports: ExtractedImport[];
  /** Heritage clauses for IMPLEMENTS edge emission (trait impls). */
  heritage: ExtractedHeritage[];
  /** Call expressions for CALLS edge emission. */
  calls: ExtractedCall[];
}

// ---------------------------------------------------------------------------
// Main extraction entry point
// ---------------------------------------------------------------------------

/**
 * Extract all intelligence data from a Rust AST.
 *
 * @param rootNode - The root (source_file) node of the parsed AST
 * @param filePath - File path relative to the repository root
 * @returns Full extraction result for the file
 */
export function extractRust(rootNode: SyntaxNode, filePath: string): RustExtractionResult {
  const language = 'rust';
  const definitions: GraphNode[] = [];
  walkItems(rootNode, filePath, language, definitions);

  const imports = extractImports(rootNode, filePath);
  const heritage = extractHeritage(rootNode, filePath);
  const calls = extractCalls(rootNode, filePath);

  return { definitions, imports, heritage, calls };
}
