/**
 * CLI config command - configuration management.
 * Delegates to core/config.ts for business logic.
 * @task T4454
 * @task T4795
 * @task T067
 */

import { CleoError, formatError, loadConfig } from '@cleocode/core';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';
import type { ShimCommand as Command } from '../commander-shim.js';
import { cliOutput } from '../renderers/index.js';

const PRESET_DESCRIPTIONS: Record<string, string> = {
  strict: 'Block on missing AC, require session notes, enforce lifecycle pipeline.',
  standard: 'Warn on missing AC, optional session notes, advisory lifecycle pipeline.',
  minimal: 'No AC checking, no session requirement, lifecycle pipeline off.',
};

export function registerConfigCommand(program: Command): void {
  const config = program.command('config').description('Configuration management');

  config
    .command('get <key>')
    .description('Get a configuration value')
    .action(async (key: string) => {
      await dispatchFromCli('query', 'admin', 'config.show', { key }, { command: 'config' });
    });

  config
    .command('set <key> <value>')
    .description('Set a configuration value')
    .option('--global', 'Set in global config instead of project config')
    .action(async (key: string, value: string) => {
      await dispatchFromCli('mutate', 'admin', 'config.set', { key, value }, { command: 'config' });
    });

  config
    .command('set-preset <preset>')
    .description(
      'Apply a strictness preset to the project config (strict | standard | minimal)\n\n' +
        '  strict   — ' +
        PRESET_DESCRIPTIONS['strict'] +
        '\n' +
        '  standard — ' +
        PRESET_DESCRIPTIONS['standard'] +
        '\n' +
        '  minimal  — ' +
        PRESET_DESCRIPTIONS['minimal'],
    )
    .action(async (preset: string) => {
      await dispatchFromCli(
        'mutate',
        'admin',
        'config.set-preset',
        { preset },
        { command: 'config' },
      );
    });

  config
    .command('presets')
    .description('List all available strictness presets')
    .action(async () => {
      await dispatchFromCli('query', 'admin', 'config.presets', {}, { command: 'config' });
    });

  // CLI-only: config list uses core directly, no dispatch op for listing all resolved config
  config
    .command('list')
    .description('Show all resolved configuration')
    .action(async () => {
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
    });
}
