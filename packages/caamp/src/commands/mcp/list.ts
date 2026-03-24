/**
 * mcp list command - LAFS-compliant with JSON-first output
 */

import type { Command } from "commander";
import pc from "picocolors";
import {
  ErrorCategories,
  ErrorCodes,
  emitJsonError,
  outputSuccess,
  resolveFormat,
} from "../../core/lafs.js";
import { isHuman } from "../../core/logger.js";
import { listMcpServers } from "../../core/mcp/reader.js";
import { resolvePreferredConfigScope } from "../../core/paths/standard.js";
import { getInstalledProviders } from "../../core/registry/detection.js";
import { getProvider } from "../../core/registry/providers.js";
import type { McpServerEntry } from "../../types.js";

/**
 * Registers the `mcp list` subcommand for listing configured MCP servers across providers.
 *
 * @remarks
 * Queries installed provider configurations and lists all MCP server entries with scope indicators.
 * Supports filtering by specific agent and global/project scope.
 *
 * @param parent - The parent `mcp` Command to attach the list subcommand to
 *
 * @example
 * ```bash
 * caamp mcp list --agent claude-code
 * caamp mcp list --global --human
 * ```
 *
 * @public
 */
export function registerMcpList(parent: Command): void {
  parent
    .command("list")
    .description("List configured MCP servers")
    .option("-a, --agent <name>", "List for specific agent")
    .option("--provider <id>", "Provider ID alias for --agent")
    .option("-g, --global", "List global config")
    .option("--json", "Output as JSON (default)")
    .option("--human", "Output in human-readable format")
    .action(async (opts: { agent?: string; provider?: string; global?: boolean; json?: boolean; human?: boolean }) => {
      const operation = "mcp.list";
      const mvi: import("../../core/lafs.js").MVILevel = "standard";

      let format: "json" | "human";
      try {
        format = resolveFormat({
          jsonFlag: opts.json ?? false,
          humanFlag: (opts.human ?? false) || isHuman(),
          projectDefault: "json",
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        emitJsonError(operation, mvi, ErrorCodes.FORMAT_CONFLICT, message, ErrorCategories.VALIDATION);
        process.exit(1);
      }

      const selectedProvider = opts.provider ?? opts.agent;

      const providers = selectedProvider
        ? [getProvider(selectedProvider)].filter((p): p is NonNullable<typeof p> => p !== undefined)
        : getInstalledProviders();

      if (selectedProvider && providers.length === 0) {
        const message = `Provider not found: ${selectedProvider}`;
        if (format === "json") {
          emitJsonError(operation, mvi, ErrorCodes.PROVIDER_NOT_FOUND, message, ErrorCategories.NOT_FOUND, {
            provider: selectedProvider,
          });
        } else {
          console.error(pc.red(message));
        }
        process.exit(1);
      }

      const allEntries: Array<{
        name: string;
        command?: string;
        scope: "global" | "project";
      }> = [];

      for (const provider of providers) {
        const scope = resolvePreferredConfigScope(provider, opts.global);

        const entries = await listMcpServers(provider, scope);
        for (const entry of entries) {
          allEntries.push({
            name: entry.name,
            command: typeof entry.config.command === "string" ? entry.config.command : undefined,
            scope,
          });
        }
      }

      if (format === "json") {
        outputSuccess(operation, mvi, {
          servers: allEntries,
          count: allEntries.length,
          scope: opts.global ? "global" : selectedProvider ? `agent:${selectedProvider}` : "project",
        });
        return;
      }

      // Human-readable output
      if (allEntries.length === 0) {
        console.log(pc.dim("No MCP servers configured."));
        return;
      }

      console.log(pc.bold(`\n${allEntries.length} MCP server(s) configured:\n`));

      for (const entry of allEntries) {
        const scopeIndicator = entry.scope === "global" ? pc.dim("[G] ") : pc.dim("[P] ");
        console.log(`  ${scopeIndicator}${pc.bold(entry.name.padEnd(25))} ${entry.command ? pc.dim(entry.command) : ""}`);
      }

      console.log();
      console.log(pc.dim("G = global config, P = project config"));
      console.log();
    });
}
