/**
 * Backward-compatibility shim for callers of `packages/cant/src/worktree.ts`.
 *
 * Provides the legacy `WorktreeConfig`-based API surface on top of the new
 * native SDK. Callers that import from `@cleocode/cant` continue working
 * unchanged; new callers should use the primary SDK surface in `index.ts`.
 *
 * @remarks
 * These adapters are deprecated and will be removed once all callers have
 * been migrated to `@cleocode/worktree`.
 *
 * @deprecated Use `@cleocode/worktree` directly.
 * @task T1161
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { gitSilent, gitSync } from './git.js';
import { resolveWorktreeRootForHash } from './paths.js';

// ---------------------------------------------------------------------------
// Legacy types (mirrors cant/src/worktree.ts exactly)
// ---------------------------------------------------------------------------

/**
 * Request payload for creating a new git worktree (legacy API).
 *
 * @deprecated Use {@link CreateWorktreeOptions} from `@cleocode/worktree`.
 */
export interface LegacyWorktreeRequest {
  /** The base ref to branch from (e.g. "main", "develop", a SHA). */
  baseRef: string;
  /** Branch name for the worktree. If absent, derived from taskId. */
  branchName?: string;
  /** Task ID driving this worktree. */
  taskId: string;
  /** Why this worktree is being created. */
  reason: 'subagent' | 'experiment' | 'parallel-wave';
}

/**
 * Handle returned after worktree creation (legacy API).
 *
 * @deprecated Use {@link CreateWorktreeResult} from `@cleocode/worktree`.
 */
export interface LegacyWorktreeHandle {
  /** Absolute path to the worktree directory. */
  path: string;
  /** Branch name created for this worktree. */
  branch: string;
  /** The base ref it was branched from. */
  baseRef: string;
  /** Task ID. */
  taskId: string;
  /** Project hash. */
  projectHash: string;
  /** Clean up: remove the worktree and optionally delete the branch. */
  cleanup(deleteBranch?: boolean): void;
}

/**
 * Configuration for worktree path resolution (legacy API).
 *
 * @deprecated Use `projectRoot` directly with the new SDK functions.
 */
export interface LegacyWorktreeConfig {
  /** Root directory for worktrees. Defaults to XDG_DATA_HOME/cleo/worktrees/<projectHash>/ */
  worktreeRoot?: string;
  /** Project hash for path scoping. */
  projectHash: string;
  /** The project's git root directory. */
  gitRoot: string;
}

/**
 * Result of a merge operation (legacy API).
 *
 * @deprecated Use {@link DestroyWorktreeResult} from `@cleocode/worktree`.
 */
export interface LegacyMergeResult {
  /** Whether the merge succeeded. */
  success: boolean;
  /** Error message if the merge failed. */
  error?: string;
}

/**
 * Entry in the list of active worktrees (legacy API).
 *
 * @deprecated Use {@link WorktreeListEntry} from `@cleocode/contracts`.
 */
export interface LegacyWorktreeEntry {
  /** Absolute path to the worktree directory. */
  path: string;
  /** Branch checked out in this worktree. */
  branch: string;
}

// ---------------------------------------------------------------------------
// Legacy API implementations
// ---------------------------------------------------------------------------

/**
 * Resolve the worktree root directory (legacy API).
 *
 * @deprecated Use `resolveWorktreeRoot` from `@cleocode/worktree`.
 * @param config - Legacy worktree config.
 * @returns Absolute path to the worktree root directory.
 */
export function legacyResolveWorktreeRoot(config: LegacyWorktreeConfig): string {
  return resolveWorktreeRootForHash(config.projectHash, config.worktreeRoot);
}

/**
 * Create a git worktree using the legacy config-based API.
 *
 * Wraps the new native SDK but returns a {@link LegacyWorktreeHandle} for
 * backward compatibility. Callers should migrate to `createWorktree` from
 * `@cleocode/worktree`.
 *
 * @deprecated Use `createWorktree` from `@cleocode/worktree`.
 * @param request - Legacy worktree request.
 * @param config - Legacy worktree config.
 * @returns A legacy handle with a cleanup function.
 */
export function legacyCreateWorktree(
  request: LegacyWorktreeRequest,
  config: LegacyWorktreeConfig,
): LegacyWorktreeHandle {
  const root = legacyResolveWorktreeRoot(config);
  mkdirSync(root, { recursive: true });

  const branch = request.branchName ?? `task/${request.taskId}`;
  const worktreePath = join(root, request.taskId);

  // Remove stale worktree if it exists.
  if (existsSync(worktreePath)) {
    try {
      gitSilent(['worktree', 'unlock', worktreePath], config.gitRoot);
      if (!gitSilent(['worktree', 'remove', '--force', worktreePath], config.gitRoot)) {
        rmSync(worktreePath, { recursive: true, force: true });
      }
    } catch {
      rmSync(worktreePath, { recursive: true, force: true });
    }
  }

  // Create the worktree.
  gitSync(['worktree', 'add', worktreePath, '-b', branch, request.baseRef], config.gitRoot);

  return buildLegacyHandle(worktreePath, branch, request.baseRef, request.taskId, config);
}

/**
 * Merge a worktree's branch back into the current branch (legacy API).
 *
 * @deprecated Use `completeAgentWorktreeViaMerge` from `@cleocode/core`
 * followed by `destroyWorktree` from `@cleocode/worktree` (ADR-062).
 * @param handle - Legacy worktree handle.
 * @param config - Legacy worktree config.
 * @param options - Merge strategy options.
 * @returns Merge result.
 */
export function legacyMergeWorktree(
  handle: LegacyWorktreeHandle,
  config: LegacyWorktreeConfig,
  options: { strategy?: 'ff-only' | 'no-ff' } = {},
): LegacyMergeResult {
  const strategy = options.strategy ?? 'ff-only';
  const mergeFlag = strategy === 'ff-only' ? '--ff-only' : '--no-ff';

  try {
    gitSync(['merge', mergeFlag, handle.branch], config.gitRoot);
    handle.cleanup(true);
    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      error: `Merge failed: ${message}. Worktree retained at ${handle.path} for forensics.`,
    };
  }
}

/**
 * List active worktrees scoped to the current project (legacy API).
 *
 * @deprecated Use `listWorktrees` from `@cleocode/worktree`.
 * @param config - Legacy worktree config.
 * @returns Array of legacy worktree entries.
 */
export function legacyListWorktrees(config: LegacyWorktreeConfig): LegacyWorktreeEntry[] {
  try {
    const output = execFileSync('git', ['worktree', 'list', '--porcelain'], {
      cwd: config.gitRoot,
      encoding: 'utf-8',
    }) as string;
    const entries: LegacyWorktreeEntry[] = [];
    const root = legacyResolveWorktreeRoot(config);
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

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Build a legacy WorktreeHandle with a cleanup closure.
 * @internal
 */
function buildLegacyHandle(
  worktreePath: string,
  branch: string,
  baseRef: string,
  taskId: string,
  config: LegacyWorktreeConfig,
): LegacyWorktreeHandle {
  return {
    path: worktreePath,
    branch,
    baseRef,
    taskId,
    projectHash: config.projectHash,
    cleanup(deleteBranch = false) {
      try {
        gitSilent(['worktree', 'unlock', worktreePath], config.gitRoot);
        if (!gitSilent(['worktree', 'remove', '--force', worktreePath], config.gitRoot)) {
          rmSync(worktreePath, { recursive: true, force: true });
        }
      } catch {
        rmSync(worktreePath, { recursive: true, force: true });
      }
      if (deleteBranch) {
        gitSilent(['branch', '-D', branch], config.gitRoot);
      }
    },
  };
}
