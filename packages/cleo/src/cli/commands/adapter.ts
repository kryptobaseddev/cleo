/**
 * CLI adapter command - provider adapter management: list, show, detect, health, activate, dispose.
 *
 * Covers all tools.adapter.* operations:
 *   adapter.list     (query)  — list all discovered provider adapters
 *   adapter.show     (query)  — show details for a specific adapter
 *   adapter.detect   (query)  — detect active providers in current environment
 *   adapter.health   (query)  — health status for adapters
 *   adapter.activate (mutate) — load and activate a provider adapter
 *   adapter.dispose  (mutate) — dispose one or all adapters
 *
 * @task T479
 * @epic T443
 */

import { dispatchFromCli } from '../../dispatch/adapters/cli.js';
import type { ShimCommand as Command } from '../commander-shim.js';

/**
 * Register the adapter command with all subcommands.
 * @task T479
 */
export function registerAdapterCommand(program: Command): void {
  const adapterCmd = program
    .command('adapter')
    .description('Provider adapter management: list, show, detect, health, activate, dispose');

  // Subcommand: list
  adapterCmd
    .command('list')
    .description('List all discovered provider adapters')
    .action(async () => {
      await dispatchFromCli(
        'query',
        'tools',
        'adapter.list',
        {},
        { command: 'adapter', operation: 'tools.adapter.list' },
      );
    });

  // Subcommand: show
  adapterCmd
    .command('show <adapter-id>')
    .description('Show details for a specific adapter')
    .action(async (adapterId: string) => {
      await dispatchFromCli(
        'query',
        'tools',
        'adapter.show',
        { id: adapterId },
        { command: 'adapter', operation: 'tools.adapter.show' },
      );
    });

  // Subcommand: detect
  adapterCmd
    .command('detect')
    .description('Detect active providers in the current environment')
    .action(async () => {
      await dispatchFromCli(
        'query',
        'tools',
        'adapter.detect',
        {},
        { command: 'adapter', operation: 'tools.adapter.detect' },
      );
    });

  // Subcommand: health
  adapterCmd
    .command('health')
    .description('Show health status for adapters')
    .option('--id <adapter-id>', 'Specific adapter ID (omit for all adapters)')
    .action(async (opts: Record<string, unknown>) => {
      await dispatchFromCli(
        'query',
        'tools',
        'adapter.health',
        { id: opts['id'] },
        { command: 'adapter', operation: 'tools.adapter.health' },
      );
    });

  // Subcommand: activate
  adapterCmd
    .command('activate <adapter-id>')
    .description('Load and activate a provider adapter')
    .action(async (adapterId: string) => {
      await dispatchFromCli(
        'mutate',
        'tools',
        'adapter.activate',
        { id: adapterId },
        { command: 'adapter', operation: 'tools.adapter.activate' },
      );
    });

  // Subcommand: dispose
  adapterCmd
    .command('dispose')
    .description('Dispose one or all adapters')
    .option('--id <adapter-id>', 'Specific adapter ID to dispose (omit to dispose all)')
    .action(async (opts: Record<string, unknown>) => {
      await dispatchFromCli(
        'mutate',
        'tools',
        'adapter.dispose',
        { id: opts['id'] },
        { command: 'adapter', operation: 'tools.adapter.dispose' },
      );
    });

  // Default action (no subcommand) - list
  adapterCmd.action(async () => {
    await dispatchFromCli(
      'query',
      'tools',
      'adapter.list',
      {},
      { command: 'adapter', operation: 'tools.adapter.list' },
    );
  });
}
