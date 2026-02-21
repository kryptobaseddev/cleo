/**
 * CLI config command - configuration management.
 * Delegates to core/config.ts for business logic.
 * @task T4454
 * @task T4795
 */

import { Command } from 'commander';
import { formatError } from '../../core/output.js';
import { cliOutput } from '../renderers/index.js';
import { CleoError } from '../../core/errors.js';
import { loadConfig, getConfigValue, setConfigValue } from '../../core/config.js';

export function registerConfigCommand(program: Command): void {
  const config = program
    .command('config')
    .description('Configuration management');

  config
    .command('get <key>')
    .description('Get a configuration value')
    .action(async (key: string) => {
      try {
        const resolved = await getConfigValue<unknown>(key);
        cliOutput({
          key,
          value: resolved.value,
          source: resolved.source,
        }, { command: 'config' });
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });

  config
    .command('set <key> <value>')
    .description('Set a configuration value')
    .option('--global', 'Set in global config instead of project config')
    .action(async (key: string, value: string, opts: Record<string, unknown>) => {
      try {
        const result = await setConfigValue(key, value, undefined, {
          global: !!opts['global'],
        });

        cliOutput({
          key: result.key,
          value: result.value,
          scope: result.scope,
        }, { command: 'config' });
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });

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
