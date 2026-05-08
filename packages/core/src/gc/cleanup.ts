/**
 * CLEO orphan cleanup utilities — worktrees and temp directories.
 *
 * Provides two independent cleanup operations:
 *
 * 1. `pruneOrphanWorktrees` — removes worktree directories under
 *    `~/.local/share/cleo/worktrees/<projectHash>/` whose task IDs
 *    are not in the active-task set.
 *
 * 2. `pruneOrphanTempDirs` — removes CLEO-generated temp directories
 *    under `os.tmpdir()` that match any known CLEO prefix and are
 *    older than a configurable age threshold (default: 2 hours).
 *
 * Both operations are safe by design:
 * - Only remove paths that match CLEO-specific patterns.
 * - Never throw — failures are returned in the result's `errors` array.
 * - `dryRun: true` returns what would be removed without deleting.
 *
 * Consumed by:
 * - `cleo gc --worktrees` / `cleo gc --temp` (Group D)
 * - `cleo doctor` orphan audit (Group C)
 *
 * @task T9043
 */

import type { Dirent } from 'node:fs';
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Shared CLEO temp-dir prefix registry
//
// This is the single canonical list used by:
//   - packages/core/src/__tests__/setup-global.ts (global Vitest sweeper)
//   - pruneOrphanTempDirs() (runtime GC)
//   - auditOrphanTempDirs() (cleo doctor)
//
// When a new prefix is introduced anywhere in the monorepo, add it here.
// ---------------------------------------------------------------------------

/**
 * All CLEO-generated temp directory prefixes that may accumulate in os.tmpdir().
 *
 * Compiled from a monorepo-wide audit of `mkdtemp`/`mkdtempSync` usages.
 *
 * @task T9043
 */
export const CLEO_TEMP_PREFIXES: readonly string[] = [
  // Production (non-test) prefixes
  'cleo-injection-chain-', // T1914 injection chain setup
  'cleo-unpack-', // packages/core/src/store/backup-unpack.ts
  'cleo-pack-', // packages/core/src/store/backup-pack.ts
  // Test-time prefixes (can accumulate when tests crash)
  'cleo-init-e2e-',
  'cleo-merge-ks-',
  'cleo-test-',
  'cleo-get-transcript-',
  'cleo-claude-install-',
  'cleo-claude-project-',
  'cleo-cursor-install-',
  'cleo-opencode-install-',
  'cleo-w9-',
  'cleo-worktree-test-',
  'cleo-os-explicit-root-',
  'cleo-os-init-root-',
  'cleo-os-caller-root-',
  'cleo-os-doctor-root-',
  'cleo-os-doctor-nested-',
  'cleo-lifecycle-',
  'cleo-w2-6-fix-',
  'cleo-brain-export-',
  'cleo-inspect-test-',
  'cleo-doctor-projects-',
  'cleo-t1858-',
  'cleo-migrate-av2-',
  'cleo-walk-',
  'cleo-gitignore-test-',
  'cleo-t365-',
  'cleo-docs-integration-',
  'cleo-playbook-fixture-',
  'cleo-audit-prune-',
  'cleo-seed-global-',
  'cleo-symlink-test-',
  'cleo-config-test-',
] as const;

/**
 * Default maximum age (in milliseconds) for orphaned CLEO temp directories.
 *
 * Directories older than this threshold are eligible for pruning.
 * Default: 2 hours. Suitable for both CI and interactive dev sessions.
 *
 * @task T9043
 */
export const DEFAULT_TEMP_MAX_AGE_MS = 2 * 60 * 60 * 1000; // 2 hours

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Result of an orphan cleanup operation.
 *
 * @task T9043
 */
export interface CleanupResult {
  /** Number of entries removed (or that would be removed in dry-run). */
  removed: number;
  /** Absolute paths that were removed (or would be removed). */
  removedPaths: string[];
  /** Entries that were skipped (dry-run). */
  skipped: number;
  /** Errors encountered during removal (non-fatal). */
  errors: Array<{ path: string; reason: string }>;
  /** Whether this was a dry run. */
  dryRun: boolean;
}

/**
 * Options for `pruneOrphanWorktrees`.
 *
 * @task T9043
 */
export interface PruneOrphanWorktreesOptions {
  /**
   * Root directory containing per-project-hash worktree subdirs.
   * Typically `~/.local/share/cleo/worktrees/`.
   */
  worktreesRoot: string;
  /**
   * Project hash to scope to. When provided, only
   * `<worktreesRoot>/<projectHash>/` is scanned.
   * When omitted, all project hashes under `worktreesRoot` are scanned.
   */
  projectHash?: string;
  /**
   * Task IDs whose worktrees must be preserved.
   *
   * Any worktree directory whose name is NOT in this set will be removed.
   * Pass an empty set to remove all non-active worktrees.
   */
  activeTaskIds: Set<string>;
  /**
   * When true, report removals without deleting anything.
   *
   * @default false
   */
  dryRun?: boolean;
}

/**
 * Options for `pruneOrphanTempDirs`.
 *
 * @task T9043
 */
export interface PruneOrphanTempDirsOptions {
  /**
   * Maximum age of a CLEO temp directory before it is eligible for removal.
   *
   * @default DEFAULT_TEMP_MAX_AGE_MS (2 hours)
   */
  maxAgeMs?: number;
  /**
   * Override for the system temp directory (for testing).
   *
   * @default os.tmpdir()
   */
  tempDir?: string;
  /**
   * When true, report removals without deleting anything.
   *
   * @default false
   */
  dryRun?: boolean;
}

/**
 * An audited orphan entry (used by cleo doctor checks).
 *
 * @task T9043
 */
export interface OrphanEntry {
  /** Absolute path to the orphaned directory. */
  path: string;
  /** Age of the directory in milliseconds (based on mtime). */
  ageMs: number;
  /** Human-readable age (e.g. "3h 15m"). */
  ageLabel: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Format a duration in milliseconds as a human-readable label.
 *
 * @param ms - Duration in milliseconds.
 * @returns Label such as "3h 15m" or "45m" or "2d".
 */
function formatAge(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${seconds}s`;
}

// ---------------------------------------------------------------------------
// Public API — worktree pruning
// ---------------------------------------------------------------------------

/**
 * Prune orphaned agent worktree directories.
 *
 * Scans `worktreesRoot` (or `worktreesRoot/<projectHash>`) for directories
 * whose names are NOT in `activeTaskIds` and removes them. Uses `rmSync`
 * directly because the worktrees at this point are only filesystem artefacts
 * — the agent has already merged its work via `completeAgentWorktreeViaMerge`.
 * Git worktree de-registration is attempted with `git worktree prune` at the
 * level of the caller (cleo gc or cleo doctor does not need a git root here;
 * individual worktrees have their own `.git` file redirects which become stale
 * and are cleaned up by `git worktree prune` in the primary repo).
 *
 * @param options - See `PruneOrphanWorktreesOptions`.
 * @returns Cleanup result.
 *
 * @task T9043
 */
export function pruneOrphanWorktrees(options: PruneOrphanWorktreesOptions): CleanupResult {
  const { worktreesRoot, projectHash, activeTaskIds, dryRun = false } = options;

  const removed: string[] = [];
  const errors: Array<{ path: string; reason: string }> = [];
  let skipped = 0;

  if (!existsSync(worktreesRoot)) {
    return { removed: 0, removedPaths: [], skipped, errors, dryRun };
  }

  // Determine which per-project directories to scan.
  let projectDirs: string[];
  if (projectHash) {
    const singleDir = join(worktreesRoot, projectHash);
    projectDirs = existsSync(singleDir) ? [singleDir] : [];
  } else {
    let entries: string[];
    try {
      entries = readdirSync(worktreesRoot);
    } catch {
      return { removed: 0, removedPaths: [], skipped, errors, dryRun };
    }
    projectDirs = entries
      .map((e) => join(worktreesRoot, e))
      .filter((p) => {
        try {
          return statSync(p).isDirectory();
        } catch {
          return false;
        }
      });
  }

  for (const projectDir of projectDirs) {
    let taskEntries: string[];
    try {
      taskEntries = readdirSync(projectDir);
    } catch {
      continue;
    }

    for (const taskId of taskEntries) {
      if (activeTaskIds.has(taskId)) {
        skipped++;
        continue;
      }

      const worktreePath = join(projectDir, taskId);
      try {
        if (!statSync(worktreePath).isDirectory()) {
          skipped++;
          continue;
        }
      } catch {
        skipped++;
        continue;
      }

      if (dryRun) {
        removed.push(worktreePath);
      } else {
        try {
          rmSync(worktreePath, { recursive: true, force: true });
          removed.push(worktreePath);
        } catch (err) {
          errors.push({
            path: worktreePath,
            reason: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  }

  return { removed: removed.length, removedPaths: removed, skipped, errors, dryRun };
}

// ---------------------------------------------------------------------------
// Public API — temp dir pruning
// ---------------------------------------------------------------------------

/**
 * Prune orphaned CLEO-generated temp directories.
 *
 * Scans `os.tmpdir()` for directories whose names start with any prefix in
 * `CLEO_TEMP_PREFIXES` and whose mtime is older than `maxAgeMs`. This is
 * safe because all CLEO temp dirs are transient; any that survive longer
 * than the threshold were left by crashed or aborted processes.
 *
 * @param options - See `PruneOrphanTempDirsOptions`.
 * @returns Cleanup result.
 *
 * @task T9043
 */
export function pruneOrphanTempDirs(options: PruneOrphanTempDirsOptions = {}): CleanupResult {
  const { maxAgeMs = DEFAULT_TEMP_MAX_AGE_MS, tempDir = tmpdir(), dryRun = false } = options;

  const removed: string[] = [];
  const errors: Array<{ path: string; reason: string }> = [];
  let skipped = 0;
  const now = Date.now();

  let entries: Dirent<string>[];
  try {
    entries = readdirSync(tempDir, { withFileTypes: true }) as Dirent<string>[];
  } catch {
    return { removed: 0, removedPaths: [], skipped, errors, dryRun };
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const matchesPrefix = CLEO_TEMP_PREFIXES.some((prefix) => entry.name.startsWith(prefix));
    if (!matchesPrefix) continue;

    const fullPath = join(tempDir, entry.name);

    // Age check — skip dirs that are too young to be orphaned.
    let ageMs: number;
    try {
      const st = statSync(fullPath);
      ageMs = now - st.mtimeMs;
    } catch {
      skipped++;
      continue;
    }

    if (ageMs < maxAgeMs) {
      skipped++;
      continue;
    }

    if (dryRun) {
      removed.push(fullPath);
    } else {
      try {
        rmSync(fullPath, { recursive: true, force: true });
        removed.push(fullPath);
      } catch (err) {
        errors.push({
          path: fullPath,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return { removed: removed.length, removedPaths: removed, skipped, errors, dryRun };
}

// ---------------------------------------------------------------------------
// Public API — audit (read-only, for cleo doctor)
// ---------------------------------------------------------------------------

/**
 * List orphaned CLEO-generated temp directories without removing them.
 *
 * Used by `auditOrphanTempDirs` doctor check. Returns entries whose age
 * exceeds the threshold, sorted oldest-first.
 *
 * @param maxAgeMs - Age threshold in milliseconds (default: 2 hours).
 * @param tempDir - Override for os.tmpdir() (testing).
 * @returns Array of orphan entries sorted oldest-first.
 *
 * @task T9043
 */
export function listOrphanTempDirs(
  maxAgeMs: number = DEFAULT_TEMP_MAX_AGE_MS,
  tempDir: string = tmpdir(),
): OrphanEntry[] {
  const orphans: OrphanEntry[] = [];
  const now = Date.now();

  let entries: Dirent<string>[];
  try {
    entries = readdirSync(tempDir, { withFileTypes: true }) as Dirent<string>[];
  } catch {
    return orphans;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!CLEO_TEMP_PREFIXES.some((p) => entry.name.startsWith(p))) continue;

    const fullPath = join(tempDir, entry.name);
    try {
      const st = statSync(fullPath);
      const ageMs = now - st.mtimeMs;
      if (ageMs >= maxAgeMs) {
        orphans.push({ path: fullPath, ageMs, ageLabel: formatAge(ageMs) });
      }
    } catch {
      // skip unreadable
    }
  }

  return orphans.sort((a, b) => b.ageMs - a.ageMs);
}

/**
 * List orphaned worktree directories without removing them.
 *
 * Used by `auditOrphanWorktrees` doctor check. Returns all task-directory
 * entries not in `activeTaskIds`, sorted by path.
 *
 * @param worktreesRoot - Root of the CLEO worktrees hierarchy.
 * @param activeTaskIds - Set of currently active task IDs to exclude.
 * @param projectHash - Scope to a single project hash (optional).
 * @returns Array of orphan entries sorted by path.
 *
 * @task T9043
 */
export function listOrphanWorktrees(
  worktreesRoot: string,
  activeTaskIds: Set<string>,
  projectHash?: string,
): OrphanEntry[] {
  const orphans: OrphanEntry[] = [];
  const now = Date.now();

  if (!existsSync(worktreesRoot)) return orphans;

  let projectDirs: string[];
  if (projectHash) {
    const singleDir = join(worktreesRoot, projectHash);
    projectDirs = existsSync(singleDir) ? [singleDir] : [];
  } else {
    try {
      projectDirs = readdirSync(worktreesRoot)
        .map((e) => join(worktreesRoot, e))
        .filter((p) => {
          try {
            return statSync(p).isDirectory();
          } catch {
            return false;
          }
        });
    } catch {
      return orphans;
    }
  }

  for (const projectDir of projectDirs) {
    let taskEntries: string[];
    try {
      taskEntries = readdirSync(projectDir);
    } catch {
      continue;
    }

    for (const taskId of taskEntries) {
      if (activeTaskIds.has(taskId)) continue;

      const worktreePath = join(projectDir, taskId);
      try {
        const st = statSync(worktreePath);
        if (!st.isDirectory()) continue;
        const ageMs = now - st.mtimeMs;
        orphans.push({ path: worktreePath, ageMs, ageLabel: formatAge(ageMs) });
      } catch {
        // skip
      }
    }
  }

  return orphans.sort((a, b) => a.path.localeCompare(b.path));
}
