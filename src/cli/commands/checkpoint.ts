/**
 * CLI checkpoint command - Git state checkpoint for CLEO data files.
 * Ported from scripts/checkpoint.sh
 * @task T4551
 * @epic T4545
 */

import { Command } from 'commander';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { formatSuccess, formatError } from '../../core/output.js';
import { CleoError } from '../../core/errors.js';
import { ExitCode } from '../../types/exit-codes.js';
import { getCleoDir, getConfigPath } from '../../core/paths.js';
import { readJson } from '../../store/json.js';

/**
 * Tracked CLEO state files for checkpointing.
 * @task T4551
 */
const CHECKPOINT_FILES = [
  'todo.json',
  'todo-log.jsonl',
  'todo-archive.json',
  'config.json',
  'sessions.json',
];

/**
 * Default checkpoint configuration.
 * @task T4551
 */
interface CheckpointConfig {
  enabled: boolean;
  debounceMinutes: number;
  messagePrefix: string;
  noVerify: boolean;
}

const DEFAULT_CONFIG: CheckpointConfig = {
  enabled: true,
  debounceMinutes: 5,
  messagePrefix: 'chore(cleo):',
  noVerify: true,
};

/**
 * Load checkpoint configuration from config.json.
 * @task T4551
 */
async function loadCheckpointConfig(): Promise<CheckpointConfig> {
  try {
    const configPath = getConfigPath();
    const config = await readJson<Record<string, unknown>>(configPath);
    if (!config) return DEFAULT_CONFIG;

    const gc = config['gitCheckpoint'] as Record<string, unknown> | undefined;
    if (!gc) return DEFAULT_CONFIG;

    return {
      enabled: gc['enabled'] !== false,
      debounceMinutes: typeof gc['debounceMinutes'] === 'number' ? gc['debounceMinutes'] : DEFAULT_CONFIG.debounceMinutes,
      messagePrefix: typeof gc['messagePrefix'] === 'string' ? gc['messagePrefix'] : DEFAULT_CONFIG.messagePrefix,
      noVerify: gc['noVerify'] !== false,
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

/**
 * Check if inside a git repository.
 * @task T4551
 */
function isGitRepo(): boolean {
  try {
    execFileSync('git', ['rev-parse', '--git-dir'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get changed CLEO files from git status.
 * @task T4551
 */
function getChangedCleoFiles(): string[] {
  const cleoDir = getCleoDir();
  const changed: string[] = [];

  for (const file of CHECKPOINT_FILES) {
    const filePath = join(cleoDir, file);
    try {
      const status = execFileSync('git', ['status', '--porcelain', filePath], { encoding: 'utf-8' }).trim();
      if (status.length > 0) {
        changed.push(filePath);
      }
    } catch {
      // File doesn't exist or git error - skip
    }
  }

  return changed;
}

/**
 * Get last checkpoint timestamp from git log.
 * @task T4551
 */
function getLastCheckpointTime(prefix: string): string | null {
  try {
    const result = execFileSync(
      'git',
      ['log', '--oneline', '--format=%aI', `--grep=${prefix}`, '-1'],
      { encoding: 'utf-8' },
    ).trim();
    return result || null;
  } catch {
    return null;
  }
}

/**
 * Perform a git checkpoint commit.
 * @task T4551
 */
function performCheckpoint(files: string[], config: CheckpointConfig): void {
  if (files.length === 0) return;

  for (const file of files) {
    execFileSync('git', ['add', file], { stdio: 'ignore' });
  }

  const commitArgs = ['commit', '-m', `${config.messagePrefix} auto checkpoint`];
  if (config.noVerify) {
    commitArgs.push('--no-verify');
  }

  execFileSync('git', commitArgs, { stdio: 'ignore' });
}

/**
 * Register the checkpoint command.
 * @task T4551
 */
export function registerCheckpointCommand(program: Command): void {
  program
    .command('checkpoint')
    .description('Git checkpoint for CLEO state files')
    .option('--status', 'Show configuration and last checkpoint time')
    .option('--dry-run', 'Show what files would be committed')
    .action(async (opts: Record<string, unknown>) => {
      try {
        if (!isGitRepo()) {
          throw new CleoError(ExitCode.GENERAL_ERROR, 'Not a git repository');
        }

        const config = await loadCheckpointConfig();

        if (opts['status']) {
          const lastCheckpoint = getLastCheckpointTime(config.messagePrefix);
          const changedFiles = getChangedCleoFiles();

          console.log(formatSuccess({
            config: {
              enabled: config.enabled,
              debounceMinutes: config.debounceMinutes,
              messagePrefix: config.messagePrefix,
              noVerify: config.noVerify,
            },
            lastCheckpoint,
            pendingFiles: changedFiles.length,
            changedFiles,
          }));
          return;
        }

        if (opts['dryRun']) {
          const changedFiles = getChangedCleoFiles();

          console.log(formatSuccess({
            dryRun: true,
            wouldCommit: changedFiles,
            fileCount: changedFiles.length,
          }, changedFiles.length === 0 ? 'No CLEO files to checkpoint' : `Would checkpoint ${changedFiles.length} file(s)`));
          return;
        }

        // Force checkpoint mode
        if (!config.enabled) {
          console.log(formatSuccess(
            { enabled: false },
            'Git checkpoint is disabled. Enable with: cleo config set gitCheckpoint.enabled true',
          ));
          return;
        }

        const changedFiles = getChangedCleoFiles();
        if (changedFiles.length === 0) {
          console.log(formatSuccess(
            { noChange: true },
            'No CLEO files to checkpoint',
          ));
          return;
        }

        performCheckpoint(changedFiles, config);

        console.log(formatSuccess({
          checkpointed: changedFiles.length,
          files: changedFiles,
        }, 'Checkpoint complete'));
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });
}
