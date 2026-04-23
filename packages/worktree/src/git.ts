/**
 * Low-level git helpers for @cleocode/worktree.
 *
 * All git invocations use `execFileSync` / `execFile` with explicit arg
 * arrays (never shell interpolation) to prevent command injection.
 *
 * @task T1161
 */

import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Run a git command synchronously and return trimmed stdout.
 *
 * @param args - Git argument array (do NOT include "git" as first element).
 * @param cwd - Working directory for the git command.
 * @returns Trimmed stdout string.
 * @throws Error if the command exits non-zero.
 */
export function gitSync(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

/**
 * Run a git command synchronously, returning false instead of throwing on error.
 *
 * Useful for best-effort cleanup operations where failure is non-fatal.
 *
 * @param args - Git argument array.
 * @param cwd - Working directory.
 * @returns true on exit 0, false otherwise.
 */
export function gitSilent(args: string[], cwd: string): boolean {
  try {
    execFileSync('git', args, { cwd, stdio: 'pipe' });
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
 * @returns Promise resolving to trimmed stdout.
 * @throws Error if the command exits non-zero.
 */
export async function gitAsync(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    encoding: 'utf-8',
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
