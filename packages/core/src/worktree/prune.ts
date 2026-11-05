/**
 * SDK primitive for the `cleo worktree prune --orphaned` command (T9547).
 *
 * Exposes {@link pruneOrphanedWorktreesByStatus} — picks up the T9546
 * structured listing, filters to orphan/merged worktrees, and disposes of
 * each one through the worktree package's `disposeWorktree` engine (T13924). Every action is
 * recorded in `.cleo/audit/worktree-lifecycle.jsonl` via
 * {@link appendWorktreeAuditEntry}.
 *
 * Naming note: there is already a {@link pruneOrphanedWorktrees} export in
 * `packages/core/src/spawn/branch-lock.ts` (T1118 — preserve-set-based cleanup
 * used by spawn). The T9547 primitive intentionally uses the suffix
 * `ByStatus` so both functions can coexist; the lifecycle command surface
 * targets the status-classified listing, the spawn surface targets the
 * known-active task IDs.
 *
 * Interactive Y/N prompting is the CLI's responsibility — the SDK primitive
 * is non-interactive. Callers pass `opts.paths` to limit the prune to a
 * pre-confirmed subset; omit the field to prune every orphan/merged entry.
 *
 * @task T9547
 * @epic T9515
 */

import type {
  EngineResult,
  EvidenceAtom,
  PrunedWorktreeOutcome,
  PruneOrphanedWorktreesOpts,
  PruneOrphanedWorktreesResult,
  WorktreeInfo,
} from '@cleocode/contracts';
import { engineError, engineSuccess } from '@cleocode/contracts/engine-result.js';
import { disposeWorktree, gitSilent, readWorktreeTaskLock } from '@cleocode/worktree';
import { taskEvidenceAtoms } from '../tasks/evidence-paths.js';
import { appendWorktreeAuditEntry, resolveWorktreeAuditActor } from './audit.js';
import {
  isPrimaryWorktree,
  listWorktrees,
  resolvePrimaryWorktreePath,
  worktreeInUseProbe,
} from './list.js';

/**
 * Drive the orphan / merged worktree prune flow used by
 * `cleo worktree prune --orphaned`.
 *
 * Steps:
 *  1. Re-use {@link listWorktrees} to enumerate every worktree with full
 *     status classification (T9546). No raw porcelain re-parsing here.
 *  2. Filter to entries whose `statusCategory` is `redundant` (T14274): the
 *     disposal proof held when listed. `active`, `keep` and `unknown` rows are
 *     never touched.
 *  3. When the caller passes `opts.paths`, intersect the candidate set with
 *     it so the CLI can render per-orphan Y/N prompts and then call this
 *     primitive with the user-confirmed subset.
 *  4. For each candidate, call {@link disposeWorktree} (T13924): removed only
 *     with proof nothing in it is lost (guard, in use, content, commits);
 *     otherwise kept with the failing clause in the outcome.
 *  5. When the prune succeeded AND the branch is reachable from `main` (the
 *     T9546 `isMerged` flag), also drop the local `task/<id>` branch via
 *     `git branch -D <branch>`. We never delete unmerged branches here —
 *     callers must use `cleo orchestrate worktree-complete` first.
 *  6. Append one {@link WorktreeLifecycleAuditEntry} per attempted prune.
 *     Under `--dry-run`, no audit entry is written and no filesystem action
 *     is taken — callers see what WOULD happen via the returned `outcomes`.
 *
 * @param opts - See {@link PruneOrphanedWorktreesOpts}.
 * @returns EngineResult wrapping a {@link PruneOrphanedWorktreesResult}.
 */
export async function pruneOrphanedWorktreesByStatus(
  opts: PruneOrphanedWorktreesOpts,
): Promise<EngineResult<PruneOrphanedWorktreesResult>> {
  const dryRun = opts.dryRun === true;
  const actor = opts.actor ?? resolveWorktreeAuditActor();

  const listResult = await listWorktrees({
    projectRoot: opts.projectRoot,
    staleDays: opts.staleDays,
  });
  if (!listResult.success) {
    return engineError<PruneOrphanedWorktreesResult>(
      listResult.error.code,
      `Failed to enumerate worktrees: ${listResult.error.message}`,
      { fix: listResult.error.fix },
    );
  }

  // Candidates: only rows the classifier proved `redundant` (T14274).
  const primaryWorktreePath = resolvePrimaryWorktreePath(opts.projectRoot);
  const allCandidates = listResult.data.worktrees.filter(
    (w) => w.statusCategory === 'redundant' && !isPrimaryWorktree(w.path, primaryWorktreePath),
  );

  const allowedPaths =
    opts.paths !== undefined && opts.paths.length > 0 ? new Set(opts.paths) : null;
  const candidates =
    allowedPaths === null ? allCandidates : allCandidates.filter((w) => allowedPaths.has(w.path));

  const outcomes: PrunedWorktreeOutcome[] = [];
  const errors: Array<{ path: string; error: string }> = [];
  let prunedCount = 0;

  for (const wt of candidates) {
    const reason = reasonForStatus(wt);
    // T13924: the one disposal engine — guard, in-use, content and commit proof.
    const disposal = disposeWorktree({
      worktreePath: wt.path,
      projectRoot: opts.projectRoot,
      taskId: wt.taskId,
      reason,
      evidence: await loadTaskEvidence(opts.projectRoot, wt.taskId),
      exemptRegenerable: wt.isMerged,
      inUse: worktreeInUseProbe(readWorktreeTaskLock, opts.projectRoot, wt.taskId),
      dryRun,
    });
    if (dryRun && disposal.keptReason === undefined) {
      outcomes.push({
        path: wt.path,
        branch: wt.branch,
        taskId: wt.taskId,
        reason,
        pruned: false,
        branchDeleted: false,
      });
      continue;
    }
    if (!disposal.removed) {
      const error = disposal.kept
        ? (disposal.keptReason ?? '')
        : `Worktree ${wt.path} kept: ${disposal.unpreserved ?? disposal.keptReason ?? 'not proven preserved'}.`;
      if (disposal.failed !== undefined) errors.push({ path: wt.path, error });
      outcomes.push({
        path: wt.path,
        branch: wt.branch,
        taskId: wt.taskId,
        reason,
        pruned: false,
        branchDeleted: false,
        error,
        ...(disposal.kept ? { kept: disposal.kept } : {}),
      });
      if (!dryRun) {
        appendWorktreeAuditEntry(
          opts.projectRoot,
          // @sync-invariant none:local-only a worktree on this machine's disk, recorded in its local audit log; never replicated
          {
            actor,
            action: 'prune',
            target: wt.path,
            ...(wt.branch ? { branch: wt.branch } : {}),
            ...(wt.taskId ? { taskId: wt.taskId } : {}),
            reason: `${reason}+kept`,
            success: false,
            error,
          },
          opts.auditLogPath,
        );
      }
      continue;
    }

    prunedCount += 1;
    // Branch cleanup — only a branch whose tip is reachable from main.
    const branchDeleted =
      wt.isMerged && wt.branch !== null && wt.branch !== 'HEAD'
        ? gitSilent(['branch', '-D', wt.branch], opts.projectRoot)
        : false;
    outcomes.push({
      path: wt.path,
      branch: wt.branch,
      taskId: wt.taskId,
      reason,
      pruned: true,
      branchDeleted,
    });
    appendWorktreeAuditEntry(
      opts.projectRoot,
      {
        actor,
        action: 'prune',
        target: wt.path,
        ...(wt.branch ? { branch: wt.branch } : {}),
        ...(wt.taskId ? { taskId: wt.taskId } : {}),
        reason,
        success: true,
      },
      opts.auditLogPath,
    );
  }

  const skippedCount = outcomes.filter((o) => !o.pruned).length;

  return engineSuccess<PruneOrphanedWorktreesResult>({
    prunedCount,
    skippedCount,
    outcomes,
    errors,
    dryRun,
  });
}

// ---------------------------------------------------------------------------
// Internal helpers — exported for tests only.
// ---------------------------------------------------------------------------

/**
 * The owning task's recorded evidence, or `[]` when there is no task or the store is unreadable.
 *
 * @param projectRoot - Project root whose task store is read.
 * @param taskId - Owning task, or `null`.
 * @returns The task's evidence atoms.
 */
export async function loadTaskEvidence(
  projectRoot: string,
  taskId: string | null,
): Promise<EvidenceAtom[]> {
  if (taskId === null) return [];
  try {
    const { getTaskAccessor } = await import('../store/data-accessor.js');
    const task = await (await getTaskAccessor(projectRoot)).loadSingleTask(taskId);
    return task ? taskEvidenceAtoms(task) : [];
  } catch {
    // Without the store the marker and dependents scan still guard the disposal.
    return [];
  }
}

/**
 * The audit and outcome reason for pruning a `redundant` worktree (T14274):
 * `redundant-done`, `redundant-cancelled`, or `redundant-taskless` (no stored
 * task, idle past the stale window). Any other category maps to itself.
 */
export function reasonForStatus(wt: WorktreeInfo): string {
  if (wt.statusCategory !== 'redundant') return wt.statusCategory;
  return wt.owningTaskStatus === 'done' || wt.owningTaskStatus === 'cancelled'
    ? `redundant-${wt.owningTaskStatus}`
    : 'redundant-taskless';
}
