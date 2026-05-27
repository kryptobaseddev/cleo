/**
 * CLI command group: cleo templates — SSoT TemplateManifest registry surface.
 *
 * Thin wrapper over the CORE registry from T9877
 * (`@cleocode/core/templates/registry`) — exposes the operator surface for
 * the `TemplateManifest` contract introduced in T9875 and consumed by
 * `cleo init`, `cleo upgrade`, and the scaffold sweeper.
 *
 * Subcommands:
 *   cleo templates list [--kind ...]                        — list every entry
 *   cleo templates show <id>                                — single entry
 *   cleo templates install <id> [--project <root>]          — install one
 *   cleo templates upgrade <id> [--project <root>] [--diff] — reconcile
 *   cleo templates diff <id> [--project <root>]             — diff vs deployed
 *   cleo templates validate [--id <id>] [--project <root>]  — sanity-check
 *
 * @task T9886
 * @saga T9855
 * @epic T9874
 * @adr 076
 */

import { showUsage } from 'citty';
import { defineCommand } from '../lib/define-cli-command.js';
import {
  templatesDiffCommand,
  templatesInstallCommand,
  templatesListCommand,
  templatesShowCommand,
  templatesUpgradeCommand,
  templatesValidateCommand,
} from './templates/index.js';

/**
 * Root templates command group.
 *
 * Operator surface for the SSoT TemplateManifest registry (T9875 contracts +
 * T9877 CORE registry). Each sub-verb is implemented in `./templates/` and
 * mounted here.
 *
 * @public
 */
export const templatesCommand = defineCommand({
  meta: {
    name: 'templates',
    description:
      'TemplateManifest SSoT registry surface (list, show, install, upgrade, diff, validate)',
  },
  subCommands: {
    list: templatesListCommand,
    show: templatesShowCommand,
    install: templatesInstallCommand,
    upgrade: templatesUpgradeCommand,
    diff: templatesDiffCommand,
    validate: templatesValidateCommand,
  },
  async run({ cmd, rawArgs }) {
    const firstArg = rawArgs?.find((a) => !a.startsWith('-'));
    if (firstArg && cmd.subCommands && firstArg in cmd.subCommands) return;
    await showUsage(cmd);
  },
});
