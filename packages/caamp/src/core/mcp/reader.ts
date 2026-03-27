/**
 * MCP config reader
 *
 * Reads, lists, and removes MCP server entries from agent config files.
 * Provides the programmatic API that CLI commands delegate to.
 */

import { existsSync } from 'node:fs';
import type { McpServerEntry, Provider } from '../../types.js';
import { readConfig, removeConfig } from '../formats/index.js';
import { getNestedValue } from '../formats/utils.js';
import { debug } from '../logger.js';
import { getAgentsMcpServersPath, resolveProviderConfigPath } from '../paths/standard.js';

/**
 * Resolve the absolute config file path for a provider and scope.
 *
 * For project scope, joins the project directory with the provider's relative
 * config path. For global scope, returns the provider's global config path.
 *
 * @remarks
 * Delegates to {@link resolveProviderConfigPath} from the paths module.
 * Returns `null` when the provider has no config path defined for the
 * requested scope (e.g. some providers only support global config).
 *
 * @param provider - Provider to resolve config path for
 * @param scope - Whether to resolve project or global config path
 * @param projectDir - Project directory (defaults to `process.cwd()`)
 * @returns Absolute config file path, or `null` if the provider does not support the given scope
 *
 * @example
 * ```typescript
 * const provider = getProvider("claude-code")!;
 * const path = resolveConfigPath(provider, "project", "/home/user/my-project");
 * // Returns provider-specific project config path
 * ```
 *
 * @public
 */
export function resolveConfigPath(
  provider: Provider,
  scope: 'project' | 'global',
  projectDir?: string,
): string | null {
  return resolveProviderConfigPath(provider, scope, projectDir ?? process.cwd());
}

/**
 * List MCP servers configured for a single provider.
 *
 * Reads the provider's config file, extracts the MCP servers section using the
 * provider's `configKey`, and returns each server entry with metadata.
 *
 * @remarks
 * The config file is read using the format handler matching the provider's
 * `configFormat` (JSON, YAML, or TOML). The `configKey` is used to extract
 * the MCP servers section (e.g. `"mcpServers"`, `"mcp_servers"`, `"extensions"`).
 * Returns an empty array if the file does not exist or cannot be parsed.
 *
 * @param provider - Provider whose config file to read
 * @param scope - Whether to read project or global config
 * @param projectDir - Project directory (defaults to `process.cwd()`)
 * @returns Array of MCP server entries found in the config file
 *
 * @example
 * ```typescript
 * const provider = getProvider("claude-code")!;
 * const servers = await listMcpServers(provider, "project", "/home/user/my-project");
 * for (const s of servers) {
 *   console.log(`${s.name} (${s.scope})`);
 * }
 * ```
 *
 * @public
 */
export async function listMcpServers(
  provider: Provider,
  scope: 'project' | 'global',
  projectDir?: string,
): Promise<McpServerEntry[]> {
  const configPath = resolveConfigPath(provider, scope, projectDir);
  debug(`listing MCP servers for ${provider.id} (${scope}) at ${configPath ?? '(none)'}`);
  if (!configPath || !existsSync(configPath)) return [];

  try {
    const config = await readConfig(configPath, provider.configFormat);
    const servers = getNestedValue(config, provider.configKey);

    if (!servers || typeof servers !== 'object') return [];

    const entries: McpServerEntry[] = [];
    for (const [name, cfg] of Object.entries(servers as Record<string, unknown>)) {
      entries.push({
        name,
        providerId: provider.id,
        providerName: provider.toolName,
        scope,
        configPath,
        config: (cfg ?? {}) as Record<string, unknown>,
      });
    }

    return entries;
  } catch {
    return [];
  }
}

/**
 * List MCP servers from the `.agents/mcp/servers.json` standard location.
 *
 * Per the `.agents/` standard (Section 9), this file is the canonical
 * provider-agnostic MCP server registry. It should be checked before
 * per-provider legacy config files.
 *
 * @remarks
 * The `.agents/mcp/servers.json` file uses a `{ "servers": { ... } }` structure
 * where each key is a server name. Entries returned from this function use
 * `providerId: ".agents"` and `providerName: ".agents/ standard"` to distinguish
 * them from per-provider legacy entries.
 *
 * @param scope - `"global"` for `~/.agents/mcp/servers.json`, `"project"` for project-level
 * @param projectDir - Project directory (defaults to `process.cwd()`)
 * @returns Array of MCP server entries found in the `.agents/` servers.json
 *
 * @example
 * ```typescript
 * const globalServers = await listAgentsMcpServers("global");
 * const projectServers = await listAgentsMcpServers("project", "/home/user/my-project");
 * console.log(`Found ${globalServers.length} global, ${projectServers.length} project servers`);
 * ```
 *
 * @public
 */
export async function listAgentsMcpServers(
  scope: 'project' | 'global',
  projectDir?: string,
): Promise<McpServerEntry[]> {
  const serversPath = getAgentsMcpServersPath(scope, projectDir);
  debug(`listing .agents/ MCP servers (${scope}) at ${serversPath}`);

  if (!existsSync(serversPath)) return [];

  try {
    const config = await readConfig(serversPath, 'json');
    // .agents/mcp/servers.json uses { "servers": { "<name>": { ... } } }
    const servers = (config as Record<string, unknown>)['servers'];

    if (!servers || typeof servers !== 'object') return [];

    const entries: McpServerEntry[] = [];
    for (const [name, cfg] of Object.entries(servers as Record<string, unknown>)) {
      entries.push({
        name,
        providerId: '.agents',
        providerName: '.agents/ standard',
        scope,
        configPath: serversPath,
        config: (cfg ?? {}) as Record<string, unknown>,
      });
    }

    return entries;
  } catch {
    return [];
  }
}

/**
 * List MCP servers across all given providers, deduplicating by config path.
 *
 * Per the `.agents/` standard (Section 9.4), checks `.agents/mcp/servers.json`
 * first, then falls back to per-provider legacy config files. Multiple providers
 * may share the same config file; this function ensures each config file is read
 * only once to avoid duplicate entries.
 *
 * @remarks
 * The deduplication is path-based: if two providers share the same config file
 * (resolved to the same absolute path), it is read only once. The `.agents/`
 * standard location is always checked first and takes precedence.
 *
 * @param providers - Array of providers to query
 * @param scope - Whether to read project or global config
 * @param projectDir - Project directory (defaults to `process.cwd()`)
 * @returns Combined array of MCP server entries from all providers
 *
 * @example
 * ```typescript
 * const installed = getInstalledProviders();
 * const allServers = await listAllMcpServers(installed, "global", "/home/user/my-project");
 * console.log(`Found ${allServers.length} servers across all providers`);
 * ```
 *
 * @public
 */
export async function listAllMcpServers(
  providers: Provider[],
  scope: 'project' | 'global',
  projectDir?: string,
): Promise<McpServerEntry[]> {
  const seen = new Set<string>();
  const allEntries: McpServerEntry[] = [];

  // Check .agents/mcp/servers.json first (standard takes precedence)
  const agentsServersPath = getAgentsMcpServersPath(scope, projectDir);
  const agentsEntries = await listAgentsMcpServers(scope, projectDir);
  if (agentsEntries.length > 0) {
    allEntries.push(...agentsEntries);
    seen.add(agentsServersPath);
  }

  // Then check per-provider legacy config files
  for (const provider of providers) {
    const configPath = resolveConfigPath(provider, scope, projectDir);
    if (!configPath || seen.has(configPath)) continue;
    seen.add(configPath);

    const entries = await listMcpServers(provider, scope, projectDir);
    allEntries.push(...entries);
  }

  return allEntries;
}

/**
 * Remove an MCP server entry from a provider's config file.
 *
 * @remarks
 * Delegates to the format-specific `removeConfig` handler. If the provider
 * does not have a config path for the requested scope, returns `false`
 * without modifying any files.
 *
 * @param provider - Provider whose config file to modify
 * @param serverName - Name/key of the MCP server to remove
 * @param scope - Whether to modify project or global config
 * @param projectDir - Project directory (defaults to `process.cwd()`)
 * @returns `true` if the entry was removed, `false` if no config path exists
 *
 * @example
 * ```typescript
 * const provider = getProvider("claude-code")!;
 * const removed = await removeMcpServer(provider, "my-server", "project", "/home/user/my-project");
 * ```
 *
 * @public
 */
export async function removeMcpServer(
  provider: Provider,
  serverName: string,
  scope: 'project' | 'global',
  projectDir?: string,
): Promise<boolean> {
  const configPath = resolveConfigPath(provider, scope, projectDir);
  if (!configPath) return false;

  return removeConfig(configPath, provider.configFormat, provider.configKey, serverName);
}
