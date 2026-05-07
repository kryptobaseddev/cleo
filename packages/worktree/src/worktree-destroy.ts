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
import { runWorktreeHooks } from './worktree-hooks.js';

/**
 * Destroy the git worktree for a task.
 *
 * Steps:
 * 1. Check for uncommitted changes (dirty detection).
 * 2. Run pre-remove hooks.
 * 3. Unlock the worktree (`git worktree unlock`).
 * 4. Remove the worktree directory (`git worktree remove --force`).
 * 5. Optionally delete the task branch.
 * 6. Run post-destroy hooks.
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
export async function destroyWorktree(
  projectRoot: string,
  options: DestroyWorktreeOptions,
): Promise<DestroyWorktreeResult> {
  const { taskId, deleteBranch = true, force = false, hooks = [] } = options;

  const gitRoot = getGitRoot(projectRoot);
  const projectHash = computeProjectHash(projectRoot);
  const worktreePath = resolveTaskWorktreePath(projectHash, taskId);
  const branch = `task/${taskId}`;

  let worktreeRemoved = false;
  let branchDeleted = false;
  let error: string | undefined;
  const hookResults: Awaited<ReturnType<typeof runWorktreeHooks>> = [];

  // Step 1: Dirty detection.
  let dirty = false;
  if (existsSync(worktreePath)) {
    try {
      const status = gitSync(['status', '--porcelain'], worktreePath);
      dirty = status.length > 0;
    } catch {
      // If git status fails, assume not dirty to avoid blocking cleanup.
      dirty = false;
    }
  }

  if (dirty && !force) {
    return {
      taskId,
      worktreeRemoved: false,
      branchDeleted: false,
      error: 'Worktree has uncommitted changes - destroy aborted',
      dirty,
      force,
      hookResults,
    };
  }

  // Step 2: Run pre-remove hooks.
  if (hooks.length > 0 && existsSync(worktreePath)) {
    try {
      const preRemoveResults = await runWorktreeHooks(hooks, 'pre-remove', worktreePath);
      hookResults.push(...preRemoveResults);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        taskId,
        worktreeRemoved: false,
        branchDeleted: false,
        error: `Pre-remove hook failed: ${message}`,
        dirty,
        force,
        hookResults,
      };
    }
  }

  // Step 3: Unlock + remove the worktree.
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

  // Step 4: Optionally delete the branch.
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

  // Step 5: Run post-destroy hooks (in git root since worktree is gone).
  if (hooks.length > 0) {
    try {
      const postDestroyResults = await runWorktreeHooks(hooks, 'post-destroy', gitRoot);
      hookResults.push(...postDestroyResults);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!error) {
        error = `Post-destroy hook failed: ${message}`;
      }
    }
  }

  return { taskId, worktreeRemoved, branchDeleted, error, dirty, force, hookResults };
}
