/**
 * Parse loop — Phase 3 of the code intelligence ingestion pipeline.
 *
 * Supports two execution paths:
 *
 * **Parallel path** (Wave H, T540): When files >= 15 OR total bytes >= 512 KB,
 * spawns a worker pool (`pipeline/workers/worker-pool.ts`) to parse files in
 * parallel across multiple CPU cores. The worker script reads file content
 * and returns structured results via IPC (structured clone).
 *
 * **Sequential path** (fallback): Used when the file count is small, the
 * worker script is not available (e.g. running from source), or worker
 * creation fails. Parses files one-at-a-time in the calling thread.
 *
 * Both paths produce the same {@link ParseLoopResult} so callers are
 * unaffected by which path is chosen.
 *
 * Ported and adapted from GitNexus `src/core/ingestion/pipeline.ts`
 * (the sequential fallback path in `runChunkedParseAndResolve`).
 *
 * Key differences from GitNexus:
 * - TypeScript/JavaScript only — other languages are Wave I
 * - Uses CLEO's existing tree-sitter parser singleton from `code/parser.ts`
 * - Byte-budget chunking follows GitNexus's 20MB-per-chunk convention but
 *   is applied only for progress reporting; memory is still sequential in
 *   the sequential path
 * - Heritage edges are accumulated and emitted after the full loop so the
 *   implementor map has complete coverage before any edge is written
 *
 * @task T534
 * @task T540
 * @module pipeline/parse-loop
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  GraphIndexFileReport,
  GraphNode,
  GraphNodeKind,
  GraphRelation,
  ParserExecutionLimits,
  ParserExecutionPort,
} from '@cleocode/contracts';
import { confidenceLabelFromNumeric } from '@cleocode/contracts';
import type {
  GraphAnalysisCapability,
  GraphFileCapabilityCoverage,
  GraphFileClassification,
  GraphFileRole,
} from '@cleocode/contracts/graph';
import type Parser from 'tree-sitter';
import { parseOriginalSource } from '../code/parser.js';
import { extractGo } from './extractors/go-extractor.js';
import { extractPython } from './extractors/python-extractor.js';
import { extractRust } from './extractors/rust-extractor.js';
import {
  type ExtractedCall,
  type ExtractedHeritage,
  type ExtractedReExport,
  extractTypeScript,
} from './extractors/typescript-extractor.js';
import type { ScannedFile } from './filesystem-walker.js';
import type {
  BarrelExportMap,
  ExtractedImport,
  ExtractedReExportRecord,
  ImportResolutionContext,
  NamedImportMap,
  TsconfigPaths,
} from './import-processor.js';
import { buildBarrelExportMap, processExtractedImports } from './import-processor.js';
import type { KnowledgeGraph } from './knowledge-graph.js';
import { detectLanguageFromPath } from './language-detection.js';
import { buildLexicalScopeModel } from './lexical-scope.js';
import { type ExtractedAccess, extractAccesses } from './processors/access-processor.js';
import type { SymbolTable } from './symbol-table.js';
import type { ParseWorkerResult } from './workers/parse-worker.js';
import { createWorkerPool } from './workers/worker-pool.js';

// ---------------------------------------------------------------------------
// Worker pool thresholds (Wave H — T540)
// ---------------------------------------------------------------------------

/**
 * Minimum file count to trigger parallel worker pool parsing.
 * Below this threshold the overhead of spawning workers exceeds the benefit.
 */
const WORKER_FILE_THRESHOLD = 15;

/**
 * Minimum total byte count to trigger parallel worker pool parsing.
 * 512 KB — matches GitNexus and the filesystem walker's single-file cap.
 */
const WORKER_BYTE_THRESHOLD = 512 * 1024;

// ---------------------------------------------------------------------------
// Tree-sitter native module loading (mirrors code/parser.ts pattern)
// ---------------------------------------------------------------------------

import { createRequire } from 'node:module';

const _require = createRequire(import.meta.url);

/** Minimal NativeParser shape — mirrors code/parser.ts internals. */
interface NativeParser extends Pick<Parser, 'parse' | 'reset' | 'setTimeoutMicros'> {
  setLanguage(lang: unknown): void;
}

type ParserConstructor = new () => NativeParser;

let _ParserClass: ParserConstructor | null = null;
let _parserInstance: NativeParser | null = null;
let _available: boolean | null = null;

/** Grammar object cache keyed by language key. */
const _grammarCache = new Map<string, unknown>();

interface GrammarSpec {
  pkg: string;
  prop?: string;
}

const GRAMMAR_SPECS: Record<string, GrammarSpec> = {
  typescript: { pkg: 'tree-sitter-typescript', prop: 'typescript' },
  tsx: { pkg: 'tree-sitter-typescript', prop: 'tsx' },
  javascript: { pkg: 'tree-sitter-javascript' },
  python: { pkg: 'tree-sitter-python' },
  go: { pkg: 'tree-sitter-go' },
  rust: { pkg: 'tree-sitter-rust' },
};

/**
 * Load the tree-sitter Parser constructor.
 * Returns null if the native module is unavailable.
 */
function getParserClass(): ParserConstructor | null {
  if (_available !== null) return _ParserClass;

  try {
    const mod = _require('tree-sitter') as ParserConstructor;
    _ParserClass = mod;
    _available = true;
  } catch {
    _available = false;
  }

  return _ParserClass;
}

/**
 * Get (or lazily create) the shared parser singleton.
 * Returns null if tree-sitter is unavailable.
 */
function getParser(): NativeParser | null {
  if (_parserInstance) return _parserInstance;
  const ParserClass = getParserClass();
  if (!ParserClass) return null;
  _parserInstance = new ParserClass();
  return _parserInstance;
}

/** Load and cache a tree-sitter grammar for the given language key. */
function loadGrammar(langKey: string): unknown | null {
  if (_grammarCache.has(langKey)) return _grammarCache.get(langKey) ?? null;

  const spec = GRAMMAR_SPECS[langKey];
  if (!spec) {
    _grammarCache.set(langKey, null);
    return null;
  }

  try {
    const mod = _require(spec.pkg) as Record<string, unknown>;
    const grammar = spec.prop ? mod[spec.prop] : mod;
    _grammarCache.set(langKey, grammar ?? null);
    return grammar ?? null;
  } catch {
    _grammarCache.set(langKey, null);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Language key mapping
// ---------------------------------------------------------------------------

/**
 * Map a canonical language name to the grammar key used in GRAMMAR_SPECS.
 * Returns null for unsupported languages.
 */
function grammarKeyForLanguage(language: string): string | null {
  const SUPPORTED: Record<string, string> = {
    typescript: 'typescript',
    javascript: 'javascript',
    python: 'python',
    go: 'go',
    rust: 'rust',
  };
  return SUPPORTED[language] ?? null;
}

// ---------------------------------------------------------------------------
// Language extractor dispatch
// ---------------------------------------------------------------------------

/**
 * Common extraction result shape shared across all language extractors.
 * Each extractor returns this interface so the parse loop can handle them uniformly.
 *
 * `reExports` is optional: only TypeScript/JavaScript extractors produce re-export
 * records. Python, Go, and Rust extractors omit this field.
 *
 * `accesses` is populated by the access-processor after the language extractor
 * runs. It is optional here so existing extractors need not be modified.
 */
export interface CommonExtractionResult {
  /** Original declarations and qualified graph identities. */
  definitions: GraphNode[];
  /** Imported bindings and source paths. */
  imports: ExtractedImport[];
  /** Type inheritance evidence. */
  heritage: ExtractedHeritage[];
  /** Static call evidence with unresolved references retained. */
  calls: ExtractedCall[];
  /** Optional barrel re-export bindings. */
  reExports?: ExtractedReExport[];
  /** Optional property access evidence. */
  accesses?: ExtractedAccess[];
}

/**
 * Dispatch extraction to the correct language extractor based on the detected language.
 *
 * Falls back to TypeScript extractor for `typescript` and `javascript`.
 * Python, Go, and Rust use their dedicated extractors (Wave I — T541).
 *
 * @param language - Canonical language name from `detectLanguageFromPath`
 * @param rootNode - Parsed tree-sitter AST root node
 * @param filePath - File path relative to repo root
 * @param sourceGeneration - SHA-256 of original source bytes, distinct from publication identity.
 * @param publicationGeneration - Preallocated graph publication identity, when publishing.
 * @returns Uniform extraction result
 */
function runExtractor(
  language: string,
  rootNode: Parser.SyntaxNode,
  filePath: string,
  sourceGeneration: string,
  publicationGeneration?: string,
): CommonExtractionResult {
  const node = rootNode;
  const model =
    language === 'typescript' || language === 'javascript'
      ? buildLexicalScopeModel(
          rootNode,
          filePath,
          sourceGeneration,
          language,
          publicationGeneration,
        )
      : undefined;

  let result: CommonExtractionResult;

  switch (language) {
    case 'typescript':
    case 'javascript':
      result = extractTypeScript(node, filePath, language, model);
      break;
    case 'python':
      result = extractPython(node, filePath);
      break;
    case 'go':
      result = extractGo(node, filePath);
      break;
    case 'rust':
      result = extractRust(node, filePath);
      break;
    default:
      return { definitions: [], imports: [], heritage: [], calls: [], reExports: [], accesses: [] };
  }

  // Run access extraction on the parsed AST (Phase 3f — T1837).
  // Supports all languages with member_expression / attribute / field_expression /
  // selector_expression AST node types (TS, JS, Python, Go, Rust).
  result.accesses = extractAccesses(node, filePath, model);

  return result;
}

/**
 * Extract a file through the same native parser and language capabilities in either realm.
 * @param source - Original Unicode source text.
 * @param filePath - Repository-relative source path used for symbol identities.
 * @param limits - Native source-byte and synchronous parsing deadline limits.
 * @param publicationGeneration - Optional immutable publication identity passed by the pipeline.
 * @returns Declarations, references, imports, heritage and access evidence.
 * @remarks Static extraction does not establish complete runtime-call discovery.
 * @example
 * ```ts
 * const extracted = extractOriginalSource('export const 文 = 1;', 'source.ts');
 * ```
 */
export function extractOriginalSource(
  source: string,
  filePath: string,
  limits?: ParserExecutionLimits,
  publicationGeneration?: string,
): CommonExtractionResult {
  const language = detectLanguageFromPath(filePath);
  const grammarKey = language
    ? filePath.endsWith('.tsx')
      ? 'tsx'
      : grammarKeyForLanguage(language)
    : null;
  const parser = getParser();
  const grammar = grammarKey ? loadGrammar(grammarKey) : null;
  if (!language || !grammarKey) throw new Error('Unsupported source language');
  if (!parser || !grammar) throw new Error(`Parser or grammar unavailable: ${grammarKey}`);
  parser.setLanguage(grammar);
  const tree = parseOriginalSource(parser, source, limits);
  return runExtractor(
    language,
    tree.rootNode,
    filePath,
    createHash('sha256').update(source).digest('hex'),
    publicationGeneration,
  );
}

// ---------------------------------------------------------------------------
// SymbolTable registration helpers
// ---------------------------------------------------------------------------

/**
 * Register extracted GraphNodes in the SymbolTable.
 *
 * Maps GraphNodeKind values to the SymbolTable `kind` parameter.
 * Only kinds that have SymbolTable equivalents are registered.
 */
function registerInSymbolTable(nodes: GraphNode[], symbolTable: SymbolTable): void {
  for (const node of nodes) {
    if (!node.name || !node.filePath) continue;

    symbolTable.add(node.filePath, node.name, node.id, node.kind, {
      parameterCount: node.parameters?.length,
      returnType: node.returnType,
      ownerId: node.parent,
    });
  }
}

// ---------------------------------------------------------------------------
// Defines edge emission helpers (T1836)
// ---------------------------------------------------------------------------

/**
 * Symbol kinds that qualify for a `defines` edge from their containing file.
 *
 * Mirrors the set emitted by GitNexus: every named, top-level or class-member
 * symbol that is directly declared in the source file. Structural containers
 * (file, folder, module, namespace) and synthetic graph nodes (community,
 * process, route, tool, section) are excluded.
 */
const DEFINES_SYMBOL_KINDS: ReadonlySet<GraphNodeKind> = new Set<GraphNodeKind>([
  'function',
  'method',
  'constructor',
  'class',
  'interface',
  'struct',
  'trait',
  'impl',
  'type_alias',
  'enum',
  'property',
  'constant',
  'variable',
  'static',
  'record',
  'delegate',
  'macro',
  'union',
  'typedef',
  'annotation',
  'template',
  'type', // legacy kind kept for T506 compatibility
]);

/**
 * Emit `defines` edges from the file node to every symbol node it declares.
 *
 * For each symbol whose kind is in {@link DEFINES_SYMBOL_KINDS} and whose
 * `filePath` matches `fileNodeId`, a directed edge of type `'defines'` is
 * added to the knowledge graph with confidence 1.0.
 *
 * This is the CLEO equivalent of the 223,627 DEFINES edges emitted by
 * GitNexus during `npx gitnexus analyze`. Closing the gap was tracked as
 * T1836 (T1042 audit gap T1844-1).
 *
 * @param fileNodeId - The file node ID (equals the relative file path)
 * @param symbols - Symbol nodes extracted from the file
 * @param graph - KnowledgeGraph to receive the new edges
 */
function emitDefinesEdges(
  fileNodeId: string,
  symbols: GraphNode[],
  graph: { addRelation(rel: GraphRelation): void },
): void {
  for (const sym of symbols) {
    if (!DEFINES_SYMBOL_KINDS.has(sym.kind)) continue;
    const confidence = 1.0;
    graph.addRelation({
      source: fileNodeId,
      target: sym.id,
      type: 'defines',
      confidence,
      confidenceLabel: confidenceLabelFromNumeric(confidence),
      reason: 'file declares symbol',
    });
  }
}

// ---------------------------------------------------------------------------
// Parse loop options
// ---------------------------------------------------------------------------

/** Options for the sequential parse loop. */
export interface ParseLoopOptions {
  /** Immutable graph publication identity shared by direct and worker extraction. */
  publicationGeneration?: string;
  /** Per-file native source/deadline limits and caller cancellation. */
  parserLimits?: ParserExecutionLimits;
  /** Existing runtime process containment; Nexus never imports core. */
  parserExecution?: ParserExecutionPort;
  /** Report extraction availability and failures for trustworthy graph publication. */
  onFileReport?: (report: GraphIndexFileReport) => void;

  /** Optional tsconfig path aliases for import resolution. */
  tsconfigPaths?: TsconfigPaths | null;
  /** Named import map to populate (for Tier 2a resolution in later waves). */
  namedImportMap?: NamedImportMap;
  /**
   * Progress callback: invoked after each file is parsed.
   * @param current - Files processed so far (1-based)
   * @param total - Total parseable files
   * @param filePath - Current file path being processed
   */
  onProgress?: (current: number, total: number, filePath: string) => void;
}

/**
 * Result returned by the parse loop.
 *
 * Callers that perform Phase 3c (heritage), Phase 3e (call resolution),
 * and Phase 3f (access resolution) can consume the accumulated records
 * directly without re-reading the graph.
 */
export interface ParseLoopResult {
  /** All heritage records accumulated during the parse loop (for Phase 3c). */
  allHeritage: ExtractedHeritage[];
  /** All call expression records accumulated during the parse loop (for Phase 3e). */
  allCalls: ExtractedCall[];
  /** All member-access records accumulated during the parse loop (for Phase 3f). */
  allAccesses: ExtractedAccess[];
  /**
   * Barrel export map built from re-export statements (T617).
   * Used by the call resolution phase to trace imports through barrel index files.
   */
  barrelMap: BarrelExportMap;
}

const EXECUTABLE_CAPABILITIES: GraphAnalysisCapability[] = [
  'file-evidence',
  'declarations',
  'imports',
  'call-references',
  'access-references',
  'type-heritage',
];
const SQL_CAPABILITIES: GraphAnalysisCapability[] = [
  'file-evidence',
  'sql-schema-objects',
  'sql-migrations',
  'sql-triggers',
  'sql-constraints',
  'sql-literal-references',
  'sql-dynamic-references',
];
const PARSEABLE_LANGUAGES = new Set(['typescript', 'javascript', 'python', 'go', 'rust']);
const EXECUTABLE_LANGUAGES = new Set([
  ...PARSEABLE_LANGUAGES,
  'java',
  'kotlin',
  'c',
  'cpp',
  'csharp',
  'php',
  'ruby',
  'swift',
  'dart',
  'vue',
  'shell',
  'cobol',
]);

/** Build a role observation from independently stated requested capabilities. */
function roleCoverage(
  role: GraphFileRole,
  classification: GraphFileClassification,
  evidence?: GraphAnalysisCapability,
): GraphFileCapabilityCoverage {
  return {
    role,
    classification,
    requested:
      role === 'sql'
        ? [...SQL_CAPABILITIES]
        : role === 'executable' || role === 'unknown'
          ? [...EXECUTABLE_CAPABILITIES]
          : ['file-evidence', ...(evidence ? [evidence] : [])],
    completed: ['file-evidence', ...(evidence ? [evidence] : [])],
    limitations:
      role === 'sql'
        ? [
            'SQL extraction is unsupported; schema and literal references remain unassessed.',
            'Dynamic SQL references remain unresolved.',
          ]
        : role === 'executable' || role === 'unknown'
          ? ['Static extraction cannot establish complete runtime-call discovery.']
          : [],
  };
}

/** Identify known binary resources from both their extension and observed bytes. */
function hasResourceSignature(extension: string, bytes: Buffer): boolean {
  const prefix = bytes.subarray(0, 12);
  if (extension === '.png')
    return prefix.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
  if (extension === '.jpg' || extension === '.jpeg')
    return prefix.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'));
  if (extension === '.gif') return /^GIF8[79]a/.test(prefix.toString('ascii'));
  if (extension === '.webp')
    return (
      prefix.subarray(0, 4).toString('ascii') === 'RIFF' &&
      prefix.subarray(8).toString('ascii') === 'WEBP'
    );
  if (extension === '.woff') return prefix.subarray(0, 4).toString('ascii') === 'wOFF';
  if (extension === '.woff2') return prefix.subarray(0, 4).toString('ascii') === 'wOF2';
  return false;
}

/** Classify only observed role evidence; unsupported or ambiguous code remains a gap. */
async function classifyFileCapabilities(
  file: ScannedFile,
  repoPath: string,
  signal?: AbortSignal,
): Promise<GraphIndexFileReport> {
  const path = file.path;
  const extension = extname(path).toLowerCase();
  const language = detectLanguageFromPath(path);
  const bytes = await fs.readFile(path.startsWith('/') ? path : `${repoPath}/${path}`, { signal });
  if (file.contentHash && createHash('sha256').update(bytes).digest('hex') !== file.contentHash)
    throw new Error('Source changed between scanning and capability classification');
  const report = (capabilities: GraphFileCapabilityCoverage): GraphIndexFileReport => ({
    path,
    status: capabilities.requested.every((capability) =>
      capabilities.completed.includes(capability),
    )
      ? 'analyzed'
      : 'unsupported',
    ...(capabilities.role === 'sql'
      ? { reason: 'No SQL schema or reference extractor is available' }
      : capabilities.role === 'executable' || capabilities.role === 'unknown'
        ? {
            reason:
              'Unsupported or unclassified executable capabilities require a symbol extractor',
          }
        : {}),
    capabilities,
  });
  if (hasResourceSignature(extension, bytes))
    return report(
      roleCoverage(
        'asset',
        {
          basis: 'path-and-content',
          reason: `Resource extension ${extension} agrees with its observed binary signature`,
        },
        'resource-evidence',
      ),
    );
  const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (/^\uFEFF?#!/.test(content))
    return report(
      roleCoverage('executable', {
        basis: 'content',
        reason: 'Observed executable shebang; an asset extension cannot override it',
      }),
    );
  if (
    EXECUTABLE_LANGUAGES.has(language ?? '') ||
    ['.svelte', '.mdx', '.lua', '.pl', '.r', '.ps1', '.bat', '.cmd'].includes(extension) ||
    /^(?:Makefile|Dockerfile)$/.test(basename(path))
  )
    return report(
      roleCoverage('executable', {
        basis: 'path',
        reason: `Recognized executable language or filename: ${path}`,
      }),
    );
  if (extension === '.sql')
    return report(
      roleCoverage('sql', {
        basis: 'path',
        reason: 'SQL source extension; no schema or reference extractor is implemented',
      }),
    );
  if (extension === '.md' || extension === '.markdown')
    return report(
      roleCoverage(
        'documentation',
        {
          basis: 'path-and-content',
          reason: 'Readable documentary Markdown; embedded examples are not production callers',
        },
        'documentary-evidence',
      ),
    );
  if (extension === '.json') {
    let value: object | string | number | boolean | null;
    try {
      value = JSON.parse(content);
    } catch (error) {
      return {
        path,
        status: 'failed',
        reason: `JSON evidence is malformed: ${error instanceof Error ? error.message : String(error)}`,
        capabilities: {
          ...roleCoverage(
            'data',
            {
              basis: 'path',
              reason:
                'JSON extension with invalid content; role-specific analysis did not complete',
            },
            'data-evidence',
          ),
          completed: ['file-evidence'],
        },
      };
    }
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      if (
        '$schema' in value &&
        typeof value.$schema === 'string' &&
        /^https?:\/\/json-schema\.org\/(?:draft-0[467]|draft\/20\d\d-\d\d)\/schema#?$/.test(
          value.$schema,
        )
      )
        return report(
          roleCoverage(
            'schema',
            {
              basis: 'content',
              reason: `Valid JSON declares the JSON Schema dialect ${value.$schema}`,
            },
            'schema-evidence',
          ),
        );
      if (
        basename(path) === 'package-lock.json' &&
        'lockfileVersion' in value &&
        typeof value.lockfileVersion === 'number' &&
        'packages' in value &&
        value.packages !== null &&
        typeof value.packages === 'object' &&
        !Array.isArray(value.packages)
      )
        return report(
          roleCoverage(
            'generated-data',
            {
              basis: 'path-and-content',
              reason:
                'npm lockfile path with numeric lockfileVersion and packages map; generated data evidence only',
            },
            'data-evidence',
          ),
        );
      if (
        ['package.json', 'tsconfig.json', 'jsconfig.json', 'composer.json', 'deno.json'].includes(
          basename(path),
        ) ||
        /(?:^|\/)\.vscode\/(?:settings|extensions|launch|tasks)\.json$/.test(path)
      )
        return report(
          roleCoverage(
            'configuration',
            {
              basis: 'path-and-content',
              reason: `Recognized configuration path ${path} contains a valid JSON object; it is not executed`,
            },
            'configuration-evidence',
          ),
        );
    }
    return report(
      roleCoverage(
        'data',
        {
          basis: 'content',
          reason:
            'Valid ordinary JSON without positive configuration, schema or generated-data provenance',
        },
        'data-evidence',
      ),
    );
  }
  if (extension === '.snap') {
    const header = /^\/\/ (?:Vitest|Jest) Snapshot v1,[^\r\n]*\r?\n/.exec(content);
    const literal = String.raw`\x60(?:\\[\s\S]|[^\x60\\$]|\$(?!\{))*\x60`;
    if (
      header &&
      new RegExp(String.raw`^(?:\s*exports\[${literal}\]\s*=\s*${literal};\s*)+$`).test(
        content.slice(header[0].length),
      )
    )
      return report(
        roleCoverage(
          'generated-data',
          {
            basis: 'path-and-content',
            reason: 'Recognized generated snapshot header and literal-only snapshot assignments',
          },
          'data-evidence',
        ),
      );
  }
  return report(
    roleCoverage('unknown', {
      basis: 'unknown',
      reason: 'No positive role evidence; potentially executable content remains unassessed',
    }),
  );
}

// ---------------------------------------------------------------------------
// Main parse loop
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Parallel parse path helpers (Wave H — T540)
// ---------------------------------------------------------------------------

/**
 * Run the parse loop using a worker pool for parallel parsing.
 *
 * Called by `runParseLoop` when the file count or total bytes exceeds the
 * worker pool thresholds. Falls back to returning `null` if the worker
 * script is not found so the caller can retry sequentially.
 *
 * @returns ParseLoopResult on success, or null if workers could not be used.
 */
async function runParallelParseLoop(
  parseableFiles: ScannedFile[],
  graph: KnowledgeGraph,
  symbolTable: SymbolTable,
  importCtx: ImportResolutionContext,
  repoPath: string,
  options: ParseLoopOptions,
): Promise<ParseLoopResult | null> {
  const { tsconfigPaths = null, namedImportMap = new Map(), onProgress } = options;

  // Resolve the compiled worker script path (parallel to this file in dist/)
  let workerUrl: URL;
  try {
    // In ESM, import.meta.url resolves relative to the current module file.
    // The worker script lives at the same directory level.
    workerUrl = new URL('./workers/parse-worker.js', import.meta.url);
    const workerPath = fileURLToPath(workerUrl);
    // Use dynamic require check — existsSync from 'node:fs'
    const { existsSync } = await import('node:fs');
    if (!existsSync(workerPath)) {
      return null; // Worker script not built yet — fall back to sequential
    }
  } catch {
    return null;
  }

  // Read all file contents first (sequential I/O, then dispatch in parallel)
  const total = parseableFiles.length;
  const workerInputs: Array<{
    path: string;
    content: string;
    limits?: Omit<ParserExecutionLimits, 'signal'>;
    publicationGeneration?: string;
  }> = [];

  for (let i = 0; i < parseableFiles.length; i++) {
    const file = parseableFiles[i];
    try {
      const absPath = file.path.startsWith('/') ? file.path : `${repoPath}/${file.path}`;
      options.parserLimits?.signal?.throwIfAborted();
      const bytes = await fs.readFile(absPath);
      if (
        file.contentHash &&
        createHash('sha256').update(bytes).digest('hex') !== file.contentHash
      ) {
        throw new Error('Source changed between scanning and parsing');
      }
      const { signal: _signal, ...limits } = options.parserLimits ?? {};
      workerInputs.push({
        path: file.path,
        content: bytes.toString('utf8'),
        limits,
        publicationGeneration: options.publicationGeneration,
      });
    } catch (error) {
      options.parserLimits?.signal?.throwIfAborted();
      throw new Error(
        `Parser input unavailable: ${file.path}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const pool = createWorkerPool(
    workerUrl,
    undefined,
    options.parserLimits,
    options.parserExecution,
  );

  let filesProcessedSoFar = 0;

  let workerResults: ParseWorkerResult[];
  try {
    workerResults = await pool.dispatch<{ path: string; content: string }, ParseWorkerResult>(
      workerInputs,
      (filesProcessed) => {
        filesProcessedSoFar = filesProcessed;
        if (onProgress) {
          const lastFile = parseableFiles[Math.min(filesProcessed, total) - 1];
          onProgress(filesProcessed, total, lastFile?.path ?? '');
        }
      },
    );
  } finally {
    await pool.terminate().catch(() => undefined);
  }

  void filesProcessedSoFar; // used for progress, not needed after dispatch

  // Merge all worker results into graph, symbolTable, and accumulator arrays
  const allExtractedImports: ExtractedImport[] = [];
  const allParallelReExports: ExtractedReExportRecord[] = [];
  const allHeritage: ExtractedHeritage[] = [];
  const allCalls: ExtractedCall[] = [];
  // Workers invoke the same extractor, including access records.
  const allParallelAccesses: ExtractedAccess[] = [];

  for (const workerResult of workerResults) {
    for (const report of workerResult.reports) options.onFileReport?.(report);
    const failed = workerResult.reports.filter((report) => report.status !== 'analyzed');
    if (failed.length > 0)
      throw new Error(
        `Parser worker incomplete: ${failed.map((report) => `${report.path}: ${report.reason}`).join('; ')}`,
      );
    allParallelAccesses.push(...workerResult.accesses);
    // Register symbols into SymbolTable and add graph nodes
    const fileGraphNodes: Map<string, GraphNode[]> = new Map();
    for (const sym of workerResult.symbols) {
      const graphNode = sym;
      registerInSymbolTable([graphNode], symbolTable);
      graph.addNode(graphNode);
      // Group by filePath for defines edge emission below
      if (graphNode.filePath) {
        const bucket = fileGraphNodes.get(graphNode.filePath) ?? [];
        bucket.push(graphNode);
        fileGraphNodes.set(graphNode.filePath, bucket);
      }
    }
    // Emit defines edges: file → each symbol it declares
    for (const [filePath, nodes] of fileGraphNodes) {
      emitDefinesEdges(filePath, nodes, graph);
    }

    allExtractedImports.push(...workerResult.imports);
    allParallelReExports.push(...workerResult.reExports);
    allHeritage.push(...workerResult.heritage);
    allCalls.push(...workerResult.calls);
  }

  if (onProgress && total > 0) {
    const lastFile = parseableFiles[total - 1];
    onProgress(total, total, lastFile?.path ?? '');
  } else if (!onProgress && total > 0) {
    process.stderr.write(`[nexus] Parsing: ${total}/${total} files (100%) [parallel]\n`);
  }

  // Batch-resolve all extracted imports
  if (allExtractedImports.length > 0) {
    await processExtractedImports({
      imports: allExtractedImports,
      graph,
      importCtx,
      namedImportMap,
      tsconfigPaths,
    });
  }

  // Build barrel export map from worker-collected re-export records (T617)
  if (process.env['CLEO_BARREL_DEBUG']) {
    const coreInternalRecords = allParallelReExports.filter((re) =>
      re.filePath.includes('core/src/internal'),
    );
    process.stderr.write(
      `[parse-loop-debug] allParallelReExports.length = ${allParallelReExports.length}\n`,
    );
    process.stderr.write(
      `[parse-loop-debug] core/src/internal records = ${coreInternalRecords.length}\n`,
    );
    // Check if internal.ts was in the worker inputs
    const internalInput = workerInputs.find((f) => f.path.includes('core/src/internal'));
    process.stderr.write(
      `[parse-loop-debug] internal.ts in workerInputs = ${internalInput ? 'YES: ' + internalInput.path : 'NO'}\n`,
    );
    // Check if internal.ts had symbols or imports
    for (const wr of workerResults) {
      const hasInternalSymbol = wr.symbols.some((s) => s.filePath?.includes('core/src/internal'));
      const hasInternalImport = wr.imports.some((i) => i.filePath.includes('core/src/internal'));
      const hasInternalReExport = wr.reExports.some((r) =>
        r.filePath.includes('core/src/internal'),
      );
      if (hasInternalSymbol || hasInternalImport || hasInternalReExport) {
        process.stderr.write(
          `[parse-loop-debug] Worker result: symbols=${hasInternalSymbol}, imports=${hasInternalImport}, reExports=${hasInternalReExport}\n`,
        );
      }
    }
  }
  const parallelBarrelMap = buildBarrelExportMap(allParallelReExports, importCtx, tsconfigPaths);
  process.stderr.write(
    `[nexus] Barrel map: ${parallelBarrelMap.size} barrel files with re-export chains\n`,
  );

  return { allHeritage, allCalls, allAccesses: allParallelAccesses, barrelMap: parallelBarrelMap };
}

// ---------------------------------------------------------------------------
// Main parse loop entry point
// ---------------------------------------------------------------------------

/**
 * Phase 3: Parse loop (parallel or sequential).
 *
 * For each TypeScript/JavaScript file in `files`:
 * 1. Read file content from disk
 * 2. Parse with tree-sitter (typescript or javascript grammar)
 * 3. Extract definitions → register in SymbolTable → add nodes to graph
 * 4. Extract imports → collect for batch resolution
 * 5. Extract heritage → accumulate for deferred edge emission
 *
 * After all files are processed:
 * - Resolves all collected imports via `processExtractedImports`
 * - Emits EXTENDS/IMPLEMENTS edges from accumulated heritage
 *
 * Files that fail to parse (grammar unavailable, syntax error, read error)
 * are skipped with a warning to stderr — the loop continues.
 *
 * **Parallel mode** (Wave H): When `parseableFiles.length >= 15` or total
 * bytes >= 512 KB, the parallel path via the worker pool is attempted first.
 * If the worker script is not found (e.g. running from source without a
 * build), the sequential path is used as a fallback.
 *
 * @param files - All scanned files (non-TypeScript/JavaScript files are filtered)
 * @param graph - Knowledge graph to add nodes and relations to
 * @param symbolTable - Symbol table to register extracted symbols in
 * @param importCtx - Pre-built import resolution context (from Phase 3a)
 * @param repoPath - Absolute path to the repository root (used to resolve relative paths)
 * @param options - Optional tsconfig paths, named import map, and progress callback
 * @returns Accumulated heritage and call records for Phase 3c and Phase 3e
 */
export async function runParseLoop(
  files: ScannedFile[],
  graph: KnowledgeGraph,
  symbolTable: SymbolTable,
  importCtx: ImportResolutionContext,
  repoPath: string,
  options: ParseLoopOptions = {},
): Promise<ParseLoopResult> {
  const { tsconfigPaths = null, namedImportMap = new Map(), onProgress } = options;

  // Attach one capability contract to sequential and worker-returned reports.
  const callerReports = options.onFileReport;
  const classifications = new Map<string, GraphFileCapabilityCoverage>();
  const emitReport = (report: GraphIndexFileReport): void => {
    const coverage = classifications.get(report.path);
    if (!coverage) throw new Error(`Missing file capability classification: ${report.path}`);
    callerReports?.({
      ...report,
      capabilities: {
        ...coverage,
        requested: [...coverage.requested],
        completed:
          report.status === 'analyzed' && coverage.role === 'executable'
            ? [...coverage.requested]
            : [...coverage.completed],
        limitations: [...coverage.limitations],
      },
    });
  };
  options = { ...options, onFileReport: emitReport };
  const parseableFiles: ScannedFile[] = [];
  for (const file of files) {
    options.parserLimits?.signal?.throwIfAborted();
    let report: GraphIndexFileReport;
    try {
      report = await classifyFileCapabilities(file, repoPath, options.parserLimits?.signal);
    } catch (error) {
      options.parserLimits?.signal?.throwIfAborted();
      report = {
        path: file.path,
        status: 'failed',
        reason: `read: ${error instanceof Error ? error.message : String(error)}`,
        capabilities: {
          ...roleCoverage('unknown', {
            basis: 'unknown',
            reason: 'Role evidence unavailable because the source read failed',
          }),
          completed: [],
        },
      };
    }
    if (!report.capabilities) throw new Error(`Missing file capability assessment: ${file.path}`);
    classifications.set(file.path, report.capabilities);
    if (
      report.status !== 'failed' &&
      report.capabilities.role === 'executable' &&
      PARSEABLE_LANGUAGES.has(detectLanguageFromPath(file.path) ?? '')
    )
      parseableFiles.push(file);
    else emitReport(report);
  }

  const total = parseableFiles.length;
  if (total === 0)
    return {
      allHeritage: [],
      allCalls: [],
      allAccesses: [],
      barrelMap: buildBarrelExportMap([], importCtx, tsconfigPaths),
    };

  // Wave H: Check thresholds for parallel dispatch
  const totalBytes = files.reduce((acc, f) => acc + f.size, 0);
  const useWorkers =
    Boolean(options.parserExecution) ||
    total >= WORKER_FILE_THRESHOLD ||
    totalBytes >= WORKER_BYTE_THRESHOLD;

  if (useWorkers && (options.parserExecution || !callerReports)) {
    process.stderr.write(
      `[nexus] Parallel parse: ${total} files, ${Math.round(totalBytes / 1024)}KB total — spawning worker pool\n`,
    );
    try {
      const parallelResult = await runParallelParseLoop(
        parseableFiles,
        graph,
        symbolTable,
        importCtx,
        repoPath,
        { ...options, tsconfigPaths, namedImportMap, onProgress },
      );
      if (parallelResult !== null) {
        process.stderr.write('[nexus] Parallel parse complete.\n');
        return parallelResult;
      }
      if (options.parserExecution) throw new Error('Isolated parser executable unavailable');
      // Worker unavailable — fall through to sequential
      process.stderr.write('[nexus] Worker script not found — using sequential parse.\n');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Parallel parser failed; generation not published: ${msg}`);
    }
  }

  const allExtractedImports: ExtractedImport[] = [];
  const allReExports: ExtractedReExportRecord[] = [];
  const allHeritage: ExtractedHeritage[] = [];
  const allCalls: ExtractedCall[] = [];
  const allAccesses: ExtractedAccess[] = [];

  const parser = getParser();
  if (!parser) {
    for (const file of parseableFiles) {
      options.onFileReport?.({
        path: file.path,
        status: 'failed',
        reason: 'tree-sitter native module unavailable',
      });
    }
    process.stderr.write(
      '[nexus] WARNING: tree-sitter native module not available — parse loop skipped.\n',
    );
    return {
      allHeritage: [],
      allCalls: [],
      allAccesses: [],
      barrelMap: buildBarrelExportMap([], importCtx, tsconfigPaths),
    };
  }

  let filesProcessed = 0;

  for (const file of parseableFiles) {
    options.parserLimits?.signal?.throwIfAborted();
    filesProcessed++;

    // Progress reporting (every file for small repos, every 10 for larger ones)
    if (onProgress && (total <= 100 || filesProcessed % 10 === 0 || filesProcessed === total)) {
      onProgress(filesProcessed, total, file.path);
    } else if (!onProgress && filesProcessed % 50 === 0) {
      // Fallback stderr progress for CLI usage without a callback
      const pct = Math.round((filesProcessed / total) * 100);
      process.stderr.write(`[nexus] Parsing: ${filesProcessed}/${total} files (${pct}%)...\n`);
    }

    // Determine grammar key
    const lang = detectLanguageFromPath(file.path);
    if (!lang) continue;
    const grammarKey = grammarKeyForLanguage(lang);
    if (!grammarKey) continue;

    // Load grammar
    const grammar = loadGrammar(grammarKey);
    if (!grammar) {
      options.onFileReport?.({
        path: file.path,
        status: 'failed',
        reason: `No grammar for ${lang}`,
      });
      process.stderr.write(`[nexus] SKIP: no grammar for ${lang} (file: ${file.path})\n`);
      continue;
    }

    // Read file content — relative path from filesystem walker, read from repoPath
    let source: string;
    try {
      const absPath = file.path.startsWith('/') ? file.path : `${repoPath}/${file.path}`;
      const bytes = await fs.readFile(absPath);
      if (
        file.contentHash &&
        createHash('sha256').update(bytes).digest('hex') !== file.contentHash
      ) {
        throw new Error('Source changed between scanning and parsing');
      }
      source = bytes.toString('utf-8');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      options.onFileReport?.({ path: file.path, status: 'failed', reason: `read: ${msg}` });
      process.stderr.write(`[nexus] SKIP read error: ${file.path}: ${msg}\n`);
      continue;
    }

    // Parse with tree-sitter
    let rootNode: Parser.SyntaxNode;
    try {
      parser.setLanguage(grammar);
      const tree = parseOriginalSource(parser, source, options.parserLimits);
      rootNode = tree.rootNode;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      options.onFileReport?.({ path: file.path, status: 'failed', reason: `parse: ${msg}` });
      options.parserLimits?.signal?.throwIfAborted();
      process.stderr.write(`[nexus] SKIP parse error: ${file.path}: ${msg}\n`);
      continue;
    }

    // Extract definitions, imports, heritage, calls, and re-exports — dispatch by language
    let extracted: CommonExtractionResult;
    try {
      extracted = runExtractor(
        lang,
        rootNode,
        file.path,
        createHash('sha256').update(source).digest('hex'),
        options.publicationGeneration,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      options.onFileReport?.({ path: file.path, status: 'failed', reason: `extract: ${msg}` });
      process.stderr.write(`[nexus] SKIP extract error: ${file.path}: ${msg}\n`);
      continue;
    }

    options.onFileReport?.({ path: file.path, status: 'analyzed' });

    // Register in SymbolTable
    registerInSymbolTable(extracted.definitions, symbolTable);

    // Add nodes to graph
    for (const node of extracted.definitions) {
      graph.addNode(node);
    }

    // Emit defines edges: file → each symbol it declares (T1836)
    emitDefinesEdges(file.path, extracted.definitions, graph);

    // Collect imports for batch resolution
    for (const imp of extracted.imports) {
      allExtractedImports.push(imp);
    }

    // Collect re-exports for barrel map construction (T617)
    if (extracted.reExports) {
      for (const re of extracted.reExports) {
        allReExports.push(re);
      }
    }

    // Collect heritage for deferred Phase 3c processing
    for (const h of extracted.heritage) {
      allHeritage.push(h);
    }

    // Collect calls for deferred Phase 3e resolution
    for (const c of extracted.calls) {
      allCalls.push(c);
    }

    // Collect access sites for deferred Phase 3f resolution (T1837)
    if (extracted.accesses) {
      for (const a of extracted.accesses) {
        allAccesses.push(a);
      }
    }

    // Yield to event loop periodically on large repos
    if (filesProcessed % 100 === 0) {
      await Promise.resolve();
    }
  }

  // Final stderr progress update
  if (!onProgress && total > 0) {
    process.stderr.write(`[nexus] Parsing: ${total}/${total} files (100%)\n`);
  }

  // Batch-resolve all extracted imports (populates namedImportMap for Phase 3e)
  if (allExtractedImports.length > 0) {
    await processExtractedImports({
      imports: allExtractedImports,
      graph,
      importCtx,
      namedImportMap,
      tsconfigPaths,
    });
  }

  // Build barrel export map from collected re-export records (T617)
  // Runs AFTER processExtractedImports so the resolve cache is warmed up.
  const barrelMap = buildBarrelExportMap(allReExports, importCtx, tsconfigPaths);
  process.stderr.write(
    `[nexus] Barrel map: ${barrelMap.size} barrel files with re-export chains\n`,
  );

  // Return accumulated heritage, calls, accesses, and barrel map
  return { allHeritage, allCalls, allAccesses, barrelMap };
}
