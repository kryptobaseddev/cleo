/**
 * CLI command group: cleo config — configuration management.
 *
 * Delegates to core/config.ts for business logic. For the `list` subcommand
 * the resolved config is read directly via `loadConfig()` (no dispatch op).
 *
 * Subcommands:
 *   cleo config get <key>           — get a configuration value
 *   cleo config set <key> <value>   — set a configuration value
 *   cleo config set-preset <preset> — apply a strictness preset
 *   cleo config presets             — list all available presets
 *   cleo config list                — show all resolved configuration
 *
 * @task T4454
 * @task T4795
 * @task T067
 */

import { CleoError, formatError, loadConfig } from '@cleocode/core';
import { defineCommand } from 'citty';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';
import { cliOutput } from '../renderers/index.js';

const PRESET_DESCRIPTIONS: Record<string, string> = {
  strict: 'Block on missing AC, require session notes, enforce lifecycle pipeline.',
  standard: 'Warn on missing AC, optional session notes, advisory lifecycle pipeline.',
  minimal: 'No AC checking, no session requirement, lifecycle pipeline off.',
};

/** cleo config get — get a configuration value */
const getCommand = defineCommand({
  meta: { name: 'get', description: 'Get a configuration value' },
  args: {
    key: {
      type: 'positional',
      description: 'Configuration key to retrieve',
      required: true,
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'admin',
      'config.show',
      { key: args.key },
      { command: 'config' },
    );
  },
});

/** cleo config set — set a configuration value */
const setCommand = defineCommand({
  meta: { name: 'set', description: 'Set a configuration value' },
  args: {
    key: {
      type: 'positional',
      description: 'Configuration key to set',
      required: true,
    },
    value: {
      type: 'positional',
      description: 'Value to assign',
      required: true,
    },
    global: {
      type: 'boolean',
      description: 'Set in global config instead of project config',
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'mutate',
      'admin',
      'config.set',
      { key: args.key, value: args.value },
      { command: 'config' },
    );
  },
});

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
        console.error(formatError(err));
        process.exit(err.code);
      }
      throw err;
    }
  },
});

/**
 * Root config command group.
 *
 * Configuration management — read, write, and apply presets for project
 * and global CLEO configuration.
 */
export const configCommand = defineCommand({
  meta: { name: 'config', description: 'Configuration management' },
  subCommands: {
    get: getCommand,
    set: setCommand,
    'set-preset': setPresetCommand,
    presets: presetsCommand,
    list: listCommand,
  },
});
