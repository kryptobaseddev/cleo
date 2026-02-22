/**
 * CLI config command - configuration management.
 * Delegates to core/config.ts for business logic.
 * @task T4454
 * @task T4795
 */

import { Command } from 'commander';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';
import { loadConfig } from '../../core/config.js';
import { formatError } from '../../core/output.js';
import { cliOutput } from '../renderers/index.js';
import { CleoError } from '../../core/errors.js';

export function registerConfigCommand(program: Command): void {
  const config = program
    .command('config')
    .description('Configuration management');

  config
    .command('get <key>')
    .description('Get a configuration value')
    .action(async (key: string) => {
      await dispatchFromCli('query', 'admin', 'config.get', { key }, { command: 'config' });
    });

  config
    .command('set <key> <value>')
    .description('Set a configuration value')
    .option('--global', 'Set in global config instead of project config')
    .action(async (key: string, value: string) => {
      await dispatchFromCli('mutate', 'admin', 'config.set', { key, value }, { command: 'config' });
    });

  // config list uses core directly — no dispatch op for listing all resolved config
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
