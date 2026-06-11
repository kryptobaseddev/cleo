/**
 * Worktree prune operation for @cleocode/worktree.
 *
 * Thin orchestration over the `worktrunk_core` SDK exposed via
 * `@cleocode/worktree-napi` (T10203 / ADR-087). The native binding owns:
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
import { appendFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { PruneWorktreesOptions, PruneWorktreesResult } from '@cleocode/contracts';
import { getGitRoot, gitSilent } from './git.js';
import {
  destroyWorktree as napiDestroyWorktree,
  pruneWorktrees as napiPrune,
  removeDir as napiRemoveDir,
} from './napi-binding.js';
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
 * Check whether a worktree has uncommitted changes (dirty state).
 *
 * Runs `git status --porcelain -uall` inside the worktree. `-uall` expands
 * untracked directories so no file (including .env, local artifacts, etc.) is
 * missed. Returns `false` when git is unavailable so we never block cleanup
 * on a git error.
 *
 * @param worktreePath - Absolute path to the worktree directory.
 * @returns `true` when uncommitted changes are present; `false` otherwise.
 *
 * @task T11996
 * @internal
 */
function isWorktreeDirty(worktreePath: string): boolean {
  try {
    const out = execFileSync('git', ['-C', worktreePath, 'status', '--porcelain', '-uall'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10_000,
    });
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Check whether a worktree has commits not pushed to any remote ref.
 *
 * Two cases (T11996 Amendment 3):
 * (a) Branch with a configured upstream: commits ahead of `@{upstream}`.
 * (b) Branch with no upstream (never pushed): commits not reachable from any
 *     remote-tracking ref.
 * (c) Detached HEAD: commits not reachable from any remote-tracking ref.
 *
 * Returns `false` when git is unavailable or the worktree has no commits.
 *
 * @param worktreePath - Absolute path to the worktree directory.
 * @returns `true` when unpushed commits exist; `false` otherwise.
 *
 * @task T11996
 * @internal
 */
function hasUnpushedCommits(worktreePath: string): boolean {
  // Case (a): branch has a tracking upstream — check ahead count.
  try {
    const aheadStr = execFileSync(
      'git',
      ['-C', worktreePath, 'rev-list', '--count', '@{upstream}..HEAD'],
      {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 10_000,
      },
    ).trim();
    const aheadCount = Number.parseInt(aheadStr, 10);
    if (!Number.isNaN(aheadCount) && aheadCount > 0) return true;
    // Upstream exists and ahead count is 0 — no unpushed commits.
    return false;
  } catch {
    // No upstream configured — fall through to case (b)/(c).
  }

  // Case (b)/(c): no upstream configured — check whether HEAD is reachable
  // from the union of all remote-tracking refs.
  try {
    const remoteRefsOut = execFileSync(
      'git',
      ['-C', worktreePath, 'for-each-ref', '--format=%(refname)', 'refs/remotes/'],
      {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 10_000,
      },
    ).trim();
    const remoteRefs = remoteRefsOut.split('\n').filter(Boolean);
    if (remoteRefs.length === 0) {
      // No remotes configured — any local commit is "unpushed".
      try {
        const headOut = execFileSync('git', ['-C', worktreePath, 'rev-parse', 'HEAD'], {
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 5_000,
        }).trim();
        return headOut.length > 0;
      } catch {
        return false;
      }
    }
    // Count commits reachable from HEAD but not from any remote ref.
    const args = ['-C', worktreePath, 'rev-list', '--count', 'HEAD', '--not', ...remoteRefs];
    const countOut = execFileSync('git', args, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 15_000,
    }).trim();
    const count = Number.parseInt(countOut, 10);
    return !Number.isNaN(count) && count > 0;
  } catch {
    return false;
  }
}

/**
 * Quarantine a dirty/unpushed worktree by packing it into a `.tar.gz` archive
 * in `<projectRoot>/.cleo/quarantine/worktrees/`. The original directory is
 * LEFT INTACT (never deleted). An audit JSONL entry is written.
 *
 * The archive is created with `tar -czf ... -C <parent> <taskId>` so the
 * archive root is `<taskId>/`. `--dereference` captures symlink targets.
 * No exclusions are applied — the archive captures ALL files including
 * `.env`, ignored artifacts, etc. (T11996 AC: untracked + ignored files).
 *
 * @returns Absolute path to the created archive, or `null` on failure.
 *
 * @task T11996
 * @internal
 */
function quarantineWorktreeDir(
  worktreePath: string,
  taskId: string,
  projectRoot: string,
  reason: string,
): string | null {
  try {
    const quarantineDir = join(projectRoot, '.cleo', 'quarantine', 'worktrees');
    mkdirSync(quarantineDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const archiveName = `${taskId}-${ts}.tar.gz`;
    const archivePath = join(quarantineDir, archiveName);

    // Capture untracked AND ignored files by not excluding anything.
    execFileSync(
      'tar',
      ['-czf', archivePath, '--dereference', '-C', join(worktreePath, '..'), taskId],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 120_000,
      },
    );

    // Write audit entry — ZERO desktop output (T11996 Amendment 6).
    const auditPath = join(quarantineDir, 'audit.jsonl');
    const entry = JSON.stringify({
      ts: new Date().toISOString(),
      action: 'quarantine',
      worktreePath,
      taskId,
      archivePath,
      reason,
      agentId: process.env['CLEO_AGENT_ID'] ?? 'cleo',
    });
    appendFileSync(auditPath, `${entry}\n`, { encoding: 'utf-8' });

    return archivePath;
  } catch {
    return null;
  }
}

/**
 * Remove a single worktree entry: check dirty/unpushed state first, then
 * either quarantine (if unsafe) or unlock+remove via napi-backed directory
 * removal, then write audit + sentinel-index entries.
 *
 * T11996: dirty or unpushed worktrees are QUARANTINED (tar archive in
 * `<projectRoot>/.cleo/quarantine/worktrees/`), never deleted. The original
 * directory is left on disk after quarantine.
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

  // T11996: Dirty/unpushed guard — quarantine instead of deleting.
  const dirty = isWorktreeDirty(path);
  const unpushed = dirty ? false : hasUnpushedCommits(path);
  const shouldQuarantine = dirty || unpushed;
  const quarantineReason = dirty ? 'dirty' : 'unpushed';

  if (shouldQuarantine) {
    const archivePath = quarantineWorktreeDir(path, taskId, projectRoot, quarantineReason);
    if (archivePath !== null) {
      quarantined.push(path);
      appendWorktreeAuditLog(projectRoot, {
        action: 'quarantine',
        xdgPath: path,
        taskId,
        reason: `${reason}+${quarantineReason}`,
        success: true,
      });
    } else {
      errors.push({
        path,
        reason: `quarantine tar failed — worktree preserved (T11996, was ${quarantineReason})`,
      });
      appendWorktreeAuditLog(projectRoot, {
        action: 'quarantine',
        xdgPath: path,
        taskId,
        reason: `${reason}+${quarantineReason}`,
        success: false,
        error: 'tar archive creation failed',
      });
    }
    return;
  }

  // T11123: Use NAPI destroyWorktree (Rust worktrunk-core) instead of raw
  // git worktree unlock + remove shell-outs. The NAPI binding handles
  // unlock + force-remove atomically in Rust.
  let pruneSuccess = false;
  let errorMessage: string | null = null;
  try {
    const result = napiDestroyWorktree({
      repoRoot: gitRoot,
      worktreePath: path,
      force: true,
    });
    pruneSuccess = result.removed;
    // T11033 — NAPI may report success even when untracked directories
    // survive inside the worktree. Verify on-disk reality.
    if (pruneSuccess && existsSync(path)) {
      pruneSuccess = false;
    }
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : String(err);
  }

  if (!pruneSuccess) {
    try {
      // Delegate the recursive directory removal to worktrunk-core via napi
      // (T10203). The SDK is best-effort: read/unlink/rmdir errors are
      // silently skipped, so a non-zero file count signals success.
      napiRemoveDir({ path });
      pruneSuccess = true;
      // Also run git worktree prune to clean stale admin entries
      // left behind by the failed NAPI destroy.
      gitSilent(['worktree', 'prune'], gitRoot);
    } catch (err) {
      if (!errorMessage) {
        errorMessage = err instanceof Error ? err.message : String(err);
      }
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
