/**
 * Skills management command group for installing, removing, listing, finding, checking, updating,
 * initializing, auditing, and validating AI agent skills.
 *
 * @packageDocumentation
 */

import type { Command } from 'commander';
import { registerSkillsAudit } from './audit.js';
import { registerSkillsCheck } from './check.js';
import { registerSkillsFind } from './find.js';
import { registerSkillsInit } from './init.js';
import { registerSkillsInstall } from './install.js';
import { registerSkillsList } from './list.js';
import { registerSkillsRemove } from './remove.js';
import { registerSkillsUpdate } from './update.js';
import { registerSkillsValidate } from './validate.js';

/**
 * Registers the `skills` command group with all skill management subcommands.
 *
 * @remarks
 * Orchestrates registration of install, remove, list, find, check, update, init, audit, and
 * validate subcommands under the unified `skills` parent command.
 *
 * @param program - The root Commander program to attach the skills command group to
 *
 * @example
 * ```bash
 * caamp skills install owner/repo
 * caamp skills list --human
 * caamp skills find "testing"
 * ```
 *
 * @public
 */
export function registerSkillsCommands(program: Command): void {
  const skills = program.command('skills').description('Manage AI agent skills');

  registerSkillsInstall(skills);
  registerSkillsRemove(skills);
  registerSkillsList(skills);
  registerSkillsFind(skills);
  registerSkillsCheck(skills);
  registerSkillsUpdate(skills);
  registerSkillsInit(skills);
  registerSkillsAudit(skills);
  registerSkillsValidate(skills);
}
