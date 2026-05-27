/**
 * YAML config reader/writer
 */

import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import yaml from 'js-yaml';
import { deepMerge, ensureDir } from './utils.js';

/**
 * Read and parse a YAML config file.
 *
 * @remarks
 * Uses `js-yaml` for parsing. Returns an empty object when the file does not
 * exist or is empty.
 *
 * @param filePath - Absolute path to the YAML file
 * @returns Parsed config object
 *
 * @example
 * ```typescript
 * const config = await readYamlConfig("/path/to/config.yaml");
 * ```
 *
 * @public
 */
export async function readYamlConfig(filePath: string): Promise<Record<string, unknown>> {
  if (!existsSync(filePath)) return {};

  const content = await readFile(filePath, 'utf-8');
  if (!content.trim()) return {};

  const result = yaml.load(content);
  return (result ?? {}) as Record<string, unknown>;
}

/**
 * Write a server config entry to a YAML file.
 *
 * @remarks
 * Reads the existing file, deep-merges the new entry, and writes the entire
 * result back. Creates the file and parent directories if they do not exist.
 *
 * @param filePath - Absolute path to the YAML file
 * @param configKey - Dot-notation key path to the servers section
 * @param serverName - Name/key for the server entry
 * @param serverConfig - Server configuration object to write
 *
 * @example
 * ```typescript
 * await writeYamlConfig("/path/to/config.yaml", "mcpServers", "my-server", { command: "node" });
 * ```
 *
 * @public
 */
export async function writeYamlConfig(
  filePath: string,
  configKey: string,
  serverName: string,
  serverConfig: unknown,
): Promise<void> {
  await ensureDir(filePath);

  const existing = await readYamlConfig(filePath);

  // Build nested structure
  const keyParts = configKey.split('.');
  let newEntry: Record<string, unknown> = { [serverName]: serverConfig };

  for (const part of [...keyParts].reverse()) {
    newEntry = { [part]: newEntry };
  }

  const merged = deepMerge(existing, newEntry);

  const content = yaml.dump(merged, {
    indent: 2,
    lineWidth: -1,
    noRefs: true,
    sortKeys: false,
  });

  await writeFile(filePath, content, 'utf-8');
}

/**
 * Remove a server entry from a YAML config file.
 *
 * @remarks
 * Navigates the parsed YAML object to the config key, deletes the server
 * entry, and re-serializes the entire config.
 *
 * @param filePath - Absolute path to the YAML file
 * @param configKey - Dot-notation key path to the servers section
 * @param serverName - Name/key of the server entry to remove
 * @returns `true` if the entry was removed, `false` if the file or entry was not found
 *
 * @example
 * ```typescript
 * const removed = await removeYamlConfig("/path/to/config.yaml", "mcpServers", "old-server");
 * ```
 *
 * @public
 */
export async function removeYamlConfig(
  filePath: string,
  configKey: string,
  serverName: string,
): Promise<boolean> {
  if (!existsSync(filePath)) return false;

  const existing = await readYamlConfig(filePath);

  // Navigate to the config key
  const keyParts = configKey.split('.');
  let current: Record<string, unknown> = existing;

  for (const part of keyParts) {
    const next = current[part];
    if (typeof next !== 'object' || next === null) return false;
    current = next as Record<string, unknown>;
  }

  if (!(serverName in current)) return false;

  delete current[serverName];

  const content = yaml.dump(existing, {
    indent: 2,
    lineWidth: -1,
    noRefs: true,
    sortKeys: false,
  });

  await writeFile(filePath, content, 'utf-8');
  return true;
}
