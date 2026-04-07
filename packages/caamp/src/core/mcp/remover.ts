/**
 * MCP server config remover.
 *
 * @remarks
 * Removes a single MCP server entry from a provider's config file
 * using the format-agnostic {@link removeConfig} substrate from
 * `core/formats`. The provider's `capabilities.mcp` block is the
 * single source of truth for the file path, format, and dot-notation
 * key.
 *
 * Both single-provider and all-providers variants are exported. Both
 * are idempotent: removing a server that does not exist returns
 * `removed: false` rather than throwing.
 *
 * @packageDocumentation
 */

import { existsSync } from 'node:fs';
import { getAllProviders } from '../../core/registry/providers.js';
import type { Provider } from '../../types.js';
import { removeConfig } from '../formats/index.js';
import { debug } from '../logger.js';
import { type McpScope, resolveMcpConfigPath } from './reader.js';

/**
 * Options accepted by {@link removeMcpServer} and
 * {@link removeMcpServerFromAll}.
 *
 * @public
 */
export interface RemoveMcpServerOptions {
  /** Scope to target (project|global). */
  scope: McpScope;
  /** Project directory used for the `project` scope. */
  projectDir?: string;
}

/**
 * Result of a single-provider {@link removeMcpServer} call.
 *
 * @remarks
 * `removed` is `true` only when an entry was actually deleted from
 * the file. The `reason` field carries an optional discriminator when
 * the call was a no-op so the command layer can surface a precise
 * envelope (e.g. "no config file" vs "entry not present").
 *
 * @public
 */
export interface RemoveMcpServerResult {
  /** Provider id the call targeted. */
  providerId: string;
  /** Server name the call targeted. */
  serverName: string;
  /** Resolved config file path, or `null` when the provider had no MCP capability. */
  sourcePath: string | null;
  /** Whether an entry was actually deleted. */
  removed: boolean;
  /**
   * Diagnostic discriminator when `removed` is `false`.
   *
   * - `"no-mcp-capability"` — provider does not consume MCP servers
   * - `"no-config-path"` — provider has no config path for the scope
   * - `"file-missing"` — config file does not exist on disk
   * - `"entry-missing"` — config file exists but had no matching entry
   *
   * Set to `null` when `removed` is `true`.
   */
  reason:
    | 'no-mcp-capability'
    | 'no-config-path'
    | 'file-missing'
    | 'entry-missing'
    | null;
}

/**
 * Remove an MCP server entry from a single provider's config file.
 *
 * @remarks
 * Idempotent: when the entry is not present (or the file is missing
 * entirely) the call returns `removed: false` with a structured
 * `reason` rather than throwing.
 *
 * @param provider - Provider whose config file to modify.
 * @param serverName - Server name/key to remove.
 * @param opts - Removal options.
 * @returns Structured result describing whether the entry was removed.
 *
 * @public
 */
export async function removeMcpServer(
  provider: Provider,
  serverName: string,
  opts: RemoveMcpServerOptions,
): Promise<RemoveMcpServerResult> {
  const mcp = provider.capabilities.mcp;
  if (mcp === null) {
    return {
      providerId: provider.id,
      serverName,
      sourcePath: null,
      removed: false,
      reason: 'no-mcp-capability',
    };
  }
  const configPath = resolveMcpConfigPath(provider, opts.scope, opts.projectDir);
  if (configPath === null) {
    return {
      providerId: provider.id,
      serverName,
      sourcePath: null,
      removed: false,
      reason: 'no-config-path',
    };
  }
  if (!existsSync(configPath)) {
    return {
      providerId: provider.id,
      serverName,
      sourcePath: configPath,
      removed: false,
      reason: 'file-missing',
    };
  }
  debug(`mcp.remove: ${provider.id} ${serverName} → ${configPath}`);
  const removed = await removeConfig(configPath, mcp.configFormat, mcp.configKey, serverName);
  return {
    providerId: provider.id,
    serverName,
    sourcePath: configPath,
    removed,
    reason: removed ? null : 'entry-missing',
  };
}

/**
 * Remove an MCP server entry from every MCP-capable provider in the
 * registry that currently has it configured.
 *
 * @remarks
 * Iterates {@link getAllProviders}, calls {@link removeMcpServer} on
 * each MCP-capable provider, and collects the per-provider results.
 * Each provider is processed independently — a failure on one does
 * not abort the others. The result array contains one entry per
 * MCP-capable provider, even when the entry was not present (so
 * callers can render a complete report).
 *
 * @param serverName - Server name/key to remove from every provider.
 * @param opts - Removal options applied uniformly to every provider.
 * @returns Array of per-provider removal results.
 *
 * @public
 */
export async function removeMcpServerFromAll(
  serverName: string,
  opts: RemoveMcpServerOptions,
): Promise<RemoveMcpServerResult[]> {
  const out: RemoveMcpServerResult[] = [];
  for (const provider of getAllProviders()) {
    if (provider.capabilities.mcp === null) continue;
    out.push(await removeMcpServer(provider, serverName, opts));
  }
  return out;
}
