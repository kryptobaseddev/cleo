/**
 * XDG-compliant worktree path resolution for @cleocode/worktree-backend.
 *
 * Canonical layout per D029:
 *   Linux:   ~/.local/share/cleo/worktrees/<projectHash>/<taskId>/
 *   macOS:   ~/Library/Application Support/cleo/worktrees/<projectHash>/<taskId>/
 *   Windows: %LOCALAPPDATA%\cleo\Data\worktrees\<projectHash>\<taskId>\
 *
 * All path derivation flows through `resolveWorktreeRootForHash` — never
 * hardcode `~/.local/share/cleo`. Use env-paths + `CLEO_HOME` env override
 * matching the convention in `packages/core/src/system/platform-paths.ts`.
 *
 * @task T1161
 */

import { createHash } from 'node:crypto';
import { join } from 'node:path';
import envPaths from 'env-paths';

const APP_NAME = 'cleo';

/**
 * Compute a project hash from an absolute project root path.
 *
 * Produces a 16-character hex prefix of SHA-256 to stay consistent with
 * `packages/core/src/spawn/branch-lock.ts#resolveAgentWorktreeRoot`.
 *
 * @param projectRoot - Absolute path to the project root.
 * @returns 16-character lowercase hex string.
 */
export function computeProjectHash(projectRoot: string): string {
  return createHash('sha256').update(projectRoot).digest('hex').slice(0, 16);
}

/**
 * Resolve the XDG worktrees root directory for a given project hash.
 *
 * Priority order:
 *   1. `worktreeRoot` arg (explicit override — for tests or config)
 *   2. `CLEO_HOME` env var (backward-compat with legacy installations)
 *   3. env-paths XDG data dir (platform-appropriate default)
 *
 * Result: `<dataDir>/worktrees/<projectHash>/`
 *
 * @param projectHash - 16-char project hash from {@link computeProjectHash}.
 * @param worktreeRoot - Optional override for the full worktree root.
 * @returns Absolute path to the project-scoped worktree root directory.
 */
export function resolveWorktreeRootForHash(projectHash: string, worktreeRoot?: string): string {
  if (worktreeRoot) return worktreeRoot;
  const ep = envPaths(APP_NAME, { suffix: '' });
  // CLEO_HOME overrides the data path for backward compatibility.
  const dataDir = process.env['CLEO_HOME'] ?? ep.data;
  return join(dataDir, 'worktrees', projectHash);
}

/**
 * Resolve the worktree directory for a specific task.
 *
 * Result: `<worktreeRoot>/<taskId>/`
 *
 * @param projectHash - 16-char project hash.
 * @param taskId - The task ID.
 * @param worktreeRoot - Optional override for the root directory.
 * @returns Absolute path to the task-specific worktree directory.
 */
export function resolveTaskWorktreePath(
  projectHash: string,
  taskId: string,
  worktreeRoot?: string,
): string {
  return join(resolveWorktreeRootForHash(projectHash, worktreeRoot), taskId);
}
