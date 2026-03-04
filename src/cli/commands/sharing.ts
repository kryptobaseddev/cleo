/**
 * CLI sharing command - Config-driven .cleo/ commit allowlist management.
 *
 * Provides backward compatibility aliases to nexus share operations.
 * All operations delegate to nexus domain for canonical implementation.
 *
 * @task T4883
 * @task T5281 - Updated to use dispatch layer (nexus share.* operations)
 */

import { Command } from 'commander';
import { formatError } from '../../core/output.js';
import { cliOutput } from '../renderers/index.js';
import { CleoError } from '../../core/errors.js';
import { dispatchFromCli, dispatchRaw, handleRawError } from '../../dispatch/adapters/cli.js';

/**
 * Register the sharing command with backward compatibility aliases to nexus share operations.
 * @task T4883
 * @task T5281
 */
export function registerSharingCommand(program: Command): void {
  const sharing = program
    .command('sharing')
    .description('Manage multi-contributor .cleo/ file sharing via commit allowlist (alias to nexus share)');

  // ── sharing status ─────────────────────────────────────────────────────
  // Alias: cleo sharing status -> cleo nexus share status

  sharing
    .command('status')
    .description('Show which .cleo/ files are tracked vs ignored based on sharing config')
    .action(async () => {
      try {
        // Delegate to nexus share.status operation
        const response = await dispatchRaw('query', 'nexus', 'share.status');
        
        if (!response.success) {
          handleRawError(response, { command: 'sharing status', operation: 'sharing.status' });
          return;
        }

        const status = response.data as {
          mode: string;
          tracked: string[];
          ignored: string[];
          allowlist: string[];
        };

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

  // ── sharing sync ───────────────────────────────────────────────────────
  // Alias: cleo sharing sync -> cleo nexus share sync.gitignore

  sharing
    .command('sync')
    .description('Update project .gitignore to match sharing config allowlist')
    .option('--dry-run', 'Preview changes without modifying .gitignore')
    .action(async (opts: Record<string, unknown>) => {
      try {
        if (opts['dryRun']) {
          // For dry-run, get status from nexus share.status
          const response = await dispatchRaw('query', 'nexus', 'share.status');
          
          if (!response.success) {
            handleRawError(response, { command: 'sharing sync', operation: 'sharing.sync' });
            return;
          }

          const status = response.data as {
            mode: string;
            tracked: string[];
            ignored: string[];
            allowlist: string[];
          };

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

        // Delegate to nexus share.sync.gitignore operation
        await dispatchFromCli('mutate', 'nexus', 'share.sync.gitignore', {}, {
          command: 'sharing',
          operation: 'sharing.sync',
        });
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });

  // ── sharing remotes ────────────────────────────────────────────────────
  // Alias: cleo sharing remotes -> cleo nexus share remotes

  sharing
    .command('remotes')
    .description('List configured sharing remotes')
    .action(async () => {
      try {
        await dispatchFromCli('query', 'nexus', 'share.remotes', {}, {
          command: 'sharing',
          operation: 'sharing.remotes',
        });
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });

  // ── sharing push ───────────────────────────────────────────────────────
  // Alias: cleo sharing push -> cleo nexus share push

  sharing
    .command('push')
    .description('Push .cleo/ state to remote')
    .option('--remote <name>', 'Remote name', 'origin')
    .option('--force', 'Force push')
    .action(async (opts: Record<string, unknown>) => {
      try {
        await dispatchFromCli('mutate', 'nexus', 'share.push', {
          remote: opts['remote'],
          force: opts['force'],
        }, {
          command: 'sharing',
          operation: 'sharing.push',
        });
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });

  // ── sharing pull ───────────────────────────────────────────────────────
  // Alias: cleo sharing pull -> cleo nexus share pull

  sharing
    .command('pull')
    .description('Pull .cleo/ state from remote')
    .option('--remote <name>', 'Remote name', 'origin')
    .action(async (opts: Record<string, unknown>) => {
      try {
        await dispatchFromCli('mutate', 'nexus', 'share.pull', {
          remote: opts['remote'],
        }, {
          command: 'sharing',
          operation: 'sharing.pull',
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
