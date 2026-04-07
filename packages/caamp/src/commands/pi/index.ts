/**
 * `caamp pi` command group — Pi-specific verbs for the Pi coding agent
 * harness.
 *
 * @remarks
 * Per ADR-035, CAAMP exposes Wave-1 Pi operations (extensions, sessions,
 * models, prompts, themes) as first-class verbs that wrap
 * {@link PiHarness} methods in LAFS-compliant envelopes. This module is
 * the single entry point for wiring every sub-verb into the root
 * `caamp` program.
 *
 * @packageDocumentation
 */

import type { Command } from 'commander';
import { registerPiExtensionsCommands } from './extensions.js';
import { registerPiModelsCommands } from './models.js';
import { registerPiPromptsCommands } from './prompts.js';
import { registerPiSessionsCommands } from './sessions.js';
import { registerPiThemesCommands } from './themes.js';

/**
 * Register the `pi` command group and all Wave-1 sub-verbs on the root
 * program.
 *
 * @remarks
 * Attaches `extensions`, `sessions`, `models`, `prompts`, and `themes`
 * under a single parent `pi` command. Each sub-group owns its own
 * verb registration in the corresponding `commands/pi/<noun>.ts` file.
 *
 * Ordering matches the logical documentation order from ADR-035 rather
 * than alphabetic, so `caamp pi --help` reads as the natural workflow:
 * install an extension, inspect a session, configure a model, install
 * a prompt, install a theme.
 *
 * @param program - The root Commander program to attach the `pi` group to.
 *
 * @example
 * ```bash
 * caamp pi extensions list
 * caamp pi sessions list
 * caamp pi models list
 * caamp pi prompts list
 * caamp pi themes list
 * ```
 *
 * @public
 */
export function registerPiCommands(program: Command): void {
  const pi = program
    .command('pi')
    .description('Pi harness operations (extensions, sessions, models, prompts, themes)');

  registerPiExtensionsCommands(pi);
  registerPiSessionsCommands(pi);
  registerPiModelsCommands(pi);
  registerPiPromptsCommands(pi);
  registerPiThemesCommands(pi);
}
