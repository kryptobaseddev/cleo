/**
 * `cleo skills doctor` — diagnostic and remediation subcommands for the skill
 * storage topology.
 *
 * @remarks
 * This module hosts the `doctor` Commander group. Individual subcommands
 * (`diagnose`, `migrate`, `bridge`, `adopt-orphans`) are owned by separate
 * modules and attached here so the group can be re-used by both the
 * standalone `caamp` CLI and the `cleo` citty CLI in `packages/cleo`.
 *
 * @see {@link docs/architecture/SG-CLEO-SKILLS-architecture-v3.md} §1
 * @task T9655
 * @epic T9571
 */

import type { Command } from 'commander';
import { registerDoctorBridge } from './doctor-bridge.js';

/**
 * Register the `doctor` subcommand group on the parent `skills` command.
 *
 * @remarks
 * Wires every `skills doctor <verb>` subcommand. New verbs (`diagnose`,
 * `migrate`, `adopt-orphans`, …) should attach themselves here so the
 * surface remains discoverable via `caamp skills doctor --help`.
 *
 * @param parent - The parent `skills` Commander group.
 *
 * @example
 * ```bash
 * caamp skills doctor bridge
 * ```
 *
 * @public
 */
export function registerSkillsDoctor(parent: Command): void {
  const doctor = parent
    .command('doctor')
    .description('Diagnose and repair the skill storage topology');
  registerDoctorBridge(doctor);
}
