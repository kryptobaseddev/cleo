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
 *
 * @task T473
 * @task T483
 * @epic T443
 */

import { ExitCode } from '@cleocode/contracts';
import { defineCommand, showUsage } from 'citty';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

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
      console.error('Error: at least one of --provider or --task is required for sync links list');
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
      console.error(`Failed to read or parse external tasks file: ${message}`);
      process.exit(2);
    }
    if (!Array.isArray(externalTasks)) {
      console.error('External tasks file must contain a JSON array');
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
  },
  async run({ cmd, rawArgs }) {
    const firstArg = rawArgs?.find((a) => !a.startsWith('-'));
    if (firstArg && cmd.subCommands && firstArg in cmd.subCommands) return;
    await showUsage(cmd);
  },
});
