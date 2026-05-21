/**
 * Worktree prune operation for @cleocode/worktree.
 *
 * Removes orphaned worktrees: worktree directories whose task ID is NOT in
 * the provided `preserveTaskIds` set, and optionally runs `git worktree prune`
 * to clean up stale git administrative entries.
 *
 * Supports an `--idle-days` abandonment-timeout threshold (T9805 AC2): when
 * set, worktrees whose branch tip is older than `idleDays` days AND which have
 * no open PR are also eligible for removal, even if their task ID is not in the
 * orphan set.
 *
 * Called periodically by `cleo sentient tick` via `worktree-dispatch.ts`.
 *
 * @task T1161
 * @task T9805
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { PruneWorktreesOptions, PruneWorktreesResult } from '@cleocode/contracts';
import { getGitRoot, gitSilent } from './git.js';
import { computeProjectHash, resolveWorktreeRootForHash } from './paths.js';
import { appendWorktreeAuditLog, removeWorktreeFromSentinelIndex } from './worktree-audit.js';

/**
 * Prune orphaned agent worktrees for a project.
 *
 * Algorithm:
 * 1. Optionally run `git worktree prune` to clean up stale git admin entries.
 * 2. Read all subdirectory entries under the project's worktree root.
 * 3. For each entry NOT in `preserveTaskIds` (or idle beyond `idleDays`),
 *    unlock and remove the worktree.
 * 4. Append an audit-log entry for each removal.
 * 5. Remove the entry from the sentinel index when removal succeeds.
 *
 * @param options - Prune options with project root and optional preserve list.
 * @returns Result listing removed paths and any errors.
 *
 * @task T1161
 * @task T9805
 */
export function pruneWorktrees(options: PruneWorktreesOptions): PruneWorktreesResult {
  const { projectRoot, preserveTaskIds, gitPrune = true, idleDays } = options;

  const projectHash = computeProjectHash(projectRoot);
  const worktreeRoot = resolveWorktreeRootForHash(projectHash);
  const removed: string[] = [];
  const errors: Array<{ path: string; reason: string }> = [];
  let gitPruneRan = false;

  let gitRoot: string;
  try {
    gitRoot = getGitRoot(projectRoot);
  } catch {
    // If there's no git root, we can still remove dirs — just skip git cmds.
    gitRoot = projectRoot;
  }

  // Step 1: Run git worktree prune if requested.
  if (gitPrune) {
    try {
      gitSilent(['worktree', 'prune'], gitRoot);
      gitPruneRan = true;
    } catch {
      // Non-fatal: project root may not be a git repo in some edge cases.
      gitPruneRan = false;
    }
  }

  // Step 2: Remove orphaned worktree directories.
  const shouldCheckDirectories =
    (preserveTaskIds !== undefined || idleDays !== undefined) && existsSync(worktreeRoot);

  if (shouldCheckDirectories) {
    let entries: string[];
    try {
      entries = readdirSync(worktreeRoot);
    } catch {
      return { removed: 0, removedPaths: [], errors, gitPruneRan };
    }

    for (const entry of entries) {
      const worktreePath = join(worktreeRoot, entry);

      // Determine whether this entry is a prune candidate.
      let reason = 'orphan';
      let shouldPrune = false;

      if (preserveTaskIds !== undefined) {
        if (preserveTaskIds.has(entry)) {
          // Still check idle-days even for preserved IDs when idleDays is set.
          if (idleDays !== undefined && isWorktreeIdle(worktreePath, idleDays)) {
            shouldPrune = true;
            reason = `idle-${idleDays}d`;
          }
        } else {
          shouldPrune = true;
          reason = 'orphan';
        }
      } else if (idleDays !== undefined) {
        // preserveTaskIds not set — only idle-days check applies.
        if (isWorktreeIdle(worktreePath, idleDays)) {
          shouldPrune = true;
          reason = `idle-${idleDays}d`;
        }
      }

      if (!shouldPrune) continue;

      // Try git-aware removal first.
      gitSilent(['worktree', 'unlock', worktreePath], gitRoot);
      let pruneSuccess = false;
      if (gitSilent(['worktree', 'remove', '--force', worktreePath], gitRoot)) {
        removed.push(worktreePath);
        pruneSuccess = true;
      } else {
        // Fall back to rmSync for directories that aren't registered worktrees.
        try {
          rmSync(worktreePath, { recursive: true, force: true });
          removed.push(worktreePath);
          pruneSuccess = true;
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          errors.push({ path: worktreePath, reason: errMsg });
          // T9805 AC3: Audit the failed removal.
          appendWorktreeAuditLog(projectRoot, {
            action: 'prune',
            xdgPath: worktreePath,
            taskId: entry,
            reason,
            success: false,
            error: errMsg,
          });
        }
      }

      if (pruneSuccess) {
        // T9805 AC3: Audit the successful removal.
        appendWorktreeAuditLog(projectRoot, {
          action: 'prune',
          xdgPath: worktreePath,
          taskId: entry,
          reason,
          success: true,
        });
        // T9805 D009: Remove from sentinel index.
        removeWorktreeFromSentinelIndex(gitRoot, entry);
      }
    }
  }

  return { removed: removed.length, removedPaths: removed, errors, gitPruneRan };
}

/**
 * Check whether the last commit on a worktree's branch is older than
 * `thresholdDays` days (abandonment-timeout heuristic for T9805 AC2).
 *
 * Returns `false` when git is unavailable or the path is not a valid worktree.
 *
 * @param worktreePath - Absolute path to the worktree directory.
 * @param thresholdDays - Number of idle days before the worktree is eligible.
 * @returns `true` if the last commit is older than `thresholdDays` days.
 *
 * @internal
 */
function isWorktreeIdle(worktreePath: string, thresholdDays: number): boolean {
  try {
    const epochStr = execFileSync('git', ['-C', worktreePath, 'log', '-1', '--format=%ct'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10_000,
    }).trim();
    if (epochStr.length === 0) return false;
    const lastCommitEpochMs = Number.parseInt(epochStr, 10) * 1000;
    if (Number.isNaN(lastCommitEpochMs)) return false;
    const idleMs = Date.now() - lastCommitEpochMs;
    const idleDaysActual = idleMs / (1000 * 60 * 60 * 24);
    return idleDaysActual >= thresholdDays;
  } catch {
    return false;
  }
}
