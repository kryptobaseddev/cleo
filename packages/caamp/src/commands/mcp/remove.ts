/**
 * `caamp mcp remove` command.
 *
 * @remarks
 * Two execution modes:
 *
 * - `--provider <id>`     — remove a single server entry from a single
 *   provider's config file (the common case).
 * - `--all-providers`     — remove a server entry by name from every
 *   MCP-capable provider in the registry that currently has it.
 *
 * Both modes are idempotent: when the entry is not present, the call
 * returns `removed: false` rather than throwing. The result envelope
 * always carries enough detail to render a precise human-readable
 * report.
 *
 * @packageDocumentation
 */

import type { Command } from 'commander';
import { removeMcpServer, removeMcpServerFromAll } from '../../core/mcp/index.js';
import { LAFSCommandError, runLafsCommand } from '../advanced/lafs.js';
import {
  MCP_ERROR_CODES,
  type McpCommandBaseOptions,
  parseScope,
  requireMcpProvider,
  resolveProjectDir,
} from './common.js';

/**
 * Options accepted by `caamp mcp remove`.
 *
 * @public
 */
export interface McpRemoveOptions extends McpCommandBaseOptions {
  /** Provider id to remove from (mutually exclusive with --all-providers). */
  provider?: string;
  /** Remove from every MCP-capable provider in the registry. */
  allProviders?: boolean;
}

/**
 * Registers the `caamp mcp remove` subcommand.
 *
 * @param parent - Parent `mcp` Command to attach the subcommand to.
 *
 * @example
 * ```bash
 * caamp mcp remove github --provider claude-desktop
 * caamp mcp remove github --provider cursor --scope global
 * caamp mcp remove github --all-providers
 * ```
 *
 * @public
 */
export function registerMcpRemoveCommand(parent: Command): void {
  parent
    .command('remove <serverName>')
    .description('Remove an MCP server entry from a provider config file')
    .option('--provider <id>', 'Provider id to remove from')
    .option('--all-providers', 'Remove from every MCP-capable provider in the registry')
    .option('--scope <scope>', 'Scope: project|global (default: project)')
    .option('--project-dir <path>', 'Project directory for the project scope (default: cwd)')
    .action(async (serverName: string, opts: McpRemoveOptions) =>
      runLafsCommand('mcp.remove', 'standard', async () => {
        if (serverName.length === 0) {
          throw new LAFSCommandError(
            MCP_ERROR_CODES.VALIDATION,
            'Server name is required',
            'Pass a non-empty server name as the positional argument.',
            false,
          );
        }
        const usingAll = opts.allProviders === true;
        const usingProvider = opts.provider !== undefined && opts.provider.length > 0;
        if (usingAll === usingProvider) {
          throw new LAFSCommandError(
            MCP_ERROR_CODES.VALIDATION,
            'Pass exactly one of --provider <id> or --all-providers',
            'Use --provider for a single target, or --all-providers to remove everywhere.',
            false,
          );
        }

        const scope = parseScope(opts.scope, 'project');
        const projectDir = resolveProjectDir(scope, opts.projectDir);

        if (usingAll) {
          const results = await removeMcpServerFromAll(serverName, { scope, projectDir });
          const removedCount = results.filter((r) => r.removed).length;
          return {
            mode: 'all-providers',
            serverName,
            scope,
            removedCount,
            providersProbed: results.length,
            results,
          };
        }

        // usingProvider
        const provider = requireMcpProvider(opts.provider as string);
        const result = await removeMcpServer(provider, serverName, { scope, projectDir });
        return {
          mode: 'single-provider',
          serverName,
          scope,
          provider: provider.id,
          removed: result.removed,
          reason: result.reason,
          sourcePath: result.sourcePath,
        };
      }),
    );
}
