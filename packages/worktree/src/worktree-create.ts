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

import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type {
  CreateWorktreeOptions,
  CreateWorktreeResult,
  WorktreeHookResult,
  WorktreeIncludePattern,
} from '@cleocode/contracts';
import { copyPathsWithReflock } from './copy-on-write.js';

/**
 * Extended result type including the bootstrap field.
 *
 * The contracts package will be updated separately to add this field to
 * {@link CreateWorktreeResult}; this local extension allows the implementation
 * to compile in the interim.
 */
interface CreateWorktreeResultWithBootstrap extends CreateWorktreeResult {
  bootstrap: {
    copiedPaths: string[];
    failedPaths: string[];
    hookResults: WorktreeHookResult[];
  };
  /** Glob patterns actually excluded via sparse-checkout (T9226). */
  appliedExcludePatterns: string[];
  /**
   * The sparse-checkout scope applied to the worktree (T9807), or `null` when
   * no scope was requested or the operation failed.
   */
  appliedScope: string | null;
}

import { BRANCH_LOCK_ERROR_CODES } from '@cleocode/contracts';
import { getCleoWorktreesRoot } from '@cleocode/paths';
import { getGitRoot, gitSilent, gitSync, resolveHeadRef } from './git.js';
import {
  computeProjectHash,
  resolveTaskWorktreePath,
  resolveWorktreeRootForHash,
} from './paths.js';
import { addWorktreeToSentinelIndex, appendWorktreeAuditLog } from './worktree-audit.js';

/**
 * Assert that `targetPath` sits inside the canonical XDG worktrees root
 * (`<cleoHome>/worktrees/`). Throws `E_WT_LOCATION_FORBIDDEN` if not.
 *
 * Per AC4 / council verdict D009: there is NO escape hatch — not even a
 * `CLEO_FORCE_LOCATION` env var. Worktrees outside the canonical location
 * are unconditionally rejected.
 *
 * @param targetPath - Absolute path that will be passed to `git worktree add`.
 * @throws Error with code `E_WT_LOCATION_FORBIDDEN` when outside canonical root.
 *
 * @task T9809
 */
function assertCanonicalWorktreeLocation(targetPath: string): void {
  const canonicalRoot = getCleoWorktreesRoot();
  // Normalise both paths to use forward slashes and ensure the root ends with
  // a separator so we don't accidentally match a sibling path that shares a
  // prefix (e.g. `/cleo-home/worktrees-other/` vs `/cleo-home/worktrees/`).
  const normalRoot = canonicalRoot.endsWith('/') ? canonicalRoot : `${canonicalRoot}/`;
  const normalTarget = targetPath.replaceAll('\\', '/');
  const normalRootFwd = normalRoot.replaceAll('\\', '/');

  if (!normalTarget.startsWith(normalRootFwd)) {
    throw Object.assign(
      new Error(
        `E_WT_LOCATION_FORBIDDEN: worktree path "${targetPath}" is outside the ` +
          `canonical XDG location "${canonicalRoot}". ` +
          `All worktrees MUST live under <cleoHome>/worktrees/<projectHash>/<taskId>/. ` +
          `There is no override — see Saga T9800 SG-WORKTREE-CANON and ADR decision D009.`,
      ),
      { code: 'E_WT_LOCATION_FORBIDDEN', targetPath, canonicalRoot },
    );
  }
}

import { runWorktreeHooks } from './worktree-hooks.js';
import { applyIncludePatterns, loadWorktreeIncludePatterns } from './worktree-include.js';

/**
 * Apply the T9226 spawn-clone-exclude filter to a newly created worktree.
 *
 * Enables git sparse-checkout in no-cone mode so individual file globs can
 * be excluded. Failures are silently swallowed.
 *
 * @task T9226
 */
function applySpawnCloneExcludeFilter(
  worktreePath: string,
  excludePatterns: readonly string[],
): string[] {
  if (excludePatterns.length === 0) return [];
  try {
    const rules = ['/*', '/**', ...excludePatterns.map((p) => `!${p}`)];
    gitSilent(['sparse-checkout', 'init', '--no-cone'], worktreePath);
    gitSilent(['sparse-checkout', 'set', '--no-cone', ...rules], worktreePath);
    return [...excludePatterns];
  } catch {
    return [];
  }
}

/**
 * Apply T9807 cone-mode sparse-checkout to limit the worktree to a scope
 * directory prefix (e.g. `packages/cleo`).
 *
 * Uses `git sparse-checkout init --cone` followed by
 * `git sparse-checkout set <scope>` — cone mode gives the fastest checkout
 * performance by working at directory granularity instead of arbitrary globs.
 *
 * Failures are silently swallowed — the worktree stays in full-checkout mode
 * when the operation is not supported by the installed git version.
 *
 * @param worktreePath - Absolute path to the newly created worktree.
 * @param scope - Directory prefix to check out (e.g. `packages/cleo`).
 * @returns The applied scope string, or `null` when the operation failed.
 *
 * @task T9807
 */
function applySpawnScope(worktreePath: string, scope: string): string | null {
  if (!scope.trim()) return null;
  try {
    gitSilent(['sparse-checkout', 'init', '--cone'], worktreePath);
    gitSilent(['sparse-checkout', 'set', scope.trim()], worktreePath);
    return scope.trim();
  } catch {
    return null;
  }
}

function isPathSpecifiedInInclude(
  patterns: readonly WorktreeIncludePattern[],
  targetPath: string,
): boolean {
  return patterns.some((p) => {
    if (p.negated) return false;
    if (p.pattern === targetPath) return true;
    if (p.pattern.startsWith(`${targetPath}/`)) return true;
    if (targetPath.startsWith(`${p.pattern}/`)) return true;
    return false;
  });
}

function isPackagesDistSpecifiedInInclude(patterns: readonly WorktreeIncludePattern[]): boolean {
  return patterns.some((p) => {
    if (p.negated) return false;
    if (p.pattern === 'packages/*/dist') return true;
    if (p.pattern.startsWith('packages/') && p.pattern.includes('/dist')) return true;
    return false;
  });
}

/**
 * Create a git worktree for an agent task.
 *
 * Steps:
 * 1. Resolve paths and project hash from the project root.
 * 2. Remove stale worktree at the same path if it exists (dirty worktrees are preserved).
 * 3. If `task/<taskId>` branch already exists (leftover from a prior aborted
 *    spawn), attach to it via `git worktree add <path> <branch>` (no `-b`).
 *    Otherwise create a new branch via `git worktree add -b <branch> <path> <baseRef>`.
 * 4. Optionally apply `git worktree lock` to prevent pruning.
 * 5. Run declarative `post-create` hooks.
 * 6. Apply `.cleo/worktree-include` glob patterns (symlinks).
 * 7. Copy `node_modules` and `packages/ * /dist` via copy-on-write when not already
 *    covered by worktree-include patterns.
 * 8. Run declarative `post-start` hooks.
 * 9. Build and return the {@link CreateWorktreeResult}.
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
): Promise<CreateWorktreeResultWithBootstrap> {
  const { taskId, hooks = [], lockWorktree = true } = options;
  const applyInclude = options.applyIncludePatterns !== false;

  const gitRoot = getGitRoot(projectRoot);
  const projectHash = computeProjectHash(projectRoot);
  const worktreeRoot = resolveWorktreeRootForHash(projectHash);
  mkdirSync(worktreeRoot, { recursive: true });

  const branch = options.branchName ?? `task/${taskId}`;
  const baseRef = options.baseRef ?? resolveHeadRef(gitRoot);
  const worktreePath = resolveTaskWorktreePath(projectHash, taskId);

  // AC1 / T9809: reject any path outside the canonical XDG worktrees root.
  // This check runs BEFORE any filesystem mutation so the error is always clean.
  // There is NO escape hatch — per council verdict D009 the ban is absolute.
  assertCanonicalWorktreeLocation(worktreePath);

  // Remove stale worktree at this path if it exists (left from a prior run).
  // Dirty worktrees are preserved to avoid losing uncommitted agent work.
  if (existsSync(worktreePath)) {
    const porcelain = gitSync(['status', '--porcelain'], worktreePath);
    if (porcelain.trim() !== '') {
      process.stderr.write(
        `[worktree] WARNING: preserving dirty worktree at ${worktreePath} (uncommitted changes detected)\n`,
      );
    } else {
      gitSilent(['worktree', 'unlock', worktreePath], gitRoot);
      if (!gitSilent(['worktree', 'remove', '--force', worktreePath], gitRoot)) {
        rmSync(worktreePath, { recursive: true, force: true });
      }
      // Best-effort: delete the stale branch so we always start fresh when the
      // directory existed (the branch-reuse path below handles the case where
      // only the branch survives without a directory).
      gitSilent(['branch', '-D', branch], gitRoot);
    }
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
    // T1927: detect orphan history — commits on task/<taskId> that are not
    // reachable from baseRef. This happens when test fixtures or prior aborted
    // sessions leave branches with unrelated commits (e.g. T1878 integration
    // tests creating fixture commits on task/ branches). Merging such a branch
    // would import garbage history into the integration base.
    const orphanLog = gitSync(['log', '--format=%H', `${baseRef}..${branch}`], gitRoot).trim();
    const orphanCommits = orphanLog
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);

    if (orphanCommits.length > 0) {
      if (options.forceReset) {
        // Caller explicitly requested reset — delete the stale branch so we
        // fall through to the fresh-branch creation path below.
        gitSilent(['branch', '-D', branch], gitRoot);
        // Fall through: branchExists will be false for the recreate below.
        gitSync(['worktree', 'add', '-b', branch, worktreePath, baseRef], gitRoot);
        reused = false;
      } else {
        throw Object.assign(
          new Error(
            `${BRANCH_LOCK_ERROR_CODES.E_DIRTY_BRANCH}: branch "${branch}" has ` +
              `${orphanCommits.length} commit(s) not reachable from "${baseRef}". ` +
              `This indicates orphan history from a test fixture or prior session. ` +
              `Delete the branch manually (\`git branch -D ${branch}\`) or pass ` +
              `{ forceReset: true } to createWorktree.`,
          ),
          { code: BRANCH_LOCK_ERROR_CODES.E_DIRTY_BRANCH, orphanCommits },
        );
      }
    } else {
      // Branch exists but is clean (points to baseRef or an ancestor) — safe to reuse.
      gitSync(['worktree', 'add', worktreePath, branch], gitRoot);
      reused = true;
    }
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

  // T9226 — spawn-clone-exclude filter: hide files matching the exclude
  // patterns from the worktree via sparse-checkout. Best-effort.
  const excludePatterns = options.spawnCloneExclude ?? [];
  const appliedExcludePatterns =
    excludePatterns.length > 0 ? applySpawnCloneExcludeFilter(worktreePath, excludePatterns) : [];

  // T9807 — spawn scope: limit the worktree to a directory prefix via cone-mode
  // sparse-checkout (e.g. `packages/cleo` for a CLI-only task). Best-effort;
  // falls back to full checkout when the operation fails or is not supported.
  // Only applied when no exclude-patterns sparse-checkout is already active to
  // avoid conflicting sparse-checkout modes.
  const spawnScope = options.spawnScope ?? null;
  const appliedScope =
    spawnScope && appliedExcludePatterns.length === 0
      ? applySpawnScope(worktreePath, spawnScope)
      : null;

  // Run post-create hooks before returning the handle.
  const postCreateHookResults = await runWorktreeHooks(hooks, 'post-create', worktreePath);

  // Apply .cleo/worktree-include patterns.
  let appliedPatterns: ReturnType<typeof applyIncludePatterns> = [];
  if (applyInclude) {
    const patterns = loadWorktreeIncludePatterns(projectRoot);
    appliedPatterns = applyIncludePatterns(patterns, projectRoot, worktreePath);
  }

  // Copy-on-write bootstrap: node_modules and packages/*/dist when not already
  // specified in .cleo/worktree-include.
  const pathsToCopy: string[] = [];

  const includePatterns = applyInclude ? loadWorktreeIncludePatterns(projectRoot) : [];

  if (!isPathSpecifiedInInclude(includePatterns, 'node_modules')) {
    pathsToCopy.push('node_modules');
  }

  if (!isPackagesDistSpecifiedInInclude(includePatterns)) {
    const packagesDir = join(projectRoot, 'packages');
    if (existsSync(packagesDir)) {
      for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const distRel = join('packages', entry.name, 'dist');
        if (existsSync(join(projectRoot, distRel))) {
          pathsToCopy.push(distRel);
        }
      }
    }
  }

  const { copied: copiedPaths, failed: failedPaths } = await copyPathsWithReflock(
    pathsToCopy,
    projectRoot,
    worktreePath,
  );

  // Run post-start hooks after copy-on-write bootstrap.
  const postStartHookResults = await runWorktreeHooks(hooks, 'post-start', worktreePath);

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

  // T9805 AC3: Append audit log entry for every worktree creation.
  appendWorktreeAuditLog(projectRoot, {
    action: reused ? 'adopt' : 'create',
    xdgPath: worktreePath,
    taskId,
    branch,
    reason: reused ? 'branch-reuse' : 'spawn',
    success: true,
  });

  // T9805 D009: Register this worktree in the sentinel index.
  addWorktreeToSentinelIndex(gitRoot, taskId, { path: worktreePath, branch, createdAt });

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
    hookResults: postCreateHookResults,
    appliedPatterns,
    appliedExcludePatterns,
    appliedScope,
    bootstrap: {
      copiedPaths,
      failedPaths,
      hookResults: postStartHookResults,
    },
  };
}
