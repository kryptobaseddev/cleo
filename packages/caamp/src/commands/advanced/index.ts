/**
 * Advanced orchestration command group providing LAFS-compliant wrappers for batch operations,
 * provider selection, and instruction management.
 *
 * @packageDocumentation
 */

import type { Command } from 'commander';
import { registerAdvancedBatch } from './batch.js';
import { registerAdvancedInstructions } from './instructions.js';
import { registerAdvancedProviders } from './providers.js';

/**
 * Registers the `advanced` command group with providers, batch, and instructions subcommands.
 *
 * @remarks
 * Provides LAFS-compliant wrappers for advanced orchestration operations that operate across
 * multiple providers and scopes in a single invocation.
 *
 * @param program - The root Commander program to attach the advanced command group to
 *
 * @example
 * ```bash
 * caamp advanced batch --skills-file skills.json
 * caamp advanced instructions --content "## Setup" --all
 * ```
 *
 * @public
 */
export function registerAdvancedCommands(program: Command): void {
  const advanced = program
    .command('advanced')
    .description('LAFS-compliant wrappers for advanced orchestration APIs');

  registerAdvancedProviders(advanced);
  registerAdvancedBatch(advanced);
  registerAdvancedInstructions(advanced);
}
