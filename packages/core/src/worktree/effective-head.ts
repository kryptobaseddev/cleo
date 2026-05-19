import { execFileSync } from 'node:child_process';

/**
 * Resolve the effective HEAD ref for evidence validation in a worktree context.
 *
 * When a task branch exists, returns `"task/<taskId>"`. Otherwise falls back to `"HEAD"`.
 * Used by validateCommit's `--is-ancestor` check so commits on a worktree's task
 * branch are correctly recognized as reachable.
 *
 * @task T-WT-1
 * @task T9600
 * @epic T9586
 */
export async function getEffectiveHead(projectRoot: string, taskId?: string): Promise<string> {
  if (!taskId) return 'HEAD';
  try {
    execFileSync('git', ['rev-parse', '--verify', `refs/heads/task/${taskId}`], {
      cwd: projectRoot,
      stdio: 'ignore',
    });
    return `task/${taskId}`;
  } catch {
    return 'HEAD';
  }
}
