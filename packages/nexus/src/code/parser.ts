/**
 * Tree-sitter AST parser — native Node bindings query execution engine.
 *
 * Uses the tree-sitter native Node module to parse source files in-process,
 * executing S-expression query patterns directly against the AST without
 * spawning a subprocess or writing temp files.
 *
 * @task T509
 * @module code/parser
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { relative } from 'node:path';
import type {
  BatchParseResult,
  CodeSymbol,
  CodeSymbolKind,
  ParseResult,
} from '@cleocode/contracts';
import { detectLanguage, type TreeSitterLanguage } from './tree-sitter-languages.js';

// ---------------------------------------------------------------------------
// Native module loading (CommonJS interop via createRequire)
// ---------------------------------------------------------------------------

/** ESM-safe require for loading native tree-sitter addons. */
const _require = createRequire(import.meta.url);

/**
 * Load a native module via require, returning null on failure.
 *
 * @param id - Module specifier (e.g. "tree-sitter" or "tree-sitter-rust")
 */
function tryRequire(id: string): unknown {
  try {
    return _require(id) as unknown;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Parser singleton — lazy-loaded on first use
// ---------------------------------------------------------------------------

/** The Parser constructor from the tree-sitter native module. */
type ParserConstructor = new () => NativeParser;

/** Minimal shape of the native tree-sitter Parser instance. */
interface NativeParser {
  setLanguage(lang: unknown): void;
  parse(source: string): NativeTree;
}

/** Minimal shape of the parsed Tree. */
interface NativeTree {
  rootNode: SyntaxNode;
}

/** Minimal shape of a tree-sitter SyntaxNode. */
interface SyntaxNode {
  type: string;
  text: string;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  children: SyntaxNode[];
  namedChildren: SyntaxNode[];
  childForFieldName(fieldName: string): SyntaxNode | null;
}

/** Minimal shape of a Query capture result. */
interface QueryCapture {
  name: string;
  node: SyntaxNode;
}

/** Minimal shape of the native Query class. */
interface NativeQueryConstructor {
  new (language: unknown, pattern: string): NativeQuery;
}

/** Minimal shape of a constructed Query instance. */
interface NativeQuery {
  captures(node: SyntaxNode): QueryCapture[];
}

/** The native Parser constructor (null if module unavailable). */
let _ParserClass: ParserConstructor | null = null;

/** The native Query constructor (null if module unavailable). */
let _QueryClass: NativeQueryConstructor | null = null;

/** Singleton parser instance, reused across calls. */
let _parserInstance: NativeParser | null = null;

/** Whether availability has been probed. */
let _availabilityChecked = false;

/** Whether the native tree-sitter module loaded successfully. */
let _available = false;

/**
 * Probe and cache tree-sitter native module availability.
 *
 * Loads the tree-sitter native module once and caches the result.
 * Subsequent calls return the cached value with no I/O.
 *
 * @returns True if the native module loaded successfully
 */
export function isTreeSitterAvailable(): boolean {
  if (_availabilityChecked) return _available;
  _availabilityChecked = true;

  const mod = tryRequire('tree-sitter');
  if (mod === null) {
    _available = false;
    return false;
  }

  // tree-sitter exports the Parser class directly
  _ParserClass = mod as ParserConstructor;

  // The Query class lives on the Parser namespace
  const parserWithQuery = mod as { Query?: NativeQueryConstructor };
  _QueryClass = parserWithQuery.Query ?? null;

  _available = _ParserClass !== null && _QueryClass !== null;
  return _available;
}

/**
 * Get (or create) the singleton Parser instance.
 *
 * @throws {Error} If tree-sitter native module is not available
 */
function getParser(): NativeParser {
  if (_parserInstance) return _parserInstance;
  if (!isTreeSitterAvailable() || _ParserClass === null) {
    throw new Error(
      'tree-sitter native module not available. ' +
        'Run: pnpm install (tree-sitter is a bundled dependency)',
    );
  }
  _parserInstance = new _ParserClass();
  return _parserInstance;
}

// ---------------------------------------------------------------------------
// Grammar registry — language identifier → loaded grammar object
// ---------------------------------------------------------------------------

/** Cache of loaded grammar objects, keyed by language identifier. */
const _grammarCache = new Map<string, unknown>();

/**
 * Describe how each grammar package exports its language object.
 *
 * Most packages export a single object via `module.exports = language`.
 * tree-sitter-typescript exports `{ typescript, tsx }`.
 * tree-sitter-php (not used here) exports `{ php, php_only }`.
 */
interface GrammarSpec {
  /** npm package name. */
  pkg: string;
  /** Property to read from the module exports (undefined = use exports directly). */
  prop?: string;
}

const GRAMMAR_SPECS: Record<string, GrammarSpec> = {
  typescript: { pkg: 'tree-sitter-typescript', prop: 'typescript' },
  tsx: { pkg: 'tree-sitter-typescript', prop: 'tsx' },
  javascript: { pkg: 'tree-sitter-javascript' },
  python: { pkg: 'tree-sitter-python' },
  go: { pkg: 'tree-sitter-go' },
  rust: { pkg: 'tree-sitter-rust' },
  java: { pkg: 'tree-sitter-java' },
  c: { pkg: 'tree-sitter-c' },
  cpp: { pkg: 'tree-sitter-cpp' },
  ruby: { pkg: 'tree-sitter-ruby' },
};

/**
 * Load and cache a grammar for the given language key.
 *
 * @param langKey - Language key matching a {@link GRAMMAR_SPECS} entry
 * @returns The grammar object, or null if the package is not installed
 */
function loadGrammar(langKey: string): unknown {
  if (_grammarCache.has(langKey)) return _grammarCache.get(langKey) ?? null;

  const spec = GRAMMAR_SPECS[langKey];
  if (!spec) return null;

  const mod = tryRequire(spec.pkg);
  if (mod === null) {
    _grammarCache.set(langKey, null);
    return null;
  }

  const grammar = spec.prop ? (mod as Record<string, unknown>)[spec.prop] : mod;
  _grammarCache.set(langKey, grammar ?? null);
  return grammar ?? null;
}

// ---------------------------------------------------------------------------
// S-expression query patterns per language family
// ---------------------------------------------------------------------------

/** Query patterns that match function/method/class/type declarations. */
const QUERY_PATTERNS: Record<string, string> = {
  // TypeScript / JavaScript
  typescript: `
(function_declaration name: (identifier) @name) @definition.function
(method_definition name: (property_identifier) @name) @definition.method
(class_declaration name: (type_identifier) @name) @definition.class
(interface_declaration name: (type_identifier) @name) @definition.interface
(type_alias_declaration name: (type_identifier) @name) @definition.type
(enum_declaration name: (identifier) @name) @definition.enum
(lexical_declaration (variable_declarator name: (identifier) @name)) @definition.variable
(export_statement (function_declaration name: (identifier) @name)) @definition.function
(export_statement (class_declaration name: (type_identifier) @name)) @definition.class
(arrow_function) @definition.function
`,
  javascript: `
(function_declaration name: (identifier) @name) @definition.function
(method_definition name: (property_identifier) @name) @definition.method
(class_declaration name: (identifier) @name) @definition.class
(lexical_declaration (variable_declarator name: (identifier) @name)) @definition.variable
(export_statement (function_declaration name: (identifier) @name)) @definition.function
(export_statement (class_declaration name: (identifier) @name)) @definition.class
(arrow_function) @definition.function
`,
  // Python
  python: `
(function_definition name: (identifier) @name) @definition.function
(class_definition name: (identifier) @name) @definition.class
(decorated_definition (function_definition name: (identifier) @name)) @definition.function
(decorated_definition (class_definition name: (identifier) @name)) @definition.class
`,
  // Go
  go: `
(function_declaration name: (identifier) @name) @definition.function
(method_declaration name: (field_identifier) @name) @definition.method
(type_declaration (type_spec name: (type_identifier) @name)) @definition.type
`,
  // Rust
  rust: `
(function_item name: (identifier) @name) @definition.function
(impl_item type: (type_identifier) @name) @definition.impl
(struct_item name: (type_identifier) @name) @definition.struct
(enum_item name: (type_identifier) @name) @definition.enum
(trait_item name: (type_identifier) @name) @definition.trait
(type_item name: (type_identifier) @name) @definition.type
(mod_item name: (identifier) @name) @definition.module
`,
  // Ruby
  ruby: `
(method name: (identifier) @name) @definition.method
(class name: (constant) @name) @definition.class
(module name: (constant) @name) @definition.module
(singleton_method name: (identifier) @name) @definition.method
`,
  // Java / C / C++
  java: `
(method_declaration name: (identifier) @name) @definition.method
(class_declaration name: (identifier) @name) @definition.class
(interface_declaration name: (identifier) @name) @definition.interface
(enum_declaration name: (identifier) @name) @definition.enum
`,
  c: `
(function_definition declarator: (function_declarator declarator: (identifier) @name)) @definition.function
(struct_specifier name: (type_identifier) @name) @definition.struct
(enum_specifier name: (type_identifier) @name) @definition.enum
(type_definition declarator: (type_identifier) @name) @definition.type
`,
  cpp: `
(function_definition declarator: (function_declarator declarator: (qualified_identifier) @name)) @definition.function
(function_definition declarator: (function_declarator declarator: (identifier) @name)) @definition.function
(class_specifier name: (type_identifier) @name) @definition.class
(struct_specifier name: (type_identifier) @name) @definition.struct
(enum_specifier name: (type_identifier) @name) @definition.enum
(namespace_definition name: (identifier) @name) @definition.module
`,
};

/** Map language to query pattern key. */
function queryKeyForLanguage(lang: TreeSitterLanguage): string {
  if (lang === 'tsx') return 'typescript';
  return lang;
}

/** Map capture name suffix to CodeSymbolKind. */
function captureToKind(capture: string): CodeSymbolKind {
  const map: Record<string, CodeSymbolKind> = {
    function: 'function',
    method: 'method',
    class: 'class',
    interface: 'interface',
    type: 'type',
    enum: 'enum',
    variable: 'variable',
    constant: 'constant',
    module: 'module',
    import: 'import',
    export: 'export',
    struct: 'struct',
    trait: 'trait',
    impl: 'impl',
  };
  return map[capture] ?? 'function';
}

// ---------------------------------------------------------------------------
// Query cache — avoid re-compiling patterns for repeated parses
// ---------------------------------------------------------------------------

/** Cache of compiled Query objects, keyed by `<langKey>:<queryKey>`. */
const _queryCache = new Map<string, NativeQuery>();

/**
 * Get or compile a tree-sitter Query for the given language and pattern.
 *
 * @param grammar - The loaded grammar object (language)
 * @param langKey - Key used for cache lookup
 * @param pattern - S-expression query pattern string
 * @returns Compiled Query instance, or null on compilation failure
 */
function getQuery(grammar: unknown, langKey: string, pattern: string): NativeQuery | null {
  const cacheKey = langKey;
  if (_queryCache.has(cacheKey)) return _queryCache.get(cacheKey) ?? null;

  if (_QueryClass === null) return null;

  try {
    const query = new _QueryClass(grammar, pattern);
    _queryCache.set(cacheKey, query);
    return query;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Capture processing — convert Query captures to CodeSymbol objects
// ---------------------------------------------------------------------------

/**
 * Convert tree-sitter query captures into CodeSymbol objects.
 *
 * The query patterns use two capture groups per match:
 * - `@definition.<kind>` — the enclosing declaration node with line range
 * - `@name` — the identifier node containing the symbol's text
 *
 * tree-sitter's Query.captures() returns captures in document order within
 * each match. Because definition nodes enclose the name node, the definition
 * capture appears first, then the name capture for the same match.
 *
 * We pair consecutive `definition.*` + `name` captures to build symbols.
 *
 * @param captures - Raw captures from Query.captures()
 * @param filePath - Relative file path for the symbol record
 * @param language - Language identifier for the symbol record
 * @returns Extracted CodeSymbol objects
 */
function captureToSymbols(
  captures: QueryCapture[],
  filePath: string,
  language: string,
): CodeSymbol[] {
  const symbols: CodeSymbol[] = [];

  let i = 0;
  while (i < captures.length) {
    const cap = captures[i]!;

    if (cap.name.startsWith('definition.')) {
      const kindSuffix = cap.name.slice('definition.'.length);
      const kind = captureToKind(kindSuffix);
      // tree-sitter rows are 0-based; convert to 1-based line numbers
      const startLine = cap.node.startPosition.row + 1;
      const endLine = cap.node.endPosition.row + 1;

      // The matching @name capture should immediately follow
      const nameCap = captures[i + 1];
      if (nameCap && nameCap.name === 'name') {
        const nameText = nameCap.node.text;
        if (nameText) {
          symbols.push({
            name: nameText,
            kind,
            startLine,
            endLine,
            filePath,
            language,
          });
        }
        i += 2;
        continue;
      }
    }

    i++;
  }

  return symbols;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse a single file and extract code symbols using the native tree-sitter
 * Node module.
 *
 * Loads the grammar for the detected language, sets it on the shared parser
 * singleton, runs the compiled Query against the AST, and converts captures
 * into CodeSymbol objects.
 *
 * @param filePath - Absolute or relative path to source file
 * @param projectRoot - Project root for relative path computation
 * @returns Parse result with symbols and any errors
 */
export function parseFile(filePath: string, projectRoot?: string): ParseResult {
  const root = projectRoot ?? process.cwd();
  const relPath = relative(root, filePath);
  const language = detectLanguage(filePath);

  if (!language) {
    return {
      filePath: relPath,
      language: 'unknown',
      symbols: [],
      errors: ['Unsupported language'],
    };
  }

  if (!isTreeSitterAvailable()) {
    return {
      filePath: relPath,
      language,
      symbols: [],
      errors: [
        'tree-sitter native module not available. ' +
          'Run: pnpm install (tree-sitter is a bundled dependency)',
      ],
    };
  }

  const queryKey = queryKeyForLanguage(language);
  const pattern = QUERY_PATTERNS[queryKey];
  if (!pattern) {
    return {
      filePath: relPath,
      language,
      symbols: [],
      errors: [`No query pattern for ${language}`],
    };
  }

  const grammar = loadGrammar(language);
  if (!grammar) {
    return {
      filePath: relPath,
      language,
      symbols: [],
      errors: [`Grammar package not installed for ${language}`],
    };
  }

  let source: string;
  try {
    source = readFileSync(filePath, 'utf-8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { filePath: relPath, language, symbols: [], errors: [`Failed to read file: ${msg}`] };
  }

  try {
    const parser = getParser();
    parser.setLanguage(grammar);
    const tree = parser.parse(source);

    const query = getQuery(grammar, queryKey, pattern);
    if (!query) {
      return {
        filePath: relPath,
        language,
        symbols: [],
        errors: [`Failed to compile query for ${language}`],
      };
    }

    const captures = query.captures(tree.rootNode);
    const symbols = captureToSymbols(captures, relPath, language);
    return { filePath: relPath, language, symbols, errors: [] };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { filePath: relPath, language, symbols: [], errors: [msg] };
  }
}

/**
 * Batch-parse multiple files, grouping by language for efficiency.
 *
 * Files are parsed individually; the parser singleton is reused across all
 * files. Grammar loading is cached so each grammar is loaded at most once
 * per process.
 *
 * @param filePaths - Array of file paths to parse
 * @param projectRoot - Project root for relative path computation
 * @returns Aggregated results with per-file breakdowns
 */
export function batchParse(filePaths: string[], projectRoot?: string): BatchParseResult {
  const root = projectRoot ?? process.cwd();
  const results: ParseResult[] = [];
  const skipped: string[] = [];

  for (const fp of filePaths) {
    const lang = detectLanguage(fp);
    if (!lang) {
      skipped.push(relative(root, fp));
      continue;
    }
    results.push(parseFile(fp, root));
  }

  const totalSymbols = results.reduce((sum, r) => sum + r.symbols.length, 0);
  return { results, skipped, totalSymbols };
}
