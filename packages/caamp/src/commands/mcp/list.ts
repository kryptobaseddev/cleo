/**
 * `caamp mcp list` command.
 *
 * @remarks
 * Two execution modes:
 *
 * - `--provider <id>` — list MCP servers for a single provider's
 *   config file.
 * - (no flag)         — fan out across every MCP-capable provider in
 *   the registry.
 *
 * Both modes accept `--scope project|global` and `--project-dir <path>`.
 * Output is a LAFS envelope containing a `count`, an optional
 * `provider` summary (single-mode only), and an `entries` array.
 *
 * Missing config files are NOT errors — a provider with no MCP
 * servers installed simply contributes an empty section to the
 * result. The only error path is an unknown `--provider` id (or one
 * that does not declare an MCP capability), which is surfaced via
 * {@link requireMcpProvider} as a typed `E_NOT_FOUND_RESOURCE`.
 *
 * @packageDocumentation
 */

import type { Command } from 'commander';
import { listAllMcpServers, listMcpServers } from '../../core/mcp/index.js';
import type { McpServerEntry } from '../../types.js';
import { runLafsCommand } from '../advanced/lafs.js';
import {
  type McpCommandBaseOptions,
  parseScope,
  requireMcpProvider,
  resolveProjectDir,
} from './common.js';

/**
 * Options accepted by `caamp mcp list`.
 *
 * @public
 */
export interface McpListOptions extends McpCommandBaseOptions {
  /** Restrict the listing to a single provider id. */
  provider?: string;
}

/**
 * Registers the `caamp mcp list` subcommand.
 *
 * @param parent - Parent `mcp` Command to attach the subcommand to.
 *
 * @example
 * ```bash
 * caamp mcp list
 * caamp mcp list --provider claude-code
 * caamp mcp list --provider cursor --scope global
 * ```
 *
 * @public
 */
export function registerMcpListCommand(parent: Command): void {
  parent
    .command('list')
    .description('List MCP servers configured for one or every MCP-capable provider')
    .option('--provider <id>', 'Restrict to a single provider id')
    .option('--scope <scope>', 'Scope: project|global (default: project)')
    .option('--project-dir <path>', 'Project directory for the project scope (default: cwd)')
    .action(async (opts: McpListOptions) =>
      runLafsCommand('mcp.list', 'standard', async () => {
        const scope = parseScope(opts.scope, 'project');
        const projectDir = resolveProjectDir(scope, opts.projectDir);

        if (opts.provider !== undefined && opts.provider.length > 0) {
          const provider = requireMcpProvider(opts.provider);
          const entries = await listMcpServers(provider, scope, projectDir);
          return {
            scope,
            provider: {
              id: provider.id,
              toolName: provider.toolName,
            },
            count: entries.length,
            entries,
          };
        }

        const map = await listAllMcpServers(scope, projectDir);
        const flat: McpServerEntry[] = [];
        const byProvider: Record<string, number> = {};
        for (const [providerId, entries] of map.entries()) {
          byProvider[providerId] = entries.length;
          flat.push(...entries);
        }
        return {
          scope,
          providers: byProvider,
          count: flat.length,
          entries: flat,
        };
      }),
    );
}
