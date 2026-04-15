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

import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { GraphNode, GraphNodeKind } from '@cleocode/contracts';
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
import type { SymbolTable } from './symbol-table.js';
import type { ParseWorkerResult, WorkerParsedSymbol } from './workers/parse-worker.js';
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
interface NativeParser {
  setLanguage(lang: unknown): void;
  parse(source: string): { rootNode: unknown };
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
 */
interface CommonExtractionResult {
  definitions: GraphNode[];
  imports: ExtractedImport[];
  heritage: ExtractedHeritage[];
  calls: ExtractedCall[];
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
 * @returns Uniform extraction result
 */
function runExtractor(
  language: string,
  rootNode: unknown,
  filePath: string,
): CommonExtractionResult {
  // biome-ignore lint/suspicious/noExplicitAny: tree-sitter rootNode has no shared TS type
  const node = rootNode as any;

  switch (language) {
    case 'typescript':
    case 'javascript':
      return extractTypeScript(node, filePath, language);
    case 'python':
      return extractPython(node, filePath);
    case 'go':
      return extractGo(node, filePath);
    case 'rust':
      return extractRust(node, filePath);
    default:
      return { definitions: [], imports: [], heritage: [], calls: [] };
  }
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
// Parse loop options
// ---------------------------------------------------------------------------

/** Options for the sequential parse loop. */
export interface ParseLoopOptions {
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
 * Callers that perform Phase 3c (heritage) and Phase 3e (call resolution)
 * can consume the accumulated records directly without re-reading the graph.
 */
export interface ParseLoopResult {
  /** All heritage records accumulated during the parse loop (for Phase 3c). */
  allHeritage: ExtractedHeritage[];
  /** All call expression records accumulated during the parse loop (for Phase 3e). */
  allCalls: ExtractedCall[];
  /**
   * Barrel export map built from re-export statements (T617).
   * Used by the call resolution phase to trace imports through barrel index files.
   */
  barrelMap: BarrelExportMap;
}

// ---------------------------------------------------------------------------
// Main parse loop
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Parallel parse path helpers (Wave H — T540)
// ---------------------------------------------------------------------------

/**
 * Map a `WorkerParsedSymbol` to a `GraphNode` for consumption by the
 * knowledge graph. The worker's extraction mirrors the sequential extractor
 * in structure so this conversion is 1:1.
 */
function workerSymbolToGraphNode(sym: WorkerParsedSymbol): GraphNode {
  return {
    id: sym.id,
    kind: sym.kind as GraphNodeKind,
    name: sym.name,
    filePath: sym.filePath,
    startLine: sym.startLine,
    endLine: sym.endLine,
    language: sym.language,
    exported: sym.exported,
    parameters: sym.parameters,
    returnType: sym.returnType,
    docSummary: sym.docSummary,
    parent: sym.parent,
  };
}

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
  const workerInputs: Array<{ path: string; content: string }> = [];

  for (let i = 0; i < parseableFiles.length; i++) {
    const file = parseableFiles[i];
    try {
      const absPath = file.path.startsWith('/') ? file.path : `${repoPath}/${file.path}`;
      const content = await fs.readFile(absPath, 'utf-8');
      workerInputs.push({ path: file.path, content });
    } catch {
      // Skip unreadable files
    }
  }

  let pool: ReturnType<typeof createWorkerPool>;
  try {
    pool = createWorkerPool(workerUrl);
  } catch {
    return null; // Worker script unavailable — fall back to sequential
  }

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
  } catch (err) {
    await pool.terminate().catch(() => undefined);
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[nexus] Worker pool failed (${msg}), falling back to sequential.\n`);
    return null;
  } finally {
    await pool.terminate().catch(() => undefined);
  }

  void filesProcessedSoFar; // used for progress, not needed after dispatch

  // Merge all worker results into graph, symbolTable, and accumulator arrays
  const allExtractedImports: ExtractedImport[] = [];
  const allParallelReExports: ExtractedReExportRecord[] = [];
  const allHeritage: ExtractedHeritage[] = [];
  const allCalls: ExtractedCall[] = [];

  for (const workerResult of workerResults) {
    // Register symbols into SymbolTable and add graph nodes
    for (const sym of workerResult.symbols) {
      const graphNode = workerSymbolToGraphNode(sym);
      registerInSymbolTable([graphNode], symbolTable);
      graph.addNode(graphNode);
    }

    // Collect imports
    for (const imp of workerResult.imports) {
      allExtractedImports.push({
        filePath: imp.filePath,
        rawImportPath: imp.rawImportPath,
      });
    }

    // Collect re-exports for barrel map construction (T617)
    if (workerResult.reExports) {
      for (const re of workerResult.reExports) {
        allParallelReExports.push(re);
      }
    }

    // Map heritage — worker uses same field names as sequential path
    for (const h of workerResult.heritage) {
      allHeritage.push({
        filePath: h.filePath,
        typeName: h.typeName,
        typeNodeId: h.typeNodeId,
        kind: h.kind,
        parentName: h.parentName,
      });
    }

    // Map calls from worker format to pipeline format
    for (const c of workerResult.calls) {
      allCalls.push({
        filePath: c.filePath,
        sourceId: c.sourceId,
        calledName: c.calledName,
        callForm: c.callForm,
        receiverName: c.receiverName,
      });
    }
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
  const parallelBarrelMap = buildBarrelExportMap(allParallelReExports, importCtx, tsconfigPaths);
  process.stderr.write(
    `[nexus] Barrel map: ${parallelBarrelMap.size} barrel files with re-export chains\n`,
  );

  return { allHeritage, allCalls, barrelMap: parallelBarrelMap };
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

  // Filter to languages supported by the parse loop (Wave I adds Python, Go, Rust)
  const PARSEABLE_LANGUAGES = new Set(['typescript', 'javascript', 'python', 'go', 'rust']);
  const parseableFiles = files.filter((f) => {
    const lang = detectLanguageFromPath(f.path);
    return lang !== null && PARSEABLE_LANGUAGES.has(lang);
  });

  const total = parseableFiles.length;
  if (total === 0)
    return {
      allHeritage: [],
      allCalls: [],
      barrelMap: buildBarrelExportMap([], importCtx, tsconfigPaths),
    };

  // Wave H: Check thresholds for parallel dispatch
  const totalBytes = files.reduce((acc, f) => acc + f.size, 0);
  const useWorkers = total >= WORKER_FILE_THRESHOLD || totalBytes >= WORKER_BYTE_THRESHOLD;

  if (useWorkers) {
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
        { tsconfigPaths, namedImportMap, onProgress },
      );
      if (parallelResult !== null) {
        process.stderr.write('[nexus] Parallel parse complete.\n');
        return parallelResult;
      }
      // Worker unavailable — fall through to sequential
      process.stderr.write('[nexus] Worker script not found — using sequential parse.\n');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[nexus] Parallel parse error (${msg}) — using sequential parse.\n`);
    }
  }

  const allExtractedImports: ExtractedImport[] = [];
  const allReExports: ExtractedReExportRecord[] = [];
  const allHeritage: ExtractedHeritage[] = [];
  const allCalls: ExtractedCall[] = [];

  const parser = getParser();
  if (!parser) {
    process.stderr.write(
      '[nexus] WARNING: tree-sitter native module not available — parse loop skipped.\n',
    );
    return {
      allHeritage: [],
      allCalls: [],
      barrelMap: buildBarrelExportMap([], importCtx, tsconfigPaths),
    };
  }

  let filesProcessed = 0;

  for (const file of parseableFiles) {
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
      process.stderr.write(`[nexus] SKIP: no grammar for ${lang} (file: ${file.path})\n`);
      continue;
    }

    // Read file content — relative path from filesystem walker, read from repoPath
    let source: string;
    try {
      const absPath = file.path.startsWith('/') ? file.path : `${repoPath}/${file.path}`;
      source = await fs.readFile(absPath, 'utf-8');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[nexus] SKIP read error: ${file.path}: ${msg}\n`);
      continue;
    }

    // Parse with tree-sitter
    let rootNode: unknown;
    try {
      parser.setLanguage(grammar);
      const tree = parser.parse(source);
      rootNode = tree.rootNode;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[nexus] SKIP parse error: ${file.path}: ${msg}\n`);
      continue;
    }

    // Extract definitions, imports, heritage, calls, and re-exports — dispatch by language
    let extracted: {
      definitions: GraphNode[];
      imports: ExtractedImport[];
      heritage: ExtractedHeritage[];
      calls: ExtractedCall[];
      reExports?: ExtractedReExport[];
    };
    try {
      extracted = runExtractor(lang, rootNode, file.path);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[nexus] SKIP extract error: ${file.path}: ${msg}\n`);
      continue;
    }

    // Register in SymbolTable
    registerInSymbolTable(extracted.definitions, symbolTable);

    // Add nodes to graph
    for (const node of extracted.definitions) {
      graph.addNode(node);
    }

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

  // Return accumulated heritage, calls, and barrel map
  return { allHeritage, allCalls, barrelMap };
}
