/**
 * `cleo orchestrate spawn --include-deps` (T14045): the base a task branch
 * starts from when it builds on dependencies whose branches have not landed.
 *
 * The orchestrator merges each dependency's `task/<id>` branch, `--no-ff`, into
 * a commit made in a TEMPORARY integration worktree under the project's
 * canonical worktree root; the primary checkout is never touched. The merge
 * commit is then handed to the `--base` path (T14027), so the resolved-sha
 * guard and the lifecycle audit apply as for any explicit base. Nothing is
 * cherry-picked or rewritten: every dependency commit stays reachable.
 *
 * @task T14045
 */

import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { addTransientWorktree, removeTransientWorktree } from '@cleocode/worktree';
import { resolveAgentWorktreeRoot } from '../spawn/branch-lock.js';

/** One dependency branch folded into the integration commit. */
export interface IncludedDependency {
  /** Dependency task id. */
  taskId: string;
  /** Its branch, `task/<id>`. */
  branch: string;
  /** The commit the branch pointed to when it was merged. */
  sha: string;
}

/** The integration commit, or why none could be built. */
export type DependencyIntegration =
  | {
      ok: true;
      /** Commit the task branch is created from (the last merge, or the base). */
      sha: string;
      /** The base the merges started from, as named (`HEAD` when none). */
      baseRef: string;
      /** The commit `baseRef` resolved to. */
      baseSha: string;
      /** Every dependency merged, in dependency order. */
      dependencies: IncludedDependency[];
    }
  | {
      ok: false;
      /** `E_INCLUDE_DEPS_MISSING`, `E_INCLUDE_DEPS_DIVERGED` or `E_WORKTREE_BASE_INVALID`. */
      code: string;
      message: string;
      fix: string;
    };

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function tryGit(cwd: string, args: readonly string[]): string | null {
  try {
    return git(cwd, args);
  } catch {
    return null;
  }
}

/**
 * Build the integration commit for `taskId` from its dependencies' branches.
 *
 * A dependency with no `task/<id>` branch is refused (its work cannot be
 * shown to be in the base), as is one sharing no history with the base or
 * one whose merge conflicts. On success the base ref, its sha and each
 * dependency sha are appended to `.cleo/audit/worktree-integration.jsonl`.
 * The temporary worktree is always removed; no existing worktree is touched.
 *
 * @param projectRoot - The project's git checkout.
 * @param taskId - The task being spawned.
 * @param dependencies - Its dependency task ids, in order.
 * @param baseRef - Ref the merges start from (`--base`); HEAD when omitted.
 * @returns The integration commit, or the refusal.
 * @task T14045
 */
export async function buildDependencyIntegration(
  projectRoot: string,
  taskId: string,
  dependencies: readonly string[],
  baseRef?: string,
): Promise<DependencyIntegration> {
  const base = baseRef ?? 'HEAD';
  const baseSha = tryGit(projectRoot, ['rev-parse', '--verify', '--quiet', `${base}^{commit}`]);
  if (!baseSha) {
    return {
      ok: false,
      // @sync-invariant none:input-shape a --base that does not resolve is refused before any write
      code: 'E_WORKTREE_BASE_INVALID',
      message: `base '${base}' does not resolve to a commit`,
      fix: 'Pass --base a branch, tag or sha that exists.',
    };
  }
  const included: IncludedDependency[] = [];
  for (const dep of dependencies) {
    const branch = `task/${dep}`;
    const sha = tryGit(projectRoot, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
    if (!sha) {
      return {
        ok: false,
        // @sync-invariant none:input-shape a dependency with no branch is refused before any write
        code: 'E_INCLUDE_DEPS_MISSING',
        message: `dependency ${dep} has no branch '${branch}' to include`,
        fix: `Spawn without --include-deps when ${dep} has already landed in the base, or restore its branch.`,
      };
    }
    if (tryGit(projectRoot, ['merge-base', baseSha, sha]) === null) {
      return {
        ok: false,
        // @sync-invariant none:input-shape a dependency that cannot merge onto the base is refused before any write
        code: 'E_INCLUDE_DEPS_DIVERGED',
        message: `dependency branch '${branch}' shares no history with ${base}`,
        fix: `Rebuild ${branch} from the base, or spawn without --include-deps.`,
      };
    }
    included.push({ taskId: dep, branch, sha });
  }

  const scratch = join(
    resolveAgentWorktreeRoot(projectRoot),
    `.integration-${taskId}-${process.pid}-${Date.now()}`,
  );
  let sha = baseSha;
  try {
    mkdirSync(join(scratch, '..'), { recursive: true });
    await addTransientWorktree({ projectRoot, worktreePath: scratch, baseRef: baseSha });
    for (const dep of included) {
      try {
        git(scratch, [
          'merge',
          '--no-ff',
          '--no-edit',
          '-m',
          `Integrate ${dep.branch} into the base of ${taskId} (--include-deps)`,
          dep.sha,
        ]);
      } catch {
        tryGit(scratch, ['merge', '--abort']);
        return {
          ok: false,
          // @sync-invariant none:input-shape a dependency that cannot merge onto the base is refused before any write
          code: 'E_INCLUDE_DEPS_DIVERGED',
          message: `dependency branch '${dep.branch}' does not merge cleanly onto ${base} and the dependencies before it`,
          fix: `Resolve the conflict on ${dep.branch} (rebase it on the base), then retry.`,
        };
      }
    }
    sha = git(scratch, ['rev-parse', 'HEAD']);
  } finally {
    await removeTransientWorktree(projectRoot, scratch).catch(() => undefined);
    rmSync(scratch, { recursive: true, force: true });
  }

  try {
    const auditDir = join(projectRoot, '.cleo', 'audit');
    mkdirSync(auditDir, { recursive: true });
    appendFileSync(
      join(auditDir, 'worktree-integration.jsonl'),
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        action: 'include-deps',
        taskId,
        baseRef: base,
        baseSha,
        integrationSha: sha,
        dependencies: included,
        agent: process.env['CLEO_AGENT_ID'] ?? 'cleo',
      })}\n`,
      'utf-8',
    );
  } catch {
    // Audit is best-effort, as for every worktree-integration row.
  }
  return { ok: true, sha, baseRef: base, baseSha, dependencies: included };
}
