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
 * 60s mirrors the T9501 `runGitWithLockRetry` budget — long enough for normal
 * `git worktree add` on large repos, short enough that a hung child surfaces
 * a clear timeout error to the spawn pipeline supervisor.
 *
 * @task T9545
 */
export const DEFAULT_GIT_TIMEOUT_MS = 60_000;

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
