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
import { countUnmergedCommits, getGitRoot, gitSilent, gitSync } from './git.js';
import { destroyWorktree as napiDestroyWorktree } from './napi-binding.js';
import { computeProjectHash, resolveTaskWorktreePath } from './paths.js';
import { appendWorktreeAuditLog, removeWorktreeFromSentinelIndex } from './worktree-audit.js';
import { runWorktreeHooks } from './worktree-hooks.js';
import { locateTaskWorktree } from './worktree-locate.js';
import { releaseWorktreeTaskLock } from './worktree-lock.js';

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

  // T12086: ask git where the worktree IS and which branch it holds, instead of
  // recomputing both by convention. A worktree provisioned under an earlier
  // project-hash scheme is not at the recomputed path, and real branches carry
  // a slug (`task/T11248-cleo-exodus`, not `task/T11248`) — so both derivations
  // missed, and the function reported success for work it never did.
  const located = locateTaskWorktree(projectRoot, taskId);
  const projectHash = computeProjectHash(projectRoot);
  const worktreePath = located?.path ?? resolveTaskWorktreePath(projectHash, taskId);
  const branch = located?.branch ?? `task/${taskId}`;

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

  // Step 3: Unlock + remove the worktree (T9982 — git plumbing routed through
  // @cleocode/worktree-napi → worktrunk-core::git_wt::destroy_worktree).
  // The TS layer still owns the unlock + filesystem-rm fallback so a locked or
  // partially-removed worktree can be force-cleaned without a second napi call.
  if (existsSync(worktreePath)) {
    gitSilent(['worktree', 'unlock', worktreePath], gitRoot);
    try {
      const result = napiDestroyWorktree({
        repoRoot: gitRoot,
        worktreePath,
        force: true,
      });
      worktreeRemoved = result.removed;
      // T11033 — NAPI may report success even when untracked directories
      // (e.g. .cleo/) survive inside the worktree. Verify on-disk reality.
      if (worktreeRemoved && existsSync(worktreePath)) {
        worktreeRemoved = false; // trigger filesystem fallback below
      }
    } catch (err) {
      // napi reported failure — fall back to filesystem rm so the audit log
      // still captures the cleanup attempt.
      try {
        rmSync(worktreePath, { recursive: true, force: true });
        worktreeRemoved = true;
      } catch (err2) {
        if (!error) {
          error = `Failed to remove worktree: napi=${err instanceof Error ? err.message : String(err)}; fs=${err2 instanceof Error ? err2.message : String(err2)}`;
        }
      }
    }
    // Filesystem fallback when NAPI reported success but directory survived.
    if (!worktreeRemoved && existsSync(worktreePath)) {
      try {
        rmSync(worktreePath, { recursive: true, force: true });
        worktreeRemoved = true;
      } catch (err2) {
        if (!error) {
          error = `Failed to remove worktree directory after NAPI: ${err2 instanceof Error ? err2.message : String(err2)}`;
        }
      }
    }
  } else if (located !== null) {
    // Registered with git but absent from disk — a stale registration. Pruning
    // it IS the removal; without this the entry lingers forever.
    gitSilent(['worktree', 'prune'], gitRoot);
    worktreeRemoved = true;
  } else {
    worktreeRemoved = true; // genuinely absent: not on disk, not registered
  }

  // T12506: the worktree is gone, so its per-task lock guards nothing — free
  // it so the next spawn of this task provisions without waiting for a TTL.
  if (worktreeRemoved) releaseWorktreeTaskLock(projectHash, taskId);

  // Step 4: Optionally delete the branch.
  if (deleteBranch) {
    try {
      const branchExists = gitSync(['branch', '--list', branch], gitRoot);
      const unmerged = branchExists ? countUnmergedCommits(gitRoot, branch, ['HEAD']) : 0;
      if (branchExists && unmerged > 0 && options.forceDeleteUnmergedBranch !== true) {
        // T12506: never delete history that exists nowhere else implicitly.
        branchDeleted = false;
        if (!error) {
          error = `Branch '${branch}' kept: ${unmerged} commit(s) are on neither origin/main nor HEAD. Merge it, or pass forceDeleteUnmergedBranch to delete it anyway.`;
        }
      } else if (branchExists) {
        gitSync(['branch', '-D', branch], gitRoot);
        branchDeleted = true;
      } else {
        // T12086: previously returned `branchDeleted: true` here. Reporting a
        // deletion that did not happen is worse than reporting the miss — it is
        // how a branch survives every cleanup pass unnoticed.
        branchDeleted = false;
        if (!error) {
          error = `Branch '${branch}' not found — nothing deleted. The worktree's own HEAD is the source of truth for its branch name; a task id alone is not.`;
        }
      }
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

  const destroySucceeded = worktreeRemoved && !error;

  // T9805 AC3: Append audit log entry for every destroy attempt.
  appendWorktreeAuditLog(projectRoot, {
    action: 'destroy',
    xdgPath: worktreePath,
    taskId,
    branch,
    reason: options.reason ?? 'manual',
    success: destroySucceeded,
    ...(error !== undefined ? { error } : {}),
  });

  // T9805 D009: Remove the entry from the sentinel index when destruction succeeded.
  if (destroySucceeded) {
    removeWorktreeFromSentinelIndex(gitRoot, taskId);
  }

  return { taskId, worktreeRemoved, branchDeleted, error, dirty, force, hookResults };
}
