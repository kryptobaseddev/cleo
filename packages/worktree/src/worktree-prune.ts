/**
 * Worktree prune operation for @cleocode/worktree.
 *
 * Thin orchestration over the `worktrunk_core` SDK exposed via
 * `@cleocode/worktree-napi` (T10203 / ADR-087). The native binding owns:
 *
 * - Git-aware prune-plan construction (`napi.pruneWorktrees`) — read-only
 *   discovery of merged-in worktrees + orphan branches.
 *
 * The TypeScript layer keeps three concerns that are explicitly outside the
 * SDK boundary per ADR-061:
 *
 * 1. CLEO XDG-layout scan + `preserveTaskIds`/`idleDays` filter — business
 *    logic that the napi binding intentionally avoids.
 * 2. Audit-log writes to `.cleo/audit/worktree-lifecycle.jsonl` (T9805 AC3).
 * 3. Sentinel-index updates at `<gitRoot>/.cleo/worktrees.json` (D009).
 *
 * Called periodically by `cleo sentient tick` via `worktree-dispatch.ts`.
 *
 * @task T1161
 * @task T9805
 * @task T10204
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { PruneWorktreesOptions, PruneWorktreesResult } from '@cleocode/contracts';
import { getGitRoot, gitSilent } from './git.js';
import { pruneWorktrees as napiPrune } from './napi-binding.js';
import { computeProjectHash, resolveWorktreeRootForHash } from './paths.js';
import { appendWorktreeAuditLog, removeWorktreeFromSentinelIndex } from './worktree-audit.js';
import { disposeWorktree } from './worktree-dispose.js';

/**
 * Prune orphaned agent worktrees for a project.
 *
 * Algorithm (thin orchestration over napi SDK):
 *
 * 1. Resolve the git root (falling back to `projectRoot` when not in a repo).
 * 2. Optionally invoke `napi.pruneWorktrees` for git-aware candidate discovery
 *    — the SDK plan is currently advisory; the TS layer drives the actual
 *    removal because audit + sentinel concerns are TS-owned per ADR-061.
 * 3. Scan the XDG worktree root, filtering by `preserveTaskIds`/`idleDays`.
 * 4. For each eligible entry: {@link disposeWorktree} (T13924) → audit-log →
 *    sentinel-index cleanup.
 *
 * @param options - Prune options with project root and optional preserve list.
 * @returns Result listing removed paths and any errors.
 *
 * @task T1161
 * @task T9805
 * @task T10204
 */
export function pruneWorktrees(options: PruneWorktreesOptions): PruneWorktreesResult {
  const { projectRoot, preserveTaskIds, gitPrune = true, idleDays } = options;
  const projectHash = computeProjectHash(projectRoot);
  const worktreeRoot = resolveWorktreeRootForHash(projectHash);
  const gitRoot = resolveGitRootOrFallback(projectRoot);
  const removed: string[] = [];
  const quarantined: string[] = [];
  const errors: Array<{ path: string; reason: string }> = [];
  const gitPruneRan = gitPrune ? runGitPruneAdminCleanup(gitRoot) : false;
  if ((preserveTaskIds === undefined && idleDays === undefined) || !existsSync(worktreeRoot)) {
    return {
      removed: 0,
      removedPaths: [],
      quarantined: 0,
      quarantinedPaths: [],
      errors,
      gitPruneRan,
    };
  }

  const entries = safeReaddir(worktreeRoot);

  // T11996 Amendment 2 — fail-closed: if the preserve set is empty AND
  // worktree directories exist, skip pruning entirely to prevent mass-deletion
  // (e.g. fresh/post-exodus DB). Write a structured audit warning.
  if (preserveTaskIds !== undefined && preserveTaskIds.size === 0 && entries.length > 0) {
    const existingDirs = entries.filter((e) => existsSync(join(worktreeRoot, e)));
    if (existingDirs.length > 0) {
      appendWorktreeAuditLog(projectRoot, {
        action: 'prune-skip',
        xdgPath: worktreeRoot,
        reason:
          'preserve set empty while worktrees exist — skipping to prevent mass-deletion (T11996 fail-closed)',
        success: false,
      });
      return {
        removed: 0,
        removedPaths: [],
        quarantined: 0,
        quarantinedPaths: [],
        errors,
        gitPruneRan,
        skippedFailClosed: true,
      };
    }
  }

  for (const entry of entries) {
    const decision = classifyPruneCandidate(entry, preserveTaskIds, idleDays, worktreeRoot);
    if (decision === null) continue;
    pruneSingleEntry(decision, gitRoot, projectRoot, removed, quarantined, errors);
  }
  return {
    removed: removed.length,
    removedPaths: removed,
    quarantined: quarantined.length,
    quarantinedPaths: quarantined,
    errors,
    gitPruneRan,
  };
}

/**
 * Resolve the git root for `projectRoot`, falling back to `projectRoot` when
 * we are not inside a git repository. Lets prune still clean directories that
 * exist outside a working repo.
 *
 * @internal
 */
function resolveGitRootOrFallback(projectRoot: string): string {
  try {
    return getGitRoot(projectRoot);
  } catch {
    return projectRoot;
  }
}

/**
 * Run `git worktree prune` to clean up stale administrative entries.
 *
 * Returns `true` on success, `false` when not in a git repo (non-fatal).
 *
 * @internal
 */
function runGitPruneAdminCleanup(gitRoot: string): boolean {
  return gitSilent(['worktree', 'prune'], gitRoot);
}

/**
 * Safely read directory entries, returning `[]` on failure.
 *
 * @internal
 */
function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * Decision payload for a single worktree directory: whether to prune and why.
 *
 * @internal
 */
interface PruneDecision {
  taskId: string;
  path: string;
  reason: string;
}

/**
 * Classify a single worktree-root subdirectory entry for prune eligibility.
 *
 * Returns `null` when the entry should be preserved, or a {@link PruneDecision}
 * describing why it qualifies. Encapsulates the CLEO-specific
 * `preserveTaskIds`/`idleDays` business logic that lives outside the
 * worktrunk-core SDK by design (ADR-061).
 *
 * T11996 Amendment 1 (PREDICATE BLOCKER): if `preserveTaskIds` is provided and
 * the entry IS in the set, it is ALWAYS preserved — idle age NEVER overrides
 * the preserve list. Only entries NOT in the preserve set are eligible for
 * idle-age pruning when `idleDays` is set.
 *
 * @internal
 */
function classifyPruneCandidate(
  entry: string,
  preserveTaskIds: Set<string> | undefined,
  idleDays: number | undefined,
  worktreeRoot: string,
): PruneDecision | null {
  const path = join(worktreeRoot, entry);
  // Only directories are worktrees; a sibling file (e.g. a `.keep.json` marker) never is.
  try {
    if (!statSync(path).isDirectory()) return null;
  } catch {
    return null;
  }
  if (preserveTaskIds !== undefined) {
    // T11996: entries in the preserve set are NEVER eligible for pruning,
    // regardless of idle age. Idle-age is only applied to orphan entries
    // (entries not in the preserve set).
    if (preserveTaskIds.has(entry)) {
      return null;
    }
    // Entry is not in the preserve set — it is an orphan.
    // Check idle age only when idleDays is specified; otherwise remove immediately.
    if (idleDays !== undefined && !isWorktreeIdle(path, idleDays)) {
      return null; // orphan but not yet idle — wait longer
    }
    return { taskId: entry, path, reason: idleDays !== undefined ? `idle-${idleDays}d` : 'orphan' };
  }
  if (idleDays !== undefined && isWorktreeIdle(path, idleDays)) {
    return { taskId: entry, path, reason: `idle-${idleDays}d` };
  }
  return null;
}

/**
 * Dispose of a single worktree entry through {@link disposeWorktree} (T13924),
 * then write audit + sentinel-index entries.
 *
 * A worktree whose content or commits are not proven preserved is kept on
 * disk untouched and reported in `quarantined`; one the dependents/evidence
 * guard keeps, or whose removal failed, is reported in `errors`.
 *
 * Mutates `removed`, `quarantined`, and `errors` in place.
 *
 * @internal
 */
function pruneSingleEntry(
  decision: PruneDecision,
  gitRoot: string,
  projectRoot: string,
  removed: string[],
  quarantined: string[],
  errors: Array<{ path: string; reason: string }>,
): void {
  const { taskId, path, reason } = decision;
  const disposal = disposeWorktree({ worktreePath: path, gitRoot, projectRoot, taskId, reason });
  if (disposal.removed) {
    removed.push(path);
    appendWorktreeAuditLog(projectRoot, {
      action: 'prune',
      xdgPath: path,
      taskId,
      reason,
      success: true,
    });
    removeWorktreeFromSentinelIndex(gitRoot, taskId);
    return;
  }
  const why = disposal.keptReason ?? 'kept';
  if (disposal.unpreserved !== undefined && !disposal.kept && disposal.failed === undefined) {
    quarantined.push(path);
  } else {
    errors.push({ path, reason: why });
  }
  appendWorktreeAuditLog(projectRoot, {
    action: 'prune',
    xdgPath: path,
    taskId,
    reason: `${reason}+kept`,
    success: false,
    error: why,
  });
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

/**
 * Build a git-aware prune plan via the `worktrunk-core` SDK (T10203).
 *
 * Wraps `napi.pruneWorktrees` with the integration-target branch the caller
 * expects. Returns `null` when the underlying call fails (the napi layer
 * raises on bare repos, detached HEAD on main, or empty worktree lists) so
 * the legacy filesystem-scan path stays unaffected.
 *
 * Currently advisory: the result is exposed for callers that want the
 * SDK-classified merge-state, but {@link pruneWorktrees} still drives removal
 * from the XDG layout because preserveTaskIds + idleDays semantics live
 * outside the SDK boundary.
 *
 * @param gitRoot - Absolute path to the git repository root.
 * @param integrationTarget - Branch name to test "is merged" against
 *   (typically `main` or `master`).
 * @returns The SDK plan, or `null` when the napi call cannot be issued.
 *
 * @task T10204
 */
export function buildGitAwarePrunePlan(
  gitRoot: string,
  integrationTarget: string,
): ReturnType<typeof napiPrune> | null {
  try {
    return napiPrune({ repoRoot: gitRoot, integrationTarget });
  } catch {
    return null;
  }
}
