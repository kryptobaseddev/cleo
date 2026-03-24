/**
 * mcp detect command - auto-detect installed MCP tools - LAFS-compliant with JSON-first output
 */

import { existsSync } from "node:fs";
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
import { listMcpServers, resolveConfigPath } from "../../core/mcp/reader.js";
import { getInstalledProviders } from "../../core/registry/detection.js";

/**
 * Registers the `mcp detect` subcommand for auto-detecting installed MCP tools and their configurations.
 *
 * @remarks
 * Scans all installed providers for existing MCP configuration files at both global and project
 * scopes, reporting which servers are configured for each provider.
 *
 * @param parent - The parent `mcp` Command to attach the detect subcommand to
 *
 * @example
 * ```bash
 * caamp mcp detect --human
 * caamp mcp detect --json
 * ```
 *
 * @public
 */
export function registerMcpDetect(parent: Command): void {
  parent
    .command("detect")
    .description("Auto-detect installed MCP tools and their configurations")
    .option("--json", "Output as JSON (default)")
    .option("--human", "Output in human-readable format")
    .action(async (opts: { json?: boolean; human?: boolean }) => {
      const operation = "mcp.detect";
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

      const providers = getInstalledProviders();

      const providersResult: Array<{
        id: string;
        configsFound: number;
        servers: string[];
      }> = [];
      let totalConfigs = 0;

      for (const provider of providers) {
        const globalPath = resolveConfigPath(provider, "global");
        const projectPath = resolveConfigPath(provider, "project");

        const globalEntries = await listMcpServers(provider, "global");
        const projectEntries = await listMcpServers(provider, "project");

        const configsFound = 
          (globalPath && existsSync(globalPath) ? 1 : 0) +
          (projectPath && existsSync(projectPath) ? 1 : 0);
        
        totalConfigs += configsFound;

        const allServers = [...globalEntries.map(e => e.name), ...projectEntries.map(e => e.name)];

        providersResult.push({
          id: provider.id,
          configsFound,
          servers: allServers,
        });
      }

      if (format === "json") {
        outputSuccess(operation, mvi, {
          providers: providersResult,
          totalConfigs,
        });
        return;
      }

      // Human-readable output
      console.log(pc.bold(`\n${providers.length} provider(s) with MCP support:\n`));

      for (const provider of providersResult) {
        const globalPath = resolveConfigPath(providers.find(p => p.id === provider.id)!, "global");
        const projectPath = resolveConfigPath(providers.find(p => p.id === provider.id)!, "project");
        
        const hasGlobal = globalPath && existsSync(globalPath);
        const hasProject = projectPath && existsSync(projectPath);
        
        const globalIcon = hasGlobal ? pc.green("G") : pc.dim("-");
        const projectIcon = hasProject ? pc.green("P") : pc.dim("-");
        const serverList = provider.servers.length > 0 ? pc.dim(provider.servers.join(", ")) : pc.dim("no servers");

        console.log(`  [${globalIcon}${projectIcon}] ${pc.bold(provider.id.padEnd(20))} ${serverList}`);
      }

      console.log(pc.dim("\nG = global config, P = project config"));
      console.log();
    });
}
