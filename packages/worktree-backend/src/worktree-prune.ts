/**
 * Worktree prune operation for @cleocode/worktree-backend.
 *
 * Removes orphaned worktrees: worktree directories whose task ID is NOT in
 * the provided `preserveTaskIds` set, and optionally runs `git worktree prune`
 * to clean up stale git administrative entries.
 *
 * Called periodically by `cleo sentient tick` via `worktree-dispatch.ts`.
 *
 * @task T1161
 */

import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { PruneWorktreesOptions, PruneWorktreesResult } from '@cleocode/contracts';
import { getGitRoot, gitSilent } from './git.js';
import { computeProjectHash, resolveWorktreeRootForHash } from './paths.js';

/**
 * Prune orphaned agent worktrees for a project.
 *
 * Algorithm:
 * 1. Optionally run `git worktree prune` to clean up stale git admin entries.
 * 2. Read all subdirectory entries under the project's worktree root.
 * 3. For each entry NOT in `preserveTaskIds`, unlock and remove the worktree.
 *
 * @param options - Prune options with project root and optional preserve list.
 * @returns Result listing removed paths and any errors.
 *
 * @task T1161
 */
export function pruneWorktrees(options: PruneWorktreesOptions): PruneWorktreesResult {
  const { projectRoot, preserveTaskIds, gitPrune = true } = options;

  const projectHash = computeProjectHash(projectRoot);
  const worktreeRoot = resolveWorktreeRootForHash(projectHash);
  const removed: string[] = [];
  const errors: Array<{ path: string; reason: string }> = [];
  let gitPruneRan = false;

  // Step 1: Run git worktree prune if requested.
  if (gitPrune) {
    try {
      const gitRoot = getGitRoot(projectRoot);
      gitSilent(['worktree', 'prune'], gitRoot);
      gitPruneRan = true;
    } catch {
      // Non-fatal: project root may not be a git repo in some edge cases.
      gitPruneRan = false;
    }
  }

  // Step 2: Remove orphaned worktree directories.
  if (preserveTaskIds !== undefined && existsSync(worktreeRoot)) {
    let entries: string[];
    try {
      entries = readdirSync(worktreeRoot);
    } catch {
      return { removed: 0, removedPaths: [], errors, gitPruneRan };
    }

    let gitRoot: string;
    try {
      gitRoot = getGitRoot(projectRoot);
    } catch {
      // If there's no git root, we can still remove dirs — just skip git cmds.
      gitRoot = projectRoot;
    }

    for (const entry of entries) {
      if (preserveTaskIds.has(entry)) continue;

      const worktreePath = join(worktreeRoot, entry);

      // Try git-aware removal first.
      gitSilent(['worktree', 'unlock', worktreePath], gitRoot);
      if (gitSilent(['worktree', 'remove', '--force', worktreePath], gitRoot)) {
        removed.push(worktreePath);
      } else {
        // Fall back to rmSync for directories that aren't registered worktrees.
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

  return { removed: removed.length, removedPaths: removed, errors, gitPruneRan };
}
