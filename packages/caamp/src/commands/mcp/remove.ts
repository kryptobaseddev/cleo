/**
 * mcp remove command - LAFS-compliant with JSON-first output
 */

import type { Command } from 'commander';
import pc from 'picocolors';
import {
  ErrorCategories,
  ErrorCodes,
  emitJsonError,
  outputSuccess,
  resolveFormat,
} from '../../core/lafs.js';
import { isHuman } from '../../core/logger.js';
import { removeMcpFromLock } from '../../core/mcp/lock.js';
import { removeMcpServer } from '../../core/mcp/reader.js';
import { getInstalledProviders } from '../../core/registry/detection.js';
import { getProvider } from '../../core/registry/providers.js';
import type { Provider } from '../../types.js';

/**
 * Registers the `mcp remove` subcommand for removing MCP servers from agent configurations.
 *
 * @remarks
 * Removes the named MCP server from targeted provider configs and cleans up the lock file entry.
 * Supports targeting specific agents or all detected providers.
 *
 * @param parent - The parent `mcp` Command to attach the remove subcommand to
 *
 * @example
 * ```bash
 * caamp mcp remove my-server --agent claude-code
 * caamp mcp remove my-server --all --global
 * ```
 *
 * @public
 */
export function registerMcpRemove(parent: Command): void {
  parent
    .command('remove')
    .description('Remove MCP server from agent configs')
    .argument('<name>', 'MCP server name to remove')
    .option(
      '-a, --agent <name>',
      'Target specific agent(s)',
      (v, prev: string[]) => [...prev, v],
      [],
    )
    .option(
      '--provider <id>',
      'Target provider ID (alias for --agent)',
      (v, prev: string[]) => [...prev, v],
      [],
    )
    .option('-g, --global', 'Remove from global config')
    .option('--all', 'Remove from all detected agents')
    .option('--json', 'Output as JSON (default)')
    .option('--human', 'Output in human-readable format')
    .action(
      async (
        name: string,
        opts: {
          agent: string[];
          provider: string[];
          global?: boolean;
          all?: boolean;
          json?: boolean;
          human?: boolean;
        },
      ) => {
        const operation = 'mcp.remove';
        const mvi: import('../../core/lafs.js').MVILevel = 'standard';

        let format: 'json' | 'human';
        try {
          format = resolveFormat({
            jsonFlag: opts.json ?? false,
            humanFlag: (opts.human ?? false) || isHuman(),
            projectDefault: 'json',
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          emitJsonError(
            operation,
            mvi,
            ErrorCodes.FORMAT_CONFLICT,
            message,
            ErrorCategories.VALIDATION,
          );
          process.exit(1);
        }

        let providers: Provider[];

        if (opts.all) {
          providers = getInstalledProviders();
        } else if (opts.agent.length > 0) {
          providers = opts.agent
            .map((a) => getProvider(a))
            .filter((p): p is Provider => p !== undefined);
        } else if (opts.provider.length > 0) {
          providers = opts.provider
            .map((a) => getProvider(a))
            .filter((p): p is Provider => p !== undefined);
        } else {
          providers = getInstalledProviders();
        }

        if (providers.length === 0) {
          const message = 'No target providers found.';
          if (format === 'json') {
            emitJsonError(
              operation,
              mvi,
              ErrorCodes.PROVIDER_NOT_FOUND,
              message,
              ErrorCategories.NOT_FOUND,
            );
          } else {
            console.error(pc.red(message));
          }
          process.exit(1);
        }

        const scope = opts.global ? ('global' as const) : ('project' as const);
        const removed: string[] = [];
        const notFound: string[] = [];

        for (const provider of providers) {
          const success = await removeMcpServer(provider, name, scope);
          if (success) {
            removed.push(provider.id);
            if (format === 'human') {
              console.log(`  ${pc.green('✓')} Removed from ${provider.toolName}`);
            }
          } else {
            notFound.push(provider.id);
          }
        }

        if (removed.length > 0) {
          await removeMcpFromLock(name);
        }

        if (format === 'json') {
          outputSuccess(operation, mvi, {
            removed,
            providers: removed,
            notFound: notFound.length > 0 ? notFound : undefined,
          });
        } else {
          if (removed.length > 0) {
            console.log(pc.green(`\n✓ Removed "${name}" from ${removed.length} provider(s).`));
          } else {
            console.log(pc.yellow(`Server "${name}" not found in any provider config.`));
          }
        }
      },
    );
}
