/**
 * `caamp mcp` command group — MCP server config management across
 * providers.
 *
 * @remarks
 * Per ADR-035, CAAMP exposes a small set of verbs for editing MCP
 * server entries inside the per-agent config files of every provider
 * that declares an `capabilities.mcp` block in `providers/registry.json`.
 *
 * This module is the single entry point for wiring every sub-verb
 * into the root `caamp` program. Each sub-verb owns its own
 * registration in the corresponding `commands/mcp/<verb>.ts` file and
 * exposes a `register*Command(parent)` function with the same shape as
 * the Wave-1 `caamp pi` verbs.
 *
 * The verbs do NOT speak the MCP protocol themselves — they just
 * read/write JSON/JSONC/YAML/TOML records via the format-agnostic
 * substrate from `core/formats`. Treat MCP server configs as plain
 * data records: `{ command, args?, env?, url?, type?, headers? }`.
 *
 * @packageDocumentation
 */

import type { Command } from 'commander';
import { registerMcpDetectCommand } from './detect.js';
import { registerMcpInstallCommand } from './install.js';
import { registerMcpListCommand } from './list.js';
import { registerMcpRemoveCommand } from './remove.js';

/**
 * Register the `mcp` command group and all sub-verbs on the root
 * program.
 *
 * @remarks
 * Attaches `list`, `install`, `remove`, and `detect` under a single
 * parent `mcp` command. Verb ordering follows the natural workflow:
 * detect what is installed, list what is configured, install or
 * remove individual servers.
 *
 * @param program - The root Commander program to attach the `mcp`
 *   group to.
 *
 * @example
 * ```bash
 * caamp mcp detect
 * caamp mcp list --provider claude-code
 * caamp mcp install github --provider claude-desktop -- npx -y @modelcontextprotocol/server-github
 * caamp mcp remove github --provider claude-desktop
 * ```
 *
 * @public
 */
export function registerMcpCommands(program: Command): void {
  const mcp = program.command('mcp').description('MCP server config management across providers');

  registerMcpDetectCommand(mcp);
  registerMcpListCommand(mcp);
  registerMcpInstallCommand(mcp);
  registerMcpRemoveCommand(mcp);
}
