/**
 * Filesystem walker — Phase 1 of the code intelligence ingestion pipeline.
 *
 * Scans the repository using Node's native `fs.glob` (Node 22+), stats each
 * file to filter large files, and returns a lightweight `ScannedFile[]` list
 * with paths and sizes. Source hashes are streamed through bounded file batches during this phase.
 *
 * Memory footprint: approximately 10 MB for 100 K files (paths + sizes only).
 *
 * Ported and adapted from GitNexus:
 * `gitnexus/src/core/ingestion/filesystem-walker.ts`
 *
 * Key adaptations:
 * - Replaces `glob` npm package with Node 24 native `fs.promises.glob`
 * - Uses Git-compatible ignore rules, including nested files and escaped patterns
 * - Adds `.cleo/` to the default exclude list for CLEO projects
 * - Language field added to `ScannedFile` (detected from extension)
 *
 * @task T532
 * @module pipeline/filesystem-walker
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { GraphIndexFileReport } from '@cleocode/contracts';
import ignore, { type Ignore } from 'ignore';
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
 * Contains path, size and content fingerprints. Files are read in bounded batches.
 */
export interface ScannedFile {
  /** File path relative to the repository root, using forward slashes. */
  path: string;
  /** File size in bytes. */
  size: number;
  /** Filesystem modification time captured before parsing. */
  mtimeMs?: number;
  /** SHA-256 digest of the scanned source bytes. */
  contentHash?: string;
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
 * Returns an empty array only when the ignore file does not exist.
 *
 * @param ignorePath - Absolute path to the ignore file
 */
async function readIgnorePatterns(ignorePath: string): Promise<string[]> {
  try {
    const content = await fs.readFile(ignorePath, 'utf-8');
    return content.split('\n');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }
}

/** Ask Git itself to apply repository, info/exclude and configured global excludes. */
function gitExcludedPaths(repoPath: string, paths: readonly string[]): Set<string> {
  const probe = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
    cwd: repoPath,
    encoding: 'utf8',
    timeout: 1000,
  });
  if (probe.error) throw probe.error;
  if (probe.status === 128 && !existsSync(path.join(repoPath, '.git'))) return new Set();
  if (probe.status !== 0)
    throw new Error(`Git source ownership check failed: ${probe.stderr.trim()}`);
  const excluded = new Set<string>();
  for (let offset = 0; offset < paths.length; offset += 256) {
    const batch = paths.slice(offset, offset + 256);
    const result = spawnSync('git', ['check-ignore', '--no-index', '-z', '--stdin'], {
      cwd: repoPath,
      encoding: 'utf8',
      input: `${batch.join('\0')}\0`,
      timeout: 2000,
      maxBuffer: 4 * 1024 * 1024,
    });
    if (result.error) throw result.error;
    // Git documents exit 1 for no ignored paths; other failures invalidate the scan.
    if (result.status !== 0 && result.status !== 1)
      throw new Error(`Git ignore assessment failed: ${result.stderr.trim()}`);
    for (const ignored of result.stdout.split('\0')) if (ignored) excluded.add(ignored);
  }
  return excluded;
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
  onFileReport?: (report: GraphIndexFileReport) => void,
  includedRepositories: readonly string[] = [],
): Promise<ScannedFile[]> {
  // Load root .gitignore and .cleoignore patterns
  const gitignorePatterns = await readIgnorePatterns(path.join(repoPath, '.gitignore'));
  const cleoignorePatterns = await readIgnorePatterns(path.join(repoPath, '.cleoignore'));
  const rootIgnore = ignore().add([...gitignorePatterns, ...cleoignorePatterns]);
  const nestedPatterns = new Map<string, Ignore>();

  /** Apply ordered ignore rules, respecting nested files and negations. */
  async function isExcluded(relPath: string, isDirectory: boolean): Promise<boolean> {
    const parts = relPath.split('/');
    if (parts.some((part) => DEFAULT_EXCLUDED_DIRS.has(part))) return true;
    const rules: Array<readonly [string, Ignore]> = [['', rootIgnore]];
    for (let index = 1; index < parts.length; index++) {
      const directory = parts.slice(0, index).join('/');
      if (!nestedPatterns.has(directory)) {
        nestedPatterns.set(
          directory,
          ignore().add([
            ...(await readIgnorePatterns(path.join(repoPath, directory, '.gitignore'))),
            ...(await readIgnorePatterns(path.join(repoPath, directory, '.cleoignore'))),
          ]),
        );
      }
      rules.push([directory, nestedPatterns.get(directory)!]);
    }
    // An ignored parent cannot be re-included solely by a child negation.
    for (let index = 1; index <= parts.length; index++) {
      const candidate = parts.slice(0, index).join('/');
      let ignored = false;
      for (const [directory, patterns] of rules) {
        if (directory && !candidate.startsWith(`${directory}/`)) continue;
        const localPath =
          (directory ? candidate.slice(directory.length + 1) : candidate) +
          (index < parts.length || isDirectory ? '/' : '');
        const result = patterns.test(localPath);
        if (result.ignored) ignored = true;
        else if (result.unignored) ignored = false;
      }
      if (ignored) return true;
    }
    return false;
  }

  // Collect all relative paths via native glob
  const relativePaths: string[] = [];
  for await (const relPath of fs.glob('**/*', {
    cwd: repoPath,
    exclude: (name) => {
      const normalized = name.replace(/\\/g, '/');
      const nestedRepository = existsSync(path.join(repoPath, name, '.git'));
      const excluded =
        DEFAULT_EXCLUDED_DIRS.has(path.basename(name)) ||
        (nestedRepository && !includedRepositories.includes(normalized));
      if (excluded)
        onFileReport?.({
          path: normalized,
          status: 'excluded',
          reason: nestedRepository
            ? 'Nested repository requires explicit inclusion'
            : 'Default excluded directory',
        });
      return excluded;
    },
  })) {
    // Normalise to forward slashes
    const normalised = relPath.replace(/\\/g, '/');
    if (
      !(await isExcluded(normalised, (await fs.stat(path.join(repoPath, relPath))).isDirectory()))
    ) {
      relativePaths.push(normalised);
    } else {
      onFileReport?.({ path: normalised, status: 'excluded', reason: 'Ignore rule' });
    }
  }

  // Preserve the parent project binding while evaluating each explicitly included
  // repository with its own Git configuration (including linked-worktree gitdirs).
  const scopes = ['', ...includedRepositories].sort((a, b) => b.length - a.length);
  const scopedPaths = new Map<string, string[]>();
  for (const file of relativePaths) {
    const scope = scopes.find((candidate) => !candidate || file.startsWith(`${candidate}/`)) ?? '';
    const local = scope ? file.slice(scope.length + 1) : file;
    const paths = scopedPaths.get(scope) ?? [];
    paths.push(local);
    scopedPaths.set(scope, paths);
  }
  const gitExcluded = new Set<string>();
  for (const [scope, paths] of scopedPaths) {
    for (const file of gitExcludedPaths(path.join(repoPath, scope), paths)) {
      const full = scope ? `${scope}/${file}` : file;
      gitExcluded.add(full);
      onFileReport?.({
        path: full,
        status: 'excluded',
        reason: 'Git ignore rule (including repository/global excludes)',
      });
    }
  }
  const eligiblePaths = relativePaths.filter((file) => !gitExcluded.has(file));

  // Stat files in batches to filter by size and collect metadata
  const entries: ScannedFile[] = [];
  let processed = 0;
  let skippedLarge = 0;

  for (let start = 0; start < eligiblePaths.length; start += STAT_CONCURRENCY) {
    const batch = eligiblePaths.slice(start, start + STAT_CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (relPath) => {
        const fullPath = path.join(repoPath, relPath);
        const stat = await fs.stat(fullPath);
        // Skip directories (glob with nodir equivalent — but native glob may include dirs)
        if (stat.isDirectory()) return null;
        if (stat.size > MAX_FILE_SIZE) {
          skippedLarge++;
          onFileReport?.({
            path: relPath,
            status: 'oversized',
            reason: 'Exceeds 512 KB scan limit',
            size: stat.size,
            mtimeMs: stat.mtimeMs,
          });
          return null;
        }
        return {
          path: relPath,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          contentHash: createHash('sha256')
            .update(await fs.readFile(fullPath))
            .digest('hex'),
          language: detectLanguageFromPath(relPath),
        };
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
        if (result.status === 'rejected') {
          onFileReport?.({ path: approxPath, status: 'failed', reason: 'Cannot stat file' });
        }
        onProgress?.(processed, relativePaths.length, approxPath);
      }
    }
  }

  if (skippedLarge > 0) {
    console.warn(
      `  [nexus/walker] Skipped ${skippedLarge} large files (>${MAX_FILE_SIZE / 1024}KB)`,
    );
  }

  return entries.sort((left, right) => left.path.localeCompare(right.path));
}
