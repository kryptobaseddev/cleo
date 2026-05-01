/**
 * Worktree destroy operation for @cleocode/worktree.
 *
 * Removes the git worktree for a completed task. Integration (merge) is
 * performed separately via `completeAgentWorktreeViaMerge` (ADR-062) before
 * calling destroy. Destroy only removes the worktree filesystem entry and
 * optionally the task branch.
 *
 * @task T1161
 * @adr ADR-062
 */

import { existsSync, rmSync } from 'node:fs';
import type { DestroyWorktreeOptions, DestroyWorktreeResult } from '@cleocode/contracts';
import { getGitRoot, gitSilent, gitSync } from './git.js';
import { computeProjectHash, resolveTaskWorktreePath } from './paths.js';

/**
 * Destroy the git worktree for a task.
 *
 * Steps:
 * 1. Unlock the worktree (`git worktree unlock`).
 * 2. Remove the worktree directory (`git worktree remove --force`).
 * 3. Optionally delete the task branch.
 *
 * Integration (merging commits back to the target branch) is performed by
 * `completeAgentWorktreeViaMerge` before this function is called. Non-fatal
 * errors are captured in the result's `error` field. The caller decides
 * whether to propagate them.
 *
 * @param projectRoot - Absolute path to the project root directory.
 * @param options - Destroy options including task ID and optional branch deletion.
 * @returns Structured result of the destroy operation.
 *
 * @task T1161
 * @adr ADR-062
 */
export function destroyWorktree(
  projectRoot: string,
  options: DestroyWorktreeOptions,
): DestroyWorktreeResult {
  const { taskId, deleteBranch = true } = options;

  const gitRoot = getGitRoot(projectRoot);
  const projectHash = computeProjectHash(projectRoot);
  const worktreePath = resolveTaskWorktreePath(projectHash, taskId);
  const branch = `task/${taskId}`;

  let worktreeRemoved = false;
  let branchDeleted = false;
  let error: string | undefined;

  // Step 1: Unlock + remove the worktree.
  if (existsSync(worktreePath)) {
    gitSilent(['worktree', 'unlock', worktreePath], gitRoot);
    if (gitSilent(['worktree', 'remove', '--force', worktreePath], gitRoot)) {
      worktreeRemoved = true;
    } else {
      try {
        rmSync(worktreePath, { recursive: true, force: true });
        worktreeRemoved = true;
      } catch (err2) {
        if (!error) {
          error = `Failed to remove worktree: ${err2 instanceof Error ? err2.message : String(err2)}`;
        }
      }
    }
  } else {
    worktreeRemoved = true; // already gone
  }

  // Step 2: Optionally delete the branch.
  if (deleteBranch) {
    try {
      const branchExists = gitSync(['branch', '--list', branch], gitRoot);
      if (branchExists) {
        gitSync(['branch', '-D', branch], gitRoot);
      }
      branchDeleted = true;
    } catch (err) {
      if (!error) {
        error = `Failed to delete branch: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
  } else {
    branchDeleted = false;
  }

  return { taskId, worktreeRemoved, branchDeleted, error };
}
