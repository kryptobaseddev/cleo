/**
 * SuffixIndex — Trie-like structure for fast import path resolution.
 *
 * Builds a set of suffix maps over the repository file list so that a raw
 * import string like `'./models/user'` can be resolved to an actual file path
 * (e.g. `src/models/user.ts`) in O(1) without scanning all files.
 *
 * For each file path in the repository, every possible trailing suffix is
 * indexed. For example, `src/models/user.ts` produces:
 *   `"user.ts"` → `"src/models/user.ts"`
 *   `"models/user.ts"` → `"src/models/user.ts"`
 *   `"src/models/user.ts"` → `"src/models/user.ts"`
 *
 * Ported from GitNexus `src/core/ingestion/import-resolvers/utils.ts` and
 * split into its own module for clarity.
 *
 * @task T533
 * @module pipeline/suffix-index
 */

// ---------------------------------------------------------------------------
// File extensions for resolution candidates
// ---------------------------------------------------------------------------

/**
 * Ordered list of file extensions tried during import path resolution.
 * TypeScript/JavaScript extensions are checked first (CLEO's primary target),
 * followed by other supported language extensions.
 */
export const EXTENSIONS: readonly string[] = [
  '',
  // TypeScript / JavaScript
  '.tsx',
  '.ts',
  '.jsx',
  '.js',
  '/index.tsx',
  '/index.ts',
  '/index.jsx',
  '/index.js',
  // Python
  '.py',
  '/__init__.py',
  // Java
  '.java',
  // Kotlin
  '.kt',
  '.kts',
  // C / C++
  '.c',
  '.h',
  '.cpp',
  '.hpp',
  '.cc',
  '.cxx',
  '.hxx',
  '.hh',
  // C#
  '.cs',
  // Go
  '.go',
  // Rust
  '.rs',
  '/mod.rs',
  // PHP
  '.php',
  '.phtml',
  // Swift
  '.swift',
  // Ruby
  '.rb',
];

// ---------------------------------------------------------------------------
// SuffixIndex interface + implementation
// ---------------------------------------------------------------------------

/**
 * Pre-built lookup structure for O(1) import path suffix resolution.
 *
 * All three methods operate on pre-built maps — there is no linear scan
 * at resolution time.
 */
export interface SuffixIndex {
  /** Exact (case-sensitive) suffix lookup. Returns the original file path. */
  get(suffix: string): string | undefined;
  /** Case-insensitive suffix lookup. Useful for case-insensitive filesystems. */
  getInsensitive(suffix: string): string | undefined;
  /**
   * Return all files that reside directly in a directory matching the given
   * suffix and have the specified file extension.
   *
   * @param dirSuffix - Trailing directory path (e.g. `"models"`, `"src/models"`)
   * @param extension - File extension including dot (e.g. `".ts"`)
   */
  getFilesInDir(dirSuffix: string, extension: string): string[];
}

/** Sentinel index that returns no results. Used after import resolution to release memory. */
export const EMPTY_SUFFIX_INDEX: SuffixIndex = Object.freeze({
  get: () => undefined,
  getInsensitive: () => undefined,
  getFilesInDir: () => [],
});

/**
 * Build a SuffixIndex from a list of repository file paths.
 *
 * Both the normalized forward-slash paths and the original paths (which may
 * use backslashes on Windows) are accepted. The index always keys on the
 * normalized form but returns original paths.
 *
 * @param normalizedFileList - File paths with forward slashes (for indexing)
 * @param allFileList - Original file paths (returned as resolved values)
 * @returns A SuffixIndex for fast import path resolution
 *
 * @example
 * ```typescript
 * const paths = ['src/models/user.ts', 'src/models/post.ts'];
 * const index = buildSuffixIndex(paths, paths);
 * index.get('user.ts');       // 'src/models/user.ts'
 * index.get('models/user.ts'); // 'src/models/user.ts'
 * index.getFilesInDir('models', '.ts'); // ['src/models/user.ts', 'src/models/post.ts']
 * ```
 */
export function buildSuffixIndex(normalizedFileList: string[], allFileList: string[]): SuffixIndex {
  // Exact-match map: normalized suffix -> original file path
  const exactMap = new Map<string, string>();
  // Case-insensitive map: lowercase suffix -> original file path
  const lowerMap = new Map<string, string>();
  // Directory membership map: `dirSuffix:extension` -> list of file paths in that dir
  const dirMap = new Map<string, string[]>();

  for (let i = 0; i < normalizedFileList.length; i++) {
    const normalized = normalizedFileList[i];
    const original = allFileList[i];
    const parts = normalized.split('/');

    // Index all trailing suffixes: "a/b/c.ts" -> ["c.ts", "b/c.ts", "a/b/c.ts"]
    for (let j = parts.length - 1; j >= 0; j--) {
      const suffix = parts.slice(j).join('/');
      // First match wins for ambiguous short suffixes (longest path preferred
      // because we iterate from tail upward; the first insertion is shortest)
      if (!exactMap.has(suffix)) {
        exactMap.set(suffix, original);
      }
      const lower = suffix.toLowerCase();
      if (!lowerMap.has(lower)) {
        lowerMap.set(lower, original);
      }
    }

    // Index directory membership (for getFilesInDir)
    const lastSlash = normalized.lastIndexOf('/');
    if (lastSlash >= 0) {
      const dirParts = parts.slice(0, -1);
      const fileName = parts[parts.length - 1];
      const dotIdx = fileName.lastIndexOf('.');
      const ext = dotIdx >= 0 ? fileName.substring(dotIdx) : '';

      for (let j = dirParts.length - 1; j >= 0; j--) {
        const dirSuffix = dirParts.slice(j).join('/');
        const key = `${dirSuffix}:${ext}`;
        let list = dirMap.get(key);
        if (!list) {
          list = [];
          dirMap.set(key, list);
        }
        list.push(original);
      }
    }
  }

  return {
    get: (suffix: string) => exactMap.get(suffix),
    getInsensitive: (suffix: string) => lowerMap.get(suffix.toLowerCase()),
    getFilesInDir: (dirSuffix: string, extension: string) =>
      dirMap.get(`${dirSuffix}:${extension}`) ?? [],
  };
}

// ---------------------------------------------------------------------------
// Resolution helpers
// ---------------------------------------------------------------------------

/**
 * Try to match a base import path against the known file set by appending each
 * candidate extension in order.
 *
 * @param basePath - Import path without extension (e.g. `"src/models/user"`)
 * @param allFiles - Set of all known file paths in the repository
 * @returns The first matching file path, or null
 */
export function tryResolveWithExtensions(basePath: string, allFiles: Set<string>): string | null {
  for (const ext of EXTENSIONS) {
    const candidate = basePath + ext;
    if (allFiles.has(candidate)) return candidate;
  }
  return null;
}

/**
 * Suffix-based resolution using the pre-built SuffixIndex.
 *
 * Tries each suffix of `pathParts` combined with each candidate extension.
 * Falls back to a linear scan over `normalizedFileList` when no `index` is
 * provided (retained for backward compatibility).
 *
 * @param pathParts - Import path split by '/' (e.g. `['models', 'user']`)
 * @param normalizedFileList - Forward-slash normalized file paths (fallback)
 * @param allFileList - Original file paths (fallback)
 * @param index - Pre-built SuffixIndex (preferred)
 * @returns The resolved file path, or null
 */
export function suffixResolve(
  pathParts: string[],
  normalizedFileList: string[],
  allFileList: string[],
  index?: SuffixIndex,
): string | null {
  if (index) {
    for (let i = 0; i < pathParts.length; i++) {
      const suffix = pathParts.slice(i).join('/');
      for (const ext of EXTENSIONS) {
        const suffixWithExt = suffix + ext;
        const result = index.get(suffixWithExt) ?? index.getInsensitive(suffixWithExt);
        if (result) return result;
      }
    }
    return null;
  }

  // Fallback: linear scan (O(files × parts × extensions))
  for (let i = 0; i < pathParts.length; i++) {
    const suffix = pathParts.slice(i).join('/');
    for (const ext of EXTENSIONS) {
      const suffixWithExt = suffix + ext;
      const suffixPattern = '/' + suffixWithExt;
      const matchIdx = normalizedFileList.findIndex(
        (fp) =>
          fp.endsWith(suffixPattern) || fp.toLowerCase().endsWith(suffixPattern.toLowerCase()),
      );
      if (matchIdx !== -1) return allFileList[matchIdx];
    }
  }
  return null;
}
