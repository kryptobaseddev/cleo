/**
 * Worktree destroy operation for @cleocode/worktree.
 *
 * Removes the git worktree for a completed task. Optionally cherry-picks
 * commits from the task branch back to the orchestrator's current branch
 * before destroying.
 *
 * @task T1161
 */

import { existsSync, rmSync } from 'node:fs';
import type { DestroyWorktreeOptions, DestroyWorktreeResult } from '@cleocode/contracts';
import { getGitRoot, gitSilent, gitSync, resolveHeadRef } from './git.js';
import { computeProjectHash, resolveTaskWorktreePath } from './paths.js';

/**
 * Destroy the git worktree for a task.
 *
 * Steps:
 * 1. Optionally cherry-pick commits from the task branch to the base ref.
 * 2. Unlock the worktree (`git worktree unlock`).
 * 3. Remove the worktree directory (`git worktree remove --force`).
 * 4. Optionally delete the task branch.
 *
 * Non-fatal errors are captured in the result's `error` field. The caller
 * decides whether to propagate them.
 *
 * @param projectRoot - Absolute path to the project root directory.
 * @param options - Destroy options including task ID and optional cherry-pick.
 * @returns Structured result of the destroy operation.
 *
 * @task T1161
 */
export function destroyWorktree(
  projectRoot: string,
  options: DestroyWorktreeOptions,
): DestroyWorktreeResult {
  const { taskId, deleteBranch = true, cherryPickFirst = false } = options;

  const gitRoot = getGitRoot(projectRoot);
  const projectHash = computeProjectHash(projectRoot);
  const worktreePath = resolveTaskWorktreePath(projectHash, taskId);
  const branch = `task/${taskId}`;
  const baseRef = resolveHeadRef(gitRoot);

  let cherryPicked = false;
  let commitCount = 0;
  let worktreeRemoved = false;
  let branchDeleted = false;
  let error: string | undefined;

  // Step 1: Cherry-pick if requested.
  if (cherryPickFirst) {
    try {
      const branchExists = gitSync(['branch', '--list', branch], gitRoot);
      if (branchExists) {
        const log = gitSync(['log', '--reverse', '--format=%H', `${baseRef}..${branch}`], gitRoot);
        const commits = log
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean);

        if (commits.length > 0) {
          gitSync(['cherry-pick', ...commits], gitRoot);
          cherryPicked = true;
          commitCount = commits.length;
        } else {
          cherryPicked = true;
          commitCount = 0;
        }
      }
    } catch (err) {
      gitSilent(['cherry-pick', '--abort'], gitRoot);
      error = `Cherry-pick failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  // Step 2: Unlock + remove the worktree (even if cherry-pick failed — caller decided).
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

  // Step 3: Optionally delete the branch.
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

  return { taskId, cherryPicked, commitCount, worktreeRemoved, branchDeleted, error };
}
