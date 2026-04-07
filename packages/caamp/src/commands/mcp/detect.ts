/**
 * `caamp mcp detect` command.
 *
 * @remarks
 * Auto-detects which providers on the current machine already have an
 * MCP config file on disk and reports the per-provider server count
 * and last-modified timestamp. Useful for onboarding ("which tools on
 * my machine already have MCP configured?") and for cross-checking
 * before running `caamp mcp install`.
 *
 * Iterates every MCP-capable provider in the registry, NOT just
 * "installed" providers — a config file may exist for a provider
 * whose binary is not on PATH (e.g. a stale config from a previous
 * install). The result envelope marks each entry with `exists` and
 * `serverCount` so callers can filter as needed.
 *
 * @packageDocumentation
 */

import type { Command } from 'commander';
import { detectMcpInstallations } from '../../core/mcp/index.js';
import { runLafsCommand } from '../advanced/lafs.js';
import { type McpCommandBaseOptions, parseScope, resolveProjectDir } from './common.js';

/**
 * Options accepted by `caamp mcp detect`.
 *
 * @public
 */
export interface McpDetectOptions extends McpCommandBaseOptions {
  /** Show only providers that actually have a config file on disk. */
  onlyExisting?: boolean;
}

/**
 * Registers the `caamp mcp detect` subcommand.
 *
 * @param parent - Parent `mcp` Command to attach the subcommand to.
 *
 * @example
 * ```bash
 * caamp mcp detect
 * caamp mcp detect --scope global
 * caamp mcp detect --only-existing
 * ```
 *
 * @public
 */
export function registerMcpDetectCommand(parent: Command): void {
  parent
    .command('detect')
    .description('Detect which providers currently have MCP config files on disk')
    .option('--scope <scope>', 'Scope: project|global (default: project)')
    .option('--project-dir <path>', 'Project directory for the project scope (default: cwd)')
    .option('--only-existing', 'Only include providers whose config file exists on disk')
    .action(async (opts: McpDetectOptions) =>
      runLafsCommand('mcp.detect', 'standard', async () => {
        const scope = parseScope(opts.scope, 'project');
        const projectDir = resolveProjectDir(scope, opts.projectDir);

        const all = await detectMcpInstallations(scope, projectDir);
        const filtered = opts.onlyExisting === true ? all.filter((e) => e.exists) : all;
        const existingCount = filtered.filter((e) => e.exists).length;
        const totalServers = filtered.reduce((sum, e) => sum + (e.serverCount ?? 0), 0);

        return {
          scope,
          providersProbed: all.length,
          existingCount,
          totalServers,
          entries: filtered,
        };
      }),
    );
}
