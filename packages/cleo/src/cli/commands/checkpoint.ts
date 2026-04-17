/**
 * CLI checkpoint command — Git state checkpoint for CLEO data files.
 *
 * Delegates to src/store/git-checkpoint.ts for isolated .cleo/.git
 * operations. This command has no dispatch route; it is CLI-only.
 *
 * @task T4551
 * @epic T4545
 * @task T4872
 */

import { ExitCode } from '@cleocode/contracts';
import {
  CleoError,
  formatError,
  getCleoDir,
  gitCheckpoint,
  gitCheckpointStatus,
  isCleoGitInitialized,
} from '@cleocode/core/internal';
import { defineCommand } from 'citty';
import { cliOutput } from '../renderers/index.js';

/**
 * Check if inside a git repository.
 *
 * Thin wrapper around isCleoGitInitialized() for --status output.
 * @task T4551
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
 * cleo checkpoint — Git checkpoint for CLEO state files.
 *
 * Commits .cleo data files to an isolated .cleo/.git repository.
 * Supports --status (show last checkpoint info) and --dry-run (preview).
 */
export const checkpointCommand = defineCommand({
  meta: {
    name: 'checkpoint',
    description: 'Git checkpoint for CLEO state files (commits to isolated .cleo/.git repo)',
  },
  args: {
    status: {
      type: 'boolean',
      description: 'Show configuration and last checkpoint time',
    },
    'dry-run': {
      type: 'boolean',
      description: 'Show what files would be committed',
    },
  },
  async run({ args }) {
    try {
      if (!isGitRepo()) {
        throw new CleoError(ExitCode.GENERAL_ERROR, '.cleo/.git not initialized. Run: cleo init');
      }

      if (args.status) {
        const status = await gitCheckpointStatus();
        cliOutput(
          {
            config: status.config,
            lastCheckpoint: status.status.lastCheckpoint,
            pendingFiles: status.status.pendingChanges,
            isGitRepo: status.status.isGitRepo,
          },
          { command: 'checkpoint' },
        );
        return;
      }

      if (args['dry-run']) {
        const status = await gitCheckpointStatus();
        const count = status.status.pendingChanges;
        cliOutput(
          {
            dryRun: true,
            fileCount: count,
          },
          {
            command: 'checkpoint',
            message:
              count === 0 ? 'No CLEO files to checkpoint' : `Would checkpoint ${count} file(s)`,
          },
        );
        return;
      }

      // Get pending count before committing so we can report it
      const before = await gitCheckpointStatus();
      if (!before.config.enabled) {
        cliOutput(
          { enabled: false },
          {
            command: 'checkpoint',
            message:
              'Git checkpoint is disabled. Enable with: cleo config set gitCheckpoint.enabled true',
          },
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

      cliOutput(
        {
          checkpointed: before.status.pendingChanges,
        },
        { command: 'checkpoint', message: 'Checkpoint complete' },
      );
    } catch (err) {
      if (err instanceof CleoError) {
        console.error(formatError(err));
        process.exit(err.code);
      }
      throw err;
    }
  },
});
