/**
 * Branch-lock engine — runtime enforcement for agent git isolation (T1118).
 *
 * Implements all four protection layers:
 *
 * - L1: Git worktree creation, merge-completion (ADR-062), and cleanup.
 * - L2: Shim symlink materialisation + spawn env construction.
 * - L3: Filesystem hardening via chmod (+ optional chattr on Linux).
 * - L4: Not here — L4 lives in validate-engine and session domain handlers.
 *
 * Worktree integration uses `git merge --no-ff` exclusively per ADR-062.
 * The legacy cherry-pick integration path was removed in T1624.
 *
 * All git operations use execFileSync with explicit arg arrays (no shell
 * interpolation) to prevent command injection.
 *
 * @task T1118
 * @adr ADR-055
 * @adr ADR-062
 */

import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { platform } from 'node:os';
import { join } from 'node:path';

import type {
  AgentWorktreeState,
  FsHardenCapabilities,
  FsHardenState,
  WorktreeCleanupResult,
  WorktreeMergeResult,
  WorktreeSpawnResult,
} from '@cleocode/contracts';
import { computeProjectHash, resolveWorktreeRootForHash } from '@cleocode/paths';

// ---------------------------------------------------------------------------
// Re-exports from @cleocode/worktree
// ---------------------------------------------------------------------------

import {
  getGitRoot,
  gitSilent,
  gitSync,
  integrateWorktree,
  napiDestroyWorktree,
  pruneWorktrees,
} from '@cleocode/worktree';

// Re-export getGitRoot for barrel consumers
export { getGitRoot };

// ---------------------------------------------------------------------------
// L1 — Worktree lifecycle
// ---------------------------------------------------------------------------

/**
 * Resolve the worktree root directory for a project.
 *
 * Delegates to the canonical paths-SSoT helpers in `@cleocode/paths`. The
 * resolved directory follows the XDG canonical layout per D029:
 *
 *   Linux:   ~/.local/share/cleo/worktrees/<projectHash>/
 *   macOS:   ~/Library/Application Support/cleo/worktrees/<projectHash>/
 *   Windows: %LOCALAPPDATA%\cleo\Data\worktrees\<projectHash>\
 *
 * T9984: previously hand-rolled `createHash('sha256').update(projectRoot)` +
 * `process.env['XDG_DATA_HOME']` — both violations of the paths-SSoT lint
 * (`packages/paths/` is the only legitimate source of these computations).
 * Now routes through `computeProjectHash` and `resolveWorktreeRootForHash`.
 *
 * @param projectRoot - Absolute path to the project root.
 * @returns Absolute path to the worktree root directory.
 *
 * @task T1118
 * @task T1120
 * @task T9984
 */
export function resolveAgentWorktreeRoot(projectRoot: string): string {
  const projectHash = computeProjectHash(projectRoot);
  return resolveWorktreeRootForHash(projectHash);
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
 * @task T11122
 * @task T11123
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

  // T11123: Remove stale worktree via NAPI destroyWorktree instead of raw
  // git worktree unlock + remove + branch delete shell-outs.
  if (existsSync(worktreePath)) {
    try {
      napiDestroyWorktree({
        repoRoot: gitRoot,
        worktreePath,
        force: true,
      });
    } catch {
      // Fallback: brute-force filesystem + git removal for stale entries
      // that NAPI cannot resolve (corrupted admin dirs, detached worktrees).
      gitSilent(['worktree', 'unlock', worktreePath], gitRoot);
      if (!gitSilent(['worktree', 'remove', '--force', worktreePath], gitRoot)) {
        try {
          rmSync(worktreePath, { recursive: true, force: true });
        } catch {
          /* best-effort */
        }
      }
      // Attempt to delete the leftover branch.
      gitSilent(['branch', '-D', branch], gitRoot);
    }
  }

  // Create the worktree with a new branch.
  gitSync(['worktree', 'add', worktreePath, '-b', branch, baseRef], gitRoot);

  // Apply git worktree lock to prevent accidental pruning.
  // Try with --reason first (git ≥ 2.37), fall back without.
  if (!gitSilent(['worktree', 'lock', '--reason', `cleo-agent-${taskId}`, worktreePath], gitRoot)) {
    gitSilent(['worktree', 'lock', worktreePath], gitRoot);
  }

  // T9984: route projectHash through @cleocode/paths SSoT.
  const projectHash = computeProjectHash(projectRoot);
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
 * Prune orphaned agent worktrees for a project.
 *
 * T11123: Delegates to `pruneWorktrees` from `@cleocode/worktree` which uses
 * the NAPI `pruneWorktrees` / `destroyWorktree` bindings (Rust worktrunk-core)
 * instead of raw `git worktree prune/unlock/remove` shell-outs.
 *
 * @param projectRoot - Absolute path to the project root.
 * @param taskIds - Optional set of known-active task IDs to preserve.
 * @returns Cleanup result.
 *
 * @task T1118
 * @task T1120
 * @task T11123
 */
export function pruneOrphanedWorktrees(
  projectRoot: string,
  taskIds?: Set<string>,
): WorktreeCleanupResult {
  const result = pruneWorktrees({ projectRoot, preserveTaskIds: taskIds });
  return { removed: result.removed, removedPaths: result.removedPaths, errors: result.errors };
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
 * This function does NOT integrate commits — it is called after
 * {@link completeAgentWorktreeViaMerge} (or `cleo complete`) has already
 * recorded the task as done. It simply removes the worktree filesystem entry
 * and the `task/<taskId>` branch if the branch has no commits ahead of the
 * base ref.
 *
 * Behaviour:
 * - Returns `{ status: 'skipped' }` when no worktree exists for the task.
 * - Unlocks the worktree before removing (handles locked worktrees created by spawn).
 * - Falls back to `rmSync` if `git worktree remove` fails.
 * - Deletes `task/<taskId>` branch only when it has 0 commits ahead of the
 *   current HEAD (i.e. the branch has already been merged or is empty).
 *   When commits are still present the branch is left in place and reported in
 *   the result — callers should use `completeAgentWorktreeViaMerge` first.
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

  // T11123: Unlock and remove the worktree via NAPI destroyWorktree
  // (Rust worktrunk-core) instead of raw git worktree unlock + remove
  // shell-outs. Keeps filesystem rmSync fallback for stale/corrupted
  // directories that NAPI cannot resolve.
  let worktreeRemoved = false;
  try {
    const napiResult = napiDestroyWorktree({
      repoRoot: gitRoot,
      worktreePath,
      force: true,
    });
    worktreeRemoved = napiResult.removed;
    // T11033 — NAPI may report success even when untracked directories
    // survive. Verify on-disk reality.
    if (worktreeRemoved && existsSync(worktreePath)) {
      worktreeRemoved = false;
    }
  } catch {
    // napi failed — fall through to filesystem removal
  }

  if (!worktreeRemoved) {
    // Filesystem fallback: unlock via git, then brute-force rmSync.
    gitSilent(['worktree', 'unlock', worktreePath], gitRoot);
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
 * Canonical worktree integration per ADR-062. Preserves the full agent
 * commit graph instead of rewriting SHAs, so `git log --grep "T<id>"`
 * returns the originating commits with their original authorship.
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

  // T11124: Delegate to Rust NAPI SSoT
  const result = integrateWorktree({
    repoRoot: gitRoot,
    worktreePath,
    branch,
    targetBranch,
    taskTitle: opts.taskTitle,
    skipFetch: opts.skipFetch ?? false,
  });
  if (!result.merged) {
    return {
      taskId,
      targetBranch,
      merged: false,
      mergeCommit: '',
      commitCount: result.commitCount,
      rebased: result.rebased,
      worktreeRemoved: false,
      branchDeleted: false,
      error: result.error,
    };
  }
  const pruneResult = pruneWorktree(taskId, projectRoot);
  return {
    taskId,
    targetBranch,
    merged: true,
    mergeCommit: result.mergeCommit,
    commitCount: result.commitCount,
    rebased: result.rebased,
    worktreeRemoved: pruneResult.worktreeRemoved,
    branchDeleted: pruneResult.branchDeleted,
    error: pruneResult.error,
  };
}

// ---------------------------------------------------------------------------
// Post-merge integration helper (T9043)
// ---------------------------------------------------------------------------

/**
 * Result of a complete post-merge worktree integration.
 *
 * Extends `WorktreeMergeResult` with an additional audit log path field.
 *
 * @task T9043
 * @adr ADR-062
 */
export interface WorktreeIntegrationResult extends WorktreeMergeResult {
  /** Path to the audit log entry that was written (if any). */
  auditLogEntry: string | null;
}

/**
 * Complete a worker task's worktree integration via merge, cleanup, and audit log.
 *
 * This is the orchestrator-facing convenience wrapper around
 * `completeAgentWorktreeViaMerge`. In addition to the merge+prune steps it:
 *
 * 1. Delegates all merge and cleanup to `completeAgentWorktreeViaMerge`.
 * 2. Appends a structured entry to `.cleo/audit/worktree-integration.jsonl`
 *    recording the merge commit, task ID, and cleanup outcome.
 *
 * Orchestrators MUST call this (not `completeAgentWorktreeViaMerge` directly)
 * so every integration is auditable.
 *
 * @param taskId - The CLEO task ID (e.g. `"T1587"`).
 * @param projectRoot - Absolute path to the project root.
 * @param opts.targetBranch - Override the resolved default branch.
 * @param opts.taskTitle - Task title used in the merge commit message subject.
 * @param opts.skipFetch - Skip the `git fetch origin` step (test fixtures).
 * @param opts.auditLogPath - Override the audit JSONL path (testing).
 * @returns Integration result including audit log path.
 *
 * @task T9043
 * @adr ADR-062
 */
export function completeAgentWorktreeIntegration(
  taskId: string,
  projectRoot: string,
  opts: {
    targetBranch?: string;
    taskTitle?: string;
    skipFetch?: boolean;
    auditLogPath?: string;
  } = {},
): WorktreeIntegrationResult {
  const mergeResult = completeAgentWorktreeViaMerge(taskId, projectRoot, {
    targetBranch: opts.targetBranch,
    taskTitle: opts.taskTitle,
    skipFetch: opts.skipFetch,
  });

  // Write audit log entry.
  let auditLogEntry: string | null = null;
  try {
    const auditDir = opts.auditLogPath
      ? opts.auditLogPath.split('/').slice(0, -1).join('/')
      : join(projectRoot, '.cleo', 'audit');
    mkdirSync(auditDir, { recursive: true });
    const logPath = opts.auditLogPath ?? join(auditDir, 'worktree-integration.jsonl');
    const entry = JSON.stringify({
      timestamp: new Date().toISOString(),
      taskId,
      mergeCommit: mergeResult.mergeCommit,
      merged: mergeResult.merged,
      worktreeRemoved: mergeResult.worktreeRemoved,
      branchDeleted: mergeResult.branchDeleted,
      error: mergeResult.error ?? null,
      agent: process.env['CLEO_AGENT_ID'] ?? 'cleo',
    });
    appendFileSync(logPath, entry + '\n', 'utf-8');
    auditLogEntry = logPath;
  } catch {
    // Audit is best-effort — never block merge on logging failure.
  }

  return { ...mergeResult, auditLogEntry };
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
