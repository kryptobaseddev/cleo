/**
 * Declarative worktree hooks framework — native lift of worktrunk's hooks
 * feature per D030.
 *
 * Executes `post-create` and `post-start` hooks in the worktree directory.
 * Each hook runs via `sh -c <command>` with the worktree path as CWD.
 *
 * @task T1161
 */

import { execFile } from 'node:child_process';
import type { WorktreeHook, WorktreeHookResult } from '@cleocode/contracts';

const DEFAULT_HOOK_TIMEOUT_MS = 30_000;

/**
 * Execute a single declarative hook in the given worktree directory.
 *
 * @param hook - The hook definition to execute.
 * @param worktreePath - Absolute path to the worktree directory (CWD for hook).
 * @returns Hook execution result.
 */
export async function runSingleHook(
  hook: WorktreeHook,
  worktreePath: string,
): Promise<WorktreeHookResult> {
  const timeoutMs = hook.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS;
  const start = Date.now();

  return new Promise<WorktreeHookResult>((resolve) => {
    const child = execFile(
      'sh',
      ['-c', hook.command],
      {
        cwd: worktreePath,
        timeout: timeoutMs,
        encoding: 'utf-8',
      },
      (_err, stdout, stderr) => {
        const durationMs = Date.now() - start;
        const exitCode = child.exitCode;
        const timedOut = exitCode === null && durationMs >= timeoutMs;

        resolve({
          hook,
          success: exitCode === 0,
          stdout: (typeof stdout === 'string' ? stdout : '').trim(),
          stderr: (typeof stderr === 'string' ? stderr : '').trim(),
          exitCode: timedOut ? null : (exitCode ?? 0),
          durationMs,
        });
      },
    );
  });
}

/**
 * Run all hooks matching a given lifecycle event in order.
 *
 * Hooks are run sequentially. If a hook has `failOnError: true` and exits
 * non-zero, execution stops immediately and the error is propagated.
 *
 * @param hooks - All hook definitions (may include hooks for other events).
 * @param event - The lifecycle event to filter and run.
 * @param worktreePath - Absolute path to the worktree directory.
 * @returns Array of results for hooks that were executed.
 * @throws Error if a `failOnError` hook fails.
 */
export async function runWorktreeHooks(
  hooks: readonly WorktreeHook[],
  event: WorktreeHook['event'],
  worktreePath: string,
): Promise<WorktreeHookResult[]> {
  const results: WorktreeHookResult[] = [];
  const filtered = hooks.filter((h) => h.event === event);

  for (const hook of filtered) {
    const result = await runSingleHook(hook, worktreePath);
    results.push(result);

    if (!result.success && hook.failOnError) {
      throw new Error(
        `Worktree hook failed (failOnError=true): ${hook.command}\n` +
          `exit: ${result.exitCode}\nstderr: ${result.stderr}`,
      );
    }
  }

  return results;
}
