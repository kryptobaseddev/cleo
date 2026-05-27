/**
 * Python AST extractor for the parse-loop pipeline.
 *
 * Extracts from a tree-sitter-python AST:
 *
 * - **Definitions**: top-level functions (`def`), classes (`class`), methods
 *   (`def` inside `class_definition`), and module-level variables.
 * - **Imports**: `import X`, `import X as Y`, `from X import Y`,
 *   `from . import Z` (relative). Returns {@link ExtractedImport} records for
 *   the import-processor fast-path.
 * - **Heritage**: class inheritance — `class Foo(Bar, Baz)` emits two
 *   `extends` records.
 * - **Calls**: free function calls (`foo()`), method calls (`obj.method()`).
 *
 * Python-specific notes:
 * - Namespace imports: `import models` makes `models.User` accessible via the
 *   `models` alias, detected as a namespace binding.
 * - `__init__.py` barrel modules are handled by the import-processor; this
 *   extractor focuses on AST traversal only.
 * - Decorators are not emitted as separate nodes; they appear as children of
 *   the decorated definition.
 *
 * Tree-sitter query patterns ported from GitNexus
 * `src/core/ingestion/tree-sitter-queries.ts` (PYTHON_QUERIES section).
 *
 * @task T541
 * @module pipeline/extractors/python-extractor
 */

import type { GraphNode, GraphNodeKind } from '@cleocode/contracts';
import type { ExtractedImport, NamedImportBinding } from '../import-processor.js';
import type { ExtractedCall, ExtractedHeritage } from './typescript-extractor.js';

// ---------------------------------------------------------------------------
// Minimal SyntaxNode interface (mirrors typescript-extractor.ts)
// ---------------------------------------------------------------------------

/**
 * Minimal tree-sitter SyntaxNode shape required by this extractor.
 * Avoids a hard dependency on any particular tree-sitter type package.
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
 * Python does not have an explicit export keyword. All top-level names are
 * "exported" (publicly accessible). Names prefixed with `_` are conventionally
 * private.
 */
function isPythonExported(name: string): boolean {
  return !name.startsWith('_');
}

/** Extract the first comment preceding a node (docstring is a child, not sibling). */
function extractDocSummary(node: SyntaxNode): string | undefined {
  // Python docstrings are expression_statement > string at position 0 in body.
  // Only the first statement of the body is checked.
  const bodyNode = node.childForFieldName('body');
  if (!bodyNode) return undefined;

  const first = bodyNode.namedChild(0);
  if (!first || first.type !== 'expression_statement') return undefined;

  const inner = first.namedChild(0);
  if (!inner || (inner.type !== 'string' && inner.type !== 'concatenated_string')) return undefined;

  const raw = inner.text.replace(/^['"]{1,3}|['"]{1,3}$/g, '').trim();
  const firstLine = raw.split('\n')[0]?.trim();
  return firstLine || undefined;
}

/** Extract parameter names from a `parameters` node. */
function extractParamNames(paramsNode: SyntaxNode): string[] {
  const names: string[] = [];
  for (let i = 0; i < paramsNode.namedChildCount; i++) {
    const param = paramsNode.namedChild(i);
    if (!param) continue;
    // Covers: identifier, typed_parameter, default_parameter, list_splat_pattern, dictionary_splat_pattern
    const nameNode =
      param.childForFieldName('name') ?? (param.type === 'identifier' ? param : null);
    if (nameNode?.text && nameNode.text !== 'self' && nameNode.text !== 'cls') {
      names.push(nameNode.text);
    }
  }
  return names;
}

// ---------------------------------------------------------------------------
// Definition extraction
// ---------------------------------------------------------------------------

/**
 * Walk the top-level AST to extract all definitions (functions and classes).
 *
 * @param root - AST root (module) node
 * @param filePath - File path relative to repo root
 * @param results - Accumulator for extracted GraphNodes (mutated in place)
 */
function walkDefinitions(root: SyntaxNode, filePath: string, results: GraphNode[]): void {
  const language = 'python';

  for (let i = 0; i < root.namedChildCount; i++) {
    const node = root.namedChild(i);
    if (!node) continue;

    if (node.type === 'function_definition') {
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
        exported: isPythonExported(name),
        parameters,
        docSummary: extractDocSummary(node),
      });
    } else if (node.type === 'class_definition') {
      const classNodes = buildClassNodes(node, filePath, language);
      for (const n of classNodes) results.push(n);
    }
    // Module-level assignments are not emitted as definitions (too noisy)
  }
}

/**
 * Build GraphNodes for a `class_definition` — the class itself plus all
 * methods defined in its body.
 */
function buildClassNodes(node: SyntaxNode, filePath: string, language: string): GraphNode[] {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return [];
  const className = nameNode.text;
  if (!className) return [];

  const classNode: GraphNode = {
    id: nodeId(filePath, className),
    kind: 'class' as GraphNodeKind,
    name: className,
    filePath,
    startLine: toLine(node.startPosition.row),
    endLine: toLine(node.endPosition.row),
    language,
    exported: isPythonExported(className),
    docSummary: extractDocSummary(node),
  };

  const results: GraphNode[] = [classNode];

  const bodyNode = node.childForFieldName('body');
  if (!bodyNode) return results;

  for (let i = 0; i < bodyNode.namedChildCount; i++) {
    const member = bodyNode.namedChild(i);
    if (!member) continue;

    if (member.type === 'function_definition') {
      const methodNameNode = member.childForFieldName('name');
      if (!methodNameNode) continue;
      const methodName = methodNameNode.text;
      if (!methodName) continue;

      const kind: GraphNodeKind = methodName === '__init__' ? 'constructor' : 'method';

      const paramsNode = member.childForFieldName('parameters');
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
        docSummary: extractDocSummary(member),
      });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Import extraction
// ---------------------------------------------------------------------------

/**
 * Extract Python import statements from the module root.
 *
 * Handles:
 * - `import foo` → rawImportPath = `"foo"`
 * - `import foo as bar` → rawImportPath = `"foo"`, namedBinding local=`"bar"` exported=`"*"`
 * - `from foo import bar, baz` → rawImportPath = `"foo"`, namedBindings
 * - `from . import bar` → rawImportPath = `"."` (relative)
 * - `from ..pkg import bar` → rawImportPath = `"..pkg"` (relative)
 *
 * @param root - AST root (module) node
 * @param filePath - File path relative to repo root
 * @returns Array of extracted import records
 */
export function extractImports(root: SyntaxNode, filePath: string): ExtractedImport[] {
  const results: ExtractedImport[] = [];

  for (let i = 0; i < root.namedChildCount; i++) {
    const stmt = root.namedChild(i);
    if (!stmt) continue;

    if (stmt.type === 'import_statement') {
      // `import X` or `import X as Y`
      for (let j = 0; j < stmt.namedChildCount; j++) {
        const name = stmt.namedChild(j);
        if (!name) continue;

        if (name.type === 'dotted_name') {
          results.push({ filePath, rawImportPath: name.text });
        } else if (name.type === 'aliased_import') {
          const srcNode = name.childForFieldName('name') ?? name.namedChild(0);
          const aliasNode = name.childForFieldName('alias') ?? name.namedChild(1);
          if (srcNode) {
            const rawImportPath = srcNode.text;
            const namedBindings: NamedImportBinding[] = aliasNode
              ? [{ local: aliasNode.text, exported: '*' }]
              : undefined!;
            results.push({
              filePath,
              rawImportPath,
              namedBindings: aliasNode ? namedBindings : undefined,
            });
          }
        }
      }
    } else if (stmt.type === 'import_from_statement') {
      // `from X import Y` or `from . import Z`
      const moduleNode = stmt.childForFieldName('module_name') ?? stmt.namedChild(0);
      if (!moduleNode) continue;

      let rawImportPath: string;
      if (moduleNode.type === 'relative_import') {
        // `from . import X` or `from ..pkg import X`
        rawImportPath = moduleNode.text; // e.g. "." or "..pkg"
      } else {
        rawImportPath = moduleNode.text; // e.g. "os.path"
      }

      const namedBindings: NamedImportBinding[] = [];

      // Collect imported names
      for (let j = 0; j < stmt.namedChildCount; j++) {
        const child = stmt.namedChild(j);
        if (!child) continue;
        if (child === moduleNode) continue;

        if (child.type === 'wildcard_import') {
          namedBindings.push({ local: '*', exported: '*' });
        } else if (child.type === 'aliased_import') {
          const srcNode = child.childForFieldName('name') ?? child.namedChild(0);
          const aliasNode = child.childForFieldName('alias') ?? child.namedChild(1);
          if (srcNode) {
            namedBindings.push({
              local: aliasNode?.text ?? srcNode.text,
              exported: srcNode.text,
            });
          }
        } else if (child.type === 'dotted_name' || child.type === 'identifier') {
          namedBindings.push({ local: child.text, exported: child.text });
        }
      }

      results.push({
        filePath,
        rawImportPath,
        namedBindings: namedBindings.length > 0 ? namedBindings : undefined,
      });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Heritage extraction
// ---------------------------------------------------------------------------

/**
 * Extract class inheritance declarations from the module root.
 *
 * Handles `class Foo(Bar, Baz):` — emits one `extends` record per base class.
 *
 * @param root - AST root (module) node
 * @param filePath - File path relative to repo root
 * @returns Array of heritage records
 */
export function extractHeritage(root: SyntaxNode, filePath: string): ExtractedHeritage[] {
  const results: ExtractedHeritage[] = [];

  for (let i = 0; i < root.namedChildCount; i++) {
    const node = root.namedChild(i);
    if (!node || node.type !== 'class_definition') continue;

    const nameNode = node.childForFieldName('name');
    if (!nameNode) continue;
    const typeName = nameNode.text;
    if (!typeName) continue;

    const typeNodeId = nodeId(filePath, typeName);

    // superclasses is an `argument_list` child
    const superclassNode = node.childForFieldName('superclasses');
    if (!superclassNode) continue;

    for (let j = 0; j < superclassNode.namedChildCount; j++) {
      const base = superclassNode.namedChild(j);
      if (!base) continue;

      // May be an identifier or attribute (e.g. `models.Base`)
      const parentName =
        base.type === 'identifier' ? base.text : (base.text.split('.').pop() ?? base.text);
      if (parentName && parentName !== 'object') {
        results.push({
          filePath,
          typeName,
          typeNodeId,
          kind: 'extends',
          parentName,
        });
      }
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Call extraction
// ---------------------------------------------------------------------------

/**
 * Build the source node ID for the call — the nearest enclosing function or
 * the file-level pseudo-node.
 */
function buildSourceId(callNode: SyntaxNode, filePath: string): string {
  let current = callNode.parent;

  while (current) {
    if (current.type === 'function_definition') {
      const nameNode = current.childForFieldName('name');
      if (nameNode?.text) {
        // Check if this function is inside a class
        const possibleBody = current.parent;
        const possibleClass = possibleBody?.parent;
        if (possibleClass?.type === 'class_definition') {
          const classNameNode = possibleClass.childForFieldName('name');
          if (classNameNode?.text) {
            return `${filePath}::${classNameNode.text}.${nameNode.text}`;
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
 * - Method calls: `obj.method(args)` → callForm `'member'`
 *
 * @param root - AST root (module) node
 * @param filePath - File path relative to repo root
 * @returns Array of extracted call records
 */
export function extractCalls(root: SyntaxNode, filePath: string): ExtractedCall[] {
  const results: ExtractedCall[] = [];

  function walk(node: SyntaxNode): void {
    if (node.type === 'call') {
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
        } else if (functionNode.type === 'attribute') {
          const attrNode = functionNode.childForFieldName('attribute');
          const objNode = functionNode.childForFieldName('object');
          if (attrNode?.text) {
            results.push({
              filePath,
              calledName: attrNode.text,
              sourceId: buildSourceId(node, filePath),
              argCount,
              callForm: 'member',
              receiverName: objNode?.type === 'identifier' ? objNode.text : undefined,
            });
          }
        }
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
 * Full extraction result for one Python file.
 */
export interface PythonExtractionResult {
  /** Symbol definition nodes extracted from the file. */
  definitions: GraphNode[];
  /** Raw import records for the import-processor fast-path. */
  imports: ExtractedImport[];
  /** Heritage clauses for EXTENDS edge emission. */
  heritage: ExtractedHeritage[];
  /** Call expressions for CALLS edge emission. */
  calls: ExtractedCall[];
}

// ---------------------------------------------------------------------------
// Main extraction entry point
// ---------------------------------------------------------------------------

/**
 * Extract all intelligence data from a Python AST.
 *
 * Combines definition extraction, import extraction, heritage extraction,
 * and call expression extraction in a single pass.
 *
 * @param rootNode - The root (module) node of the parsed AST
 * @param filePath - File path relative to the repository root
 * @returns Full extraction result for the file
 */
export function extractPython(rootNode: SyntaxNode, filePath: string): PythonExtractionResult {
  const definitions: GraphNode[] = [];
  walkDefinitions(rootNode, filePath, definitions);

  const imports = extractImports(rootNode, filePath);
  const heritage = extractHeritage(rootNode, filePath);
  const calls = extractCalls(rootNode, filePath);

  return { definitions, imports, heritage, calls };
}
