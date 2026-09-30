// @ts-nocheck — T9977 NAPI migration in progress; imports reference @cleocode/worktree that needs wiring
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
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { platform } from 'node:os';
import { dirname, isAbsolute, join, relative } from 'node:path';

import type {
  AgentWorktreeState,
  FsHardenCapabilities,
  FsHardenState,
  WorktreeCleanupResult,
  WorktreeMergeResult,
  WorktreeSpawnResult,
} from '@cleocode/contracts';
import { installGitShimLaunchers } from '@cleocode/git-shim';
import {
  computeProjectHash,
  findOnPath,
  pathEnvKey,
  prependPathEntry,
  resolveWorktreeRootForHash,
} from '@cleocode/paths';

// ---------------------------------------------------------------------------
// Re-exports from @cleocode/worktree
// ---------------------------------------------------------------------------

import {
  acquireWorktreeTaskLock,
  getGitRoot,
  gitSilent,
  gitSync,
  integrateWorktree,
  napiDestroyWorktree,
  pruneWorktrees,
  releaseWorktreeTaskLock,
} from '@cleocode/worktree';
import { resolveSpawnLockHolder } from './worktree-lock-holder.js';

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

  // T12506: take the per-task worktree lock first (E_WORKTREE_LOCKED when a
  // live holder owns it), and NEVER destroy an existing worktree — the prior
  // force-remove + `branch -D` deleted live agents' work whenever their
  // changes were gitignored or already committed. Re-attach it instead.
  const projectHashForLock = computeProjectHash(projectRoot);
  acquireWorktreeTaskLock({
    projectHash: projectHashForLock,
    taskId,
    holder: resolveSpawnLockHolder(),
  });
  if (existsSync(worktreePath)) {
    return {
      path: worktreePath,
      branch,
      taskId,
      baseRef,
      projectHash: projectHashForLock,
      createdAt: new Date().toISOString(),
      locked: true,
    };
  }

  // Create the worktree with a new branch.
  gitSync(['worktree', 'add', worktreePath, '-b', branch, baseRef], gitRoot); // raw-git-worktree-ok: legacy branch-lock provisioning pending full SDK promotion

  // Apply git worktree lock to prevent accidental pruning.
  // Try with --reason first (git ≥ 2.37), fall back without.
  if (
    !gitSilent(
      [
        'worktree' /* raw-git-worktree-ok: legacy branch-lock provisioning pending full SDK promotion */,
        'lock',
        '--reason',
        `cleo-agent-${taskId}`,
        worktreePath,
      ],
      gitRoot,
    )
  ) {
    gitSilent(['worktree', 'lock', worktreePath], gitRoot); // raw-git-worktree-ok: legacy git compatibility fallback without --reason
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
 * POSIX single-quote one shell word: wrap it in `'...'` and rewrite each
 * embedded `'` as `'\''`. The result is one literal word for any input — no
 * word splitting, parameter, command or glob expansion — so a copy-pasted
 * `cd` into a worktree under `Application Support` parses (T12528).
 *
 * @param value - Raw path.
 * @returns The single-quoted shell word.
 */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Construct the spawn env-var injection + preamble for the agent.
 *
 * Called by orchestrateSpawn after createAgentWorktree to produce the
 * env block and prompt preamble that bind the agent to its worktree.
 *
 * @param worktree - The created worktree state.
 * @param shimDir - Directory containing the git shim symlink.
 * @param identity - Per-agent session + agent identity to inject (T11343).
 *   `sessionId` → `CLEO_SESSION_ID`, `agentId` → `CLEO_AGENT_ID`. Only set
 *   when non-empty so an unallocated identity never clobbers an inherited env.
 * @returns Spawn result with env vars, CWD, and prompt preamble.
 *
 * @task T1118
 * @task T1120
 * @task T1121
 * @task T11343
 */
export function buildWorktreeSpawnResult(
  worktree: AgentWorktreeState,
  shimDir: string,
  identity: { sessionId?: string | null; agentId?: string | null } = {},
): WorktreeSpawnResult {
  const pathKey = pathEnvKey();
  const envVars: Record<string, string> = {
    CLEO_AGENT_ROLE: 'worker',
    CLEO_AGENT_CWD: worktree.path,
    CLEO_WORKTREE_ROOT: worktree.path,
    CLEO_WORKTREE_BRANCH: worktree.branch,
    CLEO_PROJECT_HASH: worktree.projectHash,
    CLEO_BRANCH_PROTECTION: 'strict',
    CLEO_SHIM_MARKER: '.cleo/bin/git-shim',
    // Prepend the shim directory so `git` resolves to the shim. The platform
    // delimiter matters: `${shimDir}:${PATH}` on Windows fuses the shim dir
    // with the first real entry and loses both (T12605).
    [pathKey]: prependPathEntry(shimDir, process.env[pathKey]),
  };

  // T11343 — bind the spawned agent's OWN session + identity into the worker
  // env so every short-lived `cleo` call inside the worktree resolves THIS
  // agent's session via `resolveSessionIdFromEnv()` rather than collapsing onto
  // the orchestrator's most-recent active row (the session-bleed root cause).
  // Only set when non-empty so we never emit a clobbering empty export.
  if (identity.sessionId) {
    envVars.CLEO_SESSION_ID = identity.sessionId;
  }
  if (identity.agentId) {
    envVars.CLEO_AGENT_ID = identity.agentId;
  }

  const preamble = [
    '## BRANCH ISOLATION PROTOCOL (MANDATORY)',
    '',
    `CLEO_AGENT_CWD=${worktree.path}`,
    '',
    `FIRST ACTION: cd ${shellQuote(worktree.path)}`,
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
  return {
    removed: result.removed,
    removedPaths: result.removedPaths,
    quarantined: result.quarantined,
    quarantinedPaths: result.quarantinedPaths,
    errors: result.errors,
  };
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
 * Move this process out of `dir` before it is deleted (T12671). `cleo done`
 * run inside a task worktree completes the task, which prunes that worktree;
 * a process whose cwd no longer exists then fails every later resolution from
 * it (the audit write logged "No CLEO project found" beside `success: true`).
 *
 * @param dir - Directory about to be removed.
 * @param to - Directory to move to (the repository root).
 */
function leaveDirectoryBeforeRemoval(dir: string, to: string): void {
  let cwd: string;
  let target: string;
  try {
    cwd = realpathSync(process.cwd()); // CWD-OK: the process's own cwd is the subject
    target = realpathSync(dir);
  } catch {
    return;
  }
  const rel = relative(target, cwd);
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) process.chdir(to);
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
        ? dirname(opts.auditLogPath)
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
  leaveDirectoryBeforeRemoval(worktreePath, gitRoot);
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
    gitSilent(['worktree', 'unlock', worktreePath], gitRoot); // raw-git-worktree-ok: cleanup fallback after NAPI destroy reports incomplete removal
    try {
      rmSync(worktreePath, { recursive: true, force: true });
      // Prune stale git admin entries.
      gitSilent(['worktree', 'prune'], gitRoot); // raw-git-worktree-ok: cleanup fallback after filesystem removal of stale worktree
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

  // T12506: the worktree is gone (e.g. integrated by completeAgentWorktreeViaMerge),
  // so its per-task lock guards nothing. Leaving it held made the next spawn
  // of the task fail E_WORKTREE_LOCKED for the rest of the owner's lifetime.
  releaseWorktreeTaskLock(computeProjectHash(projectRoot), taskId);

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
 * Verdict of {@link assessUpstreamIntegration}.
 *
 * - `landed` — the task branch is already on the upstream default branch
 *   (ancestor of it, or its changes are fully contained in it). No local
 *   merge may run.
 * - `nothing` — the task branch has no commits beyond the local default
 *   branch (e.g. a worktree that was never committed to). There is nothing to
 *   integrate, and it is NOT reported as landed upstream.
 * - `stale-target` — the local default branch is behind the upstream default
 *   branch (possibly also ahead of it — diverged); a merge there would fork it
 *   from upstream. No local merge may run.
 * - `proceed` — no upstream to compare against, or the local default branch is
 *   current; the ADR-062 local `--no-ff` integration may run.
 *
 * @task T12773
 */
export type UpstreamIntegrationKind = 'landed' | 'nothing' | 'stale-target' | 'proceed';

/**
 * Result of {@link assessUpstreamIntegration}.
 *
 * @task T12773
 */
export interface UpstreamIntegrationAssessment {
  /** What the caller may do next. */
  kind: UpstreamIntegrationKind;
  /** Remote-tracking ref compared against (e.g. `refs/remotes/origin/main`), or null. */
  upstreamRef: string | null;
  /**
   * True when this assessment ran `git fetch <remote> <targetBranch>` (whether
   * or not it succeeded), so a later integration step need not fetch again.
   */
  fetched: boolean;
  /** Commits on the upstream ref missing from the local default branch. */
  behind: number;
  /** Commits on the local default branch missing from the upstream ref. */
  ahead: number;
  /**
   * Exact shell command that syncs the local default branch with upstream,
   * or empty when no sync is needed. NEVER run by CLEO — the operator's
   * checkout is never moved (hint-only policy).
   */
  syncCommand: string;
  /** Operator-facing explanation / next step (empty for `proceed`). */
  hint: string;
}

/**
 * Default timeout for the upstream `git fetch` in
 * {@link assessUpstreamIntegration}. Short on purpose: the fetch is
 * best-effort, and a hung network or credential prompt must never stall
 * `cleo done` for the 180s generic git timeout.
 *
 * @task T12773
 */
export const UPSTREAM_FETCH_TIMEOUT_MS = 20_000;

/**
 * Environment for a non-interactive `git fetch`: no terminal credential
 * prompt, and ssh in batch mode (an existing `GIT_SSH_COMMAND` is preserved
 * with `-oBatchMode=yes` appended).
 */
function nonInteractiveGitEnv(): NodeJS.ProcessEnv {
  const existingSsh = process.env['GIT_SSH_COMMAND']?.trim();
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_SSH_COMMAND: existingSsh ? `${existingSsh} -oBatchMode=yes` : 'ssh -oBatchMode=yes',
  };
}

/**
 * Best-effort, bounded, non-interactive `git fetch <remote> <branch>`.
 *
 * @returns true when git exited 0; false on failure, offline, or timeout.
 */
function fetchUpstreamBranch(
  gitRoot: string,
  remote: string,
  branch: string,
  timeoutMs: number,
): boolean {
  try {
    execFileSync('git', ['fetch', '--quiet', remote, branch], {
      cwd: gitRoot,
      // No pipes: a timed-out git's surviving ssh grandchild must not hold
      // stdout/stderr open and keep this synchronous call waiting.
      stdio: 'ignore',
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      env: nonInteractiveGitEnv(),
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * `git rev-list --count <range>`, or 0 when git fails.
 */
function revListCount(gitRoot: string, range: string): number {
  try {
    const n = Number.parseInt(gitSync(['rev-list', '--count', range], gitRoot), 10);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

/**
 * True when the worktree at `worktreePath` has uncommitted tracked or
 * untracked changes. An unreadable status counts as dirty (never discard
 * work on uncertainty).
 */
function isWorktreeDirty(worktreePath: string): boolean {
  try {
    return gitSync(['status', '--porcelain'], worktreePath).length > 0;
  } catch {
    return true;
  }
}

/**
 * True when merging `branch` into `upstreamRef` would leave the upstream tree
 * unchanged — the branch's changes already landed (e.g. a squash-merged PR,
 * whose commits are never ancestors of upstream). Uses `git merge-tree
 * --write-tree`; older git or a conflict yields false.
 */
function branchChangesContainedIn(gitRoot: string, branch: string, upstreamRef: string): boolean {
  try {
    const merged = gitSync(['merge-tree', '--write-tree', upstreamRef, branch], gitRoot)
      .split('\n')[0]
      ?.trim();
    const upstreamTree = gitSync(['rev-parse', `${upstreamRef}^{tree}`], gitRoot);
    return merged !== undefined && merged.length > 0 && merged === upstreamTree;
  } catch {
    return false;
  }
}

/**
 * Decide whether a local ADR-062 `--no-ff` integration of `branch` into
 * `targetBranch` is safe, by comparing against the upstream default branch
 * (`<remote>/<targetBranch>`).
 *
 * T12773: `cleo done --pr <n>` for a task whose PR had already merged on
 * origin ran `git merge --no-ff task/<id>` into a local `main` that was 199
 * commits behind origin, creating a local merge commit that forked `main`
 * from `origin/main`. This check runs BEFORE any checkout or merge:
 *
 * - branch has no commits beyond the local default branch → `nothing`.
 * - branch already on upstream → `landed`; when the local default branch is
 *   behind, the hint names the exact sync command. The checkout is never
 *   moved (hint-only).
 * - local default branch behind upstream → `stale-target`; a distinct hint
 *   when it is also ahead (diverged: unpushed local commits).
 * - otherwise (no remote, no upstream ref, current target) → `proceed`.
 *
 * The fetch is best-effort, non-interactive (`GIT_TERMINAL_PROMPT=0`, ssh
 * `BatchMode`) and bounded by {@link UPSTREAM_FETCH_TIMEOUT_MS}; offline, the
 * last-known remote-tracking ref is used. Never creates a commit and never
 * moves any ref other than the remote-tracking one the fetch updates.
 *
 * @param gitRoot - Absolute git root of the project checkout.
 * @param branch - Task branch (e.g. `task/T123`).
 * @param targetBranch - Resolved default branch (e.g. `main`).
 * @param opts.skipFetch - Skip `git fetch <remote> <targetBranch>` (fixtures).
 * @param opts.remote - Remote name (default `origin`).
 * @param opts.fetchTimeoutMs - Fetch timeout (default {@link UPSTREAM_FETCH_TIMEOUT_MS}).
 * @returns The assessment.
 *
 * @task T12773
 * @adr ADR-062
 */
export function assessUpstreamIntegration(
  gitRoot: string,
  branch: string,
  targetBranch: string,
  opts: { skipFetch?: boolean; remote?: string; fetchTimeoutMs?: number } = {},
): UpstreamIntegrationAssessment {
  const remote = opts.remote ?? 'origin';
  const proceed: UpstreamIntegrationAssessment = {
    kind: 'proceed',
    upstreamRef: null,
    fetched: false,
    behind: 0,
    ahead: 0,
    syncCommand: '',
    hint: '',
  };
  if (!gitSilent(['remote', 'get-url', remote], gitRoot)) return proceed;
  const fetched = !opts.skipFetch;
  if (fetched) {
    // Best-effort: offline must not block an otherwise-local integration.
    fetchUpstreamBranch(
      gitRoot,
      remote,
      targetBranch,
      opts.fetchTimeoutMs ?? UPSTREAM_FETCH_TIMEOUT_MS,
    );
  }
  const upstreamRef = `refs/remotes/${remote}/${targetBranch}`;
  const upstreamShort = `${remote}/${targetBranch}`;
  if (!gitSilent(['rev-parse', '--verify', '--quiet', upstreamRef], gitRoot)) {
    return { ...proceed, fetched };
  }

  const localRef = `refs/heads/${targetBranch}`;
  const hasLocal = gitSilent(['rev-parse', '--verify', '--quiet', localRef], gitRoot);
  const behind = hasLocal ? revListCount(gitRoot, `${localRef}..${upstreamRef}`) : 0;
  const ahead = hasLocal ? revListCount(gitRoot, `${upstreamRef}..${localRef}`) : 0;
  const base = { upstreamRef, fetched, behind, ahead };

  // Single-quoted for the shell: macOS roots often contain spaces.
  const quotedRoot = `'${gitRoot.replace(/'/g, `'\\''`)}'`;
  const syncCommand =
    behind === 0
      ? ''
      : ahead > 0
        ? `git -C ${quotedRoot} switch ${targetBranch} && git -C ${quotedRoot} pull --rebase ${remote} ${targetBranch}`
        : `git -C ${quotedRoot} switch ${targetBranch} && git -C ${quotedRoot} merge --ff-only ${upstreamShort}`;
  const syncState =
    behind === 0
      ? ''
      : ahead > 0
        ? `local '${targetBranch}' has ${ahead} unpushed commit(s) and is ${behind} behind ${upstreamShort}`
        : `local '${targetBranch}' is ${behind} commit(s) behind ${upstreamShort}`;

  // A branch with no commits beyond the local default branch has nothing to
  // integrate — it trivially "is an ancestor of upstream", which must not be
  // reported as a landed PR.
  if (hasLocal && revListCount(gitRoot, `${localRef}..${branch}`) === 0) {
    return {
      ...base,
      kind: 'nothing',
      syncCommand,
      hint: `'${branch}' has no commits beyond local '${targetBranch}'; nothing to integrate.`,
    };
  }

  const landed =
    gitSilent(['merge-base', '--is-ancestor', branch, upstreamRef], gitRoot) ||
    branchChangesContainedIn(gitRoot, branch, upstreamRef);
  if (landed) {
    return {
      ...base,
      kind: 'landed',
      syncCommand,
      hint:
        behind === 0
          ? `'${branch}' already landed on ${upstreamShort}; no local merge was made.`
          : `'${branch}' already landed on ${upstreamShort}; no local merge was made and your checkout was not moved. ${syncState}; to sync it run: ${syncCommand}`,
    };
  }

  if (behind > 0) {
    const rerun = `re-run \`cleo orchestrate worktree-complete ${branch.replace(/^task\//, '')}\``;
    return {
      ...base,
      kind: 'stale-target',
      syncCommand,
      hint:
        ahead > 0
          ? `${syncState}: run \`git pull --rebase ${remote} ${targetBranch}\` (or merge ${upstreamShort}) in ${quotedRoot}, then ${rerun}. A merge now would fork '${targetBranch}' further from ${upstreamShort}; alternatively land '${branch}' through a PR.`
          : `${syncState}, so a merge there would fork it from ${upstreamShort}. Land '${branch}' through a PR, or sync first (${syncCommand}) and ${rerun}.`,
    };
  }
  return { ...proceed, ...base };
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
 * 1a. T12773: {@link assessUpstreamIntegration} — when `task/<id>` already
 *    landed on `origin/<targetBranch>` the merge is skipped
 *    (`landedUpstream: true`); when it has no commits beyond the local
 *    target it is `nothingToIntegrate` without `landedUpstream`; when the
 *    local target is behind (or diverged from) origin the merge is refused
 *    (`staleTarget: true`) with a `hint`. None of these paths creates a
 *    commit or moves the operator's checkout — syncing is hint-only.
 * 2. Optionally `git fetch` (skipped when step 1a already fetched), then
 *    `git checkout <targetBranch>` in the project's git root. The task
 *    branch is NOT rebased — agent SHAs are preserved.
 * 3. Run `git merge --no-ff task/<taskId> -m "<taskId>: <title> (worktree
 *    merge)"`; a failed merge is aborted so the repo is left clean, and the
 *    worktree is preserved.
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
 * @param opts.skipFetch - Skip every `git fetch` (test fixtures).
 * @param opts.fetchTimeoutMs - Timeout for the upstream fetch (default
 *   {@link UPSTREAM_FETCH_TIMEOUT_MS}).
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
    fetchTimeoutMs?: number;
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

  // T12153 (GH #1223) — distinguish "nothing to integrate" from "integration
  // failed" BEFORE delegating.
  //
  // Most tasks are worked on a feature branch and merged by PR, so no
  // `task/<id>` branch and no agent worktree ever exist. The NAPI helper
  // reports that as `merged: false` with `error: "task branch … does not
  // exist"`, which is the only shape it has — and the caller then logs a WARN
  // naming a mergeError for a task where nothing failed. That is a routine,
  // correct outcome reported as a failure, on most completions.
  //
  // Detected here rather than by string-matching the Rust error, which would
  // couple this to a message in another language that is free to change.
  const branchExists = gitSync(['branch', '--list', branch], gitRoot).trim().length > 0;
  if (!branchExists && !existsSync(worktreePath)) {
    return {
      taskId,
      targetBranch,
      merged: false,
      mergeCommit: '',
      commitCount: 0,
      rebased: false,
      worktreeRemoved: false,
      branchDeleted: false,
      // `error` is kept as a human-readable MESSAGE, while
      // `nothingToIntegrate` is the machine-readable CLASSIFICATION. Dropping
      // the string made `orchestrate worktree-complete` fall back to
      // "unknown merge failure" (it renders `integration.error ?? …`), which
      // is strictly less informative than the truth. A caller distinguishes
      // no-work from failure by the FLAG, never by the presence of a string.
      error: `no task branch '${branch}' and no worktree — nothing to integrate`,
      nothingToIntegrate: true,
    };
  }

  // T12773 — never merge locally what already landed upstream, and never
  // merge into a local default branch that is behind origin. Both produced a
  // divergent local merge commit (`merge task/<id>: Merge made by the 'ort'
  // strategy`) when `cleo done --pr <n>` ran from a stale checkout for a task
  // whose PR had already merged on origin.
  let upstreamFetched = false;
  if (branchExists) {
    const upstream = assessUpstreamIntegration(gitRoot, branch, targetBranch, {
      skipFetch: opts.skipFetch ?? false,
      fetchTimeoutMs: opts.fetchTimeoutMs,
    });
    upstreamFetched = upstream.fetched;
    if (upstream.kind === 'landed' || upstream.kind === 'nothing') {
      // The commits are safe on origin (or there are none); clean up the
      // worktree unless it holds uncommitted work, which is left for the
      // operator. The checkout itself is never moved (hint-only).
      const dirty = existsSync(worktreePath) && isWorktreeDirty(worktreePath);
      const pruneResult = dirty ? null : pruneWorktree(taskId, projectRoot);
      return {
        taskId,
        targetBranch,
        merged: false,
        mergeCommit: '',
        commitCount: 0,
        rebased: false,
        worktreeRemoved: pruneResult?.worktreeRemoved ?? false,
        branchDeleted: pruneResult?.branchDeleted ?? false,
        nothingToIntegrate: true,
        ...(upstream.kind === 'landed' ? { landedUpstream: true } : {}),
        ...(upstream.syncCommand ? { syncCommand: upstream.syncCommand } : {}),
        hint: dirty
          ? `${upstream.hint} Worktree ${worktreePath} has uncommitted changes and was preserved.`
          : upstream.hint,
      };
    }
    if (upstream.kind === 'stale-target') {
      return {
        taskId,
        targetBranch,
        merged: false,
        mergeCommit: '',
        commitCount: 0,
        rebased: false,
        worktreeRemoved: false,
        branchDeleted: false,
        error: `refusing local merge of '${branch}' into '${targetBranch}': ${upstream.hint}`,
        staleTarget: true,
        syncCommand: upstream.syncCommand,
        hint: upstream.hint,
      };
    }
  }

  // T11124: Delegate to Rust NAPI SSoT
  const result = integrateWorktree({
    repoRoot: gitRoot,
    worktreePath,
    branch,
    targetBranch,
    taskTitle: opts.taskTitle,
    // The upstream assessment already fetched (bounded + non-interactive);
    // do not fetch a second time from Rust.
    skipFetch: (opts.skipFetch ?? false) || upstreamFetched,
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
      ? dirname(opts.auditLogPath)
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

  // Create/update the `git` launcher: a symlink on POSIX; on Windows a
  // `git.cmd` + sh launcher, since PATHEXT ignores extensionless files and
  // file symlinks need privileges (T12605).
  try {
    installGitShimLaunchers(shimDir, shimBinPath);
  } catch {
    // Launcher install may fail on some filesystems — non-fatal.
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
    chattr = findOnPath('chattr') !== null;
  }
  if (detected === 'macos') {
    chflags = findOnPath('chflags') !== null;
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
