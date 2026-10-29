/**
 * SDK primitive for the `cleo worktree prune --orphaned` command (T9547).
 *
 * Exposes {@link pruneOrphanedWorktreesByStatus} — picks up the T9546
 * structured listing, filters to orphan/merged worktrees, and removes each
 * one via the NAPI destroyWorktree binding (T11123). Every action is
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

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import type {
  EngineResult,
  EvidenceAtom,
  PrunedWorktreeOutcome,
  PruneOrphanedWorktreesOpts,
  PruneOrphanedWorktreesResult,
  WorktreeInfo,
} from '@cleocode/contracts';
import { engineError, engineSuccess } from '@cleocode/contracts/engine-result.js';
import {
  describeDisposalBlockers,
  gitSilent,
  guardWorktreeDisposal,
  napiDestroyWorktree,
  pruneWorktreeRegistry,
} from '@cleocode/worktree';
import { taskEvidenceAtoms } from '../tasks/evidence-paths.js';
import { appendWorktreeAuditEntry, resolveWorktreeAuditActor } from './audit.js';
import { isPrimaryWorktree, listWorktrees, resolvePrimaryWorktreePath } from './list.js';

/**
 * Drive the orphan / merged worktree prune flow used by
 * `cleo worktree prune --orphaned`.
 *
 * Steps:
 *  1. Re-use {@link listWorktrees} to enumerate every worktree with full
 *     status classification (T9546). No raw porcelain re-parsing here.
 *  2. Filter to entries whose `statusCategory` is `orphan` or `merged`. The
 *     lifecycle command intentionally excludes `stale` and `locked` — those
 *     are handled by future T9515 follow-ups (T9548 auto-invoke, force-unlock).
 *  3. When the caller passes `opts.paths`, intersect the candidate set with
 *     it so the CLI can render per-orphan Y/N prompts and then call this
 *     primitive with the user-confirmed subset.
 *  4. For each candidate, invoke the NAPI destroyWorktree binding (T11123) for
 *     atomic unlock+force-remove via Rust worktrunk-core. On failure, falls
 *     back to the facade's pruneWorktreeRegistry for administrative cleanup.
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

  // Candidates: any worktree the T9546 classifier labelled `orphan` or `merged`.
  const primaryWorktreePath = resolvePrimaryWorktreePath(opts.projectRoot);
  const allCandidates = listResult.data.worktrees.filter(
    (w) =>
      (w.statusCategory === 'orphan' || w.statusCategory === 'merged') &&
      !isPrimaryWorktree(w.path, primaryWorktreePath),
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

    // T14142: removal is forced, so uncommitted or untracked edits would be lost.
    if (!checkoutIsClean(wt.path)) {
      const error = `Worktree ${wt.path} kept: uncommitted or untracked changes.`;
      outcomes.push({
        path: wt.path,
        branch: wt.branch,
        taskId: wt.taskId,
        reason,
        pruned: false,
        branchDeleted: false,
        error,
      });
      continue;
    }

    // T13700: the same guard as complete/cancel — dependents, evidence and the keep marker.
    const kept = guardWorktreeDisposal(wt.path, {
      taskId: wt.taskId,
      reason,
      projectRoot: opts.projectRoot,
      evidence: await loadTaskEvidence(opts.projectRoot, wt.taskId),
      dryRun,
    });
    if (kept !== null) {
      const error = describeDisposalBlockers(wt.path, kept);
      outcomes.push({
        path: wt.path,
        branch: wt.branch,
        taskId: wt.taskId,
        reason,
        pruned: false,
        branchDeleted: false,
        error,
        kept,
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

    if (dryRun) {
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

    const removalResult = removeWorktreeFromDisk(wt, opts.projectRoot);

    if (removalResult.success) {
      prunedCount += 1;
      outcomes.push({
        path: wt.path,
        branch: wt.branch,
        taskId: wt.taskId,
        reason,
        pruned: true,
        branchDeleted: removalResult.branchDeleted,
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
    } else {
      errors.push({ path: wt.path, error: removalResult.error });
      outcomes.push({
        path: wt.path,
        branch: wt.branch,
        taskId: wt.taskId,
        reason,
        pruned: false,
        branchDeleted: false,
        error: removalResult.error,
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
          success: false,
          error: removalResult.error,
        },
        opts.auditLogPath,
      );
    }
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
 * Whether a checkout has no uncommitted or untracked change. Fail-closed:
 * a git error reads as not clean, so a prune never force-removes edits.
 *
 * @param path - Checkout root.
 * @returns True only when `git status --porcelain -uall` printed nothing.
 * @task T14142
 */
export function checkoutIsClean(path: string): boolean {
  try {
    const out = execFileSync('git', ['-C', path, 'status', '--porcelain', '-uall'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
    });
    return out.trim() === '';
  } catch {
    return false;
  }
}

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
 * Map a {@link WorktreeInfo} entry's `statusCategory` to a short human-readable
 * reason string used in audit logs + envelope outcomes.
 */
export function reasonForStatus(wt: WorktreeInfo): string {
  switch (wt.statusCategory) {
    case 'orphan':
      if (wt.owningTaskStatus === 'cancelled') return 'orphan-cancelled';
      if (wt.taskId !== null && wt.owningTaskStatus === null) return 'orphan-missing-task';
      return 'orphan';
    case 'merged':
      return 'orphaned-merged';
    case 'stale':
      return 'stale';
    case 'locked':
      return 'locked';
    case 'active':
      return 'active';
    default:
      return wt.statusCategory;
  }
}

/**
 * Remove a single worktree from disk + clean up its branch when safe.
 *
 * T11123: Uses the NAPI destroyWorktree binding (Rust worktrunk-core) for
 * atomic unlock+force-remove, retiring the raw git worktree remove/unlock
 * shell-outs. The NAPI binding handles both unlock and directory removal
 * atomically.
 *
 * Steps:
 *  1. Invoke `napiDestroyWorktree({ repoRoot, worktreePath, force: true })`
 *     — atomic unlock + force-remove via Rust worktrunk-core.
 *  2. Fallback to the facade's pruneWorktreeRegistry if NAPI fails (administrative
 *     cleanup for stale entries).
 *  3. When the worktree was `isMerged`, delete the local `task/<id>` branch
 *     with `git branch -D <branch>` — safe because the branch tip is
 *     already reachable from `main`.
 *
 * Never throws — failures are reported in the returned object.
 */
export function removeWorktreeFromDisk(
  wt: Pick<WorktreeInfo, 'path' | 'branch' | 'isMerged'>,
  projectRoot: string,
): { success: true; branchDeleted: boolean } | { success: false; error: string } {
  // T11123: NAPI destroyWorktree handles unlock+force-remove atomically.
  let removed = false;
  try {
    const result = napiDestroyWorktree({
      repoRoot: projectRoot,
      worktreePath: wt.path,
      force: true,
    });
    removed = result.removed;
    // T11033 — NAPI may report success even when untracked directories
    // survive inside the worktree. Verify on-disk reality.
    if (removed && existsSync(wt.path)) {
      removed = false;
    }
  } catch {
    // NAPI failed — fall back to git admin cleanup.
  }

  if (!removed) {
    // Best-effort administrative cleanup for stale git worktree entries.
    pruneWorktreeRegistry(projectRoot);
    if (existsSync(wt.path)) {
      return {
        success: false,
        error: `Failed to remove worktree directory: ${wt.path}`,
      };
    }
    // Directory already gone (race or prior cleanup) — treat as success.
  }

  // Branch cleanup — only safe to delete merged branches.
  let branchDeleted = false;
  if (wt.isMerged && wt.branch && wt.branch !== 'HEAD') {
    if (gitSilent(['branch', '-D', wt.branch], projectRoot)) {
      branchDeleted = true;
    }
  }

  return { success: true, branchDeleted };
}
