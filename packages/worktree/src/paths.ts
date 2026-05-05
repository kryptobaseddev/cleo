/**
 * Worktree path resolution for `@cleocode/worktree`.
 *
 * Re-exports the worktree primitives from `@cleocode/paths` (the XDG / env-paths
 * SSoT) — `computeProjectHash`, `resolveWorktreeRootForHash`, and
 * `resolveTaskWorktreePath`. Public API of this file is unchanged; the
 * implementation now lives in the shared package.
 *
 * Canonical layout per D029:
 *   Linux:   ~/.local/share/cleo/worktrees/<projectHash>/<taskId>/
 *   macOS:   ~/Library/Application Support/cleo/worktrees/<projectHash>/<taskId>/
 *   Windows: %LOCALAPPDATA%\cleo\Data\worktrees\<projectHash>\<taskId>\
 *
 * @task T1161 (original)
 * @task T1885 (migrated to @cleocode/paths SSoT)
 */

export {
  computeProjectHash,
  resolveTaskWorktreePath,
  resolveWorktreeRootForHash,
} from '@cleocode/paths';
