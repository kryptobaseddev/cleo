/**
 * Provides format-agnostic config read, write, and remove operations that
 * dispatch to JSON/JSONC, YAML, or TOML handlers based on the specified
 * format.
 *
 * @packageDocumentation
 */

import type { ConfigFormat } from '../../types.js';
import { debug } from '../logger.js';
import { readJsonConfig, removeJsonConfig, writeJsonConfig } from './json.js';
import { readTomlConfig, removeTomlConfig, writeTomlConfig } from './toml.js';
import { readYamlConfig, removeYamlConfig, writeYamlConfig } from './yaml.js';

export { deepMerge, ensureDir, getNestedValue } from './utils.js';

/**
 * Read and parse a config file in the specified format.
 *
 * Dispatches to the appropriate format handler (JSON/JSONC, YAML, or TOML).
 *
 * @param filePath - Absolute path to the config file
 * @param format - Config file format
 * @returns Parsed config object
 * @throws If the file cannot be read or the format is unsupported
 *
 * @remarks
 * Supported formats: `"json"`, `"jsonc"`, `"yaml"`, `"toml"`. Throws for
 * any unrecognized format string.
 *
 * @example
 * ```typescript
 * const config = await readConfig("/path/to/config.json", "jsonc");
 * ```
 *
 * @public
 */
export async function readConfig(
  filePath: string,
  format: ConfigFormat,
): Promise<Record<string, unknown>> {
  debug(`reading config: ${filePath} (format: ${format})`);
  switch (format) {
    case 'json':
    case 'jsonc':
      return readJsonConfig(filePath);
    case 'yaml':
      return readYamlConfig(filePath);
    case 'toml':
      return readTomlConfig(filePath);
    default:
      throw new Error(`Unsupported config format: ${format as string}`);
  }
}

/**
 * Write a server entry to a config file, preserving existing content.
 *
 * Dispatches to the appropriate format handler. For JSONC files, comments are
 * preserved using `jsonc-parser`.
 *
 * @param filePath - Absolute path to the config file
 * @param format - Config file format
 * @param key - Dot-notation key path to the servers section (e.g. `"mcpServers"`)
 * @param serverName - Name/key for the server entry
 * @param serverConfig - Server configuration object to write
 * @throws If the format is unsupported
 *
 * @remarks
 * For JSONC files, comments and formatting are preserved using `jsonc-parser`.
 * For YAML and TOML, the file is fully re-serialized after deep-merging.
 *
 * @example
 * ```typescript
 * await writeConfig("/path/to/config.json", "jsonc", "mcpServers", "my-server", config);
 * ```
 *
 * @public
 */
export async function writeConfig(
  filePath: string,
  format: ConfigFormat,
  key: string,
  serverName: string,
  serverConfig: unknown,
): Promise<void> {
  debug(`writing config: ${filePath} (format: ${format}, key: ${key}, server: ${serverName})`);
  switch (format) {
    case 'json':
    case 'jsonc':
      return writeJsonConfig(filePath, key, serverName, serverConfig);
    case 'yaml':
      return writeYamlConfig(filePath, key, serverName, serverConfig);
    case 'toml':
      return writeTomlConfig(filePath, key, serverName, serverConfig);
    default:
      throw new Error(`Unsupported config format: ${format as string}`);
  }
}

/**
 * Remove a server entry from a config file in the specified format.
 *
 * @param filePath - Absolute path to the config file
 * @param format - Config file format
 * @param key - Dot-notation key path to the servers section
 * @param serverName - Name/key of the server entry to remove
 * @returns `true` if the entry was removed, `false` otherwise
 * @throws If the format is unsupported
 *
 * @remarks
 * Delegates to the format-specific removal function. Returns `false` when the
 * file does not exist or the entry is not found.
 *
 * @example
 * ```typescript
 * const removed = await removeConfig("/path/to/config.json", "jsonc", "mcpServers", "my-server");
 * ```
 *
 * @public
 */
export async function removeConfig(
  filePath: string,
  format: ConfigFormat,
  key: string,
  serverName: string,
): Promise<boolean> {
  switch (format) {
    case 'json':
    case 'jsonc':
      return removeJsonConfig(filePath, key, serverName);
    case 'yaml':
      return removeYamlConfig(filePath, key, serverName);
    case 'toml':
      return removeTomlConfig(filePath, key, serverName);
    default:
      throw new Error(`Unsupported config format: ${format as string}`);
  }
}
