/**
 * Language detection from file extensions.
 *
 * Maps file extensions to canonical language names used throughout the
 * code intelligence pipeline. Ported and adapted from the GitNexus
 * language provider registry (gitnexus/src/core/ingestion/languages/index.ts).
 *
 * @task T532
 * @module pipeline/language-detection
 */

/**
 * Map from file extension (including leading dot, lowercased) to canonical
 * language name.
 *
 * The canonical language names match the values used by the `language` column
 * in `nexus_nodes` and `code_index` tables.
 */
const EXTENSION_TO_LANGUAGE: Record<string, string> = {
  // TypeScript
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  // JavaScript
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  // Python
  '.py': 'python',
  '.pyi': 'python',
  '.pyx': 'python',
  // Go
  '.go': 'go',
  // Rust
  '.rs': 'rust',
  // Java
  '.java': 'java',
  // Kotlin
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  // C / C++
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.cxx': 'cpp',
  '.hpp': 'cpp',
  '.hh': 'cpp',
  // C#
  '.cs': 'csharp',
  // PHP
  '.php': 'php',
  // Ruby
  '.rb': 'ruby',
  '.rake': 'ruby',
  // Swift
  '.swift': 'swift',
  // Dart
  '.dart': 'dart',
  // Vue
  '.vue': 'vue',
  // HTML / CSS (structural)
  '.html': 'html',
  '.htm': 'html',
  '.css': 'css',
  '.scss': 'scss',
  '.sass': 'sass',
  '.less': 'less',
  // Markdown / docs
  '.md': 'markdown',
  '.mdx': 'markdown',
  // Configuration / data
  '.json': 'json',
  '.jsonc': 'json',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.toml': 'toml',
  '.xml': 'xml',
  // Shell
  '.sh': 'shell',
  '.bash': 'shell',
  '.zsh': 'shell',
  '.fish': 'shell',
  // SQL
  '.sql': 'sql',
  // GraphQL
  '.graphql': 'graphql',
  '.gql': 'graphql',
  // COBOL
  '.cbl': 'cobol',
  '.cob': 'cobol',
  // Proto
  '.proto': 'proto',
};

/**
 * Detect the language for a given file path from its extension.
 *
 * The extension lookup is case-insensitive. Returns `null` for unknown
 * or binary file types.
 *
 * @param filePath - Relative or absolute file path
 * @returns Canonical language name, or null if unknown
 */
export function detectLanguageFromPath(filePath: string): string | null {
  const lastDot = filePath.lastIndexOf('.');
  if (lastDot === -1) return null;
  const ext = filePath.slice(lastDot).toLowerCase();
  return EXTENSION_TO_LANGUAGE[ext] ?? null;
}

/**
 * Return true if the given file path corresponds to a text-based source
 * file that should be indexed.
 *
 * Files without a recognized extension are excluded. Binary files
 * (images, fonts, archives, etc.) are excluded implicitly because they
 * have no entry in the extension map.
 *
 * @param filePath - Relative or absolute file path
 */
export function isIndexableFile(filePath: string): boolean {
  return detectLanguageFromPath(filePath) !== null;
}
