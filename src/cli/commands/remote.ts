/**
 * CLI remote command - .cleo/.git remote push/pull for shared state.
 *
 * @task T4884
 */

import { Command } from 'commander';
import { formatError } from '../../core/output.js';
import { cliOutput } from '../renderers/index.js';
import { CleoError } from '../../core/errors.js';
import { ExitCode } from '../../types/exit-codes.js';
import {
  addRemote,
  removeRemote,
  listRemotes,
  push,
  pull,
  getSyncStatus,
} from '../../core/remote/index.js';

/**
 * Register the remote command with add/remove/list/push/pull subcommands.
 * @task T4884
 */
export function registerRemoteCommand(program: Command): void {
  const remote = program
    .command('remote')
    .description('Manage .cleo/.git remotes for multi-contributor state sharing');

  remote
    .command('add <url>')
    .description('Add a git remote to .cleo/.git for shared state syncing')
    .option('-n, --name <name>', 'Remote name (default: origin)', 'origin')
    .action(async (url: string, opts: Record<string, unknown>) => {
      try {
        const name = opts['name'] as string;
        await addRemote(url, name);

        cliOutput({
          added: true,
          name,
          url,
        }, { command: 'remote', message: `Remote '${name}' added: ${url}` });
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        if (err instanceof Error) {
          console.error(formatError(new CleoError(ExitCode.GENERAL_ERROR, err.message)));
          process.exit(ExitCode.GENERAL_ERROR);
        }
        throw err;
      }
    });

  remote
    .command('remove <name>')
    .description('Remove a git remote from .cleo/.git')
    .action(async (name: string) => {
      try {
        await removeRemote(name);

        cliOutput({
          removed: true,
          name,
        }, { command: 'remote', message: `Remote '${name}' removed` });
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        if (err instanceof Error) {
          console.error(formatError(new CleoError(ExitCode.GENERAL_ERROR, err.message)));
          process.exit(ExitCode.GENERAL_ERROR);
        }
        throw err;
      }
    });

  remote
    .command('list')
    .description('List configured .cleo/.git remotes')
    .action(async () => {
      try {
        const remotes = await listRemotes();

        cliOutput({
          remotes,
          count: remotes.length,
        }, {
          command: 'remote',
          message: remotes.length === 0
            ? 'No remotes configured. Add one with: cleo remote add <url>'
            : `${remotes.length} remote(s) configured`,
        });
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        if (err instanceof Error) {
          console.error(formatError(new CleoError(ExitCode.GENERAL_ERROR, err.message)));
          process.exit(ExitCode.GENERAL_ERROR);
        }
        throw err;
      }
    });

  // Top-level push command
  program
    .command('push')
    .description('Push .cleo/ state to remote (operates on .cleo/.git)')
    .option('-r, --remote <name>', 'Remote name (default: origin)', 'origin')
    .option('-u, --set-upstream', 'Set upstream tracking branch')
    .option('--force', 'Force push (overwrite remote)')
    .action(async (opts: Record<string, unknown>) => {
      try {
        const remoteName = opts['remote'] as string;
        const result = await push(remoteName, {
          force: opts['force'] as boolean ?? false,
          setUpstream: opts['setUpstream'] as boolean ?? false,
        });

        if (!result.success) {
          console.error(formatError(new CleoError(ExitCode.GENERAL_ERROR, result.message)));
          process.exit(ExitCode.GENERAL_ERROR);
        }

        cliOutput({
          pushed: true,
          branch: result.branch,
          remote: result.remote,
        }, { command: 'push', message: result.message });
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        if (err instanceof Error) {
          console.error(formatError(new CleoError(ExitCode.GENERAL_ERROR, err.message)));
          process.exit(ExitCode.GENERAL_ERROR);
        }
        throw err;
      }
    });

  // Top-level pull command
  program
    .command('pull')
    .description('Pull .cleo/ state from remote (operates on .cleo/.git)')
    .option('-r, --remote <name>', 'Remote name (default: origin)', 'origin')
    .action(async (opts: Record<string, unknown>) => {
      try {
        const remoteName = opts['remote'] as string;
        const result = await pull(remoteName);

        if (!result.success) {
          const output: Record<string, unknown> = {
            pulled: false,
            branch: result.branch,
            remote: result.remote,
          };
          if (result.hasConflicts) {
            output['conflicts'] = result.conflictFiles;
          }
          cliOutput(output, { command: 'pull', message: result.message });
          process.exit(ExitCode.GENERAL_ERROR);
        }

        cliOutput({
          pulled: true,
          branch: result.branch,
          remote: result.remote,
        }, { command: 'pull', message: result.message });
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        if (err instanceof Error) {
          console.error(formatError(new CleoError(ExitCode.GENERAL_ERROR, err.message)));
          process.exit(ExitCode.GENERAL_ERROR);
        }
        throw err;
      }
    });

  // Remote status subcommand
  remote
    .command('status')
    .description('Show sync status between local .cleo/.git and remote')
    .option('-r, --remote <name>', 'Remote name (default: origin)', 'origin')
    .action(async (opts: Record<string, unknown>) => {
      try {
        const remoteName = opts['remote'] as string;
        const status = await getSyncStatus(remoteName);

        let message: string;
        if (status.ahead === 0 && status.behind === 0) {
          message = `Up to date with ${remoteName}/${status.branch}`;
        } else {
          const parts: string[] = [];
          if (status.ahead > 0) parts.push(`${status.ahead} ahead`);
          if (status.behind > 0) parts.push(`${status.behind} behind`);
          message = `${parts.join(', ')} ${remoteName}/${status.branch}`;
        }

        cliOutput({
          ...status,
        }, { command: 'remote', message });
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        if (err instanceof Error) {
          console.error(formatError(new CleoError(ExitCode.GENERAL_ERROR, err.message)));
          process.exit(ExitCode.GENERAL_ERROR);
        }
        throw err;
      }
    });
}
