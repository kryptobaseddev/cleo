/**
 * MCP config installer
 *
 * Writes MCP server configurations to agent config files,
 * handling per-agent formats, keys, and transformations.
 */

import type { McpServerConfig, Provider } from '../../types.js';
import { writeConfig } from '../formats/index.js';
import { debug } from '../logger.js';
import { resolveConfigPath } from './reader.js';
import { getTransform } from './transforms.js';

/**
 * Result of installing an MCP server configuration to a single provider.
 *
 * @example
 * ```typescript
 * const provider = getProvider("claude-code")!;
 * const result = await installMcpServer(provider, "my-server", {
 *   command: "npx",
 *   args: ["-y", "@modelcontextprotocol/server-filesystem"],
 * });
 * if (result.success) {
 *   console.log(`Written to ${result.configPath}`);
 * }
 * ```
 *
 * @public
 */
export interface InstallResult {
  /** The provider the config was written to. */
  provider: Provider;
  /** Whether project or global scope was used. */
  scope: 'project' | 'global';
  /** Absolute path to the config file that was written. */
  configPath: string;
  /** Whether the write succeeded. */
  success: boolean;
  /** Error message if the write failed. @defaultValue undefined */
  error?: string;
}

/** Build the config to write, applying transforms if needed */
function buildConfig(provider: Provider, serverName: string, config: McpServerConfig): unknown {
  const transform = getTransform(provider.id);
  if (transform) {
    return transform(serverName, config);
  }
  return config;
}

/**
 * Install an MCP server configuration for a single provider.
 *
 * Applies provider-specific transforms (e.g. Goose, Zed, Codex) and writes
 * the config to the provider's config file in the specified scope.
 *
 * @remarks
 * The installation flow is: resolve config path, apply any provider-specific
 * transform via {@link getTransform}, then write the result using the
 * provider's config format (JSON, YAML, or TOML). If the provider does not
 * support the requested scope, a failed result is returned without throwing.
 *
 * @param provider - Target provider to write config for
 * @param serverName - Name/key for the MCP server entry
 * @param config - Canonical MCP server configuration
 * @param scope - Whether to write to project or global config (default: `"project"`)
 * @param projectDir - Project directory path (defaults to `process.cwd()`)
 * @returns Install result with success status and config path
 *
 * @example
 * ```typescript
 * const provider = getProvider("claude-code")!;
 * const result = await installMcpServer(provider, "filesystem", {
 *   command: "npx",
 *   args: ["-y", "@modelcontextprotocol/server-filesystem"],
 * }, "project", "/home/user/my-project");
 * ```
 *
 * @public
 */
export async function installMcpServer(
  provider: Provider,
  serverName: string,
  config: McpServerConfig,
  scope: 'project' | 'global' = 'project',
  projectDir?: string,
): Promise<InstallResult> {
  const configPath = resolveConfigPath(provider, scope, projectDir);

  debug(`installing MCP server "${serverName}" for ${provider.id} (${scope})`);
  debug(`  config path: ${configPath ?? '(none)'}`);

  if (!configPath) {
    return {
      provider,
      scope,
      configPath: '',
      success: false,
      error: `Provider ${provider.id} does not support ${scope} config`,
    };
  }

  try {
    const transformedConfig = buildConfig(provider, serverName, config);
    const transform = getTransform(provider.id);
    debug(`  transform applied: ${transform ? 'yes' : 'no'}`);

    await writeConfig(
      configPath,
      provider.configFormat,
      provider.configKey,
      serverName,
      transformedConfig,
    );

    return {
      provider,
      scope,
      configPath,
      success: true,
    };
  } catch (err) {
    return {
      provider,
      scope,
      configPath,
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Install an MCP server configuration to multiple providers.
 *
 * Calls {@link installMcpServer} for each provider sequentially and collects results.
 *
 * @remarks
 * Providers are processed sequentially (not in parallel) to avoid concurrent
 * writes to shared config files. Each provider's result is independent --
 * a failure for one provider does not prevent installation to others.
 *
 * @param providers - Array of target providers
 * @param serverName - Name/key for the MCP server entry
 * @param config - Canonical MCP server configuration
 * @param scope - Whether to write to project or global config (default: `"project"`)
 * @param projectDir - Project directory path (defaults to `process.cwd()`)
 * @returns Array of install results, one per provider
 *
 * @example
 * ```typescript
 * const providers = getInstalledProviders();
 * const config = { command: "npx", args: ["-y", "@mcp/server"] };
 * const results = await installMcpServerToAll(providers, "my-server", config, "project", "/home/user/project");
 * const successes = results.filter(r => r.success);
 * ```
 *
 * @see {@link installMcpServer}
 *
 * @public
 */
export async function installMcpServerToAll(
  providers: Provider[],
  serverName: string,
  config: McpServerConfig,
  scope: 'project' | 'global' = 'project',
  projectDir?: string,
): Promise<InstallResult[]> {
  const results: InstallResult[] = [];

  for (const provider of providers) {
    const result = await installMcpServer(provider, serverName, config, scope, projectDir);
    results.push(result);
  }

  return results;
}

/**
 * Build a canonical {@link McpServerConfig} from a parsed source.
 *
 * Maps source types to appropriate transport configurations:
 * - `"remote"` sources become HTTP/SSE configs with a `url`
 * - `"package"` sources become `npx -y <package>` stdio configs
 * - All others are treated as shell commands split into `command` + `args`
 *
 * @remarks
 * This function normalizes diverse source inputs into the canonical config
 * format that CAAMP uses internally. Provider-specific transforms are applied
 * later during installation via {@link getTransform}. Command-type sources
 * are split on whitespace, with the first token becoming `command` and the
 * remainder becoming `args`.
 *
 * @param source - Parsed source with `type` and `value`
 * @param transport - Override transport type for remote sources (default: `"http"`)
 * @param headers - Optional HTTP headers for remote servers
 * @returns Canonical MCP server configuration
 *
 * @example
 * ```typescript
 * buildServerConfig({ type: "package", value: "@mcp/server-fs" }, undefined, undefined);
 * // { command: "npx", args: ["-y", "@mcp/server-fs"] }
 *
 * buildServerConfig({ type: "remote", value: "https://mcp.example.com" }, "http", { "Authorization": "Bearer token" });
 * // { type: "http", url: "https://mcp.example.com", headers: { "Authorization": "Bearer token" } }
 * ```
 *
 * @see {@link installMcpServer}
 *
 * @public
 */
export function buildServerConfig(
  source: { type: string; value: string },
  transport?: string,
  headers?: Record<string, string>,
): McpServerConfig {
  if (source.type === 'remote') {
    return {
      type: (transport ?? 'http') as 'sse' | 'http',
      url: source.value,
      ...(headers && Object.keys(headers).length > 0 ? { headers } : {}),
    };
  }

  if (source.type === 'package') {
    return {
      command: 'npx',
      args: ['-y', source.value],
    };
  }

  // Command type - split into command and args
  const parts = source.value.trim().split(/\s+/);
  const command = parts[0] ?? source.value;
  return {
    command,
    args: parts.slice(1),
  };
}
