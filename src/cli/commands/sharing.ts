/**
 * CLI sharing command - Config-driven .cleo/ commit allowlist management.
 *
 * @task T4883
 */

import { Command } from 'commander';
import { formatError } from '../../core/output.js';
import { cliOutput } from '../renderers/index.js';
import { CleoError } from '../../core/errors.js';
import {
  getSharingStatus,
  syncGitignore,
} from '../../core/sharing/index.js';

/**
 * Register the sharing command with status and sync subcommands.
 * @task T4883
 */
export function registerSharingCommand(program: Command): void {
  const sharing = program
    .command('sharing')
    .description('Manage multi-contributor .cleo/ file sharing via commit allowlist');

  sharing
    .command('status')
    .description('Show which .cleo/ files are tracked vs ignored based on sharing config')
    .action(async () => {
      try {
        const status = await getSharingStatus();

        cliOutput({
          mode: status.mode,
          trackedCount: status.tracked.length,
          ignoredCount: status.ignored.length,
          tracked: status.tracked,
          allowlist: status.allowlist,
        }, {
          command: 'sharing',
          message: `Mode: ${status.mode} | Tracked: ${status.tracked.length} | Ignored: ${status.ignored.length}`,
        });
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });

  sharing
    .command('sync')
    .description('Update project .gitignore to match sharing config allowlist')
    .option('--dry-run', 'Preview changes without modifying .gitignore')
    .action(async (opts: Record<string, unknown>) => {
      try {
        if (opts['dryRun']) {
          const status = await getSharingStatus();
          cliOutput({
            dryRun: true,
            mode: status.mode,
            wouldTrack: status.tracked.length,
            wouldIgnore: status.ignored.length,
            allowlist: status.allowlist,
          }, {
            command: 'sharing',
            message: `Would configure .gitignore for mode '${status.mode}' with ${status.tracked.length} tracked path(s)`,
          });
          return;
        }

        const result = await syncGitignore();

        cliOutput({
          synced: true,
          updated: result.updated,
          entriesCount: result.entriesCount,
        }, {
          command: 'sharing',
          message: result.updated
            ? `Updated .gitignore with ${result.entriesCount} sharing entries`
            : '.gitignore already up to date',
        });
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });
}
