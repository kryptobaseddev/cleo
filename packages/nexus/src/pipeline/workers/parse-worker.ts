/**
 * Parse worker thread script for parallel multi-file TypeScript/JavaScript parsing.
 *
 * Runs in a Node.js Worker thread spawned by the worker pool. Receives file
 * batches via structured IPC, parses each file with tree-sitter, extracts
 * symbols/imports/heritage/calls using the CLEO TypeScript extractor, and
 * returns accumulated results via a flush message.
 *
 * IPC protocol (mirrors GitNexus parse-worker.ts):
 *   Incoming: { type: 'sub-batch', files: ParseWorkerInput[] }
 *           | { type: 'flush' }
 *   Outgoing: { type: 'sub-batch-done' }
 *           | { type: 'result', data: ParseWorkerResult }
 *           | { type: 'progress', filesProcessed: number }
 *           | { type: 'error', error: string }
 *
 * @task T540
 * @module pipeline/workers/parse-worker
 */

import { createRequire } from 'node:module';
import { parentPort } from 'node:worker_threads';

if (!parentPort) {
  throw new Error('parse-worker.ts must be run as a Worker thread, not directly.');
}

// ---------------------------------------------------------------------------
// Tree-sitter setup (native require — must use createRequire in ESM workers)
// ---------------------------------------------------------------------------

const _require = createRequire(import.meta.url);

/** Minimal NativeParser shape used here. */
interface NativeParser {
  setLanguage(lang: unknown): void;
  parse(source: string): { rootNode: NativeSyntaxNode };
}

/** Minimal SyntaxNode shape sufficient for the extractor. */
interface NativeSyntaxNode {
  type: string;
  text: string;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  children: NativeSyntaxNode[];
  namedChildren: NativeSyntaxNode[];
  namedChildCount: number;
  isNamed: boolean;
  parent: NativeSyntaxNode | null;
  previousSibling: NativeSyntaxNode | null;
  childForFieldName(field: string): NativeSyntaxNode | null;
  namedChild(index: number): NativeSyntaxNode | null;
}

type ParserConstructor = new () => NativeParser;

let _parser: NativeParser | null = null;

function getParser(): NativeParser | null {
  if (_parser) return _parser;
  try {
    const ParserClass = _require('tree-sitter') as ParserConstructor;
    _parser = new ParserClass();
    return _parser;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Grammar loading
// ---------------------------------------------------------------------------

const grammarCache = new Map<string, unknown | null>();

function loadGrammar(langKey: string): unknown | null {
  if (grammarCache.has(langKey)) return grammarCache.get(langKey) ?? null;

  try {
    if (langKey === 'typescript') {
      const mod = _require('tree-sitter-typescript') as { typescript: unknown; tsx: unknown };
      grammarCache.set('typescript', mod.typescript ?? null);
      grammarCache.set('tsx', mod.tsx ?? null);
      return mod.typescript ?? null;
    }
    if (langKey === 'tsx') {
      const mod = _require('tree-sitter-typescript') as { typescript: unknown; tsx: unknown };
      grammarCache.set('typescript', mod.typescript ?? null);
      grammarCache.set('tsx', mod.tsx ?? null);
      return mod.tsx ?? null;
    }
    if (langKey === 'javascript') {
      const mod = _require('tree-sitter-javascript') as unknown;
      grammarCache.set('javascript', mod);
      return mod;
    }
    grammarCache.set(langKey, null);
    return null;
  } catch {
    grammarCache.set(langKey, null);
    return null;
  }
}

function grammarKeyForPath(filePath: string): string | null {
  if (filePath.endsWith('.tsx')) return 'tsx';
  if (filePath.endsWith('.ts') || filePath.endsWith('.mts') || filePath.endsWith('.cts'))
    return 'typescript';
  if (
    filePath.endsWith('.js') ||
    filePath.endsWith('.mjs') ||
    filePath.endsWith('.cjs') ||
    filePath.endsWith('.jsx')
  )
    return 'javascript';
  return null;
}

// ---------------------------------------------------------------------------
// Result types (serializable over IPC)
// ---------------------------------------------------------------------------

/** A single parsed symbol extracted from a file. */
export interface WorkerParsedSymbol {
  /** Node ID (format: `${filePath}::${name}`). */
  id: string;
  kind: string;
  name: string;
  filePath: string;
  startLine: number;
  endLine: number;
  language: string;
  exported: boolean;
  parameters?: string[];
  returnType?: string | undefined;
  docSummary?: string | undefined;
  parent?: string | undefined;
}

/** A named binding extracted from an import (e.g., `import { X as Y }`). */
export interface WorkerNamedImportBinding {
  /** Local alias used in this file. */
  local: string;
  /** Exported name from the source module. */
  exported: string;
}

/** An import edge extracted from a file. */
export interface WorkerExtractedImport {
  filePath: string;
  rawImportPath: string;
  language: string;
  /** Named bindings from a destructured import, if any. */
  namedBindings?: WorkerNamedImportBinding[];
}

/** A heritage relationship (extends/implements). */
export interface WorkerExtractedHeritage {
  filePath: string;
  typeName: string;
  typeNodeId: string;
  kind: 'extends' | 'implements';
  parentName: string;
}

/** A call site extracted from a file. */
export interface WorkerExtractedCall {
  filePath: string;
  /** Node ID of the enclosing function, or `<filePath>::__file__` for top-level calls. */
  sourceId: string;
  calledName: string;
  callForm: 'free' | 'member' | 'constructor';
  receiverName?: string;
}

/**
 * A re-export record extracted from a barrel/index file (T617).
 *
 * Serializable over IPC. Mirrors `ExtractedReExportRecord` from import-processor.ts.
 */
export interface WorkerExtractedReExport {
  filePath: string;
  rawSourcePath: string;
  /** null for wildcard `export * from '...'` */
  exportedName: string | null;
  /** null for wildcard re-exports */
  localName: string | null;
}

/** Result returned by each worker containing all extracted data. */
export interface ParseWorkerResult {
  symbols: WorkerParsedSymbol[];
  imports: WorkerExtractedImport[];
  heritage: WorkerExtractedHeritage[];
  calls: WorkerExtractedCall[];
  reExports: WorkerExtractedReExport[];
  fileCount: number;
  skippedCount: number;
}

// ---------------------------------------------------------------------------
// Input type
// ---------------------------------------------------------------------------

/** A file to parse — sent from the pool to workers. */
export interface ParseWorkerInput {
  /** Absolute path to the file. */
  path: string;
  /** File content (read by the main thread before dispatching). */
  content: string;
}

// ---------------------------------------------------------------------------
// IPC message types
// ---------------------------------------------------------------------------

type WorkerIncomingMessage = { type: 'sub-batch'; files: ParseWorkerInput[] } | { type: 'flush' };

// ---------------------------------------------------------------------------
// Extraction helpers — pure functions, no module-level state
// ---------------------------------------------------------------------------

/** Convert 0-based tree-sitter row to 1-based line number. */
function toLine(row: number): number {
  return row + 1;
}

/** Derive a stable node ID from file path and symbol name. */
function mkNodeId(filePath: string, name: string): string {
  return `${filePath}::${name}`;
}

/** Check whether a node carries an `export` keyword or has an export_statement parent. */
function isExported(node: NativeSyntaxNode): boolean {
  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i];
    if (child && !child.isNamed && child.text === 'export') return true;
  }
  return node.parent !== null && node.parent.type === 'export_statement';
}

/** Extract first JSDoc/line comment preceding a node. */
function extractDocSummary(node: NativeSyntaxNode): string | undefined {
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
function extractParamNames(paramsNode: NativeSyntaxNode): string[] {
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
function extractReturnType(funcNode: NativeSyntaxNode): string | undefined {
  const retTypeNode = funcNode.childForFieldName('return_type');
  if (!retTypeNode) return undefined;
  const text = retTypeNode.text.replace(/^:\s*/, '').trim();
  return text || undefined;
}

// ---------------------------------------------------------------------------
// Definition extraction
// ---------------------------------------------------------------------------

const CONTAINER_TYPES = new Set([
  'program',
  'module',
  'namespace',
  'internal_module',
  'module_declaration',
]);

const EXPORTABLE_DECL_TYPES = new Set([
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

function walkDefinitions(
  node: NativeSyntaxNode,
  filePath: string,
  language: string,
  symbols: WorkerParsedSymbol[],
): void {
  switch (node.type) {
    case 'function_declaration':
    case 'generator_function_declaration': {
      const nameNode = node.childForFieldName('name');
      if (nameNode?.text) {
        const paramsNode =
          node.childForFieldName('parameters') ?? node.childForFieldName('formal_parameters');
        symbols.push({
          id: mkNodeId(filePath, nameNode.text),
          kind: 'function',
          name: nameNode.text,
          filePath,
          startLine: toLine(node.startPosition.row),
          endLine: toLine(node.endPosition.row),
          language,
          exported: isExported(node),
          parameters: paramsNode ? extractParamNames(paramsNode) : [],
          returnType: extractReturnType(node),
          docSummary: extractDocSummary(node),
        });
      }
      break;
    }
    case 'class_declaration':
    case 'abstract_class_declaration': {
      const nameNode = node.childForFieldName('name');
      if (nameNode?.text) {
        const className = nameNode.text;
        const classId = mkNodeId(filePath, className);
        symbols.push({
          id: classId,
          kind: 'class',
          name: className,
          filePath,
          startLine: toLine(node.startPosition.row),
          endLine: toLine(node.endPosition.row),
          language,
          exported: isExported(node),
          docSummary: extractDocSummary(node),
        });
        // Extract methods and properties from class body
        const bodyNode = node.childForFieldName('body');
        if (bodyNode) {
          for (let i = 0; i < bodyNode.namedChildCount; i++) {
            const member = bodyNode.namedChild(i);
            if (!member) continue;
            if (member.type === 'method_definition' || member.type === 'method_signature') {
              const mNameNode = member.childForFieldName('name');
              if (mNameNode?.text) {
                const mParamsNode = member.childForFieldName('parameters');
                symbols.push({
                  id: mkNodeId(filePath, `${className}.${mNameNode.text}`),
                  kind: 'method',
                  name: mNameNode.text,
                  filePath,
                  startLine: toLine(member.startPosition.row),
                  endLine: toLine(member.endPosition.row),
                  language,
                  exported: false,
                  parameters: mParamsNode ? extractParamNames(mParamsNode) : [],
                  returnType: extractReturnType(member),
                  parent: classId,
                });
              }
            } else if (
              member.type === 'public_field_definition' ||
              member.type === 'field_definition'
            ) {
              const fNameNode = member.childForFieldName('name');
              if (fNameNode?.text) {
                symbols.push({
                  id: mkNodeId(filePath, `${className}.${fNameNode.text}`),
                  kind: 'property',
                  name: fNameNode.text,
                  filePath,
                  startLine: toLine(member.startPosition.row),
                  endLine: toLine(member.endPosition.row),
                  language,
                  exported: false,
                  parent: classId,
                });
              }
            }
          }
        }
      }
      break;
    }
    case 'interface_declaration': {
      const nameNode = node.childForFieldName('name');
      if (nameNode?.text) {
        symbols.push({
          id: mkNodeId(filePath, nameNode.text),
          kind: 'interface',
          name: nameNode.text,
          filePath,
          startLine: toLine(node.startPosition.row),
          endLine: toLine(node.endPosition.row),
          language,
          exported: isExported(node),
          docSummary: extractDocSummary(node),
        });
      }
      break;
    }
    case 'type_alias_declaration': {
      const nameNode = node.childForFieldName('name');
      if (nameNode?.text) {
        symbols.push({
          id: mkNodeId(filePath, nameNode.text),
          kind: 'type_alias',
          name: nameNode.text,
          filePath,
          startLine: toLine(node.startPosition.row),
          endLine: toLine(node.endPosition.row),
          language,
          exported: isExported(node),
          docSummary: extractDocSummary(node),
        });
      }
      break;
    }
    case 'enum_declaration': {
      const nameNode = node.childForFieldName('name');
      if (nameNode?.text) {
        symbols.push({
          id: mkNodeId(filePath, nameNode.text),
          kind: 'enum',
          name: nameNode.text,
          filePath,
          startLine: toLine(node.startPosition.row),
          endLine: toLine(node.endPosition.row),
          language,
          exported: isExported(node),
          docSummary: extractDocSummary(node),
        });
      }
      break;
    }
    case 'export_statement': {
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child && EXPORTABLE_DECL_TYPES.has(child.type)) {
          walkDefinitions(child, filePath, language, symbols);
        }
      }
      break;
    }
    case 'lexical_declaration':
    case 'variable_declaration': {
      for (let i = 0; i < node.namedChildCount; i++) {
        const declarator = node.namedChild(i);
        if (!declarator || declarator.type !== 'variable_declarator') continue;
        const nameNode = declarator.childForFieldName('name');
        const valueNode = declarator.childForFieldName('value');
        if (!nameNode?.text || !valueNode) continue;
        if (valueNode.type !== 'arrow_function' && valueNode.type !== 'function_expression')
          continue;
        const paramsNode =
          valueNode.childForFieldName('parameters') ??
          valueNode.childForFieldName('formal_parameters');
        symbols.push({
          id: mkNodeId(filePath, nameNode.text),
          kind: 'function',
          name: nameNode.text,
          filePath,
          startLine: toLine(node.startPosition.row),
          endLine: toLine(node.endPosition.row),
          language,
          exported: isExported(node),
          parameters: paramsNode ? extractParamNames(paramsNode) : [],
          returnType: extractReturnType(valueNode),
          docSummary: extractDocSummary(node),
        });
      }
      break;
    }
    default:
      break;
  }

  if (CONTAINER_TYPES.has(node.type)) {
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child) walkDefinitions(child, filePath, language, symbols);
    }
  }
}

// ---------------------------------------------------------------------------
// Import extraction
// ---------------------------------------------------------------------------

function extractImports(
  rootNode: NativeSyntaxNode,
  filePath: string,
  language: string,
  imports: WorkerExtractedImport[],
): void {
  for (let i = 0; i < rootNode.namedChildCount; i++) {
    const stmt = rootNode.namedChild(i);
    if (!stmt || stmt.type !== 'import_statement') continue;

    const sourceNode = stmt.childForFieldName('source');
    if (!sourceNode) continue;

    let raw = sourceNode.text;
    if (
      (raw.startsWith('"') && raw.endsWith('"')) ||
      (raw.startsWith("'") && raw.endsWith("'"))
    ) {
      raw = raw.slice(1, -1);
    }
    if (!raw) continue;

    // Extract named bindings for Tier 2a resolution (T617)
    const namedBindings: WorkerNamedImportBinding[] = [];
    const importClause = stmt.childForFieldName('clause');
    if (importClause) {
      for (let j = 0; j < importClause.namedChildCount; j++) {
        const clauseChild = importClause.namedChild(j);
        if (!clauseChild) continue;

        if (clauseChild.type === 'named_imports') {
          for (let k = 0; k < clauseChild.namedChildCount; k++) {
            const specifier = clauseChild.namedChild(k);
            if (!specifier || specifier.type !== 'import_specifier') continue;
            const nameNode = specifier.childForFieldName('name');
            const aliasNode = specifier.childForFieldName('alias');
            if (nameNode?.text) {
              const exported = nameNode.text;
              const local = aliasNode?.text ?? exported;
              namedBindings.push({ local, exported });
            }
          }
        }

        // Namespace import: `import * as X from '...'`
        if (clauseChild.type === 'namespace_import') {
          const aliasNode = clauseChild.namedChild(0);
          if (aliasNode?.text) {
            namedBindings.push({ local: aliasNode.text, exported: '*' });
          }
        }

        // Default import: `import Foo from '...'`
        if (clauseChild.type === 'identifier') {
          const local = clauseChild.text;
          if (local) {
            namedBindings.push({ local, exported: 'default' });
          }
        }
      }
    }

    imports.push({
      filePath,
      rawImportPath: raw,
      language,
      namedBindings: namedBindings.length > 0 ? namedBindings : undefined,
    });
  }
}

// ---------------------------------------------------------------------------
// Re-export extraction (barrel files — T617)
// ---------------------------------------------------------------------------

function extractReExports(
  rootNode: NativeSyntaxNode,
  filePath: string,
  reExports: WorkerExtractedReExport[],
): void {
  for (let i = 0; i < rootNode.namedChildCount; i++) {
    const stmt = rootNode.namedChild(i);
    if (!stmt || stmt.type !== 'export_statement') continue;

    // Only care about re-exports: `export ... from '...'`
    const sourceNode = stmt.childForFieldName('source');
    if (!sourceNode) continue;

    const rawSource = sourceNode.text.replace(/^['"]|['"]$/g, '');
    if (!rawSource) continue;

    // Detect `export * from '...'` vs `export { ... } from '...'`
    let isWildcard = false;
    let hasNamespace = false;
    for (let j = 0; j < stmt.children.length; j++) {
      const child = stmt.children[j];
      if (!child) continue;
      if (!child.isNamed && child.text === '*') isWildcard = true;
      if (child.type === 'namespace_export') hasNamespace = true;
    }

    if (isWildcard && !hasNamespace) {
      reExports.push({ filePath, rawSourcePath: rawSource, exportedName: null, localName: null });
      continue;
    }

    if (hasNamespace) continue; // `export * as ns from '...'` — skip

    // Named re-exports: `export { Foo, Bar as Baz } from '...'`
    for (let j = 0; j < stmt.namedChildCount; j++) {
      const child = stmt.namedChild(j);
      if (!child) continue;
      if (child.type !== 'export_clause' && child.type !== 'named_exports') continue;
      for (let k = 0; k < child.namedChildCount; k++) {
        const specifier = child.namedChild(k);
        if (!specifier || specifier.type !== 'export_specifier') continue;
        const nameNode = specifier.childForFieldName('name');
        const aliasNode = specifier.childForFieldName('alias');
        if (!nameNode) continue;
        const localName = nameNode.text;
        const exportedName = aliasNode?.text ?? localName;
        if (localName && exportedName) {
          reExports.push({ filePath, rawSourcePath: rawSource, exportedName, localName });
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Heritage extraction
// ---------------------------------------------------------------------------

function extractHeritage(
  rootNode: NativeSyntaxNode,
  filePath: string,
  heritage: WorkerExtractedHeritage[],
  symbols: WorkerParsedSymbol[],
): void {
  function walk(node: NativeSyntaxNode): void {
    if (node.type === 'class_declaration' || node.type === 'abstract_class_declaration') {
      const nameNode = node.childForFieldName('name');
      const className = nameNode?.text;
      if (className) {
        const typeNodeId = mkNodeId(filePath, className);
        const clauseNode = node.childForFieldName('type_parameters')
          ? node.childForFieldName('heritage')
          : null;
        // Walk children for heritage clauses
        for (let i = 0; i < node.namedChildCount; i++) {
          const child = node.namedChild(i);
          if (!child) continue;
          if (child.type === 'class_heritage') {
            for (let j = 0; j < child.namedChildCount; j++) {
              const clause = child.namedChild(j);
              if (!clause) continue;
              if (clause.type === 'extends_clause') {
                for (let k = 0; k < clause.namedChildCount; k++) {
                  const parent = clause.namedChild(k);
                  if (parent?.text) {
                    // Strip type parameters e.g., Base<T> -> Base
                    const parentName = parent.text.replace(/<.*>$/, '').trim();
                    if (parentName) {
                      heritage.push({
                        filePath,
                        typeName: className,
                        typeNodeId,
                        kind: 'extends',
                        parentName,
                      });
                    }
                  }
                }
              } else if (clause.type === 'implements_clause') {
                for (let k = 0; k < clause.namedChildCount; k++) {
                  const iface = clause.namedChild(k);
                  if (iface?.text) {
                    const parentName = iface.text.replace(/<.*>$/, '').trim();
                    if (parentName) {
                      heritage.push({
                        filePath,
                        typeName: className,
                        typeNodeId,
                        kind: 'implements',
                        parentName,
                      });
                    }
                  }
                }
              }
            }
          }
        }
        void clauseNode; // referenced to suppress unused warning
      }
    }
    if (node.type === 'interface_declaration') {
      const nameNode = node.childForFieldName('name');
      const ifaceName = nameNode?.text;
      if (ifaceName) {
        const typeNodeId = mkNodeId(filePath, ifaceName);
        for (let i = 0; i < node.namedChildCount; i++) {
          const child = node.namedChild(i);
          if (!child || child.type !== 'extends_type_clause') continue;
          for (let j = 0; j < child.namedChildCount; j++) {
            const parent = child.namedChild(j);
            if (parent?.text) {
              const parentName = parent.text.replace(/<.*>$/, '').trim();
              if (parentName) {
                heritage.push({
                  filePath,
                  typeName: ifaceName,
                  typeNodeId,
                  kind: 'extends',
                  parentName,
                });
              }
            }
          }
        }
      }
    }
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child) walk(child);
    }
  }
  walk(rootNode);
  void symbols; // available for future enrichment
}

// ---------------------------------------------------------------------------
// Call extraction (lightweight — calledName only)
// ---------------------------------------------------------------------------

function extractCalls(
  rootNode: NativeSyntaxNode,
  filePath: string,
  symbols: WorkerParsedSymbol[],
  calls: WorkerExtractedCall[],
): void {
  // Build a list of callable symbols (functions/methods) for enclosing resolution
  const callableSymbols = symbols.filter((s) => s.kind === 'function' || s.kind === 'method');

  function findEnclosingId(row: number): string {
    // Find deepest callable that contains this row (smallest line span)
    let best: WorkerParsedSymbol | null = null;
    for (const sym of callableSymbols) {
      if (sym.filePath === filePath && sym.startLine <= row + 1 && sym.endLine >= row + 1) {
        if (!best || sym.endLine - sym.startLine < best.endLine - best.startLine) {
          best = sym;
        }
      }
    }
    return best?.id ?? mkNodeId(filePath, '__file__');
  }

  function walk(node: NativeSyntaxNode): void {
    if (node.type === 'call_expression') {
      const funcNode = node.childForFieldName('function');
      if (funcNode) {
        let calledName: string | null = null;
        let callForm: 'free' | 'member' | 'constructor' = 'free';
        let receiverName: string | undefined;

        if (funcNode.type === 'identifier') {
          calledName = funcNode.text;
          callForm = 'free';
        } else if (funcNode.type === 'member_expression') {
          const propNode = funcNode.childForFieldName('property');
          const objNode = funcNode.childForFieldName('object');
          if (propNode?.type === 'property_identifier') {
            calledName = propNode.text;
            callForm = 'member';
            if (objNode?.type === 'identifier') {
              receiverName = objNode.text;
            }
          }
        }

        if (calledName && calledName.length > 0) {
          const sourceId = findEnclosingId(node.startPosition.row);
          const entry: WorkerExtractedCall = { filePath, sourceId, calledName, callForm };
          if (receiverName !== undefined) entry.receiverName = receiverName;
          calls.push(entry);
        }
      }
    }
    // new Foo() — constructor calls
    if (node.type === 'new_expression') {
      const constructorNode = node.childForFieldName('constructor');
      if (constructorNode?.type === 'identifier' && constructorNode.text) {
        const sourceId = findEnclosingId(node.startPosition.row);
        calls.push({
          filePath,
          sourceId,
          calledName: constructorNode.text,
          callForm: 'constructor',
        });
      }
    }
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child) walk(child);
    }
  }
  walk(rootNode);
}

// ---------------------------------------------------------------------------
// Process a batch of files
// ---------------------------------------------------------------------------

function processBatch(
  files: ParseWorkerInput[],
  onProgress?: (filesProcessed: number) => void,
): ParseWorkerResult {
  const result: ParseWorkerResult = {
    symbols: [],
    imports: [],
    heritage: [],
    calls: [],
    reExports: [],
    fileCount: 0,
    skippedCount: 0,
  };

  const parser = getParser();
  if (!parser) {
    result.skippedCount = files.length;
    return result;
  }

  let processed = 0;
  let lastReported = 0;
  const PROGRESS_INTERVAL = 100;

  for (const file of files) {
    const grammarKey = grammarKeyForPath(file.path);
    if (!grammarKey) {
      result.skippedCount++;
      continue;
    }
    const grammar = loadGrammar(grammarKey);
    if (!grammar) {
      result.skippedCount++;
      continue;
    }

    let rootNode: NativeSyntaxNode;
    try {
      parser.setLanguage(grammar);
      const tree = parser.parse(file.content);
      rootNode = tree.rootNode;
    } catch {
      result.skippedCount++;
      continue;
    }

    const language = grammarKey === 'tsx' ? 'typescript' : grammarKey;
    const fileSymbols: WorkerParsedSymbol[] = [];

    try {
      walkDefinitions(rootNode, file.path, language, fileSymbols);
      for (const s of fileSymbols) result.symbols.push(s);

      extractImports(rootNode, file.path, language, result.imports);
      extractReExports(rootNode, file.path, result.reExports);
      extractHeritage(rootNode, file.path, result.heritage, fileSymbols);
      extractCalls(rootNode, file.path, fileSymbols, result.calls);
    } catch {
      // Skip extraction errors — file was still parseable
    }

    result.fileCount++;
    processed++;

    if (onProgress && processed - lastReported >= PROGRESS_INTERVAL) {
      lastReported = processed;
      onProgress(processed);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Accumulated result (persists across sub-batches)
// ---------------------------------------------------------------------------

let accumulated: ParseWorkerResult = {
  symbols: [],
  imports: [],
  heritage: [],
  calls: [],
  reExports: [],
  fileCount: 0,
  skippedCount: 0,
};
let cumulativeProcessed = 0;

function mergeResult(target: ParseWorkerResult, src: ParseWorkerResult): void {
  for (const s of src.symbols) target.symbols.push(s);
  for (const i of src.imports) target.imports.push(i);
  for (const h of src.heritage) target.heritage.push(h);
  for (const c of src.calls) target.calls.push(c);
  for (const r of src.reExports) target.reExports.push(r);
  target.fileCount += src.fileCount;
  target.skippedCount += src.skippedCount;
}

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

parentPort.on('message', (msg: WorkerIncomingMessage) => {
  try {
    if (msg.type === 'sub-batch') {
      const result = processBatch(msg.files, (filesProcessed) => {
        parentPort!.postMessage({
          type: 'progress',
          filesProcessed: cumulativeProcessed + filesProcessed,
        });
      });
      cumulativeProcessed += result.fileCount;
      mergeResult(accumulated, result);
      parentPort!.postMessage({ type: 'sub-batch-done' });
      return;
    }

    if (msg.type === 'flush') {
      parentPort!.postMessage({ type: 'result', data: accumulated });
      // Reset for reuse
      accumulated = {
        symbols: [],
        imports: [],
        heritage: [],
        calls: [],
        reExports: [],
        fileCount: 0,
        skippedCount: 0,
      };
      cumulativeProcessed = 0;
      return;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    parentPort!.postMessage({ type: 'error', error: message });
  }
});
