/**
 * Worktree creation operation for @cleocode/worktree.
 *
 * Creates a git worktree at the canonical XDG path per D029:
 *   `~/.local/share/cleo/worktrees/<projectHash>/<taskId>/`
 *
 * Also:
 *   - Applies git worktree lock to prevent accidental pruning.
 *   - Runs declarative `post-create` hooks (D030 native lift).
 *   - Applies `.cleo/worktree-include` patterns (D030 native lift).
 *   - Constructs the agent env-var block and prompt preamble.
 *
 * @task T1161
 */

import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { CreateWorktreeOptions, CreateWorktreeResult } from '@cleocode/contracts';
import { getGitRoot, gitSilent, gitSync, resolveHeadRef } from './git.js';
import {
  computeProjectHash,
  resolveTaskWorktreePath,
  resolveWorktreeRootForHash,
} from './paths.js';
import { runWorktreeHooks } from './worktree-hooks.js';
import { applyIncludePatterns, loadWorktreeIncludePatterns } from './worktree-include.js';

/**
 * Create a git worktree for an agent task.
 *
 * Steps:
 * 1. Resolve paths and project hash from the project root.
 * 2. Remove stale worktree at the same path if it exists.
 * 3. If `task/<taskId>` branch already exists (leftover from a prior aborted
 *    spawn), attach to it via `git worktree add <path> <branch>` (no `-b`).
 *    Otherwise create a new branch via `git worktree add -b <branch> <path> <baseRef>`.
 * 4. Optionally apply `git worktree lock` to prevent pruning.
 * 5. Run declarative `post-create` hooks.
 * 6. Apply `.cleo/worktree-include` glob patterns (symlinks).
 * 7. Build and return the {@link CreateWorktreeResult}.
 *
 * Branch-reuse semantics: when a prior spawn aborted after creating the branch
 * but before the worker committed anything, the branch still points to
 * `baseRef`. Reattaching is safe — the worker continues from a clean state.
 * The returned result includes {@link CreateWorktreeResult.reused} so callers
 * can distinguish between a fresh branch and a reattached one if needed.
 *
 * @param projectRoot - Absolute path to the project root directory.
 * @param options - Options controlling the worktree creation.
 * @returns The created worktree result with env vars and preamble.
 * @throws Error if git worktree add fails.
 *
 * @task T1161
 * @task T1878
 */
export async function createWorktree(
  projectRoot: string,
  options: CreateWorktreeOptions,
): Promise<CreateWorktreeResult> {
  const { taskId, hooks = [], lockWorktree = true } = options;
  const applyInclude = options.applyIncludePatterns !== false;

  const gitRoot = getGitRoot(projectRoot);
  const projectHash = computeProjectHash(projectRoot);
  const worktreeRoot = resolveWorktreeRootForHash(projectHash);
  mkdirSync(worktreeRoot, { recursive: true });

  const branch = options.branchName ?? `task/${taskId}`;
  const baseRef = options.baseRef ?? resolveHeadRef(gitRoot);
  const worktreePath = resolveTaskWorktreePath(projectHash, taskId);

  // Remove stale worktree at this path if it exists (left from a prior run).
  if (existsSync(worktreePath)) {
    gitSilent(['worktree', 'unlock', worktreePath], gitRoot);
    if (!gitSilent(['worktree', 'remove', '--force', worktreePath], gitRoot)) {
      rmSync(worktreePath, { recursive: true, force: true });
    }
    // Best-effort: delete the stale branch so we always start fresh when the
    // directory existed (the branch-reuse path below handles the case where
    // only the branch survives without a directory).
    gitSilent(['branch', '-D', branch], gitRoot);
  }

  // Check whether the branch already exists without a worktree directory.
  // This happens when a prior spawn created the branch but the worktree
  // directory was cleaned up (e.g. aborted after `git worktree add` but
  // before the agent ran). Attaching to the existing branch avoids the
  // "branch already exists" error from `git worktree add -b`.
  // `git branch --list <branch>` exits 0 regardless; non-empty output means
  // the branch exists.
  const branchExists = gitSync(['branch', '--list', branch], gitRoot).trim() !== '';

  let reused: boolean;
  if (branchExists) {
    // Attach to the existing branch — no -b flag.
    gitSync(['worktree', 'add', worktreePath, branch], gitRoot);
    reused = true;
  } else {
    // Create the worktree with a new branch.
    gitSync(['worktree', 'add', '-b', branch, worktreePath, baseRef], gitRoot);
    reused = false;
  }

  // Apply git worktree lock to prevent accidental pruning.
  let locked = false;
  if (lockWorktree) {
    // Try with --reason (git >= 2.37), fall back without.
    if (
      gitSilent(['worktree', 'lock', '--reason', `cleo-agent-${taskId}`, worktreePath], gitRoot)
    ) {
      locked = true;
    } else if (gitSilent(['worktree', 'lock', worktreePath], gitRoot)) {
      locked = true;
    }
  }

  const createdAt = new Date().toISOString();

  // Run post-create hooks before returning the handle.
  const hookResults = await runWorktreeHooks(hooks, 'post-create', worktreePath);

  // Apply .cleo/worktree-include patterns.
  let appliedPatterns: ReturnType<typeof applyIncludePatterns> = [];
  if (applyInclude) {
    const patterns = loadWorktreeIncludePatterns(projectRoot);
    appliedPatterns = applyIncludePatterns(patterns, projectRoot, worktreePath);
  }

  // Build env vars for agent spawn.
  const currentPath = process.env['PATH'] ?? '';
  const shimDir = join(projectRoot, '.cleo', 'bin', 'git-shim');
  const envVars: Record<string, string> = {
    CLEO_AGENT_ROLE: 'worker',
    CLEO_AGENT_CWD: worktreePath,
    CLEO_WORKTREE_ROOT: worktreePath,
    CLEO_WORKTREE_BRANCH: branch,
    CLEO_PROJECT_HASH: projectHash,
    CLEO_BRANCH_PROTECTION: 'strict',
    CLEO_SHIM_MARKER: '.cleo/bin/git-shim',
    PATH: `${shimDir}:${currentPath}`,
  };

  // Build the preamble text for agent context isolation (per acceptance criterion).
  const preamble = [
    '## BRANCH ISOLATION PROTOCOL (MANDATORY)',
    '',
    `CLEO_AGENT_CWD=${worktreePath}`,
    '',
    `FIRST ACTION: cd ${worktreePath}`,
    '',
    `You are working on branch: ${branch}`,
    'You MUST NOT run any of these git commands:',
    '  git checkout, git switch, git branch -b/-D, git reset --hard,',
    '  git worktree add/remove, git rebase, git stash pop, git push --force',
    '',
    'A git shim is active on your PATH that will exit 77 if you attempt these.',
    `Your working directory is: ${worktreePath}`,
    `You are authorized only within \`${worktreePath}\``,
    'All your commits must land on YOUR branch only.',
    '',
  ].join('\n');

  return {
    path: worktreePath,
    branch,
    baseRef,
    taskId,
    projectHash,
    createdAt,
    locked,
    reused,
    envVars,
    preamble,
    hookResults,
    appliedPatterns,
  };
}
