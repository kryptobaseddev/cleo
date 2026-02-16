/**
 * Git checkpoint system for CLEO state files.
 * Ported from lib/data/git-checkpoint.sh
 *
 * Opt-in automatic git commits of .cleo/ state files at semantic
 * boundaries (save_json, session end) with debounce to prevent commit noise.
 * All git errors are suppressed - checkpointing is never fatal.
 *
 * @task T4552
 * @epic T4545
 */

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { getCleoDir, getConfigPath } from '../core/paths.js';
import { readJson } from './json.js';

const execFileAsync = promisify(execFile);

/** State files eligible for checkpointing (relative to .cleo/). */
const STATE_FILES = [
  'todo.json',
  'todo-log.jsonl',
  'sessions.json',
  'todo-archive.json',
  'config.json',
  '.sequence',
  'metrics/COMPLIANCE.jsonl',
  'metrics/SESSIONS.jsonl',
  'metrics/TOKEN_USAGE.jsonl',
  'metrics/BENCHMARK.jsonl',
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
 * Run a git command, suppressing errors.
 * @task T4552
 */
async function gitCommand(args: string[], cwd?: string): Promise<{ stdout: string; success: boolean }> {
  try {
    const result = await execFileAsync('git', args, {
      cwd: cwd ?? process.cwd(),
      timeout: 10_000,
    });
    return { stdout: result.stdout.trim(), success: true };
  } catch {
    return { stdout: '', success: false };
  }
}

/**
 * Check if we're inside a git work tree.
 * @task T4552
 */
async function isGitRepo(cwd?: string): Promise<boolean> {
  const result = await gitCommand(['rev-parse', '--is-inside-work-tree'], cwd);
  return result.success && result.stdout === 'true';
}

/**
 * Check if a merge is in progress.
 * @task T4552
 */
async function isMergeInProgress(cwd?: string): Promise<boolean> {
  const result = await gitCommand(['rev-parse', '--git-dir'], cwd);
  if (!result.success) return false;
  return existsSync(join(result.stdout, 'MERGE_HEAD'));
}

/**
 * Check if HEAD is detached.
 * @task T4552
 */
async function isDetachedHead(cwd?: string): Promise<boolean> {
  const result = await gitCommand(['symbolic-ref', 'HEAD'], cwd);
  return !result.success;
}

/**
 * Check if a rebase is in progress.
 * @task T4552
 */
async function isRebaseInProgress(cwd?: string): Promise<boolean> {
  const result = await gitCommand(['rev-parse', '--git-dir'], cwd);
  if (!result.success) return false;
  return existsSync(join(result.stdout, 'rebase-merge')) ||
    existsSync(join(result.stdout, 'rebase-apply'));
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
 * Get list of state files with pending changes.
 * @task T4552
 */
async function getChangedStateFiles(cleoDir: string, cwd?: string): Promise<ChangedFile[]> {
  const changed: ChangedFile[] = [];

  for (const stateFile of STATE_FILES) {
    const fullPath = join(cleoDir, stateFile);
    if (!existsSync(fullPath)) continue;

    // Check for staged or unstaged changes
    const diffResult = await gitCommand(['diff', '--quiet', '--', fullPath], cwd);
    const cachedResult = await gitCommand(['diff', '--cached', '--quiet', '--', fullPath], cwd);
    const untrackedResult = await gitCommand(
      ['ls-files', '--others', '--exclude-standard', '--', fullPath],
      cwd,
    );

    if (!diffResult.success || !cachedResult.success) {
      changed.push({ path: fullPath, status: 'modified' });
    } else if (untrackedResult.stdout.length > 0) {
      changed.push({ path: fullPath, status: 'untracked' });
    }
  }

  return changed;
}

/**
 * Check whether a checkpoint should be performed.
 * Evaluates: enabled, git repo, debounce elapsed, files changed.
 * @task T4552
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
  if (!(await isGitRepo(cwd))) return false;
  if (await isMergeInProgress(cwd)) return false;
  if (await isDetachedHead(cwd)) return false;
  if (await isRebaseInProgress(cwd)) return false;

  const cleoDir = getCleoDir(cwd);
  if (!existsSync(cleoDir)) return false;

  // Check debounce (unless forced)
  if (!force) {
    const lastCheckpoint = await getLastCheckpointTime(cleoDir);
    const now = Math.floor(Date.now() / 1000);
    const elapsed = now - lastCheckpoint;
    const debounceSeconds = config.debounceMinutes * 60;

    if (elapsed < debounceSeconds) return false;
  }

  // Check if any state files have changes
  const changed = await getChangedStateFiles(cleoDir, cwd);
  return changed.length > 0;
}

/**
 * Stage .cleo/ state files and commit if conditions met.
 * Never fatal - all git errors are suppressed.
 * @task T4552
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
  const changed = await getChangedStateFiles(cleoDir, cwd);

  if (changed.length === 0) return;

  // Stage changed files
  let stagedCount = 0;
  for (const file of changed) {
    const result = await gitCommand(['add', file.path], cwd);
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

  // Commit
  const commitResult = await gitCommand(commitArgs, cwd);

  if (!commitResult.success) {
    // If commit failed, unstage our changes
    for (const file of changed) {
      await gitCommand(['reset', 'HEAD', '--', file.path], cwd);
    }
    return;
  }

  // Record checkpoint time
  await recordCheckpointTime(cleoDir);
}

/**
 * Show checkpoint configuration and status.
 * @task T4552
 */
export async function gitCheckpointStatus(cwd?: string): Promise<CheckpointStatus> {
  const config = await loadCheckpointConfig(cwd);
  const cleoDir = getCleoDir(cwd);
  const lastCheckpoint = await getLastCheckpointTime(cleoDir);

  let lastCheckpointIso = 'never';
  if (lastCheckpoint !== 0) {
    lastCheckpointIso = new Date(lastCheckpoint * 1000).toISOString();
  }

  const isRepo = await isGitRepo(cwd);

  let pendingChanges = 0;
  if (isRepo) {
    const changed = await getChangedStateFiles(cleoDir, cwd);
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
 */
export async function gitCheckpointDryRun(cwd?: string): Promise<ChangedFile[]> {
  const cleoDir = getCleoDir(cwd);
  const isRepo = await isGitRepo(cwd);

  if (!isRepo) return [];

  return getChangedStateFiles(cleoDir, cwd);
}
