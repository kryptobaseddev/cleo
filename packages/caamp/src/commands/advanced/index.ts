/**
 * Advanced orchestration command group providing LAFS-compliant wrappers for batch operations,
 * conflict detection, policy-based apply, provider selection, and cross-scope configuration.
 *
 * @packageDocumentation
 */

import type { Command } from "commander";
import { registerAdvancedProviders } from "./providers.js";
import { registerAdvancedBatch } from "./batch.js";
import { registerAdvancedConflicts } from "./conflicts.js";
import { registerAdvancedApply } from "./apply.js";
import { registerAdvancedInstructions } from "./instructions.js";
import { registerAdvancedConfigure } from "./configure.js";

/**
 * Registers the `advanced` command group with providers, batch, conflicts, apply, instructions, and configure subcommands.
 *
 * @remarks
 * Provides LAFS-compliant wrappers for advanced orchestration operations that operate across
 * multiple providers and scopes in a single invocation.
 *
 * @param program - The root Commander program to attach the advanced command group to
 *
 * @example
 * ```bash
 * caamp advanced batch --mcp-file ops.json --skills-file skills.json
 * caamp advanced apply --mcp-file ops.json --policy overwrite
 * ```
 *
 * @public
 */
export function registerAdvancedCommands(program: Command): void {
  const advanced = program
    .command("advanced")
    .description("LAFS-compliant wrappers for advanced orchestration APIs");

  registerAdvancedProviders(advanced);
  registerAdvancedBatch(advanced);
  registerAdvancedConflicts(advanced);
  registerAdvancedApply(advanced);
  registerAdvancedInstructions(advanced);
  registerAdvancedConfigure(advanced);
}
