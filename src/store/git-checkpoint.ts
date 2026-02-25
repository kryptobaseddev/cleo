/**
 * Git checkpoint system for CLEO state files.
 * Ported from lib/data/git-checkpoint.sh
 *
 * Opt-in automatic git commits of .cleo/ state files at semantic
 * boundaries (save_json, session end) with debounce to prevent commit noise.
 * All git errors are suppressed - checkpointing is never fatal.
 *
 * @task T4552
 * @task T4872
 * @epic T4545
 */

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { getCleoDir, getConfigPath } from '../core/paths.js';
import { readJson } from './json.js';

const execFileAsync = promisify(execFile);

/**
 * Build environment variables that point git at the isolated .cleo/.git repo.
 * @task T4872
 */
function makeCleoGitEnv(cleoDir: string): NodeJS.ProcessEnv {
  // resolve() ensures GIT_DIR and GIT_WORK_TREE are absolute even when cleoDir
  // is a relative path (e.g. '.cleo' returned by getCleoDir() with no cwd arg)
  const abs = resolve(cleoDir);
  return {
    ...process.env,
    GIT_DIR: join(abs, '.git'),
    GIT_WORK_TREE: abs,
  };
}

/**
 * Run a git command against the isolated .cleo/.git repo, suppressing errors.
 * @task T4872
 */
async function cleoGitCommand(args: string[], cleoDir: string): Promise<{ stdout: string; success: boolean }> {
  try {
    const result = await execFileAsync('git', args, {
      cwd: resolve(cleoDir), // absolute cwd so relative paths in args resolve correctly
      env: makeCleoGitEnv(cleoDir),
      timeout: 10_000,
    });
    return { stdout: result.stdout.trim(), success: true };
  } catch {
    return { stdout: '', success: false };
  }
}

/**
 * Check whether the isolated .cleo/.git repo has been initialized.
 * @task T4872
 */
export function isCleoGitInitialized(cleoDir: string): boolean {
  return existsSync(join(cleoDir, '.git', 'HEAD'));
}

/**
 * State files and directories eligible for checkpointing (relative to .cleo/).
 *
 * Only human-editable JSON config files (per ADR-006) and documentation
 * output directories. All operational data lives in tasks.db (SQLite).
 * tasks.db is excluded from git — backed up via VACUUM INTO rotation instead.
 *
 * Directory entries (trailing slash) are passed directly to git; git handles
 * them recursively for add/diff/ls-files operations.
 *
 * TODO: make this list config-driven via a .cleoignore-style allowlist in
 * config.json so users can add custom files without touching source code.
 */
const STATE_FILES = [
  // Human-editable config files (ADR-006: JSON retained for human-editable config only)
  'config.json',
  'project-info.json',
  'project-context.json',
  // Architecture decisions and research outputs (docs, never in SQLite)
  'adrs/',
  'agent-outputs/',
] as const;

/** Debounce state file name (relative to .cleo/). */
const CHECKPOINT_STATE_FILE = '.git-checkpoint-state';

/** Checkpoint configuration. */
export interface CheckpointConfig {
  enabled: boolean;
  debounceMinutes: number;
  messagePrefix: string;
  noVerify: boolean;
}

/** Checkpoint status information. */
export interface CheckpointStatus {
  config: CheckpointConfig;
  status: {
    isGitRepo: boolean;
    lastCheckpoint: string;
    lastCheckpointEpoch: number;
    pendingChanges: number;
    suppressed: boolean;
  };
}

/** Changed file with its status. */
export interface ChangedFile {
  path: string;
  status: 'modified' | 'untracked';
}

/**
 * Load checkpoint configuration from config.json.
 * @task T4552
 */
export async function loadCheckpointConfig(cwd?: string): Promise<CheckpointConfig> {
  try {
    const configPath = getConfigPath(cwd);
    const config = await readJson<Record<string, unknown>>(configPath);
    const gc = (config as Record<string, Record<string, unknown>> | null)?.gitCheckpoint;

    return {
      enabled: gc?.enabled !== false,
      debounceMinutes: typeof gc?.debounceMinutes === 'number' ? gc.debounceMinutes : 5,
      messagePrefix: typeof gc?.messagePrefix === 'string' ? gc.messagePrefix : 'chore(cleo):',
      noVerify: gc?.noVerify !== false,
    };
  } catch {
    return {
      enabled: true,
      debounceMinutes: 5,
      messagePrefix: 'chore(cleo):',
      noVerify: true,
    };
  }
}

/**
 * Check if the isolated .cleo/.git repo is a valid git work tree.
 * @task T4552
 * @task T4872
 */
async function isCleoGitRepo(cleoDir: string): Promise<boolean> {
  const result = await cleoGitCommand(['rev-parse', '--is-inside-work-tree'], cleoDir);
  // On a freshly initialized empty repo, git returns "false" (no commits yet) but
  // the repo is still valid for staging + committing. Fall back to existsSync check.
  return result.success && (result.stdout === 'true' || isCleoGitInitialized(cleoDir));
}

/**
 * Check if a merge is in progress in the .cleo/.git repo.
 * @task T4552
 * @task T4872
 */
function isMergeInProgress(cleoDir: string): boolean {
  return existsSync(join(cleoDir, '.git', 'MERGE_HEAD'));
}

/**
 * Check if HEAD is detached in the .cleo/.git repo.
 * @task T4552
 * @task T4872
 */
async function isDetachedHead(cleoDir: string): Promise<boolean> {
  const result = await cleoGitCommand(['symbolic-ref', 'HEAD'], cleoDir);
  return !result.success;
}

/**
 * Check if a rebase is in progress in the .cleo/.git repo.
 * @task T4552
 * @task T4872
 */
function isRebaseInProgress(cleoDir: string): boolean {
  return existsSync(join(cleoDir, '.git', 'rebase-merge')) ||
    existsSync(join(cleoDir, '.git', 'rebase-apply'));
}

/**
 * Record the current time as the last checkpoint time.
 * @task T4552
 */
async function recordCheckpointTime(cleoDir: string): Promise<void> {
  try {
    const stateFile = join(cleoDir, CHECKPOINT_STATE_FILE);
    await writeFile(stateFile, String(Math.floor(Date.now() / 1000)));
  } catch {
    // Non-fatal
  }
}

/**
 * Get the epoch time of the last checkpoint.
 * @task T4552
 */
async function getLastCheckpointTime(cleoDir: string): Promise<number> {
  try {
    const stateFile = join(cleoDir, CHECKPOINT_STATE_FILE);
    const content = await readFile(stateFile, 'utf-8');
    const epoch = parseInt(content.trim(), 10);
    return isNaN(epoch) ? 0 : epoch;
  } catch {
    return 0;
  }
}

/**
 * Get list of state files with pending changes in the .cleo/.git repo.
 * Paths are relative to cleoDir (the git work tree).
 * @task T4552
 * @task T4872
 */
async function getChangedStateFiles(cleoDir: string): Promise<ChangedFile[]> {
  const changed: ChangedFile[] = [];

  for (const stateFile of STATE_FILES) {
    const fullPath = join(cleoDir, stateFile);
    if (!existsSync(fullPath)) continue;

    // Check for staged or unstaged changes (paths relative to cleoDir work tree)
    const diffResult = await cleoGitCommand(['diff', '--quiet', '--', stateFile], cleoDir);
    const cachedResult = await cleoGitCommand(['diff', '--cached', '--quiet', '--', stateFile], cleoDir);
    const untrackedResult = await cleoGitCommand(
      ['ls-files', '--others', '--exclude-standard', '--', stateFile],
      cleoDir,
    );

    if (!diffResult.success || !cachedResult.success) {
      changed.push({ path: stateFile, status: 'modified' });
    } else if (untrackedResult.stdout.length > 0) {
      changed.push({ path: stateFile, status: 'untracked' });
    }
  }

  return changed;
}

/**
 * Check whether a checkpoint should be performed.
 * Evaluates: enabled, .cleo/.git initialized, debounce elapsed, files changed.
 * @task T4552
 * @task T4872
 */
export async function shouldCheckpoint(
  options?: { force?: boolean; cwd?: string },
): Promise<boolean> {
  const force = options?.force ?? false;
  const cwd = options?.cwd;

  // Suppression check (even force doesn't override explicit suppression)
  if (process.env['GIT_CHECKPOINT_SUPPRESS'] === 'true') {
    return false;
  }

  const config = await loadCheckpointConfig(cwd);

  if (!config.enabled) return false;

  const cleoDir = getCleoDir(cwd);
  if (!existsSync(cleoDir)) return false;

  // Guard: .cleo/.git must be initialized (run `cleo init` to enable checkpointing)
  if (!isCleoGitInitialized(cleoDir)) return false;

  if (!(await isCleoGitRepo(cleoDir))) return false;
  if (isMergeInProgress(cleoDir)) return false;
  if (await isDetachedHead(cleoDir)) return false;
  if (isRebaseInProgress(cleoDir)) return false;

  // Check debounce (unless forced)
  if (!force) {
    const lastCheckpoint = await getLastCheckpointTime(cleoDir);
    const now = Math.floor(Date.now() / 1000);
    const elapsed = now - lastCheckpoint;
    const debounceSeconds = config.debounceMinutes * 60;

    if (elapsed < debounceSeconds) return false;
  }

  // Check if any state files have changes
  const changed = await getChangedStateFiles(cleoDir);
  return changed.length > 0;
}

/**
 * Stage .cleo/ state files and commit to the isolated .cleo/.git repo.
 * Never fatal - all git errors are suppressed.
 * @task T4552
 * @task T4872
 */
export async function gitCheckpoint(
  trigger: 'auto' | 'session-end' | 'manual' = 'auto',
  context?: string,
  cwd?: string,
): Promise<void> {
  // Suppression check
  if (process.env['GIT_CHECKPOINT_SUPPRESS'] === 'true') {
    return;
  }

  const force = trigger === 'manual';

  if (!(await shouldCheckpoint({ force, cwd }))) {
    return;
  }

  const config = await loadCheckpointConfig(cwd);
  const cleoDir = getCleoDir(cwd);
  const changed = await getChangedStateFiles(cleoDir);

  if (changed.length === 0) return;

  // Stage changed files (paths are relative to cleoDir work tree)
  let stagedCount = 0;
  for (const file of changed) {
    const result = await cleoGitCommand(['add', file.path], cleoDir);
    if (result.success) stagedCount++;
  }

  if (stagedCount === 0) return;

  // Build commit message
  let commitMsg = `${config.messagePrefix} ${trigger} checkpoint`;
  if (context) {
    commitMsg = `${config.messagePrefix} ${trigger} checkpoint (${context})`;
  }

  // Build commit args
  const commitArgs = ['commit', '-m', commitMsg];
  if (config.noVerify) {
    commitArgs.push('--no-verify');
  }

  // Restrict commit to only the staged state files (prevents sweeping pre-staged project files)
  commitArgs.push('--', ...changed.map(f => f.path));

  // Commit to .cleo/.git
  const commitResult = await cleoGitCommand(commitArgs, cleoDir);

  if (!commitResult.success) {
    // If commit failed, unstage our changes
    for (const file of changed) {
      await cleoGitCommand(['reset', 'HEAD', '--', file.path], cleoDir);
    }
    return;
  }

  // Record checkpoint time
  await recordCheckpointTime(cleoDir);
}

/**
 * Show checkpoint configuration and status.
 * @task T4552
 * @task T4872
 */
export async function gitCheckpointStatus(cwd?: string): Promise<CheckpointStatus> {
  const config = await loadCheckpointConfig(cwd);
  const cleoDir = getCleoDir(cwd);
  const lastCheckpoint = await getLastCheckpointTime(cleoDir);

  let lastCheckpointIso = 'never';
  if (lastCheckpoint !== 0) {
    lastCheckpointIso = new Date(lastCheckpoint * 1000).toISOString();
  }

  const isRepo = isCleoGitInitialized(cleoDir) && await isCleoGitRepo(cleoDir);

  let pendingChanges = 0;
  if (isRepo) {
    const changed = await getChangedStateFiles(cleoDir);
    pendingChanges = changed.length;
  }

  const suppressed = process.env['GIT_CHECKPOINT_SUPPRESS'] === 'true';

  return {
    config,
    status: {
      isGitRepo: isRepo,
      lastCheckpoint: lastCheckpointIso,
      lastCheckpointEpoch: lastCheckpoint,
      pendingChanges,
      suppressed,
    },
  };
}

/**
 * Show what files would be committed (dry-run).
 * @task T4552
 * @task T4872
 */
export async function gitCheckpointDryRun(cwd?: string): Promise<ChangedFile[]> {
  const cleoDir = getCleoDir(cwd);
  const isRepo = isCleoGitInitialized(cleoDir) && await isCleoGitRepo(cleoDir);

  if (!isRepo) return [];

  return getChangedStateFiles(cleoDir);
}
