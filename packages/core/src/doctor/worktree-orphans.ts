/**
 * Worktree-orphan scan + prune primitives for `cleo doctor`.
 *
 * Background: the T9550/T9580 SSoT bug in `getCleoDirAbsolute()` (fixed in
 * v2026.5.83) caused stray `.cleo/` directories to be created underneath
 * `<projectRoot>/.claude/worktrees/<agent>/[<task>/]`. Those orphans were
 * never cleaned up — `cleo doctor --audit-worktree-orphans` (read-only)
 * lists them with full provenance, and `cleo doctor --prune-worktree-orphans`
 * archives them to a tarball, appends a JSONL audit-log line per prune,
 * then removes them.
 *
 * Also provides `auditWorktreeOrphansComprehensive` (T9808) — a broader
 * scan that reads the live `git worktree list` and checks:
 *   1. Orphan `.cleo/` dirs inside ANY registered git worktree path.
 *   2. Worktrees outside the canonical XDG location
 *      (`<cleoHome>/worktrees/<projectHash>/<taskId>/`).
 *   3. Rogue `.cleo/worktrees/` DIRECTORY (council D009 — only a `.json`
 *      sentinel file is permitted there; a full directory is a sign that the
 *      old in-tree worktrees convention leaked into the project `.cleo/`).
 *
 * Security model:
 *   - Scan limits depth to 3 (`worktrees/<agent>/[<task>/]/.cleo/`) — see
 *     `MAX_SCAN_DEPTH` below.
 *   - Prune validates every `orphanPath` is under the resolved
 *     `<projectRoot>/.claude/worktrees/` root via `path.resolve` +
 *     prefix check before any `rm -rf`. Symlinks are resolved with
 *     `realpathSync` so attackers can't escape via a planted link.
 *   - Tarball is written FIRST (atomic safety net). Audit line is appended
 *     before removal so a crash mid-rm still records the intent.
 *   - All paths logged in `.cleo/audit/worktree-prune.jsonl`.
 *
 * @task T9790
 * @task T9808
 * @epic T9790
 * @epic T9808
 */

import { spawn, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  type Dirent,
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type {
  ComprehensiveAuditResult,
  OrphanEntry,
  OrphanScanResult,
  PruneAuditEntry,
  PruneResult,
  WorktreeAnomaly,
} from '@cleocode/contracts';
import { computeProjectHash, getCleoWorktreesRoot } from '@cleocode/paths';

/**
 * Maximum directory depth (relative to `.claude/worktrees/`) at which a
 * `.cleo/` directory will be reported as an orphan.
 *
 * The known damage pattern is:
 *   - `.claude/worktrees/<agent>/.cleo/`           (depth 2 from worktrees)
 *   - `.claude/worktrees/<agent>/<task>/.cleo/`    (depth 3 from worktrees)
 *
 * Keeping the depth strict prevents accidentally pruning a legitimately
 * nested project inside a worktree.
 */
const MAX_SCAN_DEPTH = 3;

/**
 * Files whose presence under an orphan signals real data was written there
 * (vs. an empty directory). Used by `dbFiles` and `isFullDuplicate` heuristics.
 */
const KNOWN_DB_FILES = new Set([
  'tasks.db',
  'brain.db',
  'nexus.db',
  'conduit.db',
  'signaldock.db',
  'config.json',
]);

/**
 * Subdirectory names whose presence under an orphan marks it as a "full
 * duplicate" — i.e. the orphan contains structured CLEO content (decisions,
 * agent outputs, RCASD plans) and not just stray DB files.
 */
const FULL_DUPLICATE_MARKERS = new Set([
  'adrs',
  'agent-outputs',
  'rcasd',
  'audit',
  'memory',
  'specs',
]);

/**
 * Default soft-warn threshold: emit a warning when a single directory
 * level contains more than this many entries (but scan continues).
 */
const DEFAULT_SOFT_WARN_ENTRIES = 100;

/**
 * Default hard-stop threshold: abort the scan with `isPartial: true` /
 * `partialReason: 'overflow'` when a single level has more entries than
 * this. Prevents the 194-orphan / 60s+ hang class (T9962).
 */
const DEFAULT_MAX_ENTRIES_PER_LEVEL = 500;

/**
 * Options for {@link scanWorktreeOrphans} and
 * {@link scanWorktreeOrphansBudgeted}.
 */
export interface ScanOptions {
  /**
   * Override the scan root. Defaults to `<projectRoot>/.claude/worktrees/`.
   * Mainly for tests.
   */
  worktreesRoot?: string;
  /**
   * Per-level fan-out hard-stop. When the number of entries in a single
   * directory level reaches this limit the scan aborts and returns with
   * `isPartial: true, partialReason: 'overflow'`.
   *
   * Default: 500. Set to `Infinity` to disable.
   * Only honoured by {@link scanWorktreeOrphansBudgeted}.
   */
  maxEntriesPerLevel?: number;
  /**
   * Per-level soft-warn threshold. When entries in a level exceed this value
   * a warning message is added to the result but the scan continues (up to
   * `maxEntriesPerLevel`).
   *
   * Default: 100. Set to `Infinity` to disable.
   * Only honoured by {@link scanWorktreeOrphansBudgeted}.
   */
  softWarnEntriesPerLevel?: number;
  /**
   * Maximum wall-clock milliseconds for the entire scan. When exceeded the
   * scan aborts and returns with `isPartial: true, partialReason: 'timeout'`.
   *
   * Default: `undefined` (no timeout). Typically set to `30_000` (30 s) by
   * the CLI.
   * Only honoured by {@link scanWorktreeOrphansBudgeted}.
   */
  timeoutMs?: number;
}

/**
 * Options for {@link pruneWorktreeOrphans}.
 */
export interface PruneOptions {
  /**
   * Directory under which the `.tar.gz` archive is written. Created if
   * missing. Recommended:
   * `<projectRoot>/.cleo/backups/`.
   */
  archiveDir: string;
  /**
   * Absolute path to the audit log file. Each pruned entry produces one
   * JSONL line. Recommended:
   * `<projectRoot>/.cleo/audit/worktree-prune.jsonl`.
   */
  auditLogPath: string;
  /**
   * When `true`, no tarball is written, no audit line is appended, and no
   * `rm` is invoked. The returned `PruneResult.pruned` lists what would
   * have happened.
   */
  dryRun?: boolean;
  /**
   * The project root the orphans must be contained within. The prune step
   * REJECTS any entry whose `orphanPath` does not resolve to a descendant
   * of `<projectRoot>/.claude/worktrees/`. Defaults to the parent of
   * `archiveDir`'s grandparent (`<archiveDir>/../..`) when not provided.
   */
  projectRoot: string;
}

/**
 * Walk a directory tree and accumulate (size, lastMtime, dbFiles,
 * subDirNames) for orphan classification.
 *
 * Internal helper. Returns aggregate metadata over the entire subtree
 * rooted at `dir`. Symlinks are NOT followed (we use `lstat` semantics
 * via `statSync` after `realpathSync` of the entry path — see the prune
 * security check; here we just walk via `readdirSync`).
 */
function collectOrphanMetadata(dir: string): {
  sizeBytes: number;
  lastModifiedMs: number;
  dbFiles: string[];
  isFullDuplicate: boolean;
} {
  let sizeBytes = 0;
  let lastModifiedMs = 0;
  const dbFiles: string[] = [];
  let isFullDuplicate = false;

  const walk = (current: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const childPath = join(current, entry.name);
      try {
        if (entry.isDirectory()) {
          // Only top-level direct children of the orphan .cleo/ count as
          // structural duplicate markers (e.g. .cleo/adrs/).
          if (current === dir && FULL_DUPLICATE_MARKERS.has(entry.name)) {
            isFullDuplicate = true;
          }
          walk(childPath);
        } else if (entry.isFile()) {
          if (KNOWN_DB_FILES.has(entry.name)) {
            dbFiles.push(childPath);
          }
          const st = statSync(childPath);
          sizeBytes += st.size;
          if (st.mtimeMs > lastModifiedMs) {
            lastModifiedMs = st.mtimeMs;
          }
        }
      } catch {
        // Skip unreadable entries; the surrounding scan still produces a
        // useful report.
      }
    }
  };

  walk(dir);
  return { sizeBytes, lastModifiedMs, dbFiles, isFullDuplicate };
}

/**
 * Recursively search for `.cleo/` directories under `worktreesRoot`, up
 * to {@link MAX_SCAN_DEPTH} levels deep, and return one {@link OrphanEntry}
 * per match.
 *
 * Walks every sub-directory but stops descending once it has either (a)
 * found a `.cleo/` directory at the current level (it does NOT descend
 * INTO the orphan further) or (b) exceeded `MAX_SCAN_DEPTH`. This bounds
 * the cost on huge worktrees.
 *
 * @param projectRoot - The project root that owns `.claude/worktrees/`.
 * @param opts - See {@link ScanOptions}.
 * @returns Discovered orphans, sorted by `orphanPath` ascending for stable output.
 *
 * @example
 *   const orphans = await scanWorktreeOrphans('/mnt/projects/cleocode');
 *   for (const o of orphans) console.log(o.orphanPath, o.sizeBytes);
 */
export async function scanWorktreeOrphans(
  projectRoot: string,
  opts: ScanOptions = {},
): Promise<OrphanEntry[]> {
  const worktreesRoot = opts.worktreesRoot ?? join(projectRoot, '.claude', 'worktrees');

  if (!existsSync(worktreesRoot)) {
    return [];
  }

  const orphans: OrphanEntry[] = [];
  const now = Date.now();

  const walk = (current: string, depth: number, worktreePath: string): void => {
    if (depth > MAX_SCAN_DEPTH) return;

    let entries: Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const childPath = join(current, entry.name);

      if (entry.name === '.cleo') {
        const meta = collectOrphanMetadata(childPath);
        const lastModifiedMs = meta.lastModifiedMs > 0 ? meta.lastModifiedMs : now;
        orphans.push({
          worktreePath,
          orphanPath: childPath,
          dbFiles: meta.dbFiles,
          sizeBytes: meta.sizeBytes,
          lastModifiedAt: new Date(lastModifiedMs).toISOString(),
          ageSeconds: Math.max(0, Math.floor((now - lastModifiedMs) / 1000)),
          isFullDuplicate: meta.isFullDuplicate,
        });
        // Do not recurse into the orphan itself.
        continue;
      }

      walk(childPath, depth + 1, worktreePath);
    }
  };

  let topLevel: Dirent[];
  try {
    topLevel = readdirSync(worktreesRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const entry of topLevel) {
    if (!entry.isDirectory()) continue;
    const worktreePath = join(worktreesRoot, entry.name);
    walk(worktreePath, 1, worktreePath);
  }

  orphans.sort((a, b) => a.orphanPath.localeCompare(b.orphanPath));
  return orphans;
}

/**
 * Width-budgeted wrapper around {@link scanWorktreeOrphans}.
 *
 * Adds three safety valves (T9962):
 *   - **Hard stop** at `maxEntriesPerLevel` entries per directory level
 *     (default 500). Aborts immediately and returns
 *     `isPartial: true, partialReason: 'overflow'`.
 *   - **Soft warn** at `softWarnEntriesPerLevel` (default 100). Scan
 *     continues but `softWarnMessage` is set in the result.
 *   - **Timeout** at `timeoutMs` milliseconds. Aborts and returns
 *     `isPartial: true, partialReason: 'timeout'`.
 *
 * Existing callers of `scanWorktreeOrphans` keep their original behaviour
 * unchanged. New code (e.g. the CLI) should call this function instead.
 *
 * NOTE: This code is scheduled for replacement by the Rust worktrunk-core
 * rewrite in T9977/T9986. Do NOT over-engineer.
 *
 * @param projectRoot - The project root that owns `.claude/worktrees/`.
 * @param opts - See {@link ScanOptions}.
 * @returns {@link OrphanScanResult} wrapping the discovered orphans.
 *
 * @task T9962
 */
export async function scanWorktreeOrphansBudgeted(
  projectRoot: string,
  opts: ScanOptions = {},
): Promise<OrphanScanResult> {
  const maxEntriesPerLevel = opts.maxEntriesPerLevel ?? DEFAULT_MAX_ENTRIES_PER_LEVEL;
  const softWarnEntriesPerLevel = opts.softWarnEntriesPerLevel ?? DEFAULT_SOFT_WARN_ENTRIES;
  const worktreesRoot = opts.worktreesRoot ?? join(projectRoot, '.claude', 'worktrees');

  if (!existsSync(worktreesRoot)) {
    return { orphans: [], isPartial: false };
  }

  const startTime = Date.now();
  const { timeoutMs } = opts;

  const orphans: OrphanEntry[] = [];
  const now = startTime;
  let isPartial = false;
  let partialReason: 'timeout' | 'overflow' | undefined;
  let softWarnMessage: string | undefined;

  const checkTimeout = (): boolean => {
    if (timeoutMs !== undefined && Date.now() - startTime > timeoutMs) {
      isPartial = true;
      partialReason = 'timeout';
      return true;
    }
    return false;
  };

  /**
   * Recursive walker — mirrors the one in `scanWorktreeOrphans` but checks
   * per-level entry counts and the wall-clock budget on each iteration.
   */
  const walk = (current: string, depth: number, worktreePath: string): boolean => {
    if (depth > MAX_SCAN_DEPTH) return false;
    if (checkTimeout()) return true;

    let entries: Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return false;
    }

    const dirEntries = entries.filter((e) => e.isDirectory());

    // Soft-warn check (only emitted once, on the first level that crosses).
    if (softWarnMessage === undefined && dirEntries.length > softWarnEntriesPerLevel) {
      softWarnMessage =
        `Warning: ${dirEntries.length} entries found at depth ${depth} under ${current} ` +
        `(soft-warn threshold: ${softWarnEntriesPerLevel}). ` +
        `Scan continues but may be slow. Run \`cleo doctor --prune-worktree-orphans\` ` +
        `or reduce orphan count to avoid this warning.`;
    }

    // Hard-stop overflow check.
    if (dirEntries.length > maxEntriesPerLevel) {
      isPartial = true;
      partialReason = 'overflow';
      return true;
    }

    for (const entry of dirEntries) {
      if (checkTimeout()) return true;

      const childPath = join(current, entry.name);

      if (entry.name === '.cleo') {
        const meta = collectOrphanMetadata(childPath);
        const lastModifiedMs = meta.lastModifiedMs > 0 ? meta.lastModifiedMs : now;
        orphans.push({
          worktreePath,
          orphanPath: childPath,
          dbFiles: meta.dbFiles,
          sizeBytes: meta.sizeBytes,
          lastModifiedAt: new Date(lastModifiedMs).toISOString(),
          ageSeconds: Math.max(0, Math.floor((now - lastModifiedMs) / 1000)),
          isFullDuplicate: meta.isFullDuplicate,
        });
        continue;
      }

      if (walk(childPath, depth + 1, worktreePath)) return true;
    }
    return false;
  };

  let topLevel: Dirent[];
  try {
    topLevel = readdirSync(worktreesRoot, { withFileTypes: true });
  } catch {
    return { orphans: [], isPartial: false };
  }

  // Check the top-level width budget first.
  const topLevelDirs = topLevel.filter((e) => e.isDirectory());

  if (topLevelDirs.length > maxEntriesPerLevel) {
    isPartial = true;
    partialReason = 'overflow';
    return { orphans, isPartial, partialReason, softWarnMessage };
  }

  if (softWarnMessage === undefined && topLevelDirs.length > softWarnEntriesPerLevel) {
    softWarnMessage =
      `Warning: ${topLevelDirs.length} entries found at the top-level under ${worktreesRoot} ` +
      `(soft-warn threshold: ${softWarnEntriesPerLevel}). ` +
      `Scan continues but may be slow. Run \`cleo doctor --prune-worktree-orphans\` ` +
      `or reduce orphan count to avoid this warning.`;
  }

  for (const entry of topLevelDirs) {
    if (checkTimeout()) break;
    const worktreePath = join(worktreesRoot, entry.name);
    if (walk(worktreePath, 1, worktreePath)) break;
  }

  orphans.sort((a, b) => a.orphanPath.localeCompare(b.orphanPath));

  if (!isPartial) {
    return { orphans, isPartial: false, softWarnMessage };
  }

  return { orphans, isPartial, partialReason, softWarnMessage };
}

/**
 * Validate that `target` resolves to a descendant of `boundary`. Returns
 * the resolved real path on success, or `null` if the target escapes the
 * boundary (or does not exist).
 *
 * Uses `realpathSync` on `boundary` so a configured root with symlinks
 * still compares correctly. For `target`, we walk UP the path until we
 * find an existing ancestor (e.g. when `target` itself was already pruned
 * but its parent worktree dir still exists) and canonicalize THAT,
 * re-attaching the remaining segments. This keeps the symlink-aware
 * comparison stable across both "target exists" and "target was removed"
 * states — critical on macOS where `/var → /private/var` would otherwise
 * produce mismatched prefixes between the two states.
 */
function resolveWithinBoundary(target: string, boundary: string): string | null {
  let canonicalBoundary: string;
  try {
    canonicalBoundary = realpathSync(boundary);
  } catch {
    return null;
  }
  const canonicalBoundaryWithSep = canonicalBoundary.endsWith(sep)
    ? canonicalBoundary
    : canonicalBoundary + sep;

  // Resolve `target` to an absolute path first, then walk UP until we
  // hit an existing ancestor (or the filesystem root). Canonicalize the
  // ancestor, then re-attach the residual segments. This handles three
  // cases uniformly:
  //   (a) target exists                — realpath the full thing
  //   (b) target was just deleted      — realpath the existing parent
  //   (c) target never existed         — realpath bottoms out at root
  const absolute = resolve(target);
  let existing = absolute;
  const trailing: string[] = [];
  // Bound the climb at the filesystem root by stopping when `dirname`
  // becomes a fixed point (`dirname('/') === '/'`).
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    trailing.unshift(existing.slice(parent.length + 1));
    existing = parent;
  }
  let canonicalTarget: string;
  try {
    const canonicalExisting = realpathSync(existing);
    canonicalTarget =
      trailing.length === 0 ? canonicalExisting : join(canonicalExisting, ...trailing);
  } catch {
    canonicalTarget = absolute;
  }

  if (
    canonicalTarget !== canonicalBoundary &&
    !canonicalTarget.startsWith(canonicalBoundaryWithSep)
  ) {
    return null;
  }
  return canonicalTarget;
}

/**
 * Synchronously archive a list of directories into a single `.tar.gz` via
 * the system `tar` binary. Resolves on exit code 0, rejects on non-zero.
 *
 * Uses `-C <projectRoot>` and relative paths so the archive's internal
 * layout stays portable (no leaking of absolute paths from the build
 * machine).
 */
function tarGzDirs(archivePath: string, projectRoot: string, dirs: string[]): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    if (dirs.length === 0) {
      rejectPromise(new Error('tarGzDirs: refusing to write an empty archive'));
      return;
    }
    const relPaths = dirs.map((d) => relative(projectRoot, d));
    const args = ['-czf', archivePath, '-C', projectRoot, ...relPaths];
    const child = spawn('tar', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => rejectPromise(err));
    child.on('close', (code) => {
      if (code === 0) {
        resolvePromise();
      } else {
        rejectPromise(new Error(`tar exited ${code}: ${stderr.trim()}`));
      }
    });
  });
}

/**
 * Atomically archive + remove the given orphan entries.
 *
 * Workflow per call:
 *   1. Validate every entry's `orphanPath` is under
 *      `<projectRoot>/.claude/worktrees/`. Entries that fail are
 *      pushed into `rejected[]` and skipped.
 *   2. Write a single `.tar.gz` containing all surviving orphans to
 *      `<archiveDir>/worktree-orphans-<isoTimestamp>.tar.gz`.
 *   3. Append one JSONL line per pruned entry to `auditLogPath`.
 *   4. `rm -rf` each orphan.
 *
 * In dry-run mode the function performs step 1 only and returns the
 * proposed prune plan in `pruned[]` (with `archivePath: null`).
 *
 * @param entries - The orphans to prune. Typically the output of
 *   {@link scanWorktreeOrphans}.
 * @param opts - See {@link PruneOptions}.
 * @returns A {@link PruneResult} describing what happened.
 *
 * @example
 *   const orphans = await scanWorktreeOrphans(root);
 *   const result = await pruneWorktreeOrphans(orphans, {
 *     projectRoot: root,
 *     archiveDir: join(root, '.cleo/backups'),
 *     auditLogPath: join(root, '.cleo/audit/worktree-prune.jsonl'),
 *   });
 *   console.log(`archived to ${result.archivePath}, freed ${result.totalSizeBytes} bytes`);
 */
export async function pruneWorktreeOrphans(
  entries: OrphanEntry[],
  opts: PruneOptions,
): Promise<PruneResult> {
  const dryRun = opts.dryRun === true;
  const worktreesRoot = join(opts.projectRoot, '.claude', 'worktrees');
  const prunedAt = new Date().toISOString();

  const pruned: OrphanEntry[] = [];
  const rejected: Array<{ entry: OrphanEntry; reason: string }> = [];

  // Step 1 — security validation.
  for (const entry of entries) {
    const canonical = resolveWithinBoundary(entry.orphanPath, worktreesRoot);
    if (canonical === null) {
      rejected.push({ entry, reason: 'path-outside-worktrees-root' });
      continue;
    }
    if (!existsSync(entry.orphanPath)) {
      rejected.push({ entry, reason: 'path-not-found' });
      continue;
    }
    pruned.push(entry);
  }

  let archivePath: string | null = null;
  const totalSizeBytes = pruned.reduce((sum, e) => sum + e.sizeBytes, 0);

  if (pruned.length === 0 || dryRun) {
    return {
      archivePath,
      dryRun,
      pruned,
      rejected,
      totalSizeBytes,
      prunedAt,
    };
  }

  // Step 2 — write the tarball atomically.
  mkdirSync(opts.archiveDir, { recursive: true });
  const tsSlug = prunedAt.replace(/[:.]/g, '-');
  archivePath = join(opts.archiveDir, `worktree-orphans-${tsSlug}.tar.gz`);
  await tarGzDirs(
    archivePath,
    opts.projectRoot,
    pruned.map((e) => e.orphanPath),
  );

  // Step 3 — append audit lines BEFORE removal so a crash still records intent.
  mkdirSync(dirname(opts.auditLogPath), { recursive: true });
  for (const entry of pruned) {
    const line: PruneAuditEntry = {
      timestamp: prunedAt,
      worktreePath: entry.worktreePath,
      orphanPath: entry.orphanPath,
      action: 'prune-worktree-orphan',
      agent: 'cleo',
      sizeBytes: entry.sizeBytes,
      dbFileCount: entry.dbFiles.length,
      archivePath,
      dryRun: false,
    };
    appendFileSync(opts.auditLogPath, JSON.stringify(line) + '\n', 'utf8');
  }

  // Step 4 — remove. Best-effort per entry: a failure is recorded in
  // `rejected[]` and does not abort the rest.
  const reallyPruned: OrphanEntry[] = [];
  for (const entry of pruned) {
    try {
      rmSync(entry.orphanPath, { recursive: true, force: true });
      reallyPruned.push(entry);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      rejected.push({ entry, reason: `rm-failed: ${message}` });
    }
  }

  return {
    archivePath,
    dryRun: false,
    pruned: reallyPruned,
    rejected,
    totalSizeBytes: reallyPruned.reduce((sum, e) => sum + e.sizeBytes, 0),
    prunedAt,
  };
}

// ============================================================================
// Comprehensive worktree audit (T9808 — council D009)
// ============================================================================

/**
 * Maximum depth inside a git worktree path at which we look for orphan
 * `.cleo/` directories (relative to the worktree root).
 *
 * Depth 1 catches: `<worktree>/.cleo/`
 * Depth 2 catches: `<worktree>/<task>/.cleo/`  (unlikely but observed)
 */
const COMPREHENSIVE_SCAN_DEPTH = 2;

/**
 * Parse the output of `git worktree list --porcelain` and return the list of
 * worktree directory paths. Skips the bare-repo entry (no `worktree` prefix)
 * and entries that don't parse cleanly.
 *
 * @param gitDir - The project root (passed to `git -C`).
 * @returns Array of absolute worktree paths.
 */
function listGitWorktrees(gitDir: string): string[] {
  const result = spawnSync('git', ['-C', gitDir, 'worktree', 'list', '--porcelain'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0 || !result.stdout) {
    return [];
  }
  const paths: string[] = [];
  for (const line of result.stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      const p = line.slice('worktree '.length).trim();
      if (p) paths.push(p);
    }
  }
  return paths;
}

/**
 * Recursively search for `.cleo/` directories under `root`, limited to
 * `maxDepth` levels. Returns the first hit found at each sub-path (does NOT
 * recurse into a found `.cleo/`).
 */
function findCleoDirsUnder(root: string, maxDepth: number): string[] {
  const found: string[] = [];

  const walk = (current: string, depth: number): void => {
    if (depth > maxDepth) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const childPath = join(current, entry.name);
      if (entry.name === '.cleo') {
        found.push(childPath);
        // Do not recurse INTO the orphan.
        continue;
      }
      walk(childPath, depth + 1);
    }
  };

  walk(root, 0);
  return found;
}

/**
 * Comprehensive worktree anomaly audit (T9808 / council D009).
 *
 * Reads `git worktree list` for the given project root and produces a
 * structured report of three anomaly classes:
 *
 *   1. **`orphan-cleo-dir`** — any `.cleo/` directory found inside a git
 *      worktree path (these should never exist; worktrees are read-only
 *      consumers of the main project's `.cleo/`).
 *
 *   2. **`non-canonical-location`** — a worktree exists at a path that is
 *      NOT under the canonical XDG root
 *      (`<cleoHome>/worktrees/<projectHash>/`). The main repo checkout is
 *      the only accepted non-canonical entry.
 *
 *   3. **`rogue-worktrees-directory`** — `<projectRoot>/.cleo/worktrees/`
 *      exists as a **directory**. Council D009 mandates that only a single
 *      `.json` sentinel file may live at that path; a directory means the
 *      old in-tree worktree convention leaked into the project `.cleo/`.
 *
 * Returns a {@link ComprehensiveAuditResult} with all anomalies sorted by
 * `kind` then `path` for stable output. `count > 0` means anomalies were
 * found; exit code 2 is recommended on non-zero count.
 *
 * @param projectRoot - Absolute path to the project root (contains `.git/`).
 * @returns Audit result.
 *
 * @example
 *   const result = await auditWorktreeOrphansComprehensive('/mnt/projects/cleocode');
 *   if (result.count > 0) process.exitCode = 2;
 *
 * @task T9808
 */
export async function auditWorktreeOrphansComprehensive(
  projectRoot: string,
): Promise<ComprehensiveAuditResult> {
  const projectHash = computeProjectHash(projectRoot);
  const canonicalWorktreesRoot = join(getCleoWorktreesRoot(), projectHash);

  const anomalies: WorktreeAnomaly[] = [];

  // ------------------------------------------------------------------ //
  // Check 3: rogue .cleo/worktrees/ DIRECTORY (D009)
  // ------------------------------------------------------------------ //
  const cleoWorktreesPath = join(projectRoot, '.cleo', 'worktrees');
  if (existsSync(cleoWorktreesPath)) {
    let isDir = false;
    try {
      isDir = statSync(cleoWorktreesPath).isDirectory();
    } catch {
      // ignore
    }
    if (isDir) {
      anomalies.push({
        kind: 'rogue-worktrees-directory',
        path: cleoWorktreesPath,
        description:
          `Council D009: .cleo/worktrees/ must NOT be a directory. ` +
          `Only a .json sentinel file is permitted at this path. ` +
          `Remove the directory or migrate its contents to the canonical XDG location ` +
          `(${canonicalWorktreesRoot}).`,
        worktreePath: null,
      });
    }
  }

  // ------------------------------------------------------------------ //
  // Checks 1 + 2: scan git worktrees list
  // ------------------------------------------------------------------ //
  const allWorktrees = listGitWorktrees(projectRoot);

  for (const wt of allWorktrees) {
    // Check 2: non-canonical location.
    // The main project checkout is the only worktree we accept outside
    // the canonical XDG root. We identify it by comparing the resolved
    // path to the resolved projectRoot.
    let wtResolved: string;
    try {
      wtResolved = realpathSync(wt);
    } catch {
      wtResolved = resolve(wt);
    }
    let projectRootResolved: string;
    try {
      projectRootResolved = realpathSync(projectRoot);
    } catch {
      projectRootResolved = resolve(projectRoot);
    }

    const isMainCheckout = wtResolved === projectRootResolved;
    const isCanonicalXdg =
      wtResolved === canonicalWorktreesRoot ||
      wtResolved.startsWith(canonicalWorktreesRoot + sep) ||
      wt === canonicalWorktreesRoot ||
      wt.startsWith(canonicalWorktreesRoot + sep);

    if (!isMainCheckout && !isCanonicalXdg) {
      anomalies.push({
        kind: 'non-canonical-location',
        path: wt,
        description:
          `Worktree at ${wt} is outside the canonical XDG location ` +
          `(${canonicalWorktreesRoot}). ` +
          `Non-canonical worktrees bypass the git-shim isolation guards ` +
          `and may produce rogue .cleo/ directories. ` +
          `Re-provision via \`cleo orchestrate spawn <taskId>\`.`,
        worktreePath: wt,
      });
    }

    // Check 1: orphan .cleo/ dirs inside the worktree.
    if (!isMainCheckout) {
      const cleoDirs = findCleoDirsUnder(wt, COMPREHENSIVE_SCAN_DEPTH);
      for (const cleoDir of cleoDirs) {
        anomalies.push({
          kind: 'orphan-cleo-dir',
          path: cleoDir,
          description:
            `Orphan .cleo/ directory found inside worktree ${wt}. ` +
            `This is a sign of the T9550/T9580 SSoT bug (fixed in v2026.5.83). ` +
            `Run \`cleo doctor --prune-worktree-orphans\` to archive and remove.`,
          worktreePath: wt,
        });
      }
    }
  }

  // Sort anomalies: kind ASC, then path ASC for stable output.
  anomalies.sort((a, b) => {
    const kindCmp = a.kind.localeCompare(b.kind);
    return kindCmp !== 0 ? kindCmp : a.path.localeCompare(b.path);
  });

  return {
    projectRoot,
    canonicalWorktreesRoot,
    anomalies,
    count: anomalies.length,
  };
}
