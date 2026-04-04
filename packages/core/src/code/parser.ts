/**
 * Tree-sitter AST parser — query execution engine for code analysis.
 *
 * Resolves grammar paths from node_modules, writes S-expression query
 * patterns to temp files, executes tree-sitter CLI, and parses output
 * into structured CodeSymbol objects.
 *
 * @task T149
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import type {
  BatchParseResult,
  CodeSymbol,
  CodeSymbolKind,
  ParseResult,
} from '@cleocode/contracts';
import { detectLanguage, type TreeSitterLanguage } from '../lib/tree-sitter-languages.js';

// ---------------------------------------------------------------------------
// Tree-sitter CLI resolution
// ---------------------------------------------------------------------------

/** Whether tree-sitter is available on this system. */
let _treeSitterAvailable: boolean | null = null;

/** Check if tree-sitter CLI is available and executable. Cached after first call. */
export function isTreeSitterAvailable(): boolean {
  if (_treeSitterAvailable !== null) return _treeSitterAvailable;
  try {
    const bin = resolveTreeSitterBin();
    // Verify the binary actually runs (broken symlinks pass existsSync)
    execFileSync(bin, ['--version'], { timeout: 5000, stdio: 'pipe' });
    _treeSitterAvailable = true;
  } catch {
    _treeSitterAvailable = false;
  }
  return _treeSitterAvailable;
}

/** Resolve the tree-sitter CLI binary from node_modules. */
function resolveTreeSitterBin(): string {
  // Also check platform-specific binary extension for Windows
  const ext = process.platform === 'win32' ? '.exe' : '';
  const binName = `tree-sitter${ext}`;
  const candidates = [
    join(process.cwd(), 'packages', 'core', 'node_modules', '.bin', binName),
    join(process.cwd(), 'node_modules', '.bin', binName),
    // npm global install paths
    join(process.cwd(), 'node_modules', 'tree-sitter-cli', binName),
  ];
  // Also try without extension (npm .cmd shim on Windows)
  if (ext) {
    candidates.push(
      join(process.cwd(), 'packages', 'core', 'node_modules', '.bin', 'tree-sitter'),
      join(process.cwd(), 'node_modules', '.bin', 'tree-sitter'),
    );
  }
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  throw new Error(
    'tree-sitter CLI not found. Code analysis features (cleo code outline/search/unfold) ' +
      'require tree-sitter. Install with: npm install tree-sitter-cli',
  );
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
// Output parsing
// ---------------------------------------------------------------------------

/**
 * Parse tree-sitter query output into CodeSymbol objects.
 *
 * tree-sitter query output format (one match per block):
 * ```
 * path/to/file.ts
 *   pattern: 0
 *   capture: 0 - name, start: (5, 9), end: (5, 20), text: `parseFile`
 *   capture: 1 - definition.function, start: (5, 0), end: (15, 1)
 * ```
 */
function parseQueryOutput(output: string, filePath: string, language: string): CodeSymbol[] {
  const symbols: CodeSymbol[] = [];
  const lines = output.split('\n');

  let currentName = '';
  let currentKind: CodeSymbolKind = 'function';
  let endLine = 0;

  for (const line of lines) {
    const nameMatch = line.match(
      /capture: \d+ - name, start: \(\d+, \d+\), end: \(\d+, \d+\)(?:, text: `([^`]+)`)?/,
    );
    if (nameMatch) {
      currentName = nameMatch[1] ?? '';
      continue;
    }

    const defMatch = line.match(
      /capture: \d+ - definition\.(\w+), start: \((\d+), \d+\), end: \((\d+), \d+\)/,
    );
    if (defMatch && currentName) {
      currentKind = captureToKind(defMatch[1]!);
      const defStart = Number.parseInt(defMatch[2]!, 10) + 1;
      endLine = Number.parseInt(defMatch[3]!, 10) + 1;

      symbols.push({
        name: currentName,
        kind: currentKind,
        startLine: defStart,
        endLine,
        filePath,
        language,
      });
      currentName = '';
    }
  }

  return symbols;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse a single file and extract code symbols.
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

  const tmpDir = mkdtempSync(join(tmpdir(), 'cleo-ts-'));
  const queryFile = join(tmpDir, 'query.scm');

  try {
    writeFileSync(queryFile, pattern);
    const bin = resolveTreeSitterBin();

    const output = execFileSync(bin, ['query', queryFile, filePath], {
      encoding: 'utf-8',
      timeout: 30000,
      maxBuffer: 10 * 1024 * 1024, // 10MB
    });

    const symbols = parseQueryOutput(output, relPath, language);
    return { filePath: relPath, language, symbols, errors: [] };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { filePath: relPath, language, symbols: [], errors: [msg] };
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Batch-parse multiple files, grouping by language for efficiency.
 *
 * Files with the same language share a single query pattern file
 * but each file is parsed individually (tree-sitter CLI limitation).
 *
 * @param filePaths - Array of file paths to parse
 * @param projectRoot - Project root for relative path computation
 * @returns Aggregated results with per-file breakdowns
 */
export function batchParse(filePaths: string[], projectRoot?: string): BatchParseResult {
  const root = projectRoot ?? process.cwd();
  const results: ParseResult[] = [];
  const skipped: string[] = [];

  // Group files by language
  const byLanguage = new Map<string, string[]>();
  for (const fp of filePaths) {
    const lang = detectLanguage(fp);
    if (!lang) {
      skipped.push(relative(root, fp));
      continue;
    }
    const key = queryKeyForLanguage(lang);
    const group = byLanguage.get(key) ?? [];
    group.push(fp);
    byLanguage.set(key, group);
  }

  // Parse each group
  for (const [_queryKey, files] of byLanguage) {
    for (const fp of files) {
      results.push(parseFile(fp, root));
    }
  }

  const totalSymbols = results.reduce((sum, r) => sum + r.symbols.length, 0);
  return { results, skipped, totalSymbols };
}
