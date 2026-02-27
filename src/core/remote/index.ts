/**
 * Remote module for .cleo/.git push/pull operations.
 *
 * Manages a dedicated git remote for the isolated .cleo/.git repo
 * (ADR-013, ADR-015 Phase 2). Enables multi-contributor sharing
 * of CLEO state files via standard git push/pull semantics.
 *
 * @task T4884
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { getCleoDirAbsolute } from '../paths.js';
import {
  makeCleoGitEnv,
  cleoGitCommand,
  isCleoGitInitialized,
} from '../../store/git-checkpoint.js';

const execFileAsync = promisify(execFile);

/** Remote configuration. */
export interface RemoteConfig {
  name: string;
  url: string;
}

/** Result of a push operation. */
export interface PushResult {
  success: boolean;
  branch: string;
  remote: string;
  message: string;
}

/** Result of a pull operation. */
export interface PullResult {
  success: boolean;
  branch: string;
  remote: string;
  message: string;
  hasConflicts: boolean;
  conflictFiles: string[];
}

/** Result of a remote list operation. */
export interface RemoteInfo {
  name: string;
  fetchUrl: string;
  pushUrl: string;
}

/**
 * Run a git command against .cleo/.git with full output (not suppressed).
 * Unlike cleoGitCommand, this returns stderr and throws on error.
 * @task T4884
 */
async function cleoGitExec(
  args: string[],
  cleoDir: string,
): Promise<{ stdout: string; stderr: string }> {
  const abs = resolve(cleoDir);
  const result = await execFileAsync('git', args, {
    cwd: abs,
    env: makeCleoGitEnv(cleoDir),
    timeout: 30_000, // Longer timeout for network operations
  });
  return { stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

/**
 * Verify that .cleo/.git is initialized.
 * @task T4884
 */
function ensureCleoGitRepo(cleoDir: string): void {
  if (!isCleoGitInitialized(cleoDir)) {
    throw new Error('.cleo/.git not initialized. Run: cleo init');
  }
}

/**
 * Get the current branch name in .cleo/.git.
 * @task T4884
 */
export async function getCurrentBranch(cwd?: string): Promise<string> {
  const cleoDir = getCleoDirAbsolute(cwd);
  ensureCleoGitRepo(cleoDir);

  const result = await cleoGitCommand(['rev-parse', '--abbrev-ref', 'HEAD'], cleoDir);
  if (!result.success || !result.stdout) {
    // No commits yet -- default to 'main'
    return 'main';
  }
  return result.stdout;
}

/**
 * Add a git remote to .cleo/.git.
 * @task T4884
 */
export async function addRemote(url: string, name: string = 'origin', cwd?: string): Promise<void> {
  const cleoDir = getCleoDirAbsolute(cwd);
  ensureCleoGitRepo(cleoDir);

  // Check if remote already exists
  const existing = await cleoGitCommand(['remote', 'get-url', name], cleoDir);
  if (existing.success) {
    throw new Error(`Remote '${name}' already exists with URL: ${existing.stdout}. Use 'cleo remote remove ${name}' first.`);
  }

  try {
    await cleoGitExec(['remote', 'add', name, url], cleoDir);
  } catch (err) {
    throw new Error(`Failed to add remote '${name}': ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Remove a git remote from .cleo/.git.
 * @task T4884
 */
export async function removeRemote(name: string = 'origin', cwd?: string): Promise<void> {
  const cleoDir = getCleoDirAbsolute(cwd);
  ensureCleoGitRepo(cleoDir);

  try {
    await cleoGitExec(['remote', 'remove', name], cleoDir);
  } catch (err) {
    throw new Error(`Failed to remove remote '${name}': ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * List configured remotes in .cleo/.git.
 * @task T4884
 */
export async function listRemotes(cwd?: string): Promise<RemoteInfo[]> {
  const cleoDir = getCleoDirAbsolute(cwd);
  ensureCleoGitRepo(cleoDir);

  const result = await cleoGitCommand(['remote', '-v'], cleoDir);
  if (!result.success || !result.stdout) {
    return [];
  }

  const remoteMap = new Map<string, RemoteInfo>();
  for (const line of result.stdout.split('\n')) {
    const match = line.match(/^(\S+)\s+(\S+)\s+\((\w+)\)$/);
    if (!match) continue;
    const [, name, url, type] = match;
    if (!name || !url) continue;

    if (!remoteMap.has(name)) {
      remoteMap.set(name, { name, fetchUrl: '', pushUrl: '' });
    }
    const info = remoteMap.get(name)!;
    if (type === 'fetch') info.fetchUrl = url;
    if (type === 'push') info.pushUrl = url;
  }

  return [...remoteMap.values()];
}

/**
 * Push .cleo/.git to a remote.
 * @task T4884
 */
export async function push(
  remote: string = 'origin',
  options?: { force?: boolean; setUpstream?: boolean },
  cwd?: string,
): Promise<PushResult> {
  const cleoDir = getCleoDirAbsolute(cwd);
  ensureCleoGitRepo(cleoDir);

  const branch = await getCurrentBranch(cwd);
  const args = ['push'];

  if (options?.setUpstream) {
    args.push('-u');
  }
  if (options?.force) {
    args.push('--force');
  }

  args.push(remote, branch);

  try {
    const result = await cleoGitExec(args, cleoDir);
    return {
      success: true,
      branch,
      remote,
      message: result.stderr || result.stdout || 'Push successful',
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    // Check for common push failures
    if (message.includes('rejected') || message.includes('non-fast-forward')) {
      return {
        success: false,
        branch,
        remote,
        message: `Push rejected: remote has changes. Run 'cleo pull' first, then try again.`,
      };
    }

    return {
      success: false,
      branch,
      remote,
      message: `Push failed: ${message}`,
    };
  }
}

/**
 * Pull from a remote into .cleo/.git.
 * Uses rebase strategy to maintain clean history.
 * @task T4884
 */
export async function pull(
  remote: string = 'origin',
  cwd?: string,
): Promise<PullResult> {
  const cleoDir = getCleoDirAbsolute(cwd);
  ensureCleoGitRepo(cleoDir);

  const branch = await getCurrentBranch(cwd);

  // First fetch
  try {
    await cleoGitExec(['fetch', remote], cleoDir);
  } catch (err) {
    return {
      success: false,
      branch,
      remote,
      message: `Fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      hasConflicts: false,
      conflictFiles: [],
    };
  }

  // Check if remote branch exists
  const remoteBranch = `${remote}/${branch}`;
  const refCheck = await cleoGitCommand(['rev-parse', '--verify', remoteBranch], cleoDir);
  if (!refCheck.success) {
    return {
      success: true,
      branch,
      remote,
      message: `No remote branch '${remoteBranch}' found. Nothing to pull.`,
      hasConflicts: false,
      conflictFiles: [],
    };
  }

  // Attempt merge (prefer merge over rebase for simpler conflict resolution)
  try {
    const result = await cleoGitExec(['merge', remoteBranch], cleoDir);
    return {
      success: true,
      branch,
      remote,
      message: result.stdout || 'Pull successful (up to date)',
      hasConflicts: false,
      conflictFiles: [],
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    // Check for merge conflicts
    if (message.includes('CONFLICT') || message.includes('Automatic merge failed')) {
      // Get list of conflicting files
      const conflictResult = await cleoGitCommand(['diff', '--name-only', '--diff-filter=U'], cleoDir);
      const conflictFiles = conflictResult.stdout ? conflictResult.stdout.split('\n').filter(Boolean) : [];

      return {
        success: false,
        branch,
        remote,
        message: 'Merge conflicts detected. Resolve conflicts in .cleo/ files, then run: cleo push',
        hasConflicts: true,
        conflictFiles,
      };
    }

    return {
      success: false,
      branch,
      remote,
      message: `Pull failed: ${message}`,
      hasConflicts: false,
      conflictFiles: [],
    };
  }
}

/**
 * Get the sync status between local .cleo/.git and remote.
 * @task T4884
 */
export async function getSyncStatus(
  remote: string = 'origin',
  cwd?: string,
): Promise<{ ahead: number; behind: number; branch: string; remote: string }> {
  const cleoDir = getCleoDirAbsolute(cwd);
  ensureCleoGitRepo(cleoDir);

  const branch = await getCurrentBranch(cwd);

  // Fetch latest state (silently)
  await cleoGitCommand(['fetch', remote], cleoDir);

  // Compare local vs remote
  const remoteBranch = `${remote}/${branch}`;
  const result = await cleoGitCommand(
    ['rev-list', '--left-right', '--count', `${branch}...${remoteBranch}`],
    cleoDir,
  );

  if (!result.success || !result.stdout) {
    return { ahead: 0, behind: 0, branch, remote };
  }

  const parts = result.stdout.split(/\s+/);
  const ahead = parseInt(parts[0] ?? '0', 10);
  const behind = parseInt(parts[1] ?? '0', 10);

  return { ahead, behind, branch, remote };
}
