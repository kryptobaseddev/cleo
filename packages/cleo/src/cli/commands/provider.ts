/**
 * CLI provider command - CAAMP provider registry: list, detect, supports, hooks, inject.
 *
 * Covers all tools.provider.* operations:
 *   provider.list          (query)  — list registered providers
 *   provider.detect        (query)  — detect active provider in current environment
 *   provider.inject.status (query)  — show inject status for project/global scope
 *   provider.supports      (query)  — check if a provider supports a capability
 *   provider.hooks         (query)  — list providers by hook event support
 *   provider.inject        (mutate) — inject provider references into AGENTS.md
 *
 * @task T479
 * @epic T443
 */

import { dispatchFromCli } from '../../dispatch/adapters/cli.js';
import type { ShimCommand as Command } from '../commander-shim.js';

/**
 * Register the provider command with all subcommands.
 * @task T479
 */
export function registerProviderCommand(program: Command): void {
  const providerCmd = program
    .command('provider')
    .description('CAAMP provider registry: list, detect, supports, hooks, inject');

  // Subcommand: list
  providerCmd
    .command('list')
    .description('List all registered CAAMP providers')
    .option('--limit <n>', 'Maximum providers to return')
    .option('--offset <n>', 'Offset for pagination')
    .action(async (opts: Record<string, unknown>) => {
      await dispatchFromCli(
        'query',
        'tools',
        'provider.list',
        {
          limit: opts['limit'] ? Number(opts['limit']) : undefined,
          offset: opts['offset'] ? Number(opts['offset']) : undefined,
        },
        { command: 'provider', operation: 'tools.provider.list' },
      );
    });

  // Subcommand: detect
  providerCmd
    .command('detect')
    .description('Detect which provider is active in the current environment')
    .action(async () => {
      await dispatchFromCli(
        'query',
        'tools',
        'provider.detect',
        {},
        { command: 'provider', operation: 'tools.provider.detect' },
      );
    });

  // Subcommand: inject-status
  providerCmd
    .command('inject-status')
    .description('Show provider injection status for project or global scope')
    .option('--scope <scope>', 'Scope: project or global (default: project)')
    .option('--content <content>', 'Content string to check against')
    .action(async (opts: Record<string, unknown>) => {
      await dispatchFromCli(
        'query',
        'tools',
        'provider.inject.status',
        {
          scope: opts['scope'] ?? 'project',
          content: opts['content'],
        },
        { command: 'provider', operation: 'tools.provider.inject.status' },
      );
    });

  // Subcommand: supports
  providerCmd
    .command('supports <provider-id> <capability>')
    .description('Check if a provider supports a capability (e.g., spawn.supportsSubagents)')
    .action(async (providerId: string, capability: string) => {
      await dispatchFromCli(
        'query',
        'tools',
        'provider.supports',
        { providerId, capability },
        { command: 'provider', operation: 'tools.provider.supports' },
      );
    });

  // Subcommand: hooks
  providerCmd
    .command('hooks <event>')
    .description('List providers that support a specific hook event (e.g., onSessionStart)')
    .action(async (event: string) => {
      await dispatchFromCli(
        'query',
        'tools',
        'provider.hooks',
        { event },
        { command: 'provider', operation: 'tools.provider.hooks' },
      );
    });

  // Subcommand: inject
  providerCmd
    .command('inject')
    .description('Inject provider references into AGENTS.md (project or global scope)')
    .option('--scope <scope>', 'Scope: project or global (default: project)')
    .option('--references <refs...>', 'Provider reference IDs to inject')
    .option('--content <content>', 'Content string to inject directly')
    .action(async (opts: Record<string, unknown>) => {
      await dispatchFromCli(
        'mutate',
        'tools',
        'provider.inject',
        {
          scope: opts['scope'] ?? 'project',
          references: opts['references'],
          content: opts['content'],
        },
        { command: 'provider', operation: 'tools.provider.inject' },
      );
    });

  // Default action (no subcommand) - list
  providerCmd.action(async () => {
    await dispatchFromCli(
      'query',
      'tools',
      'provider.list',
      {},
      { command: 'provider', operation: 'tools.provider.list' },
    );
  });
}
