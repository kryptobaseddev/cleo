/**
 * CLI sync command group — external task synchronisation management.
 *
 * Surfaces the tasks.sync sub-domain for inspecting and removing external
 * task links, and for reconciling an external task list from a JSON file.
 *
 * Commands:
 *   cleo sync links                        — list all external task links
 *   cleo sync links --provider <id>        — filter by provider
 *   cleo sync links --task <taskId>        — filter by CLEO task ID
 *   cleo sync links remove <providerId>    — remove all links for a provider
 *   cleo sync reconcile <file> --provider <id> [--conflict-policy <policy>]
 *                                          — reconcile external tasks from a JSON file
 *   cleo sync enable push [--scope]        — genesis cut + genesis checkpoint (T12343)
 *
 * @task T473
 * @task T483
 * @epic T443
 */

import { ExitCode } from '@cleocode/contracts/exit-codes.js';
import { defineCommand, showUsage } from 'citty';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';
import { cliError } from '../renderers/index.js';

/** cleo sync links remove — remove all external task links for a provider */
const linksRemoveCommand = defineCommand({
  meta: { name: 'remove', description: 'Remove all external task links for a provider' },
  args: {
    providerId: {
      type: 'positional',
      description: 'Provider ID whose links should be removed',
      required: true,
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'mutate',
      'tasks',
      'sync.links.remove',
      { providerId: args.providerId },
      { command: 'sync', operation: 'tasks.sync.links.remove' },
    );
  },
});

/** cleo sync links — list external task links, with optional filters */
const linksCommand = defineCommand({
  meta: { name: 'links', description: 'List external task links' },
  args: {
    provider: {
      type: 'string',
      description: 'Filter links by provider (e.g. linear, jira, github)',
    },
    task: {
      type: 'string',
      description: 'Filter links by CLEO task ID',
    },
  },
  subCommands: {
    remove: linksRemoveCommand,
  },
  async run({ args }) {
    const providerId = args.provider as string | undefined;
    const taskId = args.task as string | undefined;
    if (!providerId && !taskId) {
      cliError(
        'at least one of --provider or --task is required for sync links list',
        ExitCode.INVALID_INPUT,
        { name: 'E_VALIDATION' },
      );
      process.exit(ExitCode.INVALID_INPUT);
    }
    await dispatchFromCli(
      'query',
      'tasks',
      'sync.links',
      { providerId, taskId },
      { command: 'sync', operation: 'tasks.sync.links' },
    );
  },
});

/** cleo sync reconcile — reconcile external tasks from a JSON file against CLEO tasks */
const reconcileCommand = defineCommand({
  meta: {
    name: 'reconcile',
    description: 'Reconcile external tasks from a JSON file against CLEO tasks',
  },
  args: {
    file: {
      type: 'positional',
      description: 'Path to JSON file containing external tasks array',
      required: true,
    },
    provider: {
      type: 'string',
      description: 'Provider ID (e.g. linear, jira, github)',
      required: true,
    },
    'conflict-policy': {
      type: 'string',
      description:
        'How to resolve conflicts: keep-cleo, keep-external, or newest (default: keep-cleo)',
      default: 'keep-cleo',
    },
  },
  async run({ args }) {
    const { readFileSync } = await import('node:fs');
    let externalTasks: unknown;
    try {
      externalTasks = JSON.parse(readFileSync(args.file, 'utf8'));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      cliError(`Failed to read or parse external tasks file: ${message}`, 2, {
        name: 'E_VALIDATION',
      });
      process.exit(2);
    }
    if (!Array.isArray(externalTasks)) {
      cliError('External tasks file must contain a JSON array', 2, { name: 'E_VALIDATION' });
      process.exit(2);
    }
    await dispatchFromCli(
      'mutate',
      'tasks',
      'sync.reconcile',
      {
        providerId: args.provider,
        externalTasks,
        conflictPolicy: args['conflict-policy'] as string | undefined,
      },
      { command: 'sync', operation: 'tasks.sync.reconcile' },
    );
  },
});

/** cleo sync enable push — start the change journal's push for this store (T12343 S4-1b) */
const enableCommand = defineCommand({
  meta: {
    name: 'enable',
    description:
      "Turn on a change-journal flag. 'push': record this store's genesis cut and push its genesis checkpoint to Cleo Nexus; from then on its changes travel as journal segments, not vault snapshots. The store is snapshotted under its write lock: while the bundle exports (seconds; longer on a large store), other cleo processes on this store pause their writes, wait, and refuse with E_STORE_GENESIS if it outlasts their wait (CLEO_RESTORE_WAIT_MS, default 15 s); run them again afterwards. A push that fails after the cut resumes on the next run. Refused while sync.push is unreleased.",
  },
  args: {
    flag: { type: 'positional', description: "The flag to enable: 'push'", required: true },
    scope: { type: 'string', description: "Which store: 'project' (default) or 'global'" },
    'api-url': { type: 'string', description: 'Cleo Nexus API URL (default: the configured one)' },
    json: { type: 'boolean', description: 'Output as JSON envelope' },
  },
  async run({ args }) {
    if (args.flag !== 'push') {
      cliError(
        `unknown sync flag '${String(args.flag)}': only 'push' can be enabled here`,
        ExitCode.INVALID_INPUT,
        { name: 'E_VALIDATION' },
      );
      process.exit(ExitCode.INVALID_INPUT);
    }
    const { runSyncEnablePush } = await import('../lib/nexus-vault-cli.js');
    await runSyncEnablePush(args as Record<string, unknown>);
  },
});

/**
 * Root sync command group — registers all sync subcommands.
 *
 * Dispatches to `tasks.sync.*` registry operations.
 */
export const syncCommand = defineCommand({
  meta: { name: 'sync', description: 'External task synchronisation management' },
  subCommands: {
    links: linksCommand,
    reconcile: reconcileCommand,
    enable: enableCommand,
  },
  async run({ cmd, rawArgs }) {
    const firstArg = rawArgs?.find((a) => !a.startsWith('-'));
    if (firstArg && cmd.subCommands && firstArg in cmd.subCommands) return;
    await showUsage(cmd);
  },
});
