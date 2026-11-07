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

import { existsSync } from 'node:fs';
import type { DestroyWorktreeOptions, DestroyWorktreeResult } from '@cleocode/contracts';
import { countUnmergedCommits, getGitRoot, gitSilent, gitSync } from './git.js';
import { computeProjectHash, resolveTaskWorktreePath } from './paths.js';
import { appendWorktreeAuditLog, removeWorktreeFromSentinelIndex } from './worktree-audit.js';
import { disposeWorktree } from './worktree-dispose.js';
import { runWorktreeHooks } from './worktree-hooks.js';
import { locateTaskWorktree } from './worktree-locate.js';
import { releaseWorktreeTaskLock } from './worktree-lock.js';

/**
 * Destroy the git worktree for a task.
 *
 * Steps:
 * 1. Ask {@link disposeWorktree} (T13924) whether the worktree may go: kept
 *    unless nothing in it is lost; `force` archives the unpreserved work first.
 * 2. Run pre-remove hooks.
 * 3. Dispose of it (re-proved right before removal).
 * 4. Optionally delete the task branch.
 * 5. Run post-destroy hooks.
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

  // Step 1: the one disposal engine decides first (T13924). Without proof that
  // nothing in the worktree is lost it is kept; `force` archives the
  // unpreserved work (ref + patch + receipt) first. The dependents/evidence
  // guard always holds. The pre-remove hooks run only once removal is decided.
  const reason = options.reason ?? 'manual';
  const dispose = (probe: boolean) =>
    disposeWorktree({
      worktreePath,
      gitRoot,
      projectRoot,
      taskId,
      reason,
      evidence: options.evidence,
      force,
      probe,
    });
  const refuse = (disposal: ReturnType<typeof disposeWorktree>): DestroyWorktreeResult => {
    const message = disposal.kept
      ? (disposal.keptReason ?? '')
      : `Worktree kept: ${disposal.keptReason ?? 'not proven preserved'}. Commit and push it, or pass --force to archive it and remove it.`;
    appendWorktreeAuditLog(projectRoot, {
      action: 'destroy',
      xdgPath: worktreePath,
      taskId,
      branch,
      reason,
      success: false,
      error: message,
    });
    return {
      taskId,
      worktreeRemoved: false,
      branchDeleted: false,
      error: message,
      dirty: disposal.unpreserved !== undefined,
      force,
      hookResults,
      ...(disposal.kept ? { kept: disposal.kept } : {}),
      ...(disposal.archive ? { archive: disposal.archive } : {}),
    };
  };
  let dirty = false;
  let archive: DestroyWorktreeResult['archive'];
  if (existsSync(worktreePath)) {
    const plan = dispose(true);
    if (plan.keptReason !== undefined) return refuse(plan);
    dirty = plan.unpreserved !== undefined;

    // Step 2: Run pre-remove hooks.
    if (hooks.length > 0) {
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

    // Step 3: dispose for real; the engine re-proves right before removing.
    const disposal = dispose(false);
    if (!disposal.removed) return refuse(disposal);
    archive = disposal.archive;
    worktreeRemoved = true;
  } else if (located !== null) {
    // Registered with git but absent from disk — a stale registration. Pruning
    // it IS the removal; without this the entry lingers forever.
    gitSilent(['worktree', 'prune'], gitRoot);
    worktreeRemoved = true;
    releaseWorktreeTaskLock(projectHash, taskId);
  } else {
    worktreeRemoved = true; // genuinely absent: not on disk, not registered
    releaseWorktreeTaskLock(projectHash, taskId);
  }

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

  return {
    taskId,
    worktreeRemoved,
    branchDeleted,
    error,
    dirty,
    force,
    hookResults,
    ...(archive ? { archive } : {}),
  };
}
