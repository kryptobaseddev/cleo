/**
 * Filesystem walker — Phase 1 of the code intelligence ingestion pipeline.
 *
 * Scans the repository using Node's native `fs.glob` (Node 22+), stats each
 * file to filter large files, and returns a lightweight `ScannedFile[]` list
 * with paths and sizes. No file content is loaded into memory during this phase.
 *
 * Memory footprint: approximately 10 MB for 100 K files (paths + sizes only).
 *
 * Ported and adapted from GitNexus:
 * `gitnexus/src/core/ingestion/filesystem-walker.ts`
 *
 * Key adaptations:
 * - Replaces `glob` npm package with Node 24 native `fs.promises.glob`
 * - Replaces `ignore-service` with a minimal built-in gitignore reader
 * - Adds `.cleo/` to the default exclude list for CLEO projects
 * - Language field added to `ScannedFile` (detected from extension)
 *
 * @task T532
 * @module pipeline/filesystem-walker
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { detectLanguageFromPath } from './language-detection.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Skip files larger than 512 KB — they are typically generated or vendored. */
const MAX_FILE_SIZE = 512 * 1024;

/** Concurrency for stat calls (matches GitNexus READ_CONCURRENCY). */
const STAT_CONCURRENCY = 32;

/**
 * Directory names that are always excluded from repository scans.
 *
 * These match the default ignore list from the GitNexus ignore-service plus
 * CLEO-specific entries.
 */
const DEFAULT_EXCLUDED_DIRS = new Set([
  // Version control
  '.git',
  '.svn',
  '.hg',
  // Dependencies
  'node_modules',
  'bower_components',
  'vendor',
  'venv',
  '.venv',
  '__pycache__',
  '.pytest_cache',
  // Build outputs
  'dist',
  'build',
  'out',
  'target',
  '.next',
  '.nuxt',
  '.output',
  // CLEO runtime data (not source code)
  '.cleo',
  // IDE / editor
  '.idea',
  '.vscode',
  // Test coverage
  'coverage',
  '.nyc_output',
]);

// ---------------------------------------------------------------------------
// Scanned file type
// ---------------------------------------------------------------------------

/**
 * A single file entry produced by the filesystem walker.
 *
 * Contains only path and size metadata — content is never loaded during
 * Phase 1 to keep memory usage bounded.
 */
export interface ScannedFile {
  /** File path relative to the repository root, using forward slashes. */
  path: string;
  /** File size in bytes. */
  size: number;
  /**
   * Canonical language name detected from the file extension, or null
   * for unrecognized extensions.
   */
  language: string | null;
}

// ---------------------------------------------------------------------------
// Gitignore reader
// ---------------------------------------------------------------------------

/**
 * Read and parse a single ignore file (`.gitignore` or `.cleoignore`) into a list of patterns.
 *
 * Returns an empty array if the file does not exist or cannot be read.
 *
 * @param ignorePath - Absolute path to the ignore file
 */
async function readIgnorePatterns(ignorePath: string): Promise<string[]> {
  try {
    const content = await fs.readFile(ignorePath, 'utf-8');
    return content
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'));
  } catch {
    return [];
  }
}

/**
 * Convert a gitignore pattern to a function that tests whether a relative
 * path matches that pattern.
 *
 * Supports the most common gitignore pattern forms:
 * - Plain directory name (`node_modules`) — matches any path component
 * - Negation prefix (`!`) — not implemented here (rare in practice)
 * - Trailing slash — matches only directories (treated as prefix match)
 * - `**` glob — matches any path segment sequence
 *
 * @param pattern - Raw gitignore pattern string
 * @returns Predicate or null if the pattern cannot be compiled
 */
function buildIgnoreMatcher(pattern: string): ((relPath: string) => boolean) | null {
  if (pattern.startsWith('!')) return null; // negation not supported
  const stripped = pattern.endsWith('/') ? pattern.slice(0, -1) : pattern;
  if (!stripped) return null;

  // Simple name-only patterns match any component (e.g. "*.log")
  const hasSlash = stripped.includes('/');
  if (!hasSlash) {
    // Match the pattern against each path component
    const re = globToRegex(stripped);
    return (relPath: string) => {
      const parts = relPath.split('/');
      return parts.some((part) => re.test(part));
    };
  }

  // Anchored patterns match from the repo root
  const re = globToRegex(stripped.startsWith('/') ? stripped.slice(1) : stripped);
  return (relPath: string) => re.test(relPath);
}

/**
 * Convert a simple glob pattern (supporting `*`, `**`, `?`) to a RegExp.
 *
 * @param glob - Glob pattern string
 */
function globToRegex(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000') // placeholder for **
    .replace(/\*/g, '[^/]*') // * matches within segment
    .replace(/\?/g, '[^/]') // ? matches single non-slash char
    .replace(/\u0000/g, '.*'); // ** matches across segments
  return new RegExp(`^${escaped}$`);
}

// ---------------------------------------------------------------------------
// Core walker
// ---------------------------------------------------------------------------

/**
 * Walk the repository directory tree and return a list of scanned files.
 *
 * Uses Node 24's native `fs.promises.glob` for efficient directory traversal.
 * Files in excluded directories are skipped before stat is called.
 * Files larger than {@link MAX_FILE_SIZE} are skipped after stat.
 *
 * @param repoPath - Absolute path to the repository root
 * @param onProgress - Optional progress callback invoked for each processed file
 * @returns Array of scanned file entries sorted by relative path
 */
export async function walkRepositoryPaths(
  repoPath: string,
  onProgress?: (current: number, total: number, filePath: string) => void,
): Promise<ScannedFile[]> {
  // Load root .gitignore and .cleoignore patterns
  const gitignorePatterns = await readIgnorePatterns(path.join(repoPath, '.gitignore'));
  const cleoignorePatterns = await readIgnorePatterns(path.join(repoPath, '.cleoignore'));
  const allIgnorePatterns = [...gitignorePatterns, ...cleoignorePatterns];
  const ignoreMatchers = allIgnorePatterns
    .map(buildIgnoreMatcher)
    .filter((m): m is (relPath: string) => boolean => m !== null);

  /**
   * Test whether a relative path should be excluded.
   *
   * A path is excluded if:
   * 1. Any component matches a DEFAULT_EXCLUDED_DIRS name, or
   * 2. Any compiled gitignore matcher returns true for the relative path.
   */
  function isExcluded(relPath: string): boolean {
    const parts = relPath.split('/');
    // Check every component against the hard-coded exclusion set
    for (const part of parts) {
      if (DEFAULT_EXCLUDED_DIRS.has(part)) return true;
    }
    // Check gitignore matchers
    return ignoreMatchers.some((m) => m(relPath));
  }

  // Collect all relative paths via native glob
  const relativePaths: string[] = [];
  for await (const relPath of fs.glob('**/*', {
    cwd: repoPath,
    exclude: (name) => DEFAULT_EXCLUDED_DIRS.has(name),
  })) {
    // Normalise to forward slashes
    const normalised = relPath.replace(/\\/g, '/');
    if (!isExcluded(normalised)) {
      relativePaths.push(normalised);
    }
  }

  // Stat files in batches to filter by size and collect metadata
  const entries: ScannedFile[] = [];
  let processed = 0;
  let skippedLarge = 0;

  for (let start = 0; start < relativePaths.length; start += STAT_CONCURRENCY) {
    const batch = relativePaths.slice(start, start + STAT_CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (relPath) => {
        const fullPath = path.join(repoPath, relPath);
        const stat = await fs.stat(fullPath);
        // Skip directories (glob with nodir equivalent — but native glob may include dirs)
        if (stat.isDirectory()) return null;
        if (stat.size > MAX_FILE_SIZE) {
          skippedLarge++;
          return null;
        }
        return { path: relPath, size: stat.size, language: detectLanguageFromPath(relPath) };
      }),
    );

    for (const result of results) {
      processed++;
      if (result.status === 'fulfilled' && result.value !== null) {
        entries.push(result.value);
        onProgress?.(processed, relativePaths.length, result.value.path);
      } else {
        const batchIndex = processed - 1 - start;
        const approxPath = batch[batchIndex] ?? batch[batch.length - 1] ?? '';
        onProgress?.(processed, relativePaths.length, approxPath);
      }
    }
  }

  if (skippedLarge > 0) {
    console.warn(
      `  [nexus/walker] Skipped ${skippedLarge} large files (>${MAX_FILE_SIZE / 1024}KB)`,
    );
  }

  return entries;
}
