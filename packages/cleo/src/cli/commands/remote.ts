/**
 * CLI command group for .cleo/.git remote push/pull shared state management.
 *
 * Subcommands under `cleo remote`:
 *   cleo remote add <url>    — add a git remote to .cleo/.git
 *   cleo remote remove <name> — remove a git remote from .cleo/.git
 *   cleo remote list         — list configured .cleo/.git remotes
 *   cleo remote status       — show sync status between local and remote
 *
 * Top-level commands also provided:
 *   cleo push  — push .cleo/ state to remote
 *   cleo pull  — pull .cleo/ state from remote
 *
 * @task T4884
 */

import { ExitCode } from '@cleocode/contracts';
import {
  addRemote,
  CleoError,
  formatError,
  getRemoteSyncStatus as getRemoteGitStatus,
  listRemotes,
  pull,
  push,
  removeRemote,
} from '@cleocode/core/internal';
import { defineCommand, showUsage } from 'citty';
import { cliError, cliOutput } from '../renderers/index.js';

/** cleo remote add <url> — add a git remote to .cleo/.git */
const addRemoteCommand = defineCommand({
  meta: { name: 'add', description: 'Add a git remote to .cleo/.git for shared state syncing' },
  args: {
    url: {
      type: 'positional',
      description: 'Remote URL to add',
      required: true,
    },
    name: {
      type: 'string',
      description: 'Remote name',
      alias: 'n',
      default: 'origin',
    },
  },
  async run({ args }) {
    try {
      const name = args.name ?? 'origin';
      await addRemote(args.url, name);
      cliOutput(
        { added: true, name, url: args.url },
        { command: 'remote', message: `Remote '${name}' added: ${args.url}` },
      );
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
  },
});

/** cleo remote remove <name> — remove a git remote from .cleo/.git */
const removeRemoteCommand = defineCommand({
  meta: { name: 'remove', description: 'Remove a git remote from .cleo/.git' },
  args: {
    name: {
      type: 'positional',
      description: 'Remote name to remove',
      required: true,
    },
  },
  async run({ args }) {
    try {
      await removeRemote(args.name);
      cliOutput(
        { removed: true, name: args.name },
        { command: 'remote', message: `Remote '${args.name}' removed` },
      );
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
  },
});

/** cleo remote list — list configured .cleo/.git remotes */
const listRemoteCommand = defineCommand({
  meta: { name: 'list', description: 'List configured .cleo/.git remotes' },
  async run() {
    try {
      const remotes = await listRemotes();
      cliOutput(
        { remotes, count: remotes.length },
        {
          command: 'remote',
          message:
            remotes.length === 0
              ? 'No remotes configured. Add one with: cleo remote add <url>'
              : `${remotes.length} remote(s) configured`,
        },
      );
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
  },
});

/** cleo remote status — show sync status between local .cleo/.git and remote */
const statusRemoteCommand = defineCommand({
  meta: {
    name: 'status',
    description: 'Show sync status between local .cleo/.git and remote',
  },
  args: {
    remote: {
      type: 'string',
      description: 'Remote name',
      alias: 'r',
      default: 'origin',
    },
  },
  async run({ args }) {
    try {
      const remoteName = args.remote ?? 'origin';
      const status = await getRemoteGitStatus(remoteName);

      let message: string;
      if (status.ahead === 0 && status.behind === 0) {
        message = `Up to date with ${remoteName}/${status.branch}`;
      } else {
        const parts: string[] = [];
        if (status.ahead > 0) parts.push(`${status.ahead} ahead`);
        if (status.behind > 0) parts.push(`${status.behind} behind`);
        message = `${parts.join(', ')} ${remoteName}/${status.branch}`;
      }

      cliOutput({ ...status }, { command: 'remote', message });
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
  },
});

/**
 * cleo remote — manage .cleo/.git remotes for multi-contributor state sharing.
 *
 * Dispatches add/remove/list/status subcommands against the .cleo/.git repository.
 */
export const remoteCommand = defineCommand({
  meta: {
    name: 'remote',
    description: 'Manage .cleo/.git remotes for multi-contributor state sharing',
  },
  subCommands: {
    add: addRemoteCommand,
    remove: removeRemoteCommand,
    list: listRemoteCommand,
    status: statusRemoteCommand,
  },
  async run({ cmd, rawArgs }) {
    const firstArg = rawArgs?.find((a) => !a.startsWith('-'));
    if (firstArg && cmd.subCommands && firstArg in cmd.subCommands) return;
    await showUsage(cmd);
  },
});

/** cleo push — push .cleo/ state to remote */
export const pushCommand = defineCommand({
  meta: { name: 'push', description: 'Push .cleo/ state to remote (operates on .cleo/.git)' },
  args: {
    remote: {
      type: 'string',
      description: 'Remote name',
      alias: 'r',
      default: 'origin',
    },
    'set-upstream': {
      type: 'boolean',
      description: 'Set upstream tracking branch',
      alias: 'u',
    },
    force: {
      type: 'boolean',
      description: 'Force push (overwrite remote)',
    },
  },
  async run({ args }) {
    try {
      const remoteName = args.remote ?? 'origin';
      const result = await push(remoteName, {
        force: args.force ?? false,
        setUpstream: args['set-upstream'] ?? false,
      });

      if (!result.success) {
        console.error(formatError(new CleoError(ExitCode.GENERAL_ERROR, result.message)));
        process.exit(ExitCode.GENERAL_ERROR);
      }

      cliOutput(
        { pushed: true, branch: result.branch, remote: result.remote },
        { command: 'push', message: result.message },
      );
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
  },
});

/** cleo pull — pull .cleo/ state from remote */
export const pullCommand = defineCommand({
  meta: { name: 'pull', description: 'Pull .cleo/ state from remote (operates on .cleo/.git)' },
  args: {
    remote: {
      type: 'string',
      description: 'Remote name',
      alias: 'r',
      default: 'origin',
    },
  },
  async run({ args }) {
    try {
      const remoteName = args.remote ?? 'origin';
      const result = await pull(remoteName);

      if (!result.success) {
        const details: Record<string, unknown> = {
          pulled: false,
          branch: result.branch,
          remote: result.remote,
        };
        if (result.hasConflicts) {
          details['conflicts'] = result.conflictFiles;
        }
        cliError(result.message, ExitCode.GENERAL_ERROR, { details });
        process.exit(ExitCode.GENERAL_ERROR);
      }

      cliOutput(
        { pulled: true, branch: result.branch, remote: result.remote },
        { command: 'pull', message: result.message },
      );
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
  },
});
