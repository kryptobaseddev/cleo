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
  accessSync,
  appendFileSync,
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { platform } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

import type {
  AgentWorktreeState,
  EvidenceAtom,
  FsHardenCapabilities,
  FsHardenState,
  WorktreeCleanupResult,
  WorktreeDisposalBlockers,
  WorktreeIntegrationOutcome,
  WorktreeIntegrationPlan,
  WorktreeMergeResult,
  WorktreeSpawnResult,
} from '@cleocode/contracts';
import { installGitShimLaunchers, resolveShimBinPath } from '@cleocode/git-shim';
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
  describeDisposalBlockers,
  getGitRoot,
  gitSilent,
  gitSync,
  guardWorktreeDisposal,
  integrateWorktree,
  isCleoProvisionedWorktree,
  napiDestroyWorktree,
  pruneWorktrees,
  releaseWorktreeTaskLock,
  WORKTREE_LIFECYCLE_AUDIT_FILE,
} from '@cleocode/worktree';
import { appendWorktreeAuditEntry, resolveWorktreeAuditActor } from '../worktree/audit.js';
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
  // T14053: completion merges only worktrees whose creation is recorded.
  appendWorktreeAuditEntry(projectRoot, {
    actor: resolveWorktreeAuditActor(),
    action: 'create',
    target: worktreePath,
    branch,
    taskId,
    reason: 'spawn',
    success: true,
  });

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
 * @param shim - The {@link ensureGitShimDir} result; strict protection and the
 *   PATH entry apply only when it is installed (T13522). A bare directory
 *   string is taken as installed (legacy callers).
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
  shim: string | GitShimInstall,
  identity: { sessionId?: string | null; agentId?: string | null } = {},
): WorktreeSpawnResult {
  const pathKey = pathEnvKey();
  const shimDir = typeof shim === 'string' ? shim : shim.dir;
  const shimActive = typeof shim === 'string' || shim.installed;
  const envVars: Record<string, string> = {
    CLEO_AGENT_ROLE: 'worker',
    CLEO_AGENT_CWD: worktree.path,
    CLEO_WORKTREE_ROOT: worktree.path,
    CLEO_WORKTREE_BRANCH: worktree.branch,
    CLEO_PROJECT_HASH: worktree.projectHash,
    CLEO_BRANCH_PROTECTION: shimActive ? 'strict' : 'unavailable',
    ...(shimActive
      ? {
          CLEO_SHIM_MARKER: '.cleo/bin/git-shim',
          // Prepend the shim directory so `git` resolves to the shim. The platform
          // delimiter matters: `${shimDir}:${PATH}` on Windows fuses the shim dir
          // with the first real entry and loses both (T12605).
          [pathKey]: prependPathEntry(shimDir, process.env[pathKey]),
        }
      : {}),
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
    shimActive
      ? 'A git shim is active on your PATH that will exit 77 if you attempt these, or a push to main.'
      : 'No git shim could be installed for this worktree: these rules are NOT enforced, so follow them yourself.',
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
  /** Set (with `status: 'skipped'`) when the worktree was kept because something still needs its files (T13696). */
  kept?: WorktreeDisposalBlockers;
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
 * - Keeps the worktree (`{ status: 'skipped', kept }`) while another checkout
 *   symlinks into it or it holds evidence found nowhere else (T13696).
 * - Never throws — failures are returned in `{ status: 'error', error }`.
 *
 * @param taskId     - The CLEO task ID (e.g. "T1462").
 * @param projectRoot - Absolute path to the project root.
 * @param opts.auditLogPath - Override path for the audit JSONL (testing).
 * @param opts.evidence - The task's recorded evidence atoms (T13696).
 * @returns Prune outcome.
 *
 * @task T1462
 * @adr ADR-055
 */
export function pruneWorktree(
  taskId: string,
  projectRoot: string,
  opts: { auditLogPath?: string; evidence?: readonly EvidenceAtom[] } = {},
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

  // T13696: removal deletes the whole directory, so refuse while another
  // checkout links into it or it holds the only copy of the task's evidence.
  const kept = guardWorktreeDisposal(worktreePath, {
    taskId,
    reason: 'complete',
    gitRoot,
    projectRoot,
    evidence: opts.evidence,
  });
  if (kept !== null) {
    const error = describeDisposalBlockers(worktreePath, kept);
    try {
      const logPath =
        opts.auditLogPath ?? join(projectRoot, '.cleo', 'audit', 'worktree-prune.jsonl');
      mkdirSync(dirname(logPath), { recursive: true });
      const entry = JSON.stringify({
        timestamp: new Date().toISOString(),
        taskId,
        worktreePath,
        action: 'kept',
        ...kept,
        agent: process.env['CLEO_AGENT_ID'] ?? 'cleo',
      });
      appendFileSync(logPath, entry + '\n', 'utf-8');
    } catch {
      /* audit is best-effort */
    }
    return {
      taskId,
      status: 'skipped',
      worktreeRemoved: false,
      branchDeleted: false,
      wasDirty: false,
      error,
      kept,
    };
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
 * ssh options for the upstream fetch: batch mode (no prompt), a bounded
 * connect, and keepalives so a stalled connection fails fast.
 */
const SSH_NON_INTERACTIVE_OPTS = '-oBatchMode=yes -oConnectTimeout=10 -oServerAliveInterval=5';

/**
 * Environment for a non-interactive `git fetch`: no terminal credential
 * prompt, and ssh with {@link SSH_NON_INTERACTIVE_OPTS} (an existing
 * `GIT_SSH_COMMAND` is preserved with the options appended).
 */
function nonInteractiveGitEnv(): NodeJS.ProcessEnv {
  const existingSsh = process.env['GIT_SSH_COMMAND']?.trim();
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_SSH_COMMAND: `${existingSsh || 'ssh'} ${SSH_NON_INTERACTIVE_OPTS}`,
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
      // Known small window: a SIGKILL landing while git updates the
      // remote-tracking ref can leave `refs/remotes/<remote>/<branch>.lock`
      // behind, which makes the next fetch of that ref fail until the stale
      // lock file is removed. SSH connect/keepalive bounds (above) make a
      // timeout — and so this kill — rare.
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

  // Single-quoted for the shell: macOS roots often contain spaces, and branch
  // / remote names are operator-controlled.
  const quotedRoot = shellQuote(gitRoot);
  const quotedTarget = shellQuote(targetBranch);
  const quotedUpstream = shellQuote(upstreamShort);
  // Diverged (ahead AND behind): merge, never `pull --rebase` — a rebase
  // would drop the local ADR-062 `--no-ff` task merge commits and rewrite
  // agent SHAs. Behind only: fast-forward.
  const syncCommand =
    behind === 0
      ? ''
      : ahead > 0
        ? `git -C ${quotedRoot} switch ${quotedTarget} && git -C ${quotedRoot} merge ${quotedUpstream}`
        : `git -C ${quotedRoot} switch ${quotedTarget} && git -C ${quotedRoot} merge --ff-only ${quotedUpstream}`;
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
          ? `${syncState}: sync it with \`${syncCommand}\` (a merge, not a rebase, so the local --no-ff task merges keep their SHAs), then ${rerun}. A task merge now would fork '${targetBranch}' further from ${upstreamShort}; alternatively land '${branch}' through a PR.`
          : `${syncState}, so a merge there would fork it from ${upstreamShort}. Land '${branch}' through a PR, or sync first (${syncCommand}) and ${rerun}.`,
    };
  }
  return { ...proceed, ...base };
}

/**
 * Options for {@link planWorktreeIntegration} and the merge run that shares
 * its decision (T14053).
 */
export interface WorktreeIntegrationDecisionOptions {
  /** Override the resolved default branch. */
  targetBranch?: string;
  /**
   * Set when integration is switched off (`cleo complete --no-integrate`,
   * `CLEO_NO_AUTO_WORKTREE_COMPLETE`): the decision is `skip` with this reason.
   */
  disabledReason?: string;
  /** Skip the upstream `git fetch` (the plan never fetches). */
  skipFetch?: boolean;
  /** Timeout for the upstream fetch. */
  fetchTimeoutMs?: number;
}

/** Which rule produced a {@link WorktreeIntegrationDecision}. */
type WorktreeIntegrationRule =
  | 'disabled'
  | 'no-git'
  | 'nothing'
  | 'not-provisioned'
  | 'upstream'
  | 'root'
  | 'merge';

/** A {@link WorktreeIntegrationPlan} plus what the merge run needs to act on it. */
interface WorktreeIntegrationDecision extends WorktreeIntegrationPlan {
  rule: WorktreeIntegrationRule;
  gitRoot: string | null;
  upstream: UpstreamIntegrationAssessment | null;
}

/**
 * Why a local merge must not run in the main checkout at `gitRoot`, or null
 * when it may (T14053). The merge checks out `targetBranch` there, so the
 * checkout must already be on it with no uncommitted tracked changes, and must
 * be the main checkout rather than a linked worktree (another task's). CLEO
 * never switches a checkout's branch.
 */
function mainCheckoutRefusal(gitRoot: string, branch: string, targetBranch: string): string | null {
  let linked: boolean;
  try {
    const gitDir = gitSync(['rev-parse', '--absolute-git-dir'], gitRoot);
    const commonDir = resolve(gitRoot, gitSync(['rev-parse', '--git-common-dir'], gitRoot));
    linked = realpathSync(gitDir) !== realpathSync(commonDir);
  } catch (err) {
    return `could not inspect the main checkout (${err instanceof Error ? err.message : String(err)}), so '${branch}' is not merged.`;
  }
  if (linked) {
    return `'${gitRoot}' is a linked worktree, not the main checkout; CLEO merges '${branch}' only from the project's main checkout.`;
  }
  let head: string;
  try {
    head = gitSync(['symbolic-ref', '--quiet', '--short', 'HEAD'], gitRoot);
  } catch {
    head = '(detached HEAD)';
  }
  if (head !== targetBranch) {
    return `the main checkout is on '${head}', not '${targetBranch}', and CLEO does not switch it; switch it yourself and run \`cleo orchestrate worktree-complete\`, or land '${branch}' through a PR.`;
  }
  let dirty: boolean;
  try {
    dirty = gitSync(['status', '--porcelain', '--untracked-files=no'], gitRoot).length > 0;
  } catch {
    dirty = true;
  }
  if (dirty) {
    return `the main checkout has uncommitted changes, so CLEO does not merge into it; commit or stash them and run \`cleo orchestrate worktree-complete\`, or land '${branch}' through a PR.`;
  }
  return null;
}

/**
 * Decide what completion does with a task's worktree branch (T14053): the one
 * decision both `cleo done --plan` and the merge run use. Checks, in order:
 * switched off; not a git repo; nothing to integrate; not provisioned by CLEO
 * (a hand-made `task/<id>` branch is never merged); already landed upstream or
 * a stale local target (T12773); a main checkout a merge would disturb.
 * Only reads git, plus the upstream fetch unless `skipFetch`.
 */
function decideWorktreeIntegration(
  taskId: string,
  projectRoot: string,
  opts: WorktreeIntegrationDecisionOptions,
): WorktreeIntegrationDecision {
  const branch = `task/${taskId}`;
  const worktreePath = join(resolveAgentWorktreeRoot(projectRoot), taskId);
  const targetBranch = opts.targetBranch ?? getDefaultBranch(projectRoot);
  const base = { branch, worktreePath, targetBranch, gitRoot: null, upstream: null };
  if (opts.disabledReason) {
    return { ...base, rule: 'disabled', action: 'skip', reason: opts.disabledReason };
  }
  let gitRoot: string;
  try {
    gitRoot = getGitRoot(projectRoot);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ...base, rule: 'no-git', action: 'skip', reason: `Not a git repo: ${message}` };
  }
  const at = { ...base, gitRoot };
  // T12153 (GH #1223) — most tasks are worked on a feature branch and merged
  // by PR, so no `task/<id>` branch and no agent worktree ever exist. That is
  // "nothing to integrate", not a failure.
  const branchExists = gitSync(['branch', '--list', branch], gitRoot).trim().length > 0;
  if (!branchExists && !existsSync(worktreePath)) {
    return {
      ...at,
      rule: 'nothing',
      action: 'skip',
      reason: `no task branch '${branch}' and no worktree — nothing to integrate`,
    };
  }
  if (!isCleoProvisionedWorktree(projectRoot, taskId, worktreePath)) {
    return {
      ...at,
      rule: 'not-provisioned',
      action: 'skip',
      reason: `'${branch}' was not provisioned by CLEO (no create or adopt for ${worktreePath} in ${WORKTREE_LIFECYCLE_AUDIT_FILE}), so it is not merged; land it through a PR.`,
    };
  }
  // T12773 — never merge locally what already landed upstream, and never
  // merge into a local default branch that is behind origin.
  const upstream = branchExists
    ? assessUpstreamIntegration(gitRoot, branch, targetBranch, {
        skipFetch: opts.skipFetch ?? false,
        fetchTimeoutMs: opts.fetchTimeoutMs,
      })
    : null;
  const known = { ...at, upstream };
  if (upstream?.kind === 'landed' || upstream?.kind === 'nothing') {
    return { ...known, rule: 'upstream', action: 'skip', reason: upstream.hint };
  }
  if (upstream?.kind === 'stale-target') {
    return {
      ...known,
      rule: 'upstream',
      action: 'refuse',
      reason: `refusing local merge of '${branch}' into '${targetBranch}': ${upstream.hint}`,
    };
  }
  const refusal = mainCheckoutRefusal(gitRoot, branch, targetBranch);
  if (refusal !== null) return { ...known, rule: 'root', action: 'refuse', reason: refusal };
  return {
    ...known,
    rule: 'merge',
    action: 'merge',
    reason: `merge '${branch}' into local '${targetBranch}' with --no-ff (never pushed)`,
  };
}

/**
 * Preview what completing `taskId` does with its worktree branch, without
 * changing git: the same decision the merge run makes, from local refs only
 * (no fetch). Shown by `cleo done --plan` (T14053).
 *
 * @param taskId - The CLEO task ID.
 * @param projectRoot - Absolute path to the project root.
 * @param opts - Target override and the switched-off reason, if any.
 * @returns Branch, worktree path, target branch, `merge`/`skip`/`refuse` and why.
 *
 * @example
 * ```ts
 * planWorktreeIntegration('T123', root).action; // 'skip' for a task merged by PR
 * ```
 * @task T14053
 */
export function planWorktreeIntegration(
  taskId: string,
  projectRoot: string,
  opts: Omit<WorktreeIntegrationDecisionOptions, 'skipFetch' | 'fetchTimeoutMs'> = {},
): WorktreeIntegrationPlan {
  const { branch, worktreePath, targetBranch, action, reason } = decideWorktreeIntegration(
    taskId,
    projectRoot,
    { ...opts, skipFetch: true },
  );
  return { branch, worktreePath, targetBranch, action, reason };
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
 * 1. T14053: {@link decideWorktreeIntegration} first — the same decision
 *    `cleo done --plan` shows. A branch CLEO did not provision is skipped
 *    (`notProvisioned`), never merged; a main checkout on another branch,
 *    with uncommitted tracked changes, or a linked worktree is refused
 *    (`rootRefused`) without switching or merging anything.
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
 * @param opts.evidence - The task's evidence atoms; the prune keeps a worktree holding the only copy (T13696).
 * @param opts.fetchTimeoutMs - Timeout for the upstream fetch (default
 *   {@link UPSTREAM_FETCH_TIMEOUT_MS}).
 * @param opts.disabledReason - Integration is switched off; nothing is touched (T14053).
 * @returns Merge integration result, with the decision it acted on in `plan`.
 *
 * @task T1587
 * @task T14053
 * @adr ADR-062
 */
export function completeAgentWorktreeViaMerge(
  taskId: string,
  projectRoot: string,
  opts: {
    targetBranch?: string;
    disabledReason?: string;
    taskTitle?: string;
    skipFetch?: boolean;
    fetchTimeoutMs?: number;
    evidence?: readonly EvidenceAtom[];
  } = {},
): WorktreeMergeResult {
  // T14053: one decision, shared with `cleo done --plan`.
  const decision = decideWorktreeIntegration(taskId, projectRoot, opts);
  const { branch, worktreePath, targetBranch, upstream } = decision;
  const plan: WorktreeIntegrationPlan = {
    branch,
    worktreePath,
    targetBranch,
    action: decision.action,
    reason: decision.reason,
  };
  const noMerge = {
    taskId,
    targetBranch,
    merged: false,
    mergeCommit: '',
    commitCount: 0,
    rebased: false,
    worktreeRemoved: false,
    branchDeleted: false,
    plan,
  };
  if (decision.rule === 'disabled') return { ...noMerge, hint: decision.reason };
  if (decision.rule === 'no-git') return { ...noMerge, error: decision.reason };
  if (decision.rule === 'nothing') {
    // `error` is kept as a human-readable MESSAGE, while `nothingToIntegrate`
    // is the machine-readable CLASSIFICATION (T12153): a caller distinguishes
    // no-work from failure by the FLAG, never by the presence of a string.
    return { ...noMerge, error: decision.reason, nothingToIntegrate: true };
  }
  if (decision.rule === 'not-provisioned') {
    return { ...noMerge, notProvisioned: true, hint: decision.reason };
  }
  if (decision.rule === 'root') {
    return { ...noMerge, rootRefused: true, error: decision.reason, hint: decision.reason };
  }
  const gitRoot = decision.gitRoot as string;
  if (upstream?.kind === 'landed' || upstream?.kind === 'nothing') {
    // The commits are safe on origin (or there are none); clean up the
    // worktree unless it holds uncommitted work, which is left for the
    // operator. The checkout itself is never moved (hint-only).
    const dirty = existsSync(worktreePath) && isWorktreeDirty(worktreePath);
    const pruneResult = dirty
      ? null
      : pruneWorktree(taskId, projectRoot, { evidence: opts.evidence });
    let branchDeleted = pruneResult?.branchDeleted ?? false;
    // pruneWorktree only deletes a branch with zero commits ahead of the
    // checkout HEAD, so a stale local default branch, a squash merge, or a
    // checkout on another branch would leave `task/<id>` behind forever.
    // For a PROVEN-landed branch the content is on upstream, so delete it
    // explicitly — but only once its (clean) worktree is gone.
    if (
      upstream.kind === 'landed' &&
      pruneResult !== null &&
      !branchDeleted &&
      !existsSync(worktreePath)
    ) {
      branchDeleted = gitSilent(['branch', '-D', branch], gitRoot);
    }
    return {
      ...noMerge,
      worktreeRemoved: pruneResult?.worktreeRemoved ?? false,
      ...(pruneResult?.kept ? { worktreeKept: pruneResult.kept } : {}),
      branchDeleted,
      nothingToIntegrate: true,
      ...(upstream.kind === 'landed' ? { landedUpstream: true } : {}),
      ...(upstream.syncCommand ? { syncCommand: upstream.syncCommand } : {}),
      hint: dirty
        ? `${upstream.hint} Worktree ${worktreePath} has uncommitted changes and was preserved.`
        : pruneResult?.kept
          ? `${upstream.hint} ${pruneResult.error}`
          : upstream.hint,
    };
  }
  if (upstream?.kind === 'stale-target') {
    return {
      ...noMerge,
      error: decision.reason,
      staleTarget: true,
      syncCommand: upstream.syncCommand,
      hint: upstream.hint,
    };
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
    skipFetch: (opts.skipFetch ?? false) || (upstream?.fetched ?? false),
  });
  if (!result.merged) {
    return {
      ...noMerge,
      commitCount: result.commitCount,
      rebased: result.rebased,
      error: result.error,
    };
  }
  const pruneResult = pruneWorktree(taskId, projectRoot, { evidence: opts.evidence });
  return {
    ...noMerge,
    merged: true,
    mergeCommit: result.mergeCommit,
    commitCount: result.commitCount,
    rebased: result.rebased,
    worktreeRemoved: pruneResult.worktreeRemoved,
    ...(pruneResult.kept ? { worktreeKept: pruneResult.kept } : {}),
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
 * @param opts.evidence - The task's evidence atoms; the prune keeps a worktree holding the only copy (T13696).
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
    evidence?: readonly EvidenceAtom[];
  } = {},
): WorktreeIntegrationResult {
  const mergeResult = completeAgentWorktreeViaMerge(taskId, projectRoot, {
    targetBranch: opts.targetBranch,
    taskTitle: opts.taskTitle,
    skipFetch: opts.skipFetch,
    evidence: opts.evidence,
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
      worktreeKept: mergeResult.worktreeKept ?? null,
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

/**
 * The single integration result for a completion envelope (T14053): what the
 * run actually did, so it can never contradict the merge. `merge` only when a
 * merge commit was made; a decided merge that failed reads as `refuse`.
 *
 * @param result - The merge run's result (its `plan` is the decision it acted on).
 * @returns `{branch, worktreePath, targetBranch, action, reason, mergeCommit?, pushed: false}`.
 *
 * @example
 * ```ts
 * integrationOutcome(completeAgentWorktreeIntegration('T1', root)).action; // 'skip'
 * ```
 * @task T14053
 */
export function integrationOutcome(result: WorktreeMergeResult): WorktreeIntegrationOutcome {
  const plan: WorktreeIntegrationPlan = result.plan ?? {
    branch: `task/${result.taskId}`,
    worktreePath: '',
    targetBranch: result.targetBranch,
    action: 'skip',
    reason: result.error ?? result.hint ?? 'no integration decision recorded',
  };
  if (result.merged) {
    return {
      ...plan,
      action: 'merge',
      reason: `merged into local '${result.targetBranch}' with --no-ff; not pushed`,
      ...(result.mergeCommit ? { mergeCommit: result.mergeCommit } : {}),
      pushed: false,
    };
  }
  if (plan.action === 'merge') {
    return {
      ...plan,
      action: 'refuse',
      reason: `merge failed (${result.error ?? 'unknown error'}); branch and worktree kept`,
      pushed: false,
    };
  }
  return { ...plan, pushed: false };
}

// ---------------------------------------------------------------------------
// L2 — Shim materialisation
// ---------------------------------------------------------------------------

/** Result of {@link ensureGitShimDir}. */
export interface GitShimInstall {
  /** Directory to prepend to a worker's PATH. */
  readonly dir: string;
  /** True only when an executable `git` launcher now points at the real shim. */
  readonly installed: boolean;
  /** The shim entry point used, when one was found. */
  readonly shimBinPath: string | null;
  /** Why the shim is not installed. */
  readonly reason?: string;
}

/**
 * Install the git shim launcher in the project's `.cleo/bin/git-shim/` dir
 * (T1118, wired in by T13522). Idempotent.
 *
 * The shim is resolved from the `@cleocode/git-shim` package the running CLI
 * was installed with, not from the project's node_modules, so a standalone
 * project gets it too. When it cannot be found or the launcher cannot be
 * written, nothing is installed and `installed` is `false`: callers then
 * advertise `CLEO_BRANCH_PROTECTION=unavailable` rather than a fence that is
 * not there.
 *
 * @param projectRoot - Absolute path to the project root.
 * @param shimBinPath - The shim entry point (tests); defaults to the installed package's.
 * @returns Where the shim lives and whether it is installed.
 * @task T1118
 * @task T13522
 */
export function ensureGitShimDir(
  projectRoot: string,
  shimBinPath: string = resolveShimBinPath(),
): GitShimInstall {
  const dir = join(projectRoot, '.cleo', 'bin', 'git-shim');
  if (!existsSync(shimBinPath)) {
    return {
      dir,
      installed: false,
      shimBinPath: null,
      reason: `git shim not found at ${shimBinPath}`,
    };
  }
  try {
    // A symlink on POSIX; on Windows a `git.cmd` + sh launcher, since PATHEXT
    // ignores extensionless files and file symlinks need privileges (T12605).
    const launchers = installGitShimLaunchers(dir, shimBinPath);
    // Windows has no execute bit: there the launcher existing is the check.
    for (const launcher of launchers) {
      accessSync(launcher, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
    }
    return { dir, installed: true, shimBinPath };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      dir,
      installed: false,
      shimBinPath,
      reason: `git shim launcher not installed: ${reason}`,
    };
  }
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
