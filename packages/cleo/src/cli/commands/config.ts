/**
 * CLI command group: cleo config — SSoT ConfigManifest registry surface.
 *
 * `show`, `get`, `set`, `validate`, and `drift-check` are thin wrappers over
 * the CORE registry from T9878 (`@cleocode/core/config/registry`) — they
 * implement the operator surface for the ConfigManifest contract introduced
 * in T9876.
 *
 * `set-preset`, `presets`, and `list` are legacy verbs that pre-date the SSoT
 * registry and remain for backwards compatibility (they delegate through the
 * dispatch admin domain to `loadConfig`/strictness-preset logic in
 * `core/config.ts`).
 *
 * Subcommands:
 *   cleo config show [--scope global|project|merged]      — read cascade
 *   cleo config get <key> [--scope ...]                   — single lookup
 *   cleo config set <key> <value> [--scope ...] [--type]  — write a value
 *   cleo config validate [--scope global|project]         — schema gate
 *   cleo config drift-check [--scope global|project|metadata] — drift gate
 *   cleo config set-preset <preset>                       — apply preset (legacy)
 *   cleo config presets                                   — list presets (legacy)
 *   cleo config list                                      — resolved config (legacy)
 *
 * @task T9887
 * @task T4454
 * @task T4795
 * @task T067
 * @saga T9855
 * @adr 076
 */

import { CleoError, formatError, loadConfig } from '@cleocode/core';
import { showUsage } from 'citty';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';
import { defineCommand } from '../lib/define-cli-command.js';
import { cliError, cliOutput } from '../renderers/index.js';
import {
  configDriftCheckCommand,
  configGetCommand,
  configSetCommand,
  configShowCommand,
  configValidateCommand,
} from './config/index.js';

const PRESET_DESCRIPTIONS: Record<string, string> = {
  strict: 'Block on missing AC, require session notes, enforce lifecycle pipeline.',
  standard: 'Warn on missing AC, optional session notes, advisory lifecycle pipeline.',
  minimal: 'No AC checking, no session requirement, lifecycle pipeline off.',
};

/** cleo config set-preset — apply a strictness preset to the project config */
const setPresetCommand = defineCommand({
  meta: {
    name: 'set-preset',
    description: [
      'Apply a strictness preset to the project config (strict | standard | minimal)',
      `  strict   — ${PRESET_DESCRIPTIONS['strict']}`,
      `  standard — ${PRESET_DESCRIPTIONS['standard']}`,
      `  minimal  — ${PRESET_DESCRIPTIONS['minimal']}`,
    ].join('\n\n'),
  },
  args: {
    preset: {
      type: 'positional',
      description: 'Preset name (strict | standard | minimal)',
      required: true,
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'mutate',
      'admin',
      'config.set-preset',
      { preset: args.preset },
      { command: 'config' },
    );
  },
});

/** cleo config presets — list all available strictness presets */
const presetsCommand = defineCommand({
  meta: { name: 'presets', description: 'List all available strictness presets' },
  async run() {
    await dispatchFromCli('query', 'admin', 'config.presets', {}, { command: 'config' });
  },
});

/** cleo config list — show all resolved configuration (CLI-only, uses core directly) */
const listCommand = defineCommand({
  meta: { name: 'list', description: 'Show all resolved configuration' },
  async run() {
    try {
      const resolved = await loadConfig();
      cliOutput({ config: resolved }, { command: 'config' });
    } catch (err) {
      if (err instanceof CleoError) {
        cliError(formatError(err), err.code, { name: 'E_CONFIG_LOAD' });
        process.exit(err.code);
      }
      throw err;
    }
  },
});

/**
 * Root config command group.
 *
 * Operator surface for the SSoT ConfigManifest registry (T9876 contracts +
 * T9878 CORE registry). The new SSoT sub-verbs (`show`, `get`, `set`,
 * `validate`, `drift-check`) live in `./config/` and are mounted alongside
 * the legacy preset/list verbs.
 *
 * @public
 */
export const configCommand = defineCommand({
  meta: {
    name: 'config',
    description:
      'CleoConfig SSoT registry surface (show, get, set, validate, drift-check) + legacy presets/list',
  },
  subCommands: {
    show: configShowCommand,
    get: configGetCommand,
    set: configSetCommand,
    validate: configValidateCommand,
    'drift-check': configDriftCheckCommand,
    'set-preset': setPresetCommand,
    presets: presetsCommand,
    list: listCommand,
  },
  async run({ cmd, rawArgs }) {
    const firstArg = rawArgs?.find((a) => !a.startsWith('-'));
    if (firstArg && cmd.subCommands && firstArg in cmd.subCommands) return;
    await showUsage(cmd);
  },
});
