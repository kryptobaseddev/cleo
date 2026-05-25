/**
 * Worktree recovery operations for @cleocode/worktree.
 *
 * T10456 — Auto-adopt partial worktrees:
 *   When a spawn hits ETIMEDOUT and leaves a worktree in a partial state,
 *   the recovery function:
 *     1. Detects partial state (git status, node_modules, index.lock)
 *     2. Runs `pnpm install` to restore node_modules
 *     3. Unlocks the git index if a stale index.lock is present
 *     4. Resumes from the last checkpoint (if any)
 *
 * @task T10456
 * @epic T10435
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

function resolveGitAdminDir(worktreePath: string): string {
  const gitPath = join(worktreePath, '.git');
  if (!existsSync(gitPath)) return gitPath;

  try {
    const gitContent = readFileSync(gitPath, 'utf-8').trim();
    if (gitContent.startsWith('gitdir: ')) {
      const adminDir = gitContent.slice('gitdir: '.length).trim();
      return adminDir.startsWith('/') ? adminDir : join(worktreePath, adminDir);
    }
  } catch {
    // `.git` is normally a directory for the primary checkout; fall through.
  }

  return gitPath;
}

function resolveIndexLockPath(worktreePath: string): string {
  return join(resolveGitAdminDir(worktreePath), 'index.lock');
}

/**
 * Signals that indicate a worktree may be in a partial / wedged state.
 *
 * @task T10456
 */
export interface PartialWorktreeSignals {
  /** True when `git status --porcelain` returns non-empty output. */
  hasUncommittedChanges: boolean;
  /** True when `node_modules` is missing from the worktree root. */
  nodeModulesMissing: boolean;
  /** True when `.git/index.lock` exists (wedged git index). */
  indexLockPresent: boolean;
  /** True when the worktree directory itself exists but looks incomplete. */
  worktreeExists: boolean;
}

/**
 * Result of a recovery attempt.
 *
 * @task T10456
 */
export interface RecoveryResult {
  /** Whether the recovery succeeded overall. */
  success: boolean;
  /** What actions were taken. */
  actions: string[];
  /** Error message if recovery failed. */
  error?: string;
  /** The partial-state signals that were detected before recovery. */
  signals: PartialWorktreeSignals;
}

/**
 * Detect whether a worktree is in a partial state.
 *
 * Checks for:
 *   1. Uncommitted changes (`git status --porcelain`)
 *   2. Missing `node_modules`
 *   3. Stale `.git/index.lock`
 *
 * @param worktreePath - Absolute path to the worktree directory.
 * @returns Detection signals.
 * @task T10456
 */
export function detectPartialWorktree(worktreePath: string): PartialWorktreeSignals {
  const signals: PartialWorktreeSignals = {
    hasUncommittedChanges: false,
    nodeModulesMissing: false,
    indexLockPresent: false,
    worktreeExists: existsSync(worktreePath),
  };

  if (!signals.worktreeExists) {
    return signals;
  }

  // 1. Check for uncommitted changes
  try {
    const status = execFileSync('git', ['status', '--porcelain'], {
      cwd: worktreePath,
      encoding: 'utf-8',
      timeout: 5_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    signals.hasUncommittedChanges = status.trim().length > 0;
  } catch {
    signals.hasUncommittedChanges = false;
  }

  // 2. Check for missing node_modules
  signals.nodeModulesMissing = !existsSync(join(worktreePath, 'node_modules'));

  // 3. Check for stale index.lock
  signals.indexLockPresent = existsSync(resolveIndexLockPath(worktreePath));

  return signals;
}

/**
 * Auto-adopt a partial worktree by running recovery steps.
 *
 * Steps:
 *   1. Detect partial state via {@link detectPartialWorktree}.
 *   2. If `node_modules` is missing, run `pnpm install` (bounded by 120s).
 *   3. If `.git/index.lock` is present, remove it and run `git worktree unlock`.
 *   4. If a checkpoint file (`.cleo/checkpoint.json`) exists, read it and
 *      return the checkpoint state so the caller can resume.
 *
 * All steps are best-effort: a failure in one step does not abort the others.
 *
 * @param projectRoot  - Absolute path to the project root.
 * @param worktreePath - Absolute path to the partial worktree.
 * @param taskId       - Task ID associated with the worktree.
 * @returns Recovery result with actions taken and any error.
 * @task T10456
 */
export function recoverPartialWorktree(
  projectRoot: string,
  worktreePath: string,
  taskId: string,
): RecoveryResult {
  const actions: string[] = [];
  const signals = detectPartialWorktree(worktreePath);

  if (!signals.worktreeExists) {
    return {
      success: false,
      actions: ['detect-partial-state'],
      error: `Worktree does not exist: ${worktreePath}`,
      signals,
    };
  }

  // Step 2: pnpm install when node_modules is missing
  if (signals.nodeModulesMissing) {
    try {
      execFileSync('pnpm', ['install'], {
        cwd: worktreePath,
        encoding: 'utf-8',
        timeout: 120_000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      actions.push('pnpm-install');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      actions.push(`pnpm-install-failed: ${message}`);
    }
  }

  // Step 3: unlock git index when index.lock is present
  if (signals.indexLockPresent) {
    try {
      const lockPath = resolveIndexLockPath(worktreePath);
      if (existsSync(lockPath)) {
        rmSync(lockPath, { force: true });
      }
      execFileSync('git', ['worktree', 'unlock', worktreePath], {
        cwd: projectRoot,
        encoding: 'utf-8',
        timeout: 10_000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      actions.push('unlock-git-index');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      actions.push(`unlock-git-index-failed: ${message}`);
    }
  }

  // Step 4: resume from checkpoint if present
  const checkpointPath = join(worktreePath, '.cleo', 'checkpoint.json');
  if (existsSync(checkpointPath)) {
    try {
      const raw = readFileSync(checkpointPath, 'utf-8');
      const checkpoint = JSON.parse(raw) as unknown;
      actions.push('checkpoint-resumed');
      // Return success but surface the checkpoint in the error field for
      // upstream callers that want to act on it.
      return {
        success: true,
        actions,
        signals,
        error: JSON.stringify({ checkpointResumed: true, checkpoint }),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      actions.push(`checkpoint-read-failed: ${message}`);
    }
  }

  const success =
    actions.some((a) => a === 'pnpm-install' || a === 'unlock-git-index') ||
    (!signals.nodeModulesMissing && !signals.indexLockPresent);

  return {
    success,
    actions,
    signals,
  };
}
