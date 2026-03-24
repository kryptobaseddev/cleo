/**
 * advanced conflicts command
 */

import type { Command } from "commander";
import { detectMcpConfigConflicts, selectProvidersByMinimumPriority } from "../../core/advanced/orchestration.js";
import { parsePriority, readMcpOperations, resolveProviders } from "./common.js";
import { LAFSCommandError, runLafsCommand } from "./lafs.js";

/**
 * Registers the `advanced conflicts` subcommand for preflight MCP conflict detection.
 *
 * @remarks
 * Scans existing provider configurations for naming conflicts with proposed MCP operations
 * before applying them. Reports conflicts without making any changes.
 *
 * @param parent - The parent `advanced` Command to attach the conflicts subcommand to
 *
 * @example
 * ```bash
 * caamp advanced conflicts --mcp-file ops.json --all
 * caamp advanced conflicts --mcp-file ops.json --min-tier high
 * ```
 *
 * @public
 */
export function registerAdvancedConflicts(parent: Command): void {
  parent
    .command("conflicts")
    .description("Preflight MCP conflict detection across providers")
    .requiredOption("--mcp-file <path>", "JSON file containing McpBatchOperation[]")
    .option("-a, --agent <name>", "Target specific provider(s)", (v, prev: string[]) => [...prev, v], [])
    .option("--all", "Use all registry providers (not only detected)")
    .option("--min-tier <tier>", "Minimum priority tier: high|medium|low", "low")
    .option("--project-dir <path>", "Project directory to resolve project-scope paths")
    .option("--details", "Include full conflict list")
    .action(async (opts: {
      mcpFile: string;
      agent: string[];
      all?: boolean;
      minTier: string;
      projectDir?: string;
      details?: boolean;
    }) => runLafsCommand("advanced.conflicts", opts.details ? "full" : "standard", async () => {
      const baseProviders = resolveProviders({ all: opts.all, agent: opts.agent });
      const minimumPriority = parsePriority(opts.minTier);
      const providers = selectProvidersByMinimumPriority(baseProviders, minimumPriority);
      const operations = await readMcpOperations(opts.mcpFile);

      if (providers.length === 0) {
        throw new LAFSCommandError(
          "E_ADVANCED_NO_TARGET_PROVIDERS",
          "No target providers resolved for conflict detection.",
          "Use --all or pass provider IDs with --agent.",
        );
      }

      const conflicts = await detectMcpConfigConflicts(
        providers,
        operations,
        opts.projectDir,
      );

      const countByCode = conflicts.reduce<Record<string, number>>((acc, conflict) => {
        acc[conflict.code] = (acc[conflict.code] ?? 0) + 1;
        return acc;
      }, {});

      return {
        objective: "Detect MCP configuration conflicts before mutation",
        constraints: {
          minimumPriority,
          providerCount: providers.length,
          operationCount: operations.length,
        },
        acceptanceCriteria: {
          conflictCount: conflicts.length,
        },
        data: opts.details
          ? conflicts
          : {
            conflictCount: conflicts.length,
            countByCode,
            sample: conflicts.slice(0, 5),
          },
      };
    }));
}
