/**
 * Tree-sitter language detection and grammar resolution.
 *
 * Maps file extensions to tree-sitter language identifiers used by
 * the Smart Explore code analysis pipeline (outline, search, unfold).
 * Grammar loading is handled internally by parser.ts via native Node bindings.
 *
 * @task T509
 * @module code/tree-sitter-languages
 */

/** Supported tree-sitter language identifiers. */
export type TreeSitterLanguage =
  | 'typescript'
  | 'tsx'
  | 'javascript'
  | 'python'
  | 'go'
  | 'rust'
  | 'java'
  | 'c'
  | 'cpp'
  | 'ruby';

/** Map from file extension (without dot) to tree-sitter language. */
const EXTENSION_MAP: Record<string, TreeSitterLanguage> = {
  ts: 'typescript',
  tsx: 'tsx',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
  pyi: 'python',
  go: 'go',
  rs: 'rust',
  java: 'java',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  hh: 'cpp',
  rb: 'ruby',
};

/** Map from language to its npm grammar package name. */
const GRAMMAR_PACKAGE_MAP: Record<TreeSitterLanguage, string> = {
  typescript: 'tree-sitter-typescript',
  tsx: 'tree-sitter-typescript',
  javascript: 'tree-sitter-javascript',
  python: 'tree-sitter-python',
  go: 'tree-sitter-go',
  rust: 'tree-sitter-rust',
  java: 'tree-sitter-java',
  c: 'tree-sitter-c',
  cpp: 'tree-sitter-cpp',
  ruby: 'tree-sitter-ruby',
};

/**
 * Detect tree-sitter language from a file path or file name.
 *
 * @param filePath - Path to a source file (or bare file name)
 * @returns The detected language, or undefined if unsupported
 */
export function detectLanguage(filePath: string): TreeSitterLanguage | undefined {
  const ext = filePath.split('.').pop()?.toLowerCase();
  if (!ext) return undefined;
  return EXTENSION_MAP[ext];
}

/**
 * Get the npm grammar package name for a language.
 *
 * The package name matches the native Node binding that parser.ts loads
 * via {@link createRequire}. Useful for diagnostics and install hints.
 *
 * @param language - A tree-sitter language identifier
 * @returns The npm package name containing the grammar
 */
export function grammarPackage(language: TreeSitterLanguage): string {
  return GRAMMAR_PACKAGE_MAP[language];
}

/** All supported file extensions (without leading dot). */
export const SUPPORTED_EXTENSIONS = Object.keys(EXTENSION_MAP);

/** All supported languages (deduplicated). */
export const SUPPORTED_LANGUAGES: TreeSitterLanguage[] = [...new Set(Object.values(EXTENSION_MAP))];
