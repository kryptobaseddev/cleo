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
import { accessSync, appendFileSync, chmodSync, constants, existsSync, mkdirSync } from 'node:fs';
import { platform } from 'node:os';
import { dirname, join } from 'node:path';

import type {
  AgentWorktreeState,
  EvidenceAtom,
  FsHardenCapabilities,
  FsHardenState,
  WorktreeCleanupResult,
  WorktreeDisposalBlockers,
  WorktreeLifecycleState,
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
  createWorktree,
  disposeWorktree,
  getGitRoot,
  gitSync,
  locateTaskWorktree,
  pruneWorktrees,
  readWorktreeProvisioning,
} from '@cleocode/worktree';
import { resolveSpawnLockHolder } from './worktree-lock-holder.js';

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
 * Read a task's worktree lifecycle state through one typed model (T10871):
 * the worktree git has registered for the task (its path, branch and lock),
 * else the canonical path; how CLEO provisioned it (newest `create`/`adopt`
 * lifecycle row); and whether it has uncommitted changes. Read-only.
 *
 * @param projectRoot - Absolute path to the project root.
 * @param taskId - Task whose worktree is read.
 * @returns The state; `registered`/`exists` false when there is no worktree.
 *
 * @task T10871
 */
export function readWorktreeLifecycleState(
  projectRoot: string,
  taskId: string,
): WorktreeLifecycleState {
  const located = locateTaskWorktree(projectRoot, taskId);
  const path = located?.path ?? join(resolveAgentWorktreeRoot(projectRoot), taskId);
  const exists = existsSync(path);
  let dirty = false;
  if (exists) {
    try {
      dirty = gitSync(['status', '--porcelain'], path) !== '';
    } catch {
      // Not a readable checkout: report clean rather than guess.
    }
  }
  return {
    taskId,
    path,
    branch: located?.branch ?? `task/${taskId}`,
    registered: located !== null,
    exists,
    provisioning: readWorktreeProvisioning(projectRoot, taskId, path),
    locked: located?.locked ?? false,
    dirty,
  };
}

/**
 * Create a git worktree for a spawned agent task.
 *
 * Delegates to the `@cleocode/worktree` facade ({@link createWorktree}), which
 * owns `git worktree add`/`lock`, the per-task lock, the lifecycle audit row
 * (`create`, or `adopt` for a re-attached worktree) and the sentinel index
 * (T10858). Branch `task/<taskId>` is cut from the orchestrator's HEAD; an
 * existing worktree for the task is re-attached, never destroyed. No
 * `.worktreeinclude` copy or dependency install runs, as before.
 *
 * @param taskId - The task ID driving the spawn.
 * @param projectRoot - Absolute path to the project root.
 * @returns The created worktree state.
 *
 * @task T1118
 * @task T1120
 * @task T11122
 * @task T11123
 * @task T10858
 */
export async function createAgentWorktree(
  taskId: string,
  projectRoot: string,
): Promise<AgentWorktreeState> {
  const result = await createWorktree(projectRoot, {
    taskId,
    holder: resolveSpawnLockHolder(),
    applyIncludePatterns: false,
    skipInstall: true,
  });
  return {
    path: result.path,
    branch: result.branch,
    taskId,
    baseRef: result.baseRef,
    projectHash: result.projectHash,
    createdAt: result.createdAt,
    locked: result.locked,
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
export function shellQuote(value: string): string {
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
  /** Whether the worktree's content or commits were not proven preserved (T13924: it is then kept). */
  wasDirty: boolean;
  /** Error message if any step failed. */
  error?: string;
  /** Set (with `status: 'skipped'`) when the worktree was kept because something still needs its files (T13696). */
  kept?: WorktreeDisposalBlockers;
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
 * - Disposes of the worktree through the worktree package's `disposeWorktree`
 *   engine (T13924): it is removed only with proof nothing in it is lost, and
 *   otherwise kept (`{ status: 'skipped', error }`, `wasDirty` when its
 *   content or commits are unpreserved) with a `kept` audit entry in
 *   `.cleo/audit/worktree-prune.jsonl`. A dirty worktree is never force-removed.
 * - Keeps the worktree (`{ status: 'skipped', kept }`) while another checkout
 *   symlinks into it or it holds evidence found nowhere else (T13696).
 * - Deletes `task/<taskId>` branch only when it has 0 commits ahead of the
 *   current HEAD (i.e. the branch has already been merged or is empty).
 *   When commits are still present the branch is left in place and reported in
 *   the result — callers should use `completeAgentWorktreeViaMerge` first.
 * - Never throws — failures are returned in `{ status: 'error', error }`.
 *
 * @param taskId     - The CLEO task ID (e.g. "T1462").
 * @param projectRoot - Absolute path to the project root.
 * @param opts.auditLogPath - Override path for the audit JSONL (testing).
 * @param opts.evidence - The task's recorded evidence atoms (T13696).
 * @param opts.defaultBranch - The branch the task's commits were integrated
 *   into; they count as preserved there (T13924).
 * @returns Prune outcome.
 *
 * @task T1462
 * @adr ADR-055
 */
export function pruneWorktree(
  taskId: string,
  projectRoot: string,
  opts: { auditLogPath?: string; evidence?: readonly EvidenceAtom[]; defaultBranch?: string } = {},
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
    // Still remove a stale branch, but only one holding no commits beyond HEAD.
    return {
      taskId,
      status: 'skipped',
      worktreeRemoved: false,
      branchDeleted: deleteBranchWithoutNewCommits(gitRoot, branch),
      wasDirty: false,
    };
  }

  // T13924: the one disposal engine. It keeps the worktree while another
  // checkout links into it, evidence lives only there (T13696), or anything
  // in it (changes, untracked or ignored files, commits on no remote and no
  // other branch) is not proven preserved. Nothing is force-removed here.
  const disposal = disposeWorktree({
    worktreePath,
    gitRoot,
    projectRoot,
    taskId,
    reason: 'complete',
    evidence: opts.evidence,
    defaultBranch: opts.defaultBranch,
  });
  const wasDirty = disposal.unpreserved !== undefined;
  if (!disposal.removed) {
    const error = disposal.kept
      ? (disposal.keptReason ?? '')
      : `Worktree ${worktreePath} kept: ${disposal.keptReason ?? 'not proven preserved'}. Commit and push the work, then run \`cleo worktree destroy ${taskId}\` (or \`--force\` to archive it and remove it).`;
    try {
      const logPath =
        opts.auditLogPath ?? join(projectRoot, '.cleo', 'audit', 'worktree-prune.jsonl');
      mkdirSync(dirname(logPath), { recursive: true });
      const entry = JSON.stringify({
        timestamp: new Date().toISOString(),
        taskId,
        worktreePath,
        action: 'kept',
        ...(disposal.kept ?? {}),
        ...(disposal.unpreserved !== undefined ? { unpreserved: disposal.unpreserved } : {}),
        agent: process.env['CLEO_AGENT_ID'] ?? 'cleo',
      });
      appendFileSync(logPath, entry + '\n', 'utf-8');
    } catch {
      /* audit is best-effort */
    }
    return {
      taskId,
      status: disposal.failed !== undefined ? 'error' : 'skipped',
      worktreeRemoved: false,
      branchDeleted: false,
      wasDirty,
      error,
      ...(disposal.kept ? { kept: disposal.kept } : {}),
    };
  }

  return {
    taskId,
    status: 'pruned',
    worktreeRemoved: true,
    branchDeleted: deleteBranchWithoutNewCommits(gitRoot, branch),
    wasDirty,
  };
}

/**
 * Delete `branch` only when it holds no commit beyond the repository's current
 * HEAD (merged or empty); a missing branch counts as deleted. Never throws.
 *
 * @param gitRoot - Repository root.
 * @param branch - Local branch name.
 * @returns Whether the branch is gone.
 */
function deleteBranchWithoutNewCommits(gitRoot: string, branch: string): boolean {
  try {
    if (!gitSync(['branch', '--list', branch], gitRoot)) return true; // already gone
    let baseRef: string;
    try {
      baseRef = gitSync(['rev-parse', '--abbrev-ref', 'HEAD'], gitRoot);
    } catch {
      baseRef = 'main';
    }
    const ahead = gitSync(['log', '--format=%H', `${baseRef}..${branch}`], gitRoot)
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    if (ahead.length > 0) return false; // commits ahead — leave the branch
    gitSync(['branch', '-D', branch], gitRoot);
    return true;
  } catch {
    return false;
  }
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
