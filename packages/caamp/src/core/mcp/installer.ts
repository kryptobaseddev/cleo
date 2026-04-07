/**
 * MCP server config installer.
 *
 * @remarks
 * Writes a single MCP server entry into a provider's config file using
 * the format-agnostic {@link writeConfig} substrate from `core/formats`.
 * The provider's `capabilities.mcp` block is the single source of
 * truth for the file path, format, and dot-notation key.
 *
 * Conflict-on-write semantics:
 *
 * - When the target server name does not yet exist in the file, the
 *   write succeeds and {@link InstallMcpServerResult.conflicted} is
 *   `false`.
 * - When the target server name already exists in the file and `force`
 *   is `false`, the installer DOES NOT write — it returns
 *   `installed: false, conflicted: true` so the caller can emit a
 *   typed conflict error envelope.
 * - When `force` is `true`, an existing entry is overwritten and the
 *   result reports `installed: true, conflicted: true` so the caller
 *   can surface the overwrite in its envelope.
 *
 * Parent directories of the resolved config path are created lazily on
 * write — see {@link writeConfig} for the per-format details.
 *
 * @packageDocumentation
 */

import type { McpServerConfig, Provider } from '../../types.js';
import { writeConfig } from '../formats/index.js';
import { debug } from '../logger.js';
import { listMcpServers, type McpScope, resolveMcpConfigPath } from './reader.js';

/**
 * Options accepted by {@link installMcpServer}.
 *
 * @public
 */
export interface InstallMcpServerOptions {
  /** Scope to write to (project|global). */
  scope: McpScope;
  /** When `true`, overwrite an existing server entry instead of failing. */
  force?: boolean;
  /** Project directory used for the `project` scope. */
  projectDir?: string;
}

/**
 * Result of an {@link installMcpServer} call.
 *
 * @remarks
 * `installed` is `true` only when the file was actually written.
 * `conflicted` is `true` whenever the target server name was already
 * present, regardless of whether the write went through (force was
 * supplied) or was suppressed (force was withheld).
 *
 * @public
 */
export interface InstallMcpServerResult {
  /** Whether the entry was written to the config file. */
  installed: boolean;
  /** Whether the target server name already existed before the call. */
  conflicted: boolean;
  /** Absolute path to the config file that was (or would have been) written. */
  sourcePath: string;
  /** Provider id the entry was written for. */
  providerId: string;
  /** Server name that was written. */
  serverName: string;
}

/**
 * Install an MCP server entry into a single provider's config file.
 *
 * @remarks
 * Resolves the provider's MCP config path for the requested scope,
 * checks for an existing entry with the same server name, and either
 * writes the new config (when no conflict, or when `force` is set) or
 * returns a non-installed conflict result.
 *
 * Throws a plain `Error` (not a `LAFSCommandError`) when the provider
 * has no MCP capability or no config path for the requested scope —
 * those are caller-side validation failures and should be caught and
 * re-thrown as typed `LAFSCommandError`s in the command layer.
 *
 * @param provider - Target provider.
 * @param serverName - Name/key for the new server entry.
 * @param config - Canonical {@link McpServerConfig} payload to write.
 * @param opts - Install options (scope, force, projectDir).
 * @returns Structured install result describing what happened.
 * @throws `Error` when the provider has no MCP capability or no
 *   project-scoped config path is available.
 *
 * @public
 */
export async function installMcpServer(
  provider: Provider,
  serverName: string,
  config: McpServerConfig,
  opts: InstallMcpServerOptions,
): Promise<InstallMcpServerResult> {
  const mcp = provider.capabilities.mcp;
  if (mcp === null) {
    throw new Error(`Provider ${provider.id} does not declare an MCP capability.`);
  }
  const configPath = resolveMcpConfigPath(provider, opts.scope, opts.projectDir);
  if (configPath === null) {
    throw new Error(
      `Provider ${provider.id} has no ${opts.scope}-scoped MCP config path available.`,
    );
  }

  debug(
    `mcp.install: ${provider.id} ${serverName} → ${configPath} (format=${mcp.configFormat}, key=${mcp.configKey})`,
  );

  const existing = await listMcpServers(provider, opts.scope, opts.projectDir);
  const conflicted = existing.some((e) => e.name === serverName);
  if (conflicted && opts.force !== true) {
    return {
      installed: false,
      conflicted: true,
      sourcePath: configPath,
      providerId: provider.id,
      serverName,
    };
  }

  await writeConfig(configPath, mcp.configFormat, mcp.configKey, serverName, config);

  return {
    installed: true,
    conflicted,
    sourcePath: configPath,
    providerId: provider.id,
    serverName,
  };
}
