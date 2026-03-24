/**
 * MCP server management command group for installing, removing, listing, and detecting MCP server configurations across AI agent providers.
 *
 * @packageDocumentation
 */

import type { Command } from "commander";
import { registerMcpCleoCommands, registerMcpCleoCompatibilityCommands } from "./cleo.js";
import { registerMcpDetect } from "./detect.js";
import { registerMcpInstall } from "./install.js";
import { registerMcpList } from "./list.js";
import { registerMcpRemove } from "./remove.js";

/**
 * Registers the `mcp` command group with install, remove, list, detect, and cleo subcommands.
 *
 * @remarks
 * Orchestrates registration of all MCP-related subcommands under a unified `mcp` parent command.
 * Includes both direct MCP operations and CLEO channel profile management.
 *
 * @param program - The root Commander program to attach the mcp command group to
 *
 * @example
 * ```bash
 * caamp mcp install https://example.com/server --agent claude-code
 * caamp mcp list --global
 * ```
 *
 * @public
 */
export function registerMcpCommands(program: Command): void {
  const mcp = program
    .command("mcp")
    .description("Manage MCP server configurations");

  registerMcpInstall(mcp);
  registerMcpRemove(mcp);
  registerMcpList(mcp);
  registerMcpDetect(mcp);
  registerMcpCleoCommands(mcp);
  registerMcpCleoCompatibilityCommands(mcp);
}
