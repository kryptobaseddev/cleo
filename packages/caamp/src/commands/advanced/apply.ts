/**
 * advanced apply command
 */

import type { Command } from "commander";
import {
  applyMcpInstallWithPolicy,
  selectProvidersByMinimumPriority,
  type ConflictPolicy,
} from "../../core/advanced/orchestration.js";
import { parsePriority, readMcpOperations, resolveProviders } from "./common.js";
import { LAFSCommandError, runLafsCommand } from "./lafs.js";

const VALID_POLICIES = new Set<ConflictPolicy>(["fail", "skip", "overwrite"]);

function parsePolicy(value: string): ConflictPolicy {
  if (!VALID_POLICIES.has(value as ConflictPolicy)) {
    throw new LAFSCommandError(
      "E_ADVANCED_VALIDATION_POLICY",
      `Invalid policy: ${value}`,
      "Use one of: fail, skip, overwrite.",
    );
  }
  return value as ConflictPolicy;
}

/**
 * Registers the `advanced apply` subcommand for applying MCP operations with configurable conflict policy.
 *
 * @remarks
 * Applies MCP batch operations from a JSON file to targeted providers with fail, skip, or overwrite
 * conflict resolution policies. Supports minimum priority tier filtering.
 *
 * @param parent - The parent `advanced` Command to attach the apply subcommand to
 *
 * @example
 * ```bash
 * caamp advanced apply --mcp-file ops.json --policy overwrite
 * caamp advanced apply --mcp-file ops.json --min-tier high
 * ```
 *
 * @public
 */
export function registerAdvancedApply(parent: Command): void {
  parent
    .command("apply")
    .description("Apply MCP operations with configurable conflict policy")
    .requiredOption("--mcp-file <path>", "JSON file containing McpBatchOperation[]")
    .option("--policy <policy>", "Conflict policy: fail|skip|overwrite", "fail")
    .option("-a, --agent <name>", "Target specific provider(s)", (v, prev: string[]) => [...prev, v], [])
    .option("--all", "Use all registry providers (not only detected)")
    .option("--min-tier <tier>", "Minimum priority tier: high|medium|low", "low")
    .option("--project-dir <path>", "Project directory to resolve project-scope paths")
    .option("--details", "Include detailed apply result")
    .action(async (opts: {
      mcpFile: string;
      policy: string;
      agent: string[];
      all?: boolean;
      minTier: string;
      projectDir?: string;
      details?: boolean;
    }) => runLafsCommand("advanced.apply", opts.details ? "full" : "standard", async () => {
      const baseProviders = resolveProviders({ all: opts.all, agent: opts.agent });
      const minimumPriority = parsePriority(opts.minTier);
      const providers = selectProvidersByMinimumPriority(baseProviders, minimumPriority);
      const operations = await readMcpOperations(opts.mcpFile);
      const policy = parsePolicy(opts.policy);

      if (providers.length === 0) {
        throw new LAFSCommandError(
          "E_ADVANCED_NO_TARGET_PROVIDERS",
          "No target providers resolved for apply operation.",
          "Use --all or pass provider IDs with --agent.",
        );
      }

      const result = await applyMcpInstallWithPolicy(
        providers,
        operations,
        policy,
        opts.projectDir,
      );

      if (policy === "fail" && result.conflicts.length > 0) {
        throw new LAFSCommandError(
          "E_ADVANCED_CONFLICTS_BLOCKING",
          "Conflicts detected and policy is set to fail.",
          "Run `caamp advanced conflicts` to inspect, or rerun with --policy skip/overwrite.",
          true,
          result,
        );
      }

      const failedWrites = result.applied.filter((entry) => !entry.success);
      if (failedWrites.length > 0) {
        throw new LAFSCommandError(
          "E_ADVANCED_APPLY_WRITE_FAILED",
          "One or more MCP writes failed.",
          "Check result details, fix provider config issues, and retry.",
          true,
          result,
        );
      }

      return {
        objective: "Apply MCP operations with policy-driven conflict handling",
        constraints: {
          policy,
          minimumPriority,
          providerCount: providers.length,
          operationCount: operations.length,
        },
        acceptanceCriteria: {
          conflicts: result.conflicts.length,
          writesSucceeded: result.applied.length,
        },
        data: opts.details
          ? result
          : {
            conflicts: result.conflicts.length,
            applied: result.applied.length,
            skipped: result.skipped.length,
          },
      };
    }));
}
