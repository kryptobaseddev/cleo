/**
 * Worktree path primitives — project hashing + canonical worktree root.
 *
 * Canonical layout per D029:
 *   `<cleoHome>/worktrees/<projectHash>/<taskId>/`
 *
 * `cleoHome` is resolved via {@link getCleoHome} (env-paths + `CLEO_HOME` override).
 *
 * @task T1883
 */

import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { getCleoHome } from './cleo-paths.js';

const WORKTREES_SUBDIR = 'worktrees';
const PROJECT_HASH_LENGTH = 16;

/**
 * Compute a stable 16-character project hash from an absolute project root path.
 *
 * Uses SHA-256 truncated to 16 hex chars. The truncation is consistent with
 * the historical implementation in `branch-lock.ts#resolveAgentWorktreeRoot`
 * (the root cause of the duplicated logic this package consolidates).
 *
 * @param projectRoot - Absolute path to the project root.
 * @returns 16-character lowercase hex string.
 *
 * @public
 */
export function computeProjectHash(projectRoot: string): string {
  return createHash('sha256').update(projectRoot).digest('hex').slice(0, PROJECT_HASH_LENGTH);
}

/**
 * Resolve the worktrees root directory for a given project hash.
 *
 * Result: `<cleoHome>/worktrees/<projectHash>/`
 *
 * Priority:
 *   1. Explicit `worktreeRoot` arg (used by tests / config overrides)
 *   2. `CLEO_HOME` env var via {@link getCleoHome}
 *   3. env-paths XDG data dir via {@link getCleoHome}
 *
 * @param projectHash - 16-char project hash from {@link computeProjectHash}.
 * @param worktreeRoot - Optional explicit override for the full root path.
 * @returns Absolute path to the project-scoped worktree root directory.
 *
 * @public
 */
export function resolveWorktreeRootForHash(projectHash: string, worktreeRoot?: string): string {
  if (worktreeRoot) return worktreeRoot;
  return join(getCleoHome(), WORKTREES_SUBDIR, projectHash);
}

/**
 * Resolve the worktree directory for a specific task.
 *
 * Result: `<cleoHome>/worktrees/<projectHash>/<taskId>/`
 *
 * @param projectHash - 16-char project hash from {@link computeProjectHash}.
 * @param taskId - The task ID.
 * @param worktreeRoot - Optional override for the worktree root.
 * @returns Absolute path to the task-specific worktree directory.
 *
 * @public
 */
export function resolveTaskWorktreePath(
  projectHash: string,
  taskId: string,
  worktreeRoot?: string,
): string {
  return join(resolveWorktreeRootForHash(projectHash, worktreeRoot), taskId);
}

/**
 * Resolve the canonical worktrees-by-project root for the current process —
 * `<cleoHome>/worktrees/`. Project-agnostic; useful when listing or scanning
 * across all projects.
 *
 * @returns Absolute path to `<cleoHome>/worktrees/`.
 *
 * @public
 */
export function getCleoWorktreesRoot(): string {
  return join(getCleoHome(), WORKTREES_SUBDIR);
}
