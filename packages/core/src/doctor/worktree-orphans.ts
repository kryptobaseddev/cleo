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
 * @epic T9790
 */

import { spawn } from 'node:child_process';
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
import type { OrphanEntry, PruneAuditEntry, PruneResult } from '@cleocode/contracts';

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
 * Options for {@link scanWorktreeOrphans}.
 */
export interface ScanOptions {
  /**
   * Override the scan root. Defaults to `<projectRoot>/.claude/worktrees/`.
   * Mainly for tests.
   */
  worktreesRoot?: string;
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
 * Validate that `target` resolves to a descendant of `boundary`. Returns
 * the resolved real path on success, or `null` if the target escapes the
 * boundary (or does not exist).
 *
 * Uses `realpathSync` on `boundary` so a configured root with symlinks
 * still compares correctly. For `target`, we resolve via `realpathSync`
 * when it exists; otherwise we fall back to `resolve()` (the caller will
 * fail on the subsequent `rm`).
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

  let canonicalTarget: string;
  try {
    canonicalTarget = realpathSync(target);
  } catch {
    canonicalTarget = resolve(target);
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
