/**
 * Low-level git helpers for @cleocode/worktree.
 *
 * All git invocations use `execFileSync` / `execFile` with explicit arg
 * arrays (never shell interpolation) to prevent command injection.
 *
 * T9545 — every helper now enforces a default per-subprocess timeout
 * (`DEFAULT_GIT_TIMEOUT_MS`) so a wedged git child can never block the
 * spawn pipeline indefinitely. Callers may override per-call.
 *
 * @task T1161
 * @task T9545
 */

import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Default per-subprocess timeout for every git invocation in this module.
 *
 * 180s allows large-repo `git worktree add` (~95s observed on the cleocode
 * monorepo with 10,712 tracked files) to complete while still bounding wedged
 * git children — a clear timeout error still surfaces to the spawn pipeline
 * supervisor before the overall {@link SPAWN_BUDGET_MS} fires (T9823).
 *
 * @task T9545
 * @task T9823
 */
export const DEFAULT_GIT_TIMEOUT_MS = 180_000;

/**
 * Run a git command synchronously and return trimmed stdout.
 *
 * @param args - Git argument array (do NOT include "git" as first element).
 * @param cwd - Working directory for the git command.
 * @param timeoutMs - Optional timeout override in milliseconds. Defaults to
 *   {@link DEFAULT_GIT_TIMEOUT_MS}. Pass `0` to disable (NOT recommended).
 * @returns Trimmed stdout string.
 * @throws Error if the command exits non-zero or exceeds the timeout.
 * @task T9545
 */
export function gitSync(args: string[], cwd: string, timeoutMs?: number): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS,
  }).trim();
}

/**
 * Run a git command synchronously, returning false instead of throwing on error.
 *
 * Useful for best-effort cleanup operations where failure is non-fatal.
 *
 * @param args - Git argument array.
 * @param cwd - Working directory.
 * @param timeoutMs - Optional timeout override in milliseconds. Defaults to
 *   {@link DEFAULT_GIT_TIMEOUT_MS}.
 * @returns true on exit 0, false otherwise (including timeout).
 * @task T9545
 */
export function gitSilent(args: string[], cwd: string, timeoutMs?: number): boolean {
  try {
    execFileSync('git', args, {
      cwd,
      stdio: 'pipe',
      timeout: timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Run a git command asynchronously, returning trimmed stdout.
 *
 * @param args - Git argument array.
 * @param cwd - Working directory.
 * @param timeoutMs - Optional timeout override in milliseconds. Defaults to
 *   {@link DEFAULT_GIT_TIMEOUT_MS}.
 * @returns Promise resolving to trimmed stdout.
 * @throws Error if the command exits non-zero or exceeds the timeout.
 * @task T9545
 */
export async function gitAsync(args: string[], cwd: string, timeoutMs?: number): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    encoding: 'utf-8',
    timeout: timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS,
  });
  return stdout.trim();
}

/**
 * Determine the git root directory for a given project path.
 *
 * @param projectRoot - Absolute path to start the search from.
 * @returns Absolute path to the git root.
 * @throws Error if not inside a git repository.
 */
export function getGitRoot(projectRoot: string): string {
  try {
    return gitSync(['rev-parse', '--show-toplevel'], projectRoot);
  } catch {
    throw new Error(`Not a git repository: ${projectRoot}`);
  }
}

/**
 * Resolve the current HEAD ref (branch name or SHA) for a git repository.
 *
 * @param gitRoot - Absolute path to the git root.
 * @param fallback - Value to return if HEAD resolution fails.
 * @returns Current HEAD ref string.
 */
export function resolveHeadRef(gitRoot: string, fallback = 'main'): string {
  try {
    return gitSync(['rev-parse', '--abbrev-ref', 'HEAD'], gitRoot);
  } catch {
    return fallback;
  }
}

/**
 * Options for {@link addTransientWorktree}.
 *
 * @task T9984
 */
export interface AddTransientWorktreeOptions {
  /** Absolute project root the worktree is added to. */
  projectRoot: string;
  /** Absolute path where the worktree directory will be created. */
  worktreePath: string;
  /** Branch name (created or reused if already present). */
  branch: string;
  /** Ref to branch from (e.g. `origin/main`, `origin/<branch>`). */
  baseRef: string;
  /**
   * When true, pass `-B` (force-reset the branch ref). Otherwise `-b` is used
   * (fail if the branch already exists locally).
   *
   * @default true
   */
  resetBranch?: boolean;
}

/**
 * Add a **transient** (non-canonical-location) worktree via `git worktree add`.
 *
 * This is the legitimate escape hatch for callers that need a worktree
 * OUTSIDE the canonical XDG agent-worktree root — for example the
 * `cleo docs publish-pr` flow which provisions a temporary worktree in the
 * OS tmpdir to produce a doc-PR commit/push.
 *
 * Routing through this helper keeps the raw `git worktree add` shell-out
 * confined to `@cleocode/worktree` (the legitimate owner) so the lint gate
 * introduced in T9984 can reject inline `git worktree` calls everywhere
 * else.
 *
 * For AGENT worktrees (under XDG canonical root) use {@link createWorktree}
 * from `@cleocode/worktree/worktree-create.js` instead — it adds locking,
 * include-patterns, hook lifecycle, and sentinel-index registration.
 *
 * @param options - Provisioning options.
 * @throws Error if `git worktree add` exits non-zero.
 *
 * @task T9984
 */
export async function addTransientWorktree(options: AddTransientWorktreeOptions): Promise<void> {
  const { projectRoot, worktreePath, branch, baseRef, resetBranch = true } = options;
  const flag = resetBranch ? '-B' : '-b';
  await gitAsync(['worktree', 'add', flag, branch, worktreePath, baseRef], projectRoot);
}

/**
 * Remove a transient worktree previously created via {@link addTransientWorktree}.
 *
 * Best-effort — failures throw, but callers SHOULD swallow in `finally`
 * blocks so cleanup never masks the underlying error.
 *
 * @param projectRoot - Absolute project root.
 * @param worktreePath - Absolute path to the worktree to remove.
 *
 * @task T9984
 */
export async function removeTransientWorktree(
  projectRoot: string,
  worktreePath: string,
): Promise<void> {
  await gitAsync(['worktree', 'remove', '--force', worktreePath], projectRoot);
}
