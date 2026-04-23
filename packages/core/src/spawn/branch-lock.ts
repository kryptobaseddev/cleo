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
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
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
