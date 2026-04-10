/**
 * CLI sync command group — external task synchronisation management.
 *
 * Surfaces the tasks.sync sub-domain for inspecting and removing external
 * task links. The tasks.sync.reconcile operation is intentionally excluded
 * from the CLI because it requires a structured ExternalTask[] payload that
 * must be supplied programmatically by an agent or integration layer, not
 * typed as shell arguments.
 *
 * Commands:
 *   cleo sync links                        — list all external task links
 *   cleo sync links --provider <id>        — filter by provider
 *   cleo sync links --task <taskId>        — filter by CLEO task ID
 *   cleo sync links remove <providerId>    — remove all links for a provider
 *
 * @task T473
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
}
