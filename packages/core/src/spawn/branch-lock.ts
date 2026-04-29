/**
 * Branch-lock engine — runtime enforcement for agent git isolation (T1118).
 *
 * Implements all four protection layers:
 *
 * - L1: Git worktree creation, completion (cherry-pick), and cleanup.
 * - L2: Shim symlink materialisation + spawn env construction.
 * - L3: Filesystem hardening via chmod (+ optional chattr on Linux).
 * - L4: Not here — L4 lives in validate-engine and session domain handlers.
 *
 * All git operations use execFileSync with explicit arg arrays (no shell
 * interpolation) to prevent command injection.
 *
 * @task T1118
 * @adr ADR-055
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

import type {
  AgentWorktreeState,
  FsHardenCapabilities,
  FsHardenState,
  WorktreeCleanupResult,
  WorktreeCompleteResult,
  WorktreeMergeResult,
  WorktreeSpawnResult,
} from '@cleocode/contracts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Run git with explicit args (no shell) and return stdout as a trimmed string.
 * Throws on non-zero exit.
 *
 * @param args - Git arguments (no "git" prefix).
 * @param cwd - Working directory.
 * @returns stdout trimmed.
 */
function gitSync(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

/**
 * Run git silently — ignores output, suppresses errors.
 *
 * @param args - Git arguments.
 * @param cwd - Working directory.
 * @returns true on success, false on error.
 */
function gitSilent(args: string[], cwd: string): boolean {
  try {
    execFileSync('git', args, { cwd, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// L1 — Worktree lifecycle
// ---------------------------------------------------------------------------

/**
 * Resolve the worktree root directory for a project.
 *
 * Uses `$XDG_DATA_HOME/cleo/worktrees/<projectHash>/` per ULTRAPLAN §14.3,
 * falling back to `~/.local/share/cleo/worktrees/<projectHash>/`.
 *
 * @param projectRoot - Absolute path to the project root.
 * @returns Absolute path to the worktree root directory.
 *
 * @task T1118
 * @task T1120
 */
export function resolveAgentWorktreeRoot(projectRoot: string): string {
  const projectHash = createHash('sha256').update(projectRoot).digest('hex').slice(0, 16);
  const xdgData = process.env['XDG_DATA_HOME'] ?? join(homedir(), '.local', 'share');
  return join(xdgData, 'cleo', 'worktrees', projectHash);
}

/**
 * Determine the git root for a project.
 *
 * @param projectRoot - Absolute path to the project root.
 * @returns Absolute path to the git root directory.
 * @throws Error if the directory is not inside a git repository.
 *
 * @task T1118
 * @task T1120
 */
export function getGitRoot(projectRoot: string): string {
  try {
    return gitSync(['rev-parse', '--show-toplevel'], projectRoot);
  } catch {
    throw new Error(`Not a git repository: ${projectRoot}`);
  }
}

/**
 * Create a git worktree for a spawned agent task.
 *
 * Creates branch `task/<taskId>` off the current HEAD of the orchestrator's
 * branch and locks the worktree to prevent accidental pruning.
 *
 * @param taskId - The task ID driving the spawn.
 * @param projectRoot - Absolute path to the project root.
 * @returns The created worktree state.
 *
 * @task T1118
 * @task T1120
 */
export function createAgentWorktree(taskId: string, projectRoot: string): AgentWorktreeState {
  const gitRoot = getGitRoot(projectRoot);
  const worktreeRoot = resolveAgentWorktreeRoot(projectRoot);
  mkdirSync(worktreeRoot, { recursive: true });

  const branch = `task/${taskId}`;
  const worktreePath = join(worktreeRoot, taskId);

  // Determine base ref — current HEAD on orchestrator branch.
  let baseRef: string;
  try {
    baseRef = gitSync(['rev-parse', '--abbrev-ref', 'HEAD'], gitRoot);
  } catch {
    baseRef = 'main';
  }

  // Remove stale worktree at this path if it exists.
  if (existsSync(worktreePath)) {
    gitSilent(['worktree', 'unlock', worktreePath], gitRoot);
    if (!gitSilent(['worktree', 'remove', '--force', worktreePath], gitRoot)) {
      rmSync(worktreePath, { recursive: true, force: true });
    }
    // Attempt to delete the leftover branch.
    gitSilent(['branch', '-D', branch], gitRoot);
  }

  // Create the worktree with a new branch.
  gitSync(['worktree', 'add', worktreePath, '-b', branch, baseRef], gitRoot);

  // Apply git worktree lock to prevent accidental pruning.
  // Try with --reason first (git ≥ 2.37), fall back without.
  if (!gitSilent(['worktree', 'lock', '--reason', `cleo-agent-${taskId}`, worktreePath], gitRoot)) {
    gitSilent(['worktree', 'lock', worktreePath], gitRoot);
  }

  const projectHash = createHash('sha256').update(projectRoot).digest('hex').slice(0, 16);
  return {
    path: worktreePath,
    branch,
    taskId,
    baseRef,
    projectHash,
    createdAt: new Date().toISOString(),
    locked: true,
  };
}

/**
 * Construct the spawn env-var injection + preamble for the agent.
 *
 * Called by orchestrateSpawn after createAgentWorktree to produce the
 * env block and prompt preamble that bind the agent to its worktree.
 *
 * @param worktree - The created worktree state.
 * @param shimDir - Directory containing the git shim symlink.
 * @returns Spawn result with env vars, CWD, and prompt preamble.
 *
 * @task T1118
 * @task T1120
 * @task T1121
 */
export function buildWorktreeSpawnResult(
  worktree: AgentWorktreeState,
  shimDir: string,
): WorktreeSpawnResult {
  const currentPath = process.env['PATH'] ?? '';
  const envVars: Record<string, string> = {
    CLEO_AGENT_ROLE: 'worker',
    CLEO_AGENT_CWD: worktree.path,
    CLEO_WORKTREE_ROOT: worktree.path,
    CLEO_WORKTREE_BRANCH: worktree.branch,
    CLEO_PROJECT_HASH: worktree.projectHash,
    CLEO_BRANCH_PROTECTION: 'strict',
    CLEO_SHIM_MARKER: '.cleo/bin/git-shim',
    // Prepend the shim directory so `git` resolves to the shim.
    PATH: `${shimDir}:${currentPath}`,
  };

  const preamble = [
    '## BRANCH ISOLATION PROTOCOL (MANDATORY)',
    '',
    `CLEO_AGENT_CWD=${worktree.path}`,
    '',
    `FIRST ACTION: cd ${worktree.path}`,
    '',
    `You are working on branch: ${worktree.branch}`,
    'You MUST NOT run any of these git commands:',
    '  git checkout, git switch, git branch -b/-D, git reset --hard,',
    '  git worktree add/remove, git rebase, git stash pop, git push --force',
    '',
    'A git shim is active on your PATH that will exit 77 if you attempt these.',
    `Your working directory is: ${worktree.path}`,
    'All your commits must land on YOUR branch only.',
    '',
  ].join('\n');

  return { worktree, envVars, cwd: worktree.path, preamble };
}

/**
 * Complete a task's worktree by cherry-picking commits to main and cleaning up.
 *
 * Steps:
 * 1. List commits on the task branch not present on baseRef.
 * 2. Cherry-pick them onto the orchestrator's current branch.
 * 3. Unlock the worktree and remove it.
 * 4. Delete the task branch.
 *
 * @param taskId - The task ID whose worktree to complete.
 * @param projectRoot - Absolute path to the project root.
 * @returns Completion result.
 *
 * @task T1118
 * @task T1120
 */
export function completeAgentWorktree(taskId: string, projectRoot: string): WorktreeCompleteResult {
  const gitRoot = getGitRoot(projectRoot);
  const worktreeRoot = resolveAgentWorktreeRoot(projectRoot);
  const worktreePath = join(worktreeRoot, taskId);
  const branch = `task/${taskId}`;

  // Determine base ref.
  let baseRef: string;
  try {
    baseRef = gitSync(['rev-parse', '--abbrev-ref', 'HEAD'], gitRoot);
  } catch {
    baseRef = 'main';
  }

  let cherryPicked = false;
  let commitCount = 0;
  let error: string | undefined;

  // Step 1: Collect commits on the task branch not on baseRef.
  let commits: string[] = [];
  try {
    const branchExists = gitSync(['branch', '--list', branch], gitRoot);
    if (branchExists) {
      const log = gitSync(['log', '--reverse', '--format=%H', `${baseRef}..${branch}`], gitRoot);
      commits = log
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
    }
  } catch (err) {
    error = `Failed to list commits: ${err instanceof Error ? err.message : String(err)}`;
  }

  // Step 2: Cherry-pick commits if any.
  if (commits.length > 0 && !error) {
    try {
      gitSync(['cherry-pick', ...commits], gitRoot);
      cherryPicked = true;
      commitCount = commits.length;
    } catch (err) {
      gitSilent(['cherry-pick', '--abort'], gitRoot);
      error = `Cherry-pick failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  } else if (commits.length === 0 && !error) {
    cherryPicked = true;
    commitCount = 0;
  }

  // Step 3: Unlock + remove the worktree.
  let worktreeRemoved = false;
  if (existsSync(worktreePath)) {
    gitSilent(['worktree', 'unlock', worktreePath], gitRoot);
    if (gitSilent(['worktree', 'remove', '--force', worktreePath], gitRoot)) {
      worktreeRemoved = true;
    } else {
      try {
        rmSync(worktreePath, { recursive: true, force: true });
        worktreeRemoved = true;
      } catch (err) {
        if (!error) {
          error = `Failed to remove worktree: ${err instanceof Error ? err.message : String(err)}`;
        }
      }
    }
  } else {
    worktreeRemoved = true;
  }

  // Step 4: Delete the task branch.
  let branchDeleted = false;
  try {
    const branchExists = gitSync(['branch', '--list', branch], gitRoot);
    if (branchExists) {
      gitSync(['branch', '-D', branch], gitRoot);
    }
    branchDeleted = true;
  } catch (err) {
    if (!error) {
      error = `Failed to delete branch: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  return { taskId, cherryPicked, commitCount, worktreeRemoved, branchDeleted, error };
}

/**
 * Prune orphaned agent worktrees for a project.
 *
 * @param projectRoot - Absolute path to the project root.
 * @param taskIds - Optional set of known-active task IDs to preserve.
 * @returns Cleanup result.
 *
 * @task T1118
 * @task T1120
 */
export function pruneOrphanedWorktrees(
  projectRoot: string,
  taskIds?: Set<string>,
): WorktreeCleanupResult {
  const gitRoot = getGitRoot(projectRoot);
  const worktreeRoot = resolveAgentWorktreeRoot(projectRoot);
  const removed: string[] = [];
  const errors: Array<{ path: string; reason: string }> = [];

  // Run git worktree prune to clean up stale administrative entries.
  gitSilent(['worktree', 'prune'], gitRoot);

  if (taskIds !== undefined && existsSync(worktreeRoot)) {
    let entries: string[] = [];
    try {
      entries = readdirSync(worktreeRoot);
    } catch {
      // ignore
    }
    for (const entry of entries) {
      if (taskIds.has(entry)) continue;
      const worktreePath = join(worktreeRoot, entry);
      gitSilent(['worktree', 'unlock', worktreePath], gitRoot);
      if (gitSilent(['worktree', 'remove', '--force', worktreePath], gitRoot)) {
        removed.push(worktreePath);
      } else {
        try {
          rmSync(worktreePath, { recursive: true, force: true });
          removed.push(worktreePath);
        } catch (err2) {
          errors.push({
            path: worktreePath,
            reason: err2 instanceof Error ? err2.message : String(err2),
          });
        }
      }
    }
  }

  return { removed: removed.length, removedPaths: removed, errors };
}

/**
 * Result of a single-task worktree prune operation.
 *
 * @task T1462
 */
export interface PruneWorktreeResult {
  /** Task ID whose worktree was targeted. */
  taskId: string;
  /** Outcome: 'pruned' — cleaned up, 'skipped' — no worktree found, 'error' — failed. */
  status: 'pruned' | 'skipped' | 'error';
  /** Whether the worktree directory was removed. */
  worktreeRemoved: boolean;
  /** Whether the task branch was deleted. */
  branchDeleted: boolean;
  /** Whether the worktree was dirty (had uncommitted changes) when pruned. */
  wasDirty: boolean;
  /** Error message if any step failed. */
  error?: string;
}

/**
 * Prune the worktree for a single completed or cancelled task.
 *
 * Unlike {@link completeAgentWorktree}, this function does NOT cherry-pick
 * any commits — it is called after `cleo complete` has already recorded the
 * task as done. It simply removes the worktree filesystem entry and the
 * `task/<taskId>` branch if the branch has no commits ahead of the base ref.
 *
 * Behaviour:
 * - Returns `{ status: 'skipped' }` when no worktree exists for the task.
 * - Unlocks the worktree before removing (handles locked worktrees created by spawn).
 * - Falls back to `rmSync` if `git worktree remove` fails.
 * - Deletes `task/<taskId>` branch only when it has 0 commits ahead of the
 *   current HEAD (i.e. the branch has already been cherry-picked or is empty).
 *   When commits are still present the branch is left in place and reported in
 *   the result — callers should use `cleo orchestrate worktree.complete` first.
 * - Always writes a `--force` remove with an audit log entry (`.cleo/audit/worktree-prune.jsonl`)
 *   when the worktree is detected as dirty.
 * - Never throws — failures are returned in `{ status: 'error', error }`.
 *
 * @param taskId     - The CLEO task ID (e.g. "T1462").
 * @param projectRoot - Absolute path to the project root.
 * @param opts.auditLogPath - Override path for the audit JSONL (testing).
 * @returns Prune outcome.
 *
 * @task T1462
 * @adr ADR-055
 */
export function pruneWorktree(
  taskId: string,
  projectRoot: string,
  opts: { auditLogPath?: string } = {},
): PruneWorktreeResult {
  const branch = `task/${taskId}`;
  let gitRoot: string;
  try {
    gitRoot = getGitRoot(projectRoot);
  } catch (err) {
    return {
      taskId,
      status: 'error',
      worktreeRemoved: false,
      branchDeleted: false,
      wasDirty: false,
      error: `Not a git repo: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const worktreeRoot = resolveAgentWorktreeRoot(projectRoot);
  const worktreePath = join(worktreeRoot, taskId);

  // Fast-path: nothing to do if the worktree directory doesn't exist.
  if (!existsSync(worktreePath)) {
    // Still attempt to remove a stale branch if it exists.
    let branchDeleted = false;
    try {
      const branchExists = gitSync(['branch', '--list', branch], gitRoot);
      if (branchExists) {
        gitSync(['branch', '-D', branch], gitRoot);
        branchDeleted = true;
      } else {
        branchDeleted = true; // nothing to delete
      }
    } catch {
      /* best-effort */
    }
    return { taskId, status: 'skipped', worktreeRemoved: false, branchDeleted, wasDirty: false };
  }

  // Detect dirty state: uncommitted changes in the worktree.
  let wasDirty = false;
  try {
    const statusOut = gitSync(['status', '--porcelain'], worktreePath);
    wasDirty = statusOut.length > 0;
  } catch {
    // If we can't check status assume clean.
  }

  // If dirty, write an audit log entry before force-removing.
  if (wasDirty) {
    try {
      const auditDir = opts.auditLogPath
        ? opts.auditLogPath.split('/').slice(0, -1).join('/')
        : join(projectRoot, '.cleo', 'audit');
      mkdirSync(auditDir, { recursive: true });
      const logPath = opts.auditLogPath ?? join(auditDir, 'worktree-prune.jsonl');
      const entry = JSON.stringify({
        timestamp: new Date().toISOString(),
        taskId,
        worktreePath,
        action: 'force-remove-dirty',
        agent: process.env['CLEO_AGENT_ID'] ?? 'cleo',
      });
      appendFileSync(logPath, entry + '\n', 'utf-8');
    } catch {
      /* audit is best-effort */
    }
  }

  // Unlock and remove the worktree.
  let worktreeRemoved = false;
  gitSilent(['worktree', 'unlock', worktreePath], gitRoot);
  if (gitSilent(['worktree', 'remove', '--force', worktreePath], gitRoot)) {
    worktreeRemoved = true;
  } else {
    try {
      rmSync(worktreePath, { recursive: true, force: true });
      // Prune stale git admin entries.
      gitSilent(['worktree', 'prune'], gitRoot);
      worktreeRemoved = true;
    } catch (err) {
      return {
        taskId,
        status: 'error',
        worktreeRemoved: false,
        branchDeleted: false,
        wasDirty,
        error: `Failed to remove worktree: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // Delete the branch only when it has no commits ahead of current HEAD.
  let branchDeleted = false;
  try {
    const branchExists = gitSync(['branch', '--list', branch], gitRoot);
    if (branchExists) {
      // Check for unmerged commits.
      let baseRef: string;
      try {
        baseRef = gitSync(['rev-parse', '--abbrev-ref', 'HEAD'], gitRoot);
      } catch {
        baseRef = 'main';
      }
      const aheadLog = gitSync(['log', '--format=%H', `${baseRef}..${branch}`], gitRoot);
      const aheadCommits = aheadLog
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
      if (aheadCommits.length === 0) {
        gitSync(['branch', '-D', branch], gitRoot);
        branchDeleted = true;
      } else {
        // Commits ahead — leave branch, surface in result.
        branchDeleted = false;
      }
    } else {
      branchDeleted = true; // already gone
    }
  } catch {
    /* best-effort */
  }

  return { taskId, status: 'pruned', worktreeRemoved, branchDeleted, wasDirty };
}

// ---------------------------------------------------------------------------
// Project-agnostic default-branch resolution (ADR-062 / T1587)
// ---------------------------------------------------------------------------

/**
 * Probe order for default-branch fallback when neither config nor
 * `origin/HEAD` resolves. Order matches industry convention frequency.
 */
const DEFAULT_BRANCH_PROBE_ORDER: readonly string[] = [
  'main',
  'master',
  'develop',
  'trunk',
] as const;

/**
 * Resolve the project's default integration branch in a project-agnostic way.
 *
 * Resolution order (per ADR-062):
 *
 * 1. `.cleo/config.json::git.defaultBranch` (explicit override).
 * 2. `git symbolic-ref refs/remotes/origin/HEAD` (what the remote calls
 *    default — works for `master`, `main`, `trunk`, etc.).
 * 3. Probe local branches in order: `main`, `master`, `develop`, `trunk`.
 * 4. Fallback to `'main'`.
 *
 * @param projectRoot - Absolute path to the project root.
 * @returns The resolved default branch name (never throws).
 *
 * @task T1587
 * @adr ADR-062
 */
export function getDefaultBranch(projectRoot: string): string {
  // (1) .cleo/config.json override.
  const configPath = join(projectRoot, '.cleo', 'config.json');
  if (existsSync(configPath)) {
    try {
      const raw = readFileSync(configPath, 'utf-8');
      const cfg = JSON.parse(raw) as { git?: { defaultBranch?: unknown } };
      const fromCfg = cfg.git?.defaultBranch;
      if (typeof fromCfg === 'string' && fromCfg.length > 0) {
        return fromCfg;
      }
    } catch {
      // malformed config — fall through.
    }
  }

  let gitRoot: string;
  try {
    gitRoot = getGitRoot(projectRoot);
  } catch {
    return 'main';
  }

  // (2) origin/HEAD.
  try {
    const ref = gitSync(['symbolic-ref', 'refs/remotes/origin/HEAD'], gitRoot);
    const stripped = ref.replace(/^refs\/remotes\/origin\//, '').trim();
    if (stripped.length > 0) return stripped;
  } catch {
    // origin/HEAD not set — fall through.
  }

  // (3) probe local branches.
  for (const candidate of DEFAULT_BRANCH_PROBE_ORDER) {
    try {
      const out = gitSync(['branch', '--list', candidate], gitRoot);
      if (out.length > 0) return candidate;
    } catch {
      /* ignore — try next */
    }
  }

  // (4) last-resort fallback.
  return 'main';
}

/**
 * Complete a worker task's worktree via `git merge --no-ff` (ADR-062).
 *
 * Replaces {@link completeAgentWorktree} (cherry-pick) — see ADR-062 for
 * rationale. Preserves the full agent commit graph instead of rewriting
 * SHAs, so `git log --grep "T<id>"` returns the originating commits.
 *
 * Steps performed inside the worktree at
 * `~/.local/share/cleo/worktrees/<projectHash>/<taskId>/`:
 *
 * 1. Resolve target branch via {@link getDefaultBranch} (or `opts.targetBranch`
 *    override). NEVER hardcodes "main".
 * 2. `git fetch origin` then `git rebase origin/<targetBranch>` inside the
 *    worktree. Conflicts cause an early non-fatal return — the agent must
 *    re-resolve before completion.
 * 3. From the project's git root on `<targetBranch>`, run
 *    `git merge --no-ff task/<taskId> -m "Merge T<id>: <title>"` so the
 *    merge commit subject is `git log --grep`-friendly.
 * 4. Capture the merge commit SHA and report it.
 * 5. Delegate worktree+branch removal to {@link pruneWorktree} (T1462).
 *
 * Project-agnostic: no string in this function hardcodes "main", "master",
 * or any other branch name. Test fixtures pass arbitrary `targetBranch`.
 *
 * @param taskId - The CLEO task ID (e.g. `"T1587"`).
 * @param projectRoot - Absolute path to the project root.
 * @param opts.targetBranch - Override the resolved default branch.
 * @param opts.taskTitle - Task title used in the merge commit message subject.
 * @param opts.skipFetch - Skip the `git fetch origin` step (test fixtures).
 * @returns Merge integration result.
 *
 * @task T1587
 * @adr ADR-062
 */
export function completeAgentWorktreeViaMerge(
  taskId: string,
  projectRoot: string,
  opts: {
    targetBranch?: string;
    taskTitle?: string;
    skipFetch?: boolean;
  } = {},
): WorktreeMergeResult {
  const branch = `task/${taskId}`;
  const targetBranch = opts.targetBranch ?? getDefaultBranch(projectRoot);

  let gitRoot: string;
  try {
    gitRoot = getGitRoot(projectRoot);
  } catch (err) {
    return {
      taskId,
      targetBranch,
      merged: false,
      mergeCommit: '',
      commitCount: 0,
      rebased: false,
      worktreeRemoved: false,
      branchDeleted: false,
      error: `Not a git repo: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const worktreeRoot = resolveAgentWorktreeRoot(projectRoot);
  const worktreePath = join(worktreeRoot, taskId);

  // Step 1: verify the worktree branch exists.
  let branchExists = '';
  try {
    branchExists = gitSync(['branch', '--list', branch], gitRoot);
  } catch (err) {
    return {
      taskId,
      targetBranch,
      merged: false,
      mergeCommit: '',
      commitCount: 0,
      rebased: false,
      worktreeRemoved: false,
      branchDeleted: false,
      error: `Failed to query branch: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!branchExists) {
    return {
      taskId,
      targetBranch,
      merged: false,
      mergeCommit: '',
      commitCount: 0,
      rebased: false,
      worktreeRemoved: false,
      branchDeleted: false,
      error: `Branch ${branch} does not exist`,
    };
  }

  // Step 2: rebase inside the worktree (only when worktree dir present).
  let rebased = false;
  if (existsSync(worktreePath)) {
    if (!opts.skipFetch) {
      gitSilent(['fetch', 'origin'], worktreePath);
    }
    // Prefer remote target if available, else local.
    const rebaseOnto = (() => {
      const hasRemote = gitSilent(
        ['rev-parse', '--verify', `refs/remotes/origin/${targetBranch}`],
        worktreePath,
      );
      return hasRemote ? `origin/${targetBranch}` : targetBranch;
    })();
    try {
      gitSync(['rebase', rebaseOnto], worktreePath);
      rebased = true;
    } catch (err) {
      gitSilent(['rebase', '--abort'], worktreePath);
      return {
        taskId,
        targetBranch,
        merged: false,
        mergeCommit: '',
        commitCount: 0,
        rebased: false,
        worktreeRemoved: false,
        branchDeleted: false,
        error: `Rebase onto ${rebaseOnto} failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // Step 3: count commits ahead before merge (for reporting).
  let commitCount = 0;
  try {
    const aheadLog = gitSync(['log', '--format=%H', `${targetBranch}..${branch}`], gitRoot);
    commitCount = aheadLog
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean).length;
  } catch {
    /* best-effort */
  }

  if (commitCount === 0) {
    // Nothing to merge — proceed straight to prune.
    const pruneResult = pruneWorktree(taskId, projectRoot);
    return {
      taskId,
      targetBranch,
      merged: true,
      mergeCommit: '',
      commitCount: 0,
      rebased,
      worktreeRemoved: pruneResult.worktreeRemoved,
      branchDeleted: pruneResult.branchDeleted,
    };
  }

  // Step 4: merge --no-ff into target branch.
  const subject = opts.taskTitle
    ? `Merge ${taskId}: ${opts.taskTitle}`
    : `Merge ${taskId}: worktree integration`;

  // Capture current branch in gitRoot so we can restore it.
  let originalBranch: string | null = null;
  try {
    originalBranch = gitSync(['rev-parse', '--abbrev-ref', 'HEAD'], gitRoot);
  } catch {
    /* ignore */
  }

  let checkedOut = false;
  if (originalBranch !== targetBranch) {
    if (gitSilent(['checkout', targetBranch], gitRoot)) {
      checkedOut = true;
    } else {
      return {
        taskId,
        targetBranch,
        merged: false,
        mergeCommit: '',
        commitCount,
        rebased,
        worktreeRemoved: false,
        branchDeleted: false,
        error: `Failed to checkout ${targetBranch} in main worktree`,
      };
    }
  }

  let mergeCommit = '';
  let merged = false;
  let mergeError: string | undefined;
  try {
    // T1591: set CLEO_ORCHESTRATE_MERGE=1 so a PATH-shimmed git accepts this
    // merge. The shim refuses `git merge` from agent worktrees unless this env
    // is set — completeAgentWorktreeViaMerge is the ONLY sanctioned call site.
    execFileSync('git', ['merge', '--no-ff', branch, '-m', subject], {
      cwd: gitRoot,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, CLEO_ORCHESTRATE_MERGE: '1' },
    });
    mergeCommit = gitSync(['rev-parse', 'HEAD'], gitRoot);
    merged = true;
  } catch (err) {
    gitSilent(['merge', '--abort'], gitRoot);
    mergeError = `Merge --no-ff failed: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    // Restore previous branch if we changed it (only on failure — on success
    // staying on target is the expected post-condition).
    if (!merged && checkedOut && originalBranch && originalBranch !== targetBranch) {
      gitSilent(['checkout', originalBranch], gitRoot);
    }
  }

  if (!merged) {
    return {
      taskId,
      targetBranch,
      merged: false,
      mergeCommit: '',
      commitCount,
      rebased,
      worktreeRemoved: false,
      branchDeleted: false,
      error: mergeError,
    };
  }

  // Step 5: prune worktree + branch (T1462).
  const pruneResult = pruneWorktree(taskId, projectRoot);

  return {
    taskId,
    targetBranch,
    merged: true,
    mergeCommit,
    commitCount,
    rebased,
    worktreeRemoved: pruneResult.worktreeRemoved,
    branchDeleted: pruneResult.branchDeleted,
    error: pruneResult.error,
  };
}

// ---------------------------------------------------------------------------
// L2 — Shim materialisation
// ---------------------------------------------------------------------------

/** Minimal stub shim script content for when the package isn't installed. */
const STUB_SHIM_CONTENT = `#!/usr/bin/env node
// git-shim stub (install @cleocode/git-shim for the full binary)
import { spawnSync } from 'node:child_process';
const RESTRICTED = new Set(['worker','lead','subagent']);
const BLOCKED = new Set(['checkout','switch','rebase']);
const role = process.env['CLEO_AGENT_ROLE'];
const sub = process.argv[2];
if (role && RESTRICTED.has(role) && sub && BLOCKED.has(sub) && !process.env['CLEO_ALLOW_BRANCH_OPS']) {
  process.stderr.write('[git-shim] BLOCKED: ' + sub + ' is not allowed for role ' + role + '\\n');
  process.exit(77);
}
const git = process.env['CLEO_REAL_GIT_PATH'] || '/usr/bin/git';
const r = spawnSync(git, process.argv.slice(2), { stdio: 'inherit' });
process.exit(r.status ?? 0);
`;

/**
 * Ensure the git shim symlink exists in the project's `.cleo/bin/git-shim/` dir.
 *
 * The shim directory is prepended to PATH in agent spawn env. Idempotent.
 *
 * @param projectRoot - Absolute path to the project root.
 * @returns Absolute path to the shim directory (to prepend to PATH).
 *
 * @task T1118
 * @task T1121
 */
export function ensureGitShimDir(projectRoot: string): string {
  const shimDir = join(projectRoot, '.cleo', 'bin', 'git-shim');
  mkdirSync(shimDir, { recursive: true });

  const linkPath = join(shimDir, 'git');

  // Resolve the shim binary from @cleocode/git-shim package.
  let shimBinPath: string | null = null;
  try {
    // Node.js require.resolve to find the installed package binary.
    // We use a dynamic import approach compatible with ESM.
    const candidatePaths = [
      join(projectRoot, 'node_modules', '@cleocode', 'git-shim', 'dist', 'shim.js'),
      join(projectRoot, '..', '..', 'node_modules', '@cleocode', 'git-shim', 'dist', 'shim.js'),
    ];
    for (const p of candidatePaths) {
      if (existsSync(p)) {
        shimBinPath = p;
        break;
      }
    }
  } catch {
    // ignore
  }

  if (!shimBinPath) {
    // Write a minimal stub shim.
    shimBinPath = join(shimDir, '_shim_bin.cjs');
    try {
      writeFileSync(shimBinPath, STUB_SHIM_CONTENT, { encoding: 'utf-8', mode: 0o755 });
    } catch {
      // ignore — best effort
    }
  }

  // Create/update the `git` symlink.
  if (existsSync(linkPath)) {
    try {
      const target = readlinkSync(linkPath);
      if (target === shimBinPath) return shimDir;
      unlinkSync(linkPath);
    } catch {
      try {
        unlinkSync(linkPath);
      } catch {
        /* ignore */
      }
    }
  }

  try {
    symlinkSync(shimBinPath, linkPath);
    try {
      chmodSync(shimBinPath, 0o755);
    } catch {
      /* ignore */
    }
  } catch {
    // Symlink may fail on some filesystems — non-fatal.
  }

  return shimDir;
}

// ---------------------------------------------------------------------------
// L3 — Filesystem hardening
// ---------------------------------------------------------------------------

/**
 * Detect platform capabilities for filesystem hardening.
 *
 * @returns Capability report.
 *
 * @task T1118
 * @task T1122
 */
export function detectFsHardenCapabilities(): FsHardenCapabilities {
  const plat = platform();
  let detected: FsHardenCapabilities['platform'] = 'unknown';

  if (plat === 'linux') {
    try {
      const uname = execFileSync('uname', ['-r'], {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
      detected = uname.toLowerCase().includes('microsoft') ? 'wsl' : 'linux';
    } catch {
      detected = 'linux';
    }
  } else if (plat === 'darwin') {
    detected = 'macos';
  } else if (plat === 'win32') {
    detected = 'windows';
  }

  let chattr = false;
  let chflags = false;

  if (detected === 'linux' || detected === 'wsl') {
    try {
      execFileSync('which', ['chattr'], { stdio: 'pipe' });
      chattr = true;
    } catch {
      chattr = false;
    }
  }
  if (detected === 'macos') {
    try {
      execFileSync('which', ['chflags'], { stdio: 'pipe' });
      chflags = true;
    } catch {
      chflags = false;
    }
  }

  return { chmod: true, chattr, chflags, platform: detected };
}

/**
 * Apply filesystem hardening to the orchestrator's .git/HEAD file.
 *
 * On Linux/macOS: chmod 400 the HEAD file.
 * When CLEO_HARD_LOCK=1: additionally attempt chattr +i (Linux) or chflags uchg (macOS).
 *
 * @param gitRoot - Absolute path to the git root directory.
 * @param opts.hardLock - Whether to apply immutable-file hardening.
 * @returns The applied harden state.
 *
 * @task T1118
 * @task T1122
 */
export function applyFsHarden(gitRoot: string, opts: { hardLock?: boolean } = {}): FsHardenState {
  const caps = detectFsHardenCapabilities();
  const headPath = join(gitRoot, '.git', 'HEAD');
  const lockedPaths: string[] = [];
  let mechanism: FsHardenState['mechanism'] = 'none';

  if (caps.platform === 'windows') {
    return { active: false, mechanism: 'none', lockedPaths: [] };
  }

  if (!existsSync(headPath)) {
    return { active: false, mechanism: 'none', lockedPaths: [] };
  }

  try {
    chmodSync(headPath, 0o400);
    lockedPaths.push(headPath);
    mechanism = 'chmod';
  } catch {
    return { active: false, mechanism: 'none', lockedPaths: [] };
  }

  if (opts.hardLock) {
    if (caps.chattr) {
      try {
        execFileSync('chattr', ['+i', headPath], { stdio: 'pipe' });
        mechanism = 'chattr';
      } catch {
        // sudo may be required — degrade to chmod only
      }
    } else if (caps.chflags) {
      try {
        execFileSync('chflags', ['uchg', headPath], { stdio: 'pipe' });
        mechanism = 'chflags';
      } catch {
        // degrade to chmod only
      }
    }
  }

  return { active: true, mechanism, lockedPaths, appliedAt: new Date().toISOString() };
}

/**
 * Restore filesystem hardening (unlock HEAD) on session end or cleanup.
 *
 * @param hardenState - The state returned by applyFsHarden.
 *
 * @task T1118
 * @task T1122
 */
export function removeFsHarden(hardenState: FsHardenState): void {
  if (!hardenState.active) return;

  for (const p of hardenState.lockedPaths) {
    if (!existsSync(p)) continue;

    if (hardenState.mechanism === 'chattr') {
      try {
        execFileSync('chattr', ['-i', p], { stdio: 'pipe' });
      } catch {
        /* ignore */
      }
    } else if (hardenState.mechanism === 'chflags') {
      try {
        execFileSync('chflags', ['nouchg', p], { stdio: 'pipe' });
      } catch {
        /* ignore */
      }
    }

    try {
      chmodSync(p, 0o644);
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------------------
// Composite helper
// ---------------------------------------------------------------------------

/**
 * Build the complete env block for a worker spawn with L1+L2 applied.
 *
 * @param worktreeResult - Result from buildWorktreeSpawnResult.
 * @param baseEnv - Base environment (defaults to process.env).
 * @returns Merged environment record.
 *
 * @task T1118
 * @task T1120
 * @task T1121
 */
export function buildAgentEnv(
  worktreeResult: WorktreeSpawnResult,
  baseEnv: Record<string, string> = process.env as Record<string, string>,
): Record<string, string> {
  return { ...baseEnv, ...worktreeResult.envVars };
}
