/**
 * CLI config command - configuration management.
 * @task T4454
 */

import { Command } from 'commander';
import { formatSuccess, formatError } from '../../core/output.js';
import { CleoError } from '../../core/errors.js';
import { loadConfig, getConfigValue } from '../../core/config.js';
import { readJson, saveJson } from '../../store/json.js';
import { getConfigPath, getGlobalConfigPath } from '../../core/paths.js';

/**
 * Set a value at a dotted path in an object (mutates).
 */
function setNestedValue(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let current: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]!;
    if (current[part] === undefined || typeof current[part] !== 'object') {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]!] = value;
}

/**
 * Parse a string value to its appropriate type.
 */
function parseValue(value: string): unknown {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null') return null;
  const num = Number(value);
  if (!isNaN(num) && value.trim() !== '') return num;
  return value;
}

export function registerConfigCommand(program: Command): void {
  const config = program
    .command('config')
    .description('Configuration management');

  config
    .command('get <key>')
    .description('Get a configuration value')
    .option('--json', 'Output in JSON format (default)')
    .action(async (key: string) => {
      try {
        const resolved = await getConfigValue<unknown>(key);
        console.log(formatSuccess({
          key,
          value: resolved.value,
          source: resolved.source,
        }));
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
    .option('--json', 'Output in JSON format (default)')
    .action(async (key: string, value: string, opts: Record<string, unknown>) => {
      try {
        const configPath = opts['global'] ? getGlobalConfigPath() : getConfigPath();
        const existing = await readJson<Record<string, unknown>>(configPath) ?? {};

        const parsedValue = parseValue(value);
        setNestedValue(existing, key, parsedValue);

        await saveJson(configPath, existing);

        console.log(formatSuccess({
          key,
          value: parsedValue,
          scope: opts['global'] ? 'global' : 'project',
        }));
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
    .option('--json', 'Output in JSON format (default)')
    .action(async () => {
      try {
        const resolved = await loadConfig();
        console.log(formatSuccess({ config: resolved }));
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });
}
