/**
 * Instruction file management command group for injecting, checking, and updating CAAMP-managed
 * instruction blocks in provider instruction files (CLAUDE.md, AGENTS.md, GEMINI.md).
 *
 * @packageDocumentation
 */

import type { Command } from "commander";
import { registerInstructionsInject } from "./inject.js";
import { registerInstructionsCheck } from "./check.js";
import { registerInstructionsUpdate } from "./update.js";

/**
 * Registers the `instructions` command group with inject, check, and update subcommands.
 *
 * @remarks
 * Manages CAAMP marker-based injection blocks within provider instruction files.
 * Supports inject (create), check (verify status), and update (refresh) operations.
 *
 * @param program - The root Commander program to attach the instructions command group to
 *
 * @example
 * ```bash
 * caamp instructions inject --all
 * caamp instructions check --human
 * caamp instructions update --yes
 * ```
 *
 * @public
 */
export function registerInstructionsCommands(program: Command): void {
  const instructions = program
    .command("instructions")
    .description("Manage instruction file injections");

  registerInstructionsInject(instructions);
  registerInstructionsCheck(instructions);
  registerInstructionsUpdate(instructions);
}
