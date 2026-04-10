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

import { dispatchFromCli } from '../../dispatch/adapters/cli.js';
import type { ShimCommand as Command } from '../commander-shim.js';

/**
 * Register the sync command group and its subcommands.
 *
 * @param program - Root CLI program instance.
 */
export function registerSyncCommand(program: Command): void {
  const sync = program.command('sync').description('External task synchronisation management');

  // -- sync links --
  const links = sync.command('links').description('List external task links');

  links
    .command('list')
    .description('List external task links (filter by provider or task)')
    .option('--provider <providerId>', 'Filter links by provider (e.g. linear, jira, github)')
    .option('--task <taskId>', 'Filter links by CLEO task ID')
    .action(async (opts: Record<string, unknown>) => {
      await dispatchFromCli(
        'query',
        'tasks',
        'sync.links',
        {
          providerId: opts['provider'] as string | undefined,
          taskId: opts['task'] as string | undefined,
        },
        { command: 'sync', operation: 'tasks.sync.links' },
      );
    });

  links
    .command('remove <providerId>')
    .description('Remove all external task links for a provider')
    .action(async (providerId: string) => {
      await dispatchFromCli(
        'mutate',
        'tasks',
        'sync.links.remove',
        { providerId },
        { command: 'sync', operation: 'tasks.sync.links.remove' },
      );
    });

  // Default action for `cleo sync links` (no subcommand): list all links
  links.action(async () => {
    await dispatchFromCli(
      'query',
      'tasks',
      'sync.links',
      {},
      { command: 'sync', operation: 'tasks.sync.links' },
    );
  });

  // -- sync reconcile --
  sync
    .command('reconcile <file>')
    .description('Reconcile external tasks from a JSON file against CLEO tasks')
    .requiredOption('--provider <providerId>', 'Provider ID (e.g. linear, jira, github)')
    .option(
      '--conflict-policy <policy>',
      'How to resolve conflicts: keep-cleo, keep-external, or newest (default: keep-cleo)',
      'keep-cleo',
    )
    .action(async (file: string, opts: Record<string, unknown>) => {
      const { readFileSync } = await import('node:fs');
      let externalTasks: unknown;
      try {
        externalTasks = JSON.parse(readFileSync(file, 'utf8'));
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
          providerId: opts['provider'] as string,
          externalTasks,
          conflictPolicy: opts['conflictPolicy'] as string | undefined,
        },
        { command: 'sync', operation: 'tasks.sync.reconcile' },
      );
    });
}
