/**
 * Worktree completion SDK — auto-invoke `worktree-complete` post-success (T9548).
 *
 * Exposes {@link completeWorktreeForTask}, the high-level SDK entry point used
 * by {@link orchestrateSpawnExecute} to integrate a worker's worktree back to
 * the project default branch after a successful spawn returns. Also used by
 * the `cleo orchestrate worktree-complete <taskId>` CLI command.
 *
 * Idempotent semantics:
 *
 *  - Re-invoking on a completed worktree is a **no-op**. The function inspects
 *    `.cleo/audit/worktree-lifecycle.jsonl` for the most-recent `complete`
 *    entry for the task; if found, a `complete-skip` audit row is appended
 *    and an explanatory envelope is returned.
 *  - Branch / worktree absence is also treated as already-complete (cleanup
 *    already happened or the worker did not produce any commits).
 *
 * Merge-conflict semantics (ADR-062):
 *
 *  - On merge / rebase failure, the worktree is **preserved** (NOT pruned).
 *    The function returns an error envelope describing the recovery path,
 *    and writes a `complete-conflict` audit row. Operators resolve manually
 *    by entering the worktree, fixing conflicts, then re-running with
 *    `--resolve manual` to mark the worktree as handled.
 *
 * Manual resolve mode:
 *
 *  - `opts.resolve === 'manual'` skips the merge attempt entirely. The
 *    function writes a `complete-manual` audit row and returns success.
 *    Use this AFTER you have manually merged / cherry-picked the worktree
 *    contents back to the target branch.
 *
 * All git operations follow ADR-062: `git merge --no-ff` is the only
 * canonical integration strategy. Cherry-pick is forbidden — it destroys
 * commit SHAs and breaks `git log --grep "<taskId>"` traceability.
 *
 * @task T9548
 * @epic T9515 — worktree-lifecycle bug-fix epic (4 of 5)
 * @adr ADR-062
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WorktreeIntegrationResult } from '../spawn/branch-lock.js';
import {
  completeAgentWorktreeIntegration,
  resolveAgentWorktreeRoot,
} from '../spawn/branch-lock.js';
import {
  appendWorktreeAuditEntry,
  resolveWorktreeAuditActor,
  WORKTREE_LIFECYCLE_AUDIT_FILE,
} from '../worktree/audit.js';

// ---------------------------------------------------------------------------
// Public API surface
// ---------------------------------------------------------------------------

/**
 * Conflict-recovery strategy passed to {@link completeWorktreeForTask}.
 *
 * - `'auto'` (default) — attempt the canonical `git merge --no-ff` flow. On
 *   conflict the worktree is preserved and an error envelope is returned.
 * - `'manual'` — skip the merge attempt entirely. The caller asserts they
 *   have already resolved the integration manually. A `complete-manual`
 *   audit row is written and the function returns success.
 *
 * @task T9548
 */
export type WorktreeCompleteResolveMode = 'auto' | 'manual';

/**
 * Options for {@link completeWorktreeForTask}.
 *
 * Mirrors the {@link completeAgentWorktreeIntegration} options surface plus
 * the T9548-specific `resolve` + audit-path overrides.
 *
 * @task T9548
 */
export interface CompleteWorktreeForTaskOpts {
  /** Override the resolved default branch (test fixtures + integration calls). */
  targetBranch?: string;
  /** Task title to embed in the merge commit subject. */
  taskTitle?: string;
  /** Skip the `git fetch origin` step (test fixtures, offline runs). */
  skipFetch?: boolean;
  /** Conflict-recovery strategy. Default `'auto'`. */
  resolve?: WorktreeCompleteResolveMode;
  /**
   * Override the `worktree-integration.jsonl` path (testing). When omitted
   * `.cleo/audit/worktree-integration.jsonl` under `projectRoot` is used.
   */
  integrationAuditPath?: string;
  /**
   * Override the `worktree-lifecycle.jsonl` path (testing). When omitted
   * `.cleo/audit/worktree-lifecycle.jsonl` under `projectRoot` is used.
   */
  lifecycleAuditPath?: string;
}

/**
 * Envelope returned by {@link completeWorktreeForTask}.
 *
 * Mirrors the {@link WorktreeIntegrationResult} fields plus a discriminating
 * `outcome` tag and a `recovery` block surfaced when a merge conflict
 * preserved the worktree.
 *
 * @task T9548
 */
export interface CompleteWorktreeForTaskResult {
  /** Task ID the call targeted. */
  taskId: string;
  /**
   * What happened:
   *
   *  - `merged` — auto-merge succeeded; worktree pruned.
   *  - `noop`   — idempotent skip (worktree was already integrated, or no
   *               commits to merge).
   *  - `manual` — `resolve: 'manual'` was set; audit row written, no merge.
   *  - `conflict` — auto-merge failed; worktree preserved for manual recovery.
   */
  outcome: 'merged' | 'noop' | 'manual' | 'conflict';
  /** Underlying integration result when an auto-merge was attempted. */
  integration: WorktreeIntegrationResult | null;
  /** Human-readable reason — surfaced in CLI envelopes and audit rows. */
  reason: string;
  /**
   * Recovery instructions populated when `outcome === 'conflict'`. Used by
   * the CLI to render an actionable error message to the operator.
   */
  recovery?: {
    /** The worktree path that was preserved. */
    worktreePath: string;
    /** Task branch that needs manual resolution. */
    branch: string;
    /** Ordered list of recovery steps. */
    steps: readonly string[];
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Scan the worktree-integration audit log for a prior successful merge of
 * `taskId`. Returns `true` when one is found so callers can short-circuit.
 *
 * The check is best-effort — if the audit file is missing, unreadable, or
 * malformed we conservatively return `false` so the caller proceeds with
 * the merge (which itself becomes a near-no-op when the branch is absent).
 *
 * @task T9548
 */
function priorMergeRecorded(
  projectRoot: string,
  taskId: string,
  integrationAuditPath?: string,
): boolean {
  const auditPath =
    integrationAuditPath ?? join(projectRoot, '.cleo', 'audit', 'worktree-integration.jsonl');
  if (!existsSync(auditPath)) return false;

  let raw: string;
  try {
    raw = readFileSync(auditPath, 'utf-8');
  } catch {
    return false;
  }

  const lines = raw.split('\n').filter((l) => l.trim().length > 0);
  // Walk from newest to oldest so the most recent record wins.
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;
    try {
      const entry = JSON.parse(line) as {
        taskId?: string;
        merged?: boolean;
      };
      if (entry.taskId === taskId && entry.merged === true) {
        return true;
      }
    } catch {
      // Skip malformed rows.
    }
  }
  return false;
}

/**
 * Build a recovery instruction block surfaced in the conflict envelope.
 *
 * The `branch` arg is intentionally part of the signature even when unused in
 * the rendered steps — it documents the contract that recovery is scoped to
 * a single task branch and keeps the call-site self-documenting at the
 * conflict path.
 *
 * @task T9548
 */
function buildRecoverySteps(
  taskId: string,
  worktreePath: string,
  _branch: string,
): readonly string[] {
  return [
    `cd ${worktreePath}`,
    'git status                      # inspect conflicted files',
    'git rebase --continue           # OR resolve + git commit',
    'git push origin HEAD            # push resolution upstream',
    `cleo orchestrate worktree-complete ${taskId} --resolve manual`,
  ];
}

// ---------------------------------------------------------------------------
// Public SDK entry point
// ---------------------------------------------------------------------------

/**
 * Complete the worktree integration lifecycle for a task.
 *
 * Called automatically by {@link orchestrateSpawnExecute} after a worker
 * spawn returns a success result. Also invokable directly via
 * `cleo orchestrate worktree-complete <taskId>`.
 *
 * Behaviour:
 *
 * 1. **Manual resolve** — when `opts.resolve === 'manual'`, write a
 *    `complete-manual` audit row and return success without touching git.
 * 2. **Idempotent check** — if a prior `complete` audit row exists for
 *    the task, return `outcome: 'noop'` and append `complete-skip` to the
 *    lifecycle audit log.
 * 3. **Auto merge** — delegate to {@link completeAgentWorktreeIntegration}
 *    (ADR-062 `git merge --no-ff`). On success write `complete` audit row.
 * 4. **Conflict** — when the merge fails, the worktree is **preserved**
 *    (no prune attempt). A `complete-conflict` audit row is written and
 *    the envelope's `recovery` block describes the manual recovery path.
 *
 * @param taskId       - Task ID whose worktree should be integrated.
 * @param projectRoot  - Absolute path to the project root.
 * @param opts         - Optional behaviour overrides.
 * @returns Envelope describing what happened.
 *
 * @task T9548
 * @adr ADR-062
 */
export function completeWorktreeForTask(
  taskId: string,
  projectRoot: string,
  opts: CompleteWorktreeForTaskOpts = {},
): CompleteWorktreeForTaskResult {
  const resolve = opts.resolve ?? 'auto';
  const actor = resolveWorktreeAuditActor();
  const worktreeRoot = resolveAgentWorktreeRoot(projectRoot);
  const worktreePath = join(worktreeRoot, taskId);
  const branch = `task/${taskId}`;

  // ---- Manual resolve: write audit row and return. -----------------------
  if (resolve === 'manual') {
    appendWorktreeAuditEntry(
      projectRoot,
      {
        actor,
        action: 'complete-manual',
        target: worktreePath,
        branch,
        taskId,
        reason: 'operator marked worktree as manually-handled',
        success: true,
      },
      opts.lifecycleAuditPath,
    );
    return {
      taskId,
      outcome: 'manual',
      integration: null,
      reason: 'Worktree marked as manually-handled (--resolve manual).',
    };
  }

  // ---- Idempotent check: prior merge already recorded? -------------------
  if (priorMergeRecorded(projectRoot, taskId, opts.integrationAuditPath)) {
    appendWorktreeAuditEntry(
      projectRoot,
      {
        actor,
        action: 'complete-skip',
        target: worktreePath,
        branch,
        taskId,
        reason: 'prior merge already recorded in worktree-integration.jsonl',
        success: true,
      },
      opts.lifecycleAuditPath,
    );
    return {
      taskId,
      outcome: 'noop',
      integration: null,
      reason: `Worktree for ${taskId} already integrated (audit log shows prior merge).`,
    };
  }

  // ---- Auto merge: delegate to ADR-062 integration helper. ---------------
  const integration = completeAgentWorktreeIntegration(taskId, projectRoot, {
    targetBranch: opts.targetBranch,
    taskTitle: opts.taskTitle,
    skipFetch: opts.skipFetch,
    auditLogPath: opts.integrationAuditPath,
  });

  if (integration.merged) {
    appendWorktreeAuditEntry(
      projectRoot,
      {
        actor,
        action: 'complete',
        target: worktreePath,
        branch,
        taskId,
        reason: `merged --no-ff (${integration.commitCount} commits) into ${integration.targetBranch}`,
        success: true,
      },
      opts.lifecycleAuditPath,
    );
    return {
      taskId,
      outcome: 'merged',
      integration,
      reason: `Merged ${integration.commitCount} commits into ${integration.targetBranch}.`,
    };
  }

  // ---- Conflict path: preserve worktree, write audit, return error. -------
  appendWorktreeAuditEntry(
    projectRoot,
    {
      actor,
      action: 'complete-conflict',
      target: worktreePath,
      branch,
      taskId,
      reason: integration.error ?? 'unknown merge failure',
      success: false,
      error: integration.error,
    },
    opts.lifecycleAuditPath,
  );

  return {
    taskId,
    outcome: 'conflict',
    integration,
    reason: integration.error ?? 'Auto-merge failed; worktree preserved for manual resolution.',
    recovery: {
      worktreePath,
      branch,
      steps: buildRecoverySteps(taskId, worktreePath, branch),
    },
  };
}

/**
 * Audit log file (relative to project root) used by completeWorktreeForTask.
 *
 * Re-exported for tests + downstream consumers that need to assert on the
 * canonical path.
 *
 * @task T9548
 */
export { WORKTREE_LIFECYCLE_AUDIT_FILE };
