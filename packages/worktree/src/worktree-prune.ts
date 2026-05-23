/**
 * Worktree prune operation for @cleocode/worktree.
 *
 * Thin orchestration over the `worktrunk_core` SDK exposed via
 * `@cleocode/worktree-napi` (T10203 / ADR-078). The native binding owns:
 *
 * - Git-aware prune-plan construction (`napi.pruneWorktrees`) — read-only
 *   discovery of merged-in worktrees + orphan branches.
 * - Recursive directory removal (`napi.removeDir`) — replaces the
 *   `rmSync` + `git worktree remove` fallback that previously lived here.
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
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { PruneWorktreesOptions, PruneWorktreesResult } from '@cleocode/contracts';
import { getGitRoot, gitSilent } from './git.js';
import { pruneWorktrees as napiPrune, removeDir as napiRemoveDir } from './napi-binding.js';
import { computeProjectHash, resolveWorktreeRootForHash } from './paths.js';
import { appendWorktreeAuditLog, removeWorktreeFromSentinelIndex } from './worktree-audit.js';

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
 * 4. For each eligible entry: unlock via git → remove via napi → audit-log →
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
  const errors: Array<{ path: string; reason: string }> = [];
  const gitPruneRan = gitPrune ? runGitPruneAdminCleanup(gitRoot) : false;
  if ((preserveTaskIds === undefined && idleDays === undefined) || !existsSync(worktreeRoot)) {
    return { removed: 0, removedPaths: [], errors, gitPruneRan };
  }
  for (const entry of safeReaddir(worktreeRoot)) {
    const decision = classifyPruneCandidate(entry, preserveTaskIds, idleDays, worktreeRoot);
    if (decision === null) continue;
    pruneSingleEntry(decision, gitRoot, projectRoot, removed, errors);
  }
  return { removed: removed.length, removedPaths: removed, errors, gitPruneRan };
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
 * @internal
 */
function classifyPruneCandidate(
  entry: string,
  preserveTaskIds: Set<string> | undefined,
  idleDays: number | undefined,
  worktreeRoot: string,
): PruneDecision | null {
  const path = join(worktreeRoot, entry);
  if (preserveTaskIds !== undefined) {
    if (!preserveTaskIds.has(entry)) {
      return { taskId: entry, path, reason: 'orphan' };
    }
    if (idleDays !== undefined && isWorktreeIdle(path, idleDays)) {
      return { taskId: entry, path, reason: `idle-${idleDays}d` };
    }
    return null;
  }
  if (idleDays !== undefined && isWorktreeIdle(path, idleDays)) {
    return { taskId: entry, path, reason: `idle-${idleDays}d` };
  }
  return null;
}

/**
 * Remove a single worktree entry: unlock via git, remove via napi-backed
 * directory removal, then write audit + sentinel-index entries.
 *
 * Mutates `removed` and `errors` in place to keep the orchestrator function
 * thin. Both audit-log and sentinel-index updates are best-effort and never
 * block successful removal.
 *
 * @internal
 */
function pruneSingleEntry(
  decision: PruneDecision,
  gitRoot: string,
  projectRoot: string,
  removed: string[],
  errors: Array<{ path: string; reason: string }>,
): void {
  const { taskId, path, reason } = decision;
  gitSilent(['worktree', 'unlock', path], gitRoot);
  const gitRemoveSucceeded = gitSilent(['worktree', 'remove', '--force', path], gitRoot);
  let pruneSuccess = gitRemoveSucceeded;
  let errorMessage: string | null = null;
  if (!gitRemoveSucceeded) {
    try {
      // Delegate the recursive directory removal to worktrunk-core via napi
      // (T10203). The SDK is best-effort: read/unlink/rmdir errors are
      // silently skipped, so a non-zero file count signals success.
      napiRemoveDir({ path });
      pruneSuccess = true;
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : String(err);
    }
  }
  if (pruneSuccess) {
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
  const finalError = errorMessage ?? 'napi removeDir failed';
  errors.push({ path, reason: finalError });
  appendWorktreeAuditLog(projectRoot, {
    action: 'prune',
    xdgPath: path,
    taskId,
    reason,
    success: false,
    error: finalError,
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
