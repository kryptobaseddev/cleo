/**
 * Git worktree manager for multi-agent isolation.
 *
 * Implements ULTRAPLAN §14: each spawned agent gets its own git
 * worktree so parallel workers cannot conflict. The orchestrator
 * stays on its current branch.
 *
 * @packageDocumentation
 */

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/** Request payload for creating a new git worktree. */
export interface WorktreeRequest {
  /** The base ref to branch from (e.g. "main", "develop", a SHA). */
  baseRef: string;
  /** Branch name for the worktree. If absent, derived from taskId. */
  branchName?: string;
  /** Task ID driving this worktree. */
  taskId: string;
  /** Why this worktree is being created. */
  reason: 'subagent' | 'experiment' | 'parallel-wave';
}

/** Handle returned after worktree creation; used for merge and cleanup. */
export interface WorktreeHandle {
  /** Absolute path to the worktree directory. */
  path: string;
  /** Branch name created for this worktree. */
  branch: string;
  /** The base ref it was branched from. */
  baseRef: string;
  /** Task ID. */
  taskId: string;
  /** Clean up: remove the worktree and optionally delete the branch. */
  cleanup(deleteBranch?: boolean): void;
}

/** Configuration for worktree path resolution and git operations. */
export interface WorktreeConfig {
  /** Root directory for worktrees. Defaults to $XDG_DATA_HOME/cleo/worktrees/<projectHash>/ */
  worktreeRoot?: string;
  /** Project hash for path scoping. */
  projectHash: string;
  /** The project's git root directory. */
  gitRoot: string;
}

/** Result of a merge operation. */
export interface MergeResult {
  /** Whether the merge succeeded. */
  success: boolean;
  /** Error message if the merge failed. */
  error?: string;
}

/** Entry in the list of active worktrees. */
export interface WorktreeEntry {
  /** Absolute path to the worktree directory. */
  path: string;
  /** Branch checked out in this worktree. */
  branch: string;
}

/**
 * Resolve the worktree root directory.
 *
 * Uses `$XDG_DATA_HOME/cleo/worktrees/<projectHash>/` per ULTRAPLAN §14.3.
 * Falls back to `~/.local/share/cleo/worktrees/<projectHash>/` when
 * `XDG_DATA_HOME` is not set.
 *
 * @param config - Worktree configuration containing optional override and project hash.
 * @returns Absolute path to the worktree root directory.
 */
export function resolveWorktreeRoot(config: WorktreeConfig): string {
  if (config.worktreeRoot) return config.worktreeRoot;
  const xdgData = process.env['XDG_DATA_HOME'] ?? join(homedir(), '.local', 'share');
  return join(xdgData, 'cleo', 'worktrees', config.projectHash);
}

/**
 * Create a git worktree for an agent.
 *
 * Runs `git worktree add <path> -b <branch> <baseRef>` from the
 * project's git root. Branch naming convention: `cleo/<taskId>-<shortId>`.
 *
 * If a worktree already exists at the target path (stale from a prior run),
 * it is removed before creating the new one.
 *
 * @param request - The worktree request specifying task, base ref, and optional branch name.
 * @param config - Project-level worktree configuration.
 * @returns A handle for the created worktree with cleanup capability.
 * @throws Error if the git worktree add command fails.
 */
export function createWorktree(
  request: WorktreeRequest,
  config: WorktreeConfig,
): WorktreeHandle {
  const root = resolveWorktreeRoot(config);
  mkdirSync(root, { recursive: true });

  const shortId = Math.random().toString(36).slice(2, 8);
  const branch = request.branchName ?? `cleo/${request.taskId}-${shortId}`;
  const worktreePath = join(root, request.taskId);

  // Remove existing worktree at this path if it exists (stale from prior run)
  if (existsSync(worktreePath)) {
    try {
      execSync(`git worktree remove "${worktreePath}" --force`, {
        cwd: config.gitRoot,
        stdio: 'pipe',
      });
    } catch {
      // Best-effort cleanup — directory may not be a valid worktree
      rmSync(worktreePath, { recursive: true, force: true });
    }
  }

  // Create the worktree
  execSync(
    `git worktree add "${worktreePath}" -b "${branch}" "${request.baseRef}"`,
    { cwd: config.gitRoot, stdio: 'pipe' },
  );

  return buildHandle(worktreePath, branch, request.baseRef, request.taskId, config.gitRoot);
}

/**
 * Merge a worktree's branch back into the current branch.
 *
 * On success the worktree is cleaned up (directory removed, branch deleted).
 * On failure the worktree is retained for forensic inspection.
 *
 * @param handle - The worktree handle returned from {@link createWorktree}.
 * @param config - Project-level worktree configuration.
 * @param options - Merge strategy options (defaults to fast-forward only).
 * @returns A result object indicating success or failure with an error message.
 */
export function mergeWorktree(
  handle: WorktreeHandle,
  config: WorktreeConfig,
  options: { strategy?: 'ff-only' | 'no-ff' } = {},
): MergeResult {
  const strategy = options.strategy ?? 'ff-only';
  const mergeFlag = strategy === 'ff-only' ? '--ff-only' : '--no-ff';

  try {
    execSync(`git merge ${mergeFlag} "${handle.branch}"`, {
      cwd: config.gitRoot,
      stdio: 'pipe',
    });
    // Success: clean up worktree
    handle.cleanup(true);
    return { success: true };
  } catch (err) {
    // Failure: retain worktree for forensics
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      error: `Merge failed: ${message}. Worktree retained at ${handle.path} for forensics.`,
    };
  }
}

/**
 * List active worktrees scoped to the current project.
 *
 * Parses `git worktree list --porcelain` and filters entries whose path
 * falls under the project's worktree root directory.
 *
 * @param config - Project-level worktree configuration.
 * @returns Array of worktree entries with their paths and branch names.
 */
export function listWorktrees(config: WorktreeConfig): WorktreeEntry[] {
  try {
    const output = execSync('git worktree list --porcelain', {
      cwd: config.gitRoot,
      encoding: 'utf-8',
    });
    const entries: WorktreeEntry[] = [];
    const root = resolveWorktreeRoot(config);
    let currentPath = '';
    let currentBranch = '';
    for (const line of output.split('\n')) {
      if (line.startsWith('worktree ')) {
        currentPath = line.slice('worktree '.length);
      } else if (line.startsWith('branch ')) {
        currentBranch = line.slice('branch refs/heads/'.length);
      } else if (line === '') {
        if (currentPath.startsWith(root)) {
          entries.push({ path: currentPath, branch: currentBranch });
        }
        currentPath = '';
        currentBranch = '';
      }
    }
    return entries;
  } catch {
    return [];
  }
}

/**
 * Build a WorktreeHandle with a cleanup closure.
 *
 * @internal
 */
function buildHandle(
  worktreePath: string,
  branch: string,
  baseRef: string,
  taskId: string,
  gitRoot: string,
): WorktreeHandle {
  return {
    path: worktreePath,
    branch,
    baseRef,
    taskId,
    cleanup(deleteBranch = false) {
      try {
        execSync(`git worktree remove "${worktreePath}" --force`, {
          cwd: gitRoot,
          stdio: 'pipe',
        });
      } catch {
        rmSync(worktreePath, { recursive: true, force: true });
      }
      if (deleteBranch) {
        try {
          execSync(`git branch -D "${branch}"`, {
            cwd: gitRoot,
            stdio: 'pipe',
          });
        } catch {
          // Branch may already be deleted
        }
      }
    },
  };
}
