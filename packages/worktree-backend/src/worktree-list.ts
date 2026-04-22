/**
 * Worktree listing operations for @cleocode/worktree-backend.
 *
 * `listWorktrees` and `listWorktreesByProjectRoot` scan the CLEO XDG worktrees
 * directory to return structured entries.
 *
 * @task T1161
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ListWorktreesOptions, WorktreeListEntry } from '@cleocode/contracts';
import envPaths from 'env-paths';
import { computeProjectHash, resolveWorktreeRootForHash } from './paths.js';

const APP_NAME = 'cleo';

/**
 * Resolve the worktree root directory for a given project hash.
 *
 * Exported so callers can inspect the canonical path without creating a worktree.
 *
 * @param projectHash - 16-char project hash.
 * @param worktreeRoot - Optional explicit override for the root path.
 * @returns Absolute path to the worktrees root directory for this project.
 */
export function resolveWorktreeRoot(projectHash: string, worktreeRoot?: string): string {
  return resolveWorktreeRootForHash(projectHash, worktreeRoot);
}

/**
 * List all active CLEO worktrees scoped to a specific project hash.
 *
 * Scans the XDG worktrees filesystem directory. Entries without a valid
 * worktree path on disk are omitted.
 *
 * @param options - Listing options including optional project hash filter.
 * @returns Array of worktree entries.
 */
export function listWorktrees(options: ListWorktreesOptions = {}): WorktreeListEntry[] {
  const ep = envPaths(APP_NAME, { suffix: '' });
  const dataDir = process.env['CLEO_HOME'] ?? ep.data;
  const worktreesBase = join(dataDir, 'worktrees');

  if (!existsSync(worktreesBase)) return [];

  const entries: WorktreeListEntry[] = [];

  let projectHashes: string[];
  try {
    projectHashes = readdirSync(worktreesBase);
  } catch {
    return [];
  }

  for (const hash of projectHashes) {
    // Filter by project hash when provided
    if (options.projectHash && hash !== options.projectHash) continue;

    const hashDir = join(worktreesBase, hash);
    let taskDirs: string[];
    try {
      taskDirs = readdirSync(hashDir);
    } catch {
      continue;
    }

    for (const taskId of taskDirs) {
      const worktreePath = join(hashDir, taskId);
      if (!existsSync(worktreePath)) continue;

      const branch = resolveWorktreeBranch(worktreePath) ?? `task/${taskId}`;
      entries.push({
        path: worktreePath,
        branch,
        taskId,
        projectHash: hash,
      });
    }
  }

  return entries;
}

/**
 * List all active CLEO worktrees for a specific project root.
 *
 * Computes the project hash from the project root, then delegates to
 * {@link listWorktrees} with the computed hash as filter.
 *
 * @param projectRoot - Absolute path to the project root directory.
 * @returns Array of worktree list entries for this project.
 */
export function listWorktreesByProjectRoot(projectRoot: string): WorktreeListEntry[] {
  const projectHash = computeProjectHash(projectRoot);
  return listWorktrees({ projectHash });
}

/**
 * Resolve the current branch for a worktree directory by invoking git.
 *
 * Returns null if the path is not a valid git worktree or git fails.
 *
 * @param worktreePath - Absolute path to the worktree directory.
 * @returns Branch name string, or null if not determinable.
 * @internal
 */
function resolveWorktreeBranch(worktreePath: string): string | null {
  try {
    return execFileSync('git', ['-C', worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return null;
  }
}
