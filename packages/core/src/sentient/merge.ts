/**
 * FF-only git merge utility for the Tier-3 merge ritual.
 *
 * Enforces the linear-history contract: merges MUST be fast-forward only.
 * If the experiment branch has diverged from the target (i.e. cannot be
 * fast-forwarded), the merge is aborted immediately. The codebase NEVER
 * auto-rebases — the caller must resolve divergence manually and retry.
 *
 * Kill-switch checks are performed at `pre-merge` and `post-merge` step
 * boundaries via {@link checkKillSwitch}. A kill between the merge commit
 * landing and the post-merge check cannot be auto-reverted by this utility;
 * the caller is responsible for manual cleanup in that case.
 *
 * Algorithm:
 *   1. `checkKillSwitch('pre-merge')` — abort before touching git
 *   2. `git -C <targetBranchCwd> merge --ff-only <experimentRef>`
 *   3. Non-zero exit → `git merge --abort` (safety net), return
 *      `{ merged: false, reason: 'ff-failed-abort' }`
 *   4. `checkKillSwitch('post-merge')` — warn but cannot auto-revert
 *   5. Return `{ merged: true, headSha }`
 *
 * Subprocess safety:
 * - All git arguments are passed as separate array elements to
 *   `child_process.spawn`. No shell interpolation of user-supplied strings.
 * - `shell: false` (Node default) ensures paths with spaces or special
 *   characters cannot escape into shell metacharacter injection.
 *
 * @see ADR-054 — Sentient Loop Tier-3 (sandbox auto-merge)
 * @task T1028
 */

import { spawn } from 'node:child_process';
import { checkKillSwitch } from './kill-switch.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result returned by {@link gitFfMerge}. */
export interface MergeResult {
  /** Whether the fast-forward merge succeeded and was committed. */
  merged: boolean;
  /**
   * HEAD SHA of the target branch after the operation.
   *
   * - When `merged: true` — the new HEAD after the ff-merge.
   * - When `merged: false` — the unchanged HEAD (merge was aborted).
   * - Empty string on unexpected git failure.
   */
  headSha: string;
  /**
   * Reason for a non-merged outcome.
   *
   * - `'ff-failed-abort'` — `git merge --ff-only` exited non-zero; histories
   *   have diverged. The caller MUST resolve divergence manually.
   * - `'kill-switch-activated'` — kill switch fired at `pre-merge`; merge was
   *   never attempted.
   * - `'verify-failed'` — git subprocess could not be spawned or an unexpected
   *   error occurred during the merge operation.
   */
  reason?: 'ff-failed-abort' | 'kill-switch-activated' | 'verify-failed';
}

/** Options for {@link gitFfMerge}. */
export interface GitFfMergeOptions {
  /**
   * Absolute path to the experiment worktree (the directory that contains the
   * experiment branch's work tree). Used to derive the experiment ref.
   */
  experimentWorktree: string;
  /**
   * Name of the target branch (e.g. `'main'`). The merge is performed inside
   * the working directory of the target branch — callers must ensure `cwd`
   * resolves to a worktree that has `targetBranch` checked out.
   *
   * The merge command run is:
   * ```
   * git -C <targetBranchCwd> merge --ff-only <experimentRef>
   * ```
   * where `<targetBranchCwd>` is resolved from `experimentWorktree` via
   * the `cwd` option below, or defaults to `process.cwd()`.
   */
  targetBranch: string;
  /**
   * Working directory for git commands. Should be a worktree that has
   * `targetBranch` checked out.
   *
   * Defaults to `process.cwd()`.
   */
  cwd?: string;
  /**
   * Override for the git binary path. Defaults to `'git'` (from PATH).
   * Useful for testing with a fake git script.
   */
  gitBin?: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Result of a raw git subprocess invocation. */
interface GitRunResult {
  /** Exit code (0 = success). */
  exitCode: number;
  /** Captured stdout. */
  stdout: string;
  /** Captured stderr. */
  stderr: string;
}

/**
 * Run a git command as a child process.
 *
 * Arguments are passed as a plain array — no shell interpolation.
 * `shell: false` is the Node.js default for `spawn`.
 *
 * @param gitBin - Path to the git binary.
 * @param args - Argument list (each element is a separate argument).
 * @param cwd - Working directory for the git command.
 * @returns Resolved promise with exit code + captured output.
 */
function runGit(gitBin: string, args: readonly string[], cwd: string): Promise<GitRunResult> {
  return new Promise<GitRunResult>((resolve) => {
    let stdout = '';
    let stderr = '';

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(gitBin, [...args], {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        // shell: false is Node's default — explicitly documenting intent.
        shell: false,
      });
    } catch (err) {
      // spawn itself threw (e.g. binary not found).
      resolve({
        exitCode: 127,
        stdout: '',
        stderr: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    child.stdout?.setEncoding('utf-8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });

    child.stderr?.setEncoding('utf-8');
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });

    child.on('error', (err: Error) => {
      resolve({
        exitCode: 1,
        stdout,
        stderr: stderr + `\n[merge] git spawn error: ${err.message}`,
      });
    });

    child.on('exit', (code) => {
      resolve({
        exitCode: code ?? 1,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      });
    });
  });
}

/**
 * Read the current HEAD SHA of the given worktree.
 *
 * Returns an empty string on failure (non-git directory, detached HEAD, etc.).
 *
 * @param gitBin - Path to the git binary.
 * @param cwd - Working directory (the relevant worktree).
 */
async function readHeadSha(gitBin: string, cwd: string): Promise<string> {
  const result = await runGit(gitBin, ['rev-parse', 'HEAD'], cwd);
  if (result.exitCode !== 0) return '';
  return result.stdout.trim();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Perform a fast-forward-only git merge of an experiment worktree into the
 * target branch.
 *
 * The merge is the final gating action of the Tier-3 ritual. This function
 * enforces two invariants:
 *
 * 1. **Linear history only** — if `git merge --ff-only` exits non-zero, the
 *    merge is immediately aborted (`git merge --abort`) and
 *    `{ merged: false, reason: 'ff-failed-abort' }` is returned. The caller
 *    MUST resolve the divergence manually before retrying.
 *
 * 2. **Kill-switch gates** — the kill switch is checked at `pre-merge` before
 *    any git command is issued, and at `post-merge` after a successful merge.
 *    A `post-merge` kill-switch activation cannot be auto-reverted; the caller
 *    receives `{ merged: true, headSha }` and must handle cleanup.
 *
 * @param options - See {@link GitFfMergeOptions}.
 * @returns {@link MergeResult} describing the outcome.
 */
export async function gitFfMerge(options: GitFfMergeOptions): Promise<MergeResult> {
  const { experimentWorktree, cwd = process.cwd(), gitBin = 'git' } = options;

  // -- Step 1: kill-switch check before any git operation -------------------
  try {
    await checkKillSwitch('pre-merge');
  } catch {
    // KillSwitchActivatedError or unexpected — abort without touching git.
    const headSha = await readHeadSha(gitBin, cwd).catch(() => '');
    return { merged: false, headSha, reason: 'kill-switch-activated' };
  }

  // -- Step 2: attempt ff-only merge ----------------------------------------
  // The experiment ref is the HEAD of the experiment worktree.
  // We use `git -C <cwd> merge --ff-only <experimentRef>` where experimentRef
  // is resolved from the experiment worktree's HEAD.
  const experimentRef = await readHeadSha(gitBin, experimentWorktree);
  if (!experimentRef) {
    const headSha = await readHeadSha(gitBin, cwd).catch(() => '');
    return { merged: false, headSha, reason: 'verify-failed' };
  }

  const mergeResult = await runGit(gitBin, ['merge', '--ff-only', experimentRef], cwd);

  if (mergeResult.exitCode !== 0) {
    // -- Step 3: non-FF — abort and return immediately ----------------------
    // Run `git merge --abort` as a safety net; ignore its exit code because
    // the merge may not have left an in-progress state if it failed early.
    await runGit(gitBin, ['merge', '--abort'], cwd).catch(() => {
      // Swallow — abort is best-effort.
    });

    const headSha = await readHeadSha(gitBin, cwd).catch(() => '');
    return { merged: false, headSha, reason: 'ff-failed-abort' };
  }

  // -- Step 4: kill-switch check after merge --------------------------------
  // The merge has already landed. If the kill switch fires here the operator
  // must manually revert — we still return `merged: true` so the caller can
  // log the situation correctly.
  try {
    await checkKillSwitch('post-merge');
  } catch {
    // Kill switch fired after merge — return merged:true with headSha so the
    // caller knows the merge landed and can decide whether to revert.
    const headSha = await readHeadSha(gitBin, cwd).catch(() => '');
    return { merged: true, headSha };
  }

  // -- Step 5: success -------------------------------------------------------
  const headSha = await readHeadSha(gitBin, cwd).catch(() => '');
  return { merged: true, headSha };
}
