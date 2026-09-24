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

import { type SpawnSyncReturns, spawnSync } from 'node:child_process';
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

/** Previously observed metadata and content hash of one file. */
export interface KnownFileFingerprint {
  /** File size in bytes when the hash was taken. */
  size: number;
  /** Modification time when the hash was taken. */
  mtimeMs: number;
  /** SHA-256 of the file's bytes. */
  contentHash: string;
}

/** Optional walker behaviour. */
export interface WalkOptions {
  /**
   * Files whose size AND mtime still equal a known record reuse its hash
   * instead of being read. Only a freshness check should pass this: an index
   * build must hash what it parses. A metadata-preserving edit can defeat it,
   * which is why the published generation still verifies by content.
   */
  knownFiles?: ReadonlyMap<string, KnownFileFingerprint>;
  /** Called for every file whose bytes were actually read and hashed. */
  onHashed?: (path: string) => void;
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

/** Paths handed to one `git check-ignore` invocation. */
const GIT_IGNORE_BATCH_SIZE = 256;

/** Floor for one ignore-assessment batch, before the per-path allowance. */
export const GIT_IGNORE_BASE_TIMEOUT_MS = 10_000;

/** Added per path in the batch, so the budget scales with the work asked of git. */
export const GIT_IGNORE_PER_PATH_TIMEOUT_MS = 40;

/** Budget for the one-shot `rev-parse` ownership probe. */
export const GIT_PROBE_TIMEOUT_MS = 10_000;

/** Multiplier applied to a batch's budget on its single retry. */
const GIT_IGNORE_RETRY_FACTOR = 4;

/** Operator override for the ignore-assessment budget, in milliseconds. */
export const GIT_IGNORE_TIMEOUT_ENV = 'CLEO_NEXUS_GIT_TIMEOUT_MS';

/**
 * Milliseconds allowed for one ignore-assessment batch.
 *
 * Scales with batch size rather than standing at a constant, because the work
 * git is asked to do scales with it and the filesystem underneath may be far
 * slower than the one the constant was written on.
 *
 * @param batchSize - Paths in this invocation.
 * @param env - Environment to read the operator override from.
 * @returns The budget in milliseconds.
 */
function gitIgnoreTimeoutMs(batchSize: number, env: NodeJS.ProcessEnv = process.env): number {
  const override = Number.parseInt(env[GIT_IGNORE_TIMEOUT_ENV] ?? '', 10);
  if (Number.isFinite(override) && override > 0) return override;
  return GIT_IGNORE_BASE_TIMEOUT_MS + batchSize * GIT_IGNORE_PER_PATH_TIMEOUT_MS;
}

/**
 * Ask Git itself to apply repository, info/exclude and configured global excludes.
 *
 * ## Why the budget is not a constant (T12312)
 *
 * This used to allow `git rev-parse` 1 s and each `git check-ignore` batch 2 s,
 * and to `throw result.error` verbatim on an overrun. Measured 2026-09-23 on a
 * fuseblk mount 23–49× slower than local disk, warm cache, idle machine:
 * rev-parse 152/152/188 ms, and check-ignore over 256 paths 797/974/**1701** ms
 * — one run at 85 % of its budget, a 2.1× spread between runs. A repository of
 * 9 141 tracked files is 36 batches, so that budget was rolled 36 times per
 * `nexus analyze` and one slow roll killed the entire index rebuild with the
 * bare Node string `spawnSync git ETIMEDOUT`: no invocation named, no budget
 * quoted, no remedy. Intermittent by construction, which is why it reproduced
 * for one agent and not the next.
 *
 * The budget now scales with the batch, a transient overrun is retried once
 * with a larger one, and a genuine timeout says what it was doing and how to
 * raise the ceiling. Being ignored is not something git can be asked about
 * approximately, so an exhausted retry still fails the scan — loudly, rather
 * than by silently indexing a vendored tree.
 *
 * @param repoPath - Repository to assess; never inferred from cwd.
 * @param paths - Repo-relative paths to classify.
 * @returns The subset git considers ignored.
 */
function gitExcludedPaths(repoPath: string, paths: readonly string[]): Set<string> {
  const probe = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
    cwd: repoPath,
    encoding: 'utf8',
    timeout: GIT_PROBE_TIMEOUT_MS,
  });
  if (probe.error) {
    throw new Error(
      `Git ownership probe (git rev-parse --is-inside-work-tree) in ${repoPath} did not complete ` +
        `within ${GIT_PROBE_TIMEOUT_MS}ms: ${probe.error.message}. ` +
        `Raise the ignore-assessment budget with ${GIT_IGNORE_TIMEOUT_ENV}=<ms>, or run the scan ` +
        `from a faster filesystem — a network or FUSE mount can exceed this on a loaded machine.`,
      { cause: probe.error },
    );
  }
  if (probe.status === 128 && !existsSync(path.join(repoPath, '.git'))) return new Set();
  if (probe.status !== 0)
    throw new Error(`Git source ownership check failed: ${probe.stderr.trim()}`);
  const excluded = new Set<string>();
  for (let offset = 0; offset < paths.length; offset += GIT_IGNORE_BATCH_SIZE) {
    const batch = paths.slice(offset, offset + GIT_IGNORE_BATCH_SIZE);
    const budget = gitIgnoreTimeoutMs(batch.length);
    const batchNumber = Math.floor(offset / GIT_IGNORE_BATCH_SIZE) + 1;
    const batchCount = Math.ceil(paths.length / GIT_IGNORE_BATCH_SIZE);
    // One retry with a larger budget: an overrun under momentary load is not
    // evidence that the budget is wrong, and abandoning a whole index rebuild
    // on a single slow roll is the failure this replaces.
    let result = runGitCheckIgnore(repoPath, batch, budget);
    let elapsedBudget = budget;
    if (result.error) {
      elapsedBudget = budget * GIT_IGNORE_RETRY_FACTOR;
      result = runGitCheckIgnore(repoPath, batch, elapsedBudget);
    }
    if (result.error) {
      throw new Error(
        `Git ignore assessment (git check-ignore) timed out on batch ${batchNumber} of ` +
          `${batchCount} (${batch.length} paths) in ${repoPath}: allowed ${budget}ms, then ` +
          `${elapsedBudget}ms on retry, and neither completed (${result.error.message}). ` +
          `Raise the per-batch budget with ${GIT_IGNORE_TIMEOUT_ENV}=<ms>. The scan is abandoned ` +
          `rather than continued, because a batch git could not classify would otherwise be ` +
          `indexed as if nothing in it were ignored.`,
        { cause: result.error },
      );
    }
    // Git documents exit 1 for no ignored paths; other failures invalidate the scan.
    if (result.status !== 0 && result.status !== 1)
      throw new Error(`Git ignore assessment failed: ${result.stderr.trim()}`);
    for (const ignored of result.stdout.split('\0')) if (ignored) excluded.add(ignored);
  }
  return excluded;
}

/** One `git check-ignore` invocation over a batch, under an explicit budget. */
function runGitCheckIgnore(
  repoPath: string,
  batch: readonly string[],
  timeout: number,
): SpawnSyncReturns<string> {
  return spawnSync('git', ['check-ignore', '--no-index', '-z', '--stdin'], {
    cwd: repoPath,
    encoding: 'utf8',
    input: `${batch.join('\0')}\0`,
    timeout,
    maxBuffer: 4 * 1024 * 1024,
  });
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
 * @param onFileReport - Optional receiver for exclusion, size and stat outcomes
 * @param includedRepositories - Explicitly included nested repository paths
 * @param options - Metadata fast path for freshness checks (T12316)
 * @returns Array of scanned file entries sorted by relative path
 */
export async function walkRepositoryPaths(
  repoPath: string,
  onProgress?: (current: number, total: number, filePath: string) => void,
  onFileReport?: (report: GraphIndexFileReport) => void,
  includedRepositories: readonly string[] = [],
  options: WalkOptions = {},
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
  for await (const entry of fs.glob('**/*', {
    cwd: repoPath,
    withFileTypes: true,
    exclude: (candidate) => {
      const absolutePath = path.join(candidate.parentPath, candidate.name);
      const normalized = path.relative(repoPath, absolutePath).replace(/\\/g, '/');
      const nestedRepository =
        (candidate.isDirectory() || candidate.isSymbolicLink()) &&
        existsSync(path.join(absolutePath, '.git'));
      const excluded =
        DEFAULT_EXCLUDED_DIRS.has(candidate.name) ||
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
    const relPath = path.relative(repoPath, path.join(entry.parentPath, entry.name));
    const normalised = relPath.replace(/\\/g, '/');
    // Native directory entries avoid a serial stat for every source; metadata
    // and content hashes are still captured by the bounded batches below.
    const isDirectory = entry.isSymbolicLink()
      ? (await fs.stat(path.join(repoPath, relPath))).isDirectory()
      : entry.isDirectory();
    if (!(await isExcluded(normalised, isDirectory))) {
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
        const known = options.knownFiles?.get(relPath);
        let contentHash: string;
        if (known && known.size === stat.size && known.mtimeMs === stat.mtimeMs) {
          contentHash = known.contentHash;
        } else {
          contentHash = createHash('sha256')
            .update(await fs.readFile(fullPath))
            .digest('hex');
          options.onHashed?.(relPath);
        }
        return {
          path: relPath,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          contentHash,
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
