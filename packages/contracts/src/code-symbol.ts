/**
 * Code symbol types for tree-sitter AST analysis.
 *
 * Used by the Smart Explore code analysis pipeline to represent
 * parsed source code structures.
 *
 * @task T149
 */

/** Kind of code symbol extracted from AST. */
export type CodeSymbolKind =
  | 'function'
  | 'method'
  | 'class'
  | 'interface'
  | 'type'
  | 'enum'
  | 'variable'
  | 'constant'
  | 'module'
  | 'import'
  | 'export'
  | 'struct'
  | 'trait'
  | 'impl';

/** A structured code symbol extracted from a source file via tree-sitter. */
export interface CodeSymbol {
  /** Symbol name (e.g. "parseFile", "HttpTransport"). */
  name: string;
  /** Kind of symbol. */
  kind: CodeSymbolKind;
  /** Start line (1-based). */
  startLine: number;
  /** End line (1-based). */
  endLine: number;
  /** File path (relative to project root). */
  filePath: string;
  /** Language of the source file. */
  language: string;
  /** Parent symbol name (e.g. class name for methods). */
  parent?: string;
  /** Whether the symbol is exported. */
  exported?: boolean;
  /** Function/method parameters (if applicable). */
  parameters?: string[];
  /** Return type annotation (if available). */
  returnType?: string;
  /** JSDoc/docstring summary (first line only). */
  docSummary?: string;
}

/** Result of parsing a single file. */
export interface ParseResult {
  /** Source file path. */
  filePath: string;
  /** Detected language. */
  language: string;
  /** Extracted symbols. */
  symbols: CodeSymbol[];
  /** Parse errors (non-fatal). */
  errors: string[];
}

/** Result of batch-parsing multiple files. */
export interface BatchParseResult {
  /** Per-file results. */
  results: ParseResult[];
  /** Files that were skipped (unsupported language). */
  skipped: string[];
  /** Total symbols found across all files. */
  totalSymbols: number;
}

/** Bounds for one native parser invocation; cancellation is cooperative in-process. */
export interface ParserExecutionLimits {
  /** Maximum UTF-8 source bytes; defaults to 512 KiB. */
  maxSourceBytes?: number;
  /** Native parsing deadline in milliseconds; defaults to 1000. */
  timeoutMs?: number;
  /** Per-worker V8 old-generation heap ceiling in MiB; excludes native allocations. */
  workerHeapMb?: number;
  /** Caller cancellation, checked before parsing and between native input reads. */
  signal?: AbortSignal;
}
