/**
 * CLI checkpoint command - Git state checkpoint for CLEO data files.
 * Ported from scripts/checkpoint.sh
 * @task T4551
 * @epic T4545
 */
// TODO T4894: operation not yet in registry — git checkpoint has no dispatch route

import { Command } from 'commander';
import { formatError } from '../../core/output.js';
import { cliOutput } from '../renderers/index.js';
import { CleoError } from '../../core/errors.js';
import { ExitCode } from '../../types/exit-codes.js';
import { getCleoDir } from '../../core/paths.js';
import {
  gitCheckpoint,
  gitCheckpointStatus,
  isCleoGitInitialized,
} from '../../store/git-checkpoint.js';

/**
 * Check if inside a git repository.
 * @task T4551
 * Thin wrapper around isCleoGitInitialized() for --status output.
 */
function isGitRepo(): boolean {
  try {
    const cleoDir = getCleoDir();
    return isCleoGitInitialized(cleoDir);
  } catch {
    return false;
  }
}

/**
 * Register the checkpoint command.
 * Delegates to src/store/git-checkpoint.ts for isolated .cleo/.git operations.
 * @task T4551
 * @task T4872
 */
export function registerCheckpointCommand(program: Command): void {
  program
    .command('checkpoint')
    .description('Git checkpoint for CLEO state files (commits to isolated .cleo/.git repo)')
    .option('--status', 'Show configuration and last checkpoint time')
    .option('--dry-run', 'Show what files would be committed')
    .action(async (opts: Record<string, unknown>) => {
      try {
        if (!isGitRepo()) {
          throw new CleoError(ExitCode.GENERAL_ERROR, '.cleo/.git not initialized. Run: cleo init');
        }

        if (opts['status']) {
          const status = await gitCheckpointStatus();
          cliOutput({
            config: status.config,
            lastCheckpoint: status.status.lastCheckpoint,
            pendingFiles: status.status.pendingChanges,
            isGitRepo: status.status.isGitRepo,
          }, { command: 'checkpoint' });
          return;
        }

        if (opts['dryRun']) {
          const status = await gitCheckpointStatus();
          const count = status.status.pendingChanges;
          cliOutput({
            dryRun: true,
            fileCount: count,
          }, { command: 'checkpoint', message: count === 0 ? 'No CLEO files to checkpoint' : `Would checkpoint ${count} file(s)` });
          return;
        }

        // Get pending count before committing so we can report it
        const before = await gitCheckpointStatus();
        if (!before.config.enabled) {
          cliOutput(
            { enabled: false },
            { command: 'checkpoint', message: 'Git checkpoint is disabled. Enable with: cleo config set gitCheckpoint.enabled true' },
          );
          return;
        }

        if (before.status.pendingChanges === 0) {
          cliOutput(
            { noChange: true },
            { command: 'checkpoint', message: 'No CLEO files to checkpoint' },
          );
          return;
        }

        await gitCheckpoint('manual');

        cliOutput({
          checkpointed: before.status.pendingChanges,
        }, { command: 'checkpoint', message: 'Checkpoint complete' });
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });
}
