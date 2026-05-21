/**
 * Worktree path primitives — project hashing + canonical worktree root.
 *
 * Canonical layout per D029:
 *   `<cleoHome>/worktrees/<projectHash>/<taskId>/`
 *
 * `cleoHome` is resolved via {@link getCleoHome} (env-paths + `CLEO_HOME` override).
 *
 * Council verdict D009 (T9802 / SG-WORKTREE-CANON) added the hybrid sentinel
 * index concept: a per-project JSON file at `<projectRoot>/.cleo/worktrees.json`
 * that acts as the canonical registry of active worktrees for that project.
 * Use {@link resolveWorktreeIndexPath} to get this path.
 *
 * @task T1883
 * @task T9802
 */

import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { getCleoHome } from './cleo-paths.js';

const WORKTREES_SUBDIR = 'worktrees';
const PROJECT_HASH_LENGTH = 16;

/**
 * Join path segments using the separator already present in the base path.
 *
 * When the base path uses only forward slashes (e.g. a POSIX path or a
 * `CLEO_HOME` test override like `/test/cleo-home`), we concatenate with `/`
 * to avoid Windows `path.join` converting separators to backslashes. Native
 * Windows paths (containing `\`) use `path.join` as usual.
 *
 * @internal
 */
function joinSegments(base: string, ...parts: string[]): string {
  if (base.includes('/') && !base.includes('\\')) {
    return [base, ...parts].join('/');
  }
  return join(base, ...parts);
}

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
  return joinSegments(getCleoHome(), WORKTREES_SUBDIR, projectHash);
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
  const root = resolveWorktreeRootForHash(projectHash, worktreeRoot);
  return joinSegments(root, taskId);
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
  return joinSegments(getCleoHome(), WORKTREES_SUBDIR);
}

/**
 * Resolve the canonical SENTINEL INDEX path for active worktrees associated
 * with a project — `<projectRoot>/.cleo/worktrees.json`.
 *
 * Council verdict D009 (T9802 / SG-WORKTREE-CANON) introduced the hybrid
 * worktree-location model: worktree directories themselves live under the XDG
 * data directory (see {@link resolveWorktreeRootForHash}), while a lightweight
 * JSON index file lives **inside the project** at
 * `<projectRoot>/.cleo/worktrees.json`. This sentinel acts as the canonical
 * registry of active worktrees for that project and is:
 *
 * - **Tracked alongside project state** — lives in `.cleo/` (git-ignored),
 *   survives across `CLEO_HOME` changes and machine migrations.
 * - **Machine-local** — absolute XDG paths inside the JSON are valid only on
 *   the machine that created them; consumers must handle stale entries.
 * - **FILE not DIRECTORY** — the path ends in `.json`, never a directory.
 *   Create with `JSON.stringify` + `fs.writeFileSync`; read with
 *   `JSON.parse(fs.readFileSync(...))`.
 *
 * Invariant: the returned path is always
 * `<projectRoot>/.cleo/worktrees.json` regardless of `CLEO_HOME`, XDG
 * environment variables, or platform. It is the T9805 lifecycle hook's
 * canonical write target.
 *
 * @param projectRoot - Absolute path to the project root (the directory that
 *   contains the `.cleo/` subdirectory for this project).
 * @returns Absolute path to `<projectRoot>/.cleo/worktrees.json`.
 *
 * @example
 * ```typescript
 * import { resolveWorktreeIndexPath } from '@cleocode/paths';
 *
 * const indexPath = resolveWorktreeIndexPath('/mnt/projects/cleocode');
 * // "/mnt/projects/cleocode/.cleo/worktrees.json"
 * ```
 *
 * @public
 */
export function resolveWorktreeIndexPath(projectRoot: string): string {
  return joinSegments(projectRoot, '.cleo', 'worktrees.json');
}
