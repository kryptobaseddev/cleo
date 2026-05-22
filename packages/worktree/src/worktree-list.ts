/**
 * Worktree listing operations for @cleocode/worktree.
 *
 * `listWorktrees` and `listWorktreesByProjectRoot` scan the CLEO XDG worktrees
 * directory and use `@cleocode/worktree-napi` (`listWorktrees` →
 * `worktrunk_core::git_wt::list_worktrees`) to look up per-entry branch info
 * in a single Rust call — the prior N+1 `git rev-parse` loop is gone.
 *
 * Classification of each entry (status / stale / orphan / owningTask) stays in
 * TS because it consumes the tasks DB and other CLEO-specific state.
 *
 * @task T9982
 * @task T1161
 */

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ListWorktreesOptions, WorktreeListEntry } from '@cleocode/contracts';
import {
  computeProjectHash,
  getCleoWorktreesRoot,
  resolveWorktreeRootForHash,
} from '@cleocode/paths';
import { listWorktrees as napiListWorktrees, type WorktreeInfoNapi } from '@cleocode/worktree-napi';
import { getGitRoot } from './git.js';

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
 * Build a `worktreePath → branch` lookup table for all worktrees registered
 * with `gitRoot`, using the napi binding for the porcelain parse.
 *
 * Falls back to an empty map on any error — callers degrade gracefully to
 * the synthesized `task/<taskId>` default in {@link listWorktrees}.
 *
 * @internal
 */
function buildBranchLookup(gitRoot: string | null): Map<string, string> {
  if (!gitRoot) return new Map();
  let infos: WorktreeInfoNapi[];
  try {
    infos = napiListWorktrees({ repoRoot: gitRoot });
  } catch {
    return new Map();
  }
  const lookup = new Map<string, string>();
  for (const info of infos) {
    if (info.branch) lookup.set(info.path, info.branch);
  }
  return lookup;
}

/**
 * List all active CLEO worktrees scoped to a specific project hash.
 *
 * Scans the XDG worktrees filesystem directory. Entries without a valid
 * worktree path on disk are omitted. Branch lookup is performed once per call
 * via `napi.listWorktrees` — no per-entry `git rev-parse` invocation.
 *
 * @param options - Listing options including optional project hash filter.
 * @returns Array of worktree entries.
 *
 * @task T9982
 */
export function listWorktrees(options: ListWorktreesOptions = {}): WorktreeListEntry[] {
  const worktreesBase = getCleoWorktreesRoot();

  if (!existsSync(worktreesBase)) return [];

  const entries: WorktreeListEntry[] = [];

  let projectHashes: string[];
  try {
    projectHashes = readdirSync(worktreesBase);
  } catch {
    return [];
  }

  // Cache one branch lookup per gitRoot — callers typically pass a single
  // projectHash, so this collapses to a single napi call per listWorktrees().
  const branchLookups = new Map<string, Map<string, string>>();

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

      let gitRoot: string | null;
      try {
        gitRoot = getGitRoot(worktreePath);
      } catch {
        gitRoot = null;
      }

      let lookup = gitRoot ? branchLookups.get(gitRoot) : undefined;
      if (gitRoot && !lookup) {
        lookup = buildBranchLookup(gitRoot);
        branchLookups.set(gitRoot, lookup);
      }

      const branch = lookup?.get(worktreePath) ?? `task/${taskId}`;
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
