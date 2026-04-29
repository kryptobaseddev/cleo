/**
 * Worktree-path resolution for the git-shim (T1591 L2 boundary fence).
 *
 * Mirrors `@cleocode/core::resolveAgentWorktreeRoot` so the shim can decide
 * "is this `cwd` inside an agent worktree?" without taking a runtime
 * dependency on `@cleocode/core` (the shim must stay lean — it spawns on every
 * git invocation).
 *
 * The shim resolves the worktree root via XDG env-paths convention:
 *   `$XDG_DATA_HOME/cleo/worktrees/<projectHash>/<taskId>/`
 *   fallback: `~/.local/share/cleo/worktrees/<projectHash>/<taskId>/`
 *
 * `<projectHash>` is sha256(projectRoot)[:16].
 *
 * @task T1591
 * @adr ADR-062
 */
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { isAbsolute, join, normalize, resolve } from 'node:path';

/**
 * Compute the canonical worktrees-by-project root used by CLEO.
 *
 * @returns Absolute path to `<XDG>/cleo/worktrees/`.
 *
 * @task T1591
 */
export function resolveCleoWorktreesRoot(): string {
  const xdgData = process.env['XDG_DATA_HOME'] ?? join(homedir(), '.local', 'share');
  return join(xdgData, 'cleo', 'worktrees');
}

/**
 * Compute the per-project worktree root.
 *
 * @param projectRoot - Absolute path to the project.
 * @returns Absolute path to `<XDG>/cleo/worktrees/<projectHash>/`.
 *
 * @task T1591
 */
export function resolveProjectWorktreeRoot(projectRoot: string): string {
  const projectHash = createHash('sha256').update(projectRoot).digest('hex').slice(0, 16);
  return join(resolveCleoWorktreesRoot(), projectHash);
}

/**
 * Check whether the given path is inside the canonical worktrees tree.
 *
 * Project-agnostic: matches the global worktrees root, not a specific project.
 *
 * @param cwdPath - Absolute path to check.
 * @returns true if the path is inside `<XDG>/cleo/worktrees/`.
 *
 * @task T1591
 */
export function isInsideWorktreesRoot(cwdPath: string): boolean {
  const worktreesRoot = resolveCleoWorktreesRoot();
  const normalized = resolve(cwdPath);
  const normalizedRoot = resolve(worktreesRoot);
  return (
    normalized === normalizedRoot ||
    normalized.startsWith(`${normalizedRoot}/`) ||
    normalized.startsWith(`${normalizedRoot}\\`)
  );
}

/**
 * Extract the task ID from a worktree path.
 *
 * Path layout: `<XDG>/cleo/worktrees/<projectHash>/<taskId>/...`
 * The taskId is the path segment immediately after the projectHash.
 *
 * @param cwdPath - Absolute path inside a worktree.
 * @returns The task ID segment, or null if the path is not inside the worktrees root.
 *
 * @task T1591
 */
export function extractTaskIdFromWorktreePath(cwdPath: string): string | null {
  const worktreesRoot = resolveCleoWorktreesRoot();
  const normalized = resolve(cwdPath);
  const normalizedRoot = resolve(worktreesRoot);
  if (
    !normalized.startsWith(`${normalizedRoot}/`) &&
    !normalized.startsWith(`${normalizedRoot}\\`)
  ) {
    return null;
  }
  const remainder = normalized.slice(normalizedRoot.length + 1);
  const segments = remainder.split(/[/\\]/).filter(Boolean);
  // segments = [projectHash, taskId, ...rest]
  if (segments.length < 2) return null;
  return segments[1] ?? null;
}

/**
 * Resolve the agent worktree boundary for the current shim invocation.
 *
 * Strategy (in order):
 * 1. `CLEO_WORKTREE_ROOT` env — explicit worktree path injected by the spawn prompt.
 * 2. Walk up from `cwd` until a directory under `<XDG>/cleo/worktrees/<projectHash>/<taskId>/`
 *    is found.
 * 3. Return null when not inside any worktree.
 *
 * @param cwd - Working directory at shim invocation time.
 * @returns The worktree root path + task ID, or null when not inside a worktree.
 *
 * @task T1591
 */
export function resolveActiveWorktree(
  cwd: string,
): { worktreePath: string; taskId: string } | null {
  // Explicit env-driven path wins.
  const envWorktree = process.env['CLEO_WORKTREE_ROOT'];
  if (envWorktree && isAbsolute(envWorktree)) {
    const taskId = process.env['CLEO_TASK_ID'] ?? extractTaskIdFromWorktreePath(envWorktree);
    if (taskId) {
      return { worktreePath: resolve(envWorktree), taskId };
    }
  }

  // Walk up from cwd until we find a path that matches the worktree layout.
  if (!isInsideWorktreesRoot(cwd)) return null;

  const worktreesRoot = resolve(resolveCleoWorktreesRoot());
  let candidate = resolve(cwd);
  // Climb until parent is the projectHash directory (one level under worktreesRoot).
  while (candidate !== '/' && candidate.length > worktreesRoot.length) {
    const parent = normalize(join(candidate, '..'));
    // parent should be `<worktreesRoot>/<projectHash>`.
    if (
      parent.startsWith(`${worktreesRoot}/`) &&
      parent.split(/[/\\]/).filter(Boolean).length ===
        worktreesRoot.split(/[/\\]/).filter(Boolean).length + 1
    ) {
      const taskId = candidate.split(/[/\\]/).pop() ?? '';
      return taskId ? { worktreePath: candidate, taskId } : null;
    }
    if (parent === candidate) break;
    candidate = parent;
  }
  return null;
}

/**
 * Check whether an absolute path lives inside the given worktree.
 *
 * @param targetPath - Absolute path to test.
 * @param worktreePath - Absolute path to the worktree root.
 * @returns true if `targetPath` is the worktree or a descendant.
 *
 * @task T1591
 */
export function isPathInsideWorktree(targetPath: string, worktreePath: string): boolean {
  const t = resolve(targetPath);
  const w = resolve(worktreePath);
  return t === w || t.startsWith(`${w}/`) || t.startsWith(`${w}\\`);
}
