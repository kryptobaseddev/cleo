/**
 * MCP server config reader.
 *
 * @remarks
 * Reads MCP server entries from a provider's per-agent config file using
 * the format-agnostic {@link readConfig} substrate from `core/formats`.
 * The provider's `capabilities.mcp` block is the single source of truth
 * for the file path, format, and dot-notation key — this module never
 * hard-codes provider-specific layout.
 *
 * Three operations are exported:
 *
 * - {@link listMcpServers} — enumerate every server entry on a single
 *   provider's config file at a given scope.
 * - {@link listAllMcpServers} — fan out across every MCP-capable
 *   provider in the registry, returning a map keyed by provider id.
 * - {@link detectMcpInstallations} — lighter-weight scan that just
 *   reports which providers currently have any MCP config files on
 *   disk (used by `caamp mcp detect`).
 *
 * @packageDocumentation
 */

import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { resolveProviderConfigPath } from '../../core/paths/standard.js';
import { getAllProviders } from '../../core/registry/providers.js';
import type { McpServerEntry, Provider } from '../../types.js';
import { readConfig } from '../formats/index.js';
import { getNestedValue } from '../formats/utils.js';
import { debug } from '../logger.js';

/**
 * Scope identifier for MCP config file resolution.
 *
 * @remarks
 * Mirrors the two-tier scope model the underlying provider config files
 * already use: `project` reads `<projectDir>/<provider.configPathProject>`
 * and `global` reads the absolute `provider.configPathGlobal` path. The
 * three-tier {@link HarnessTier} model used by the Pi extensions
 * verbs is intentionally not adopted here — MCP config files are owned
 * by individual tools and live on those tools' two-tier hierarchy, not
 * on a CleoOS-managed hub.
 *
 * @public
 */
export type McpScope = 'project' | 'global';

/**
 * Result of a single provider's MCP installation probe.
 *
 * @remarks
 * Returned by {@link detectMcpInstallations} for each provider that
 * declares an MCP capability in the registry. The `configPath` field
 * is the resolved file path the probe inspected; `exists` indicates
 * whether the file is present on disk; `serverCount` is `null` when
 * the file is missing or unparseable, otherwise the number of server
 * entries found at the dot-notation key.
 *
 * @public
 */
export interface McpDetectionEntry {
  /** Provider id (e.g. `"claude-code"`). */
  providerId: string;
  /** Human-readable provider name. */
  providerName: string;
  /** Resolved scope of the probed config file. */
  scope: McpScope;
  /** Absolute path to the provider's MCP config file. */
  configPath: string;
  /** Whether the config file exists on disk. */
  exists: boolean;
  /** Number of server entries found, or `null` when the file is missing/unparseable. */
  serverCount: number | null;
  /** ISO 8601 timestamp of the file's last modification, or `null` when the file is missing. */
  lastModified: string | null;
}

/**
 * Resolve a provider's MCP config file path for the given scope, or
 * `null` if the provider does not declare an MCP capability or the
 * scope is unsupported.
 *
 * @remarks
 * Thin wrapper over {@link resolveProviderConfigPath} that filters out
 * providers without an MCP capability up front so callers can use a
 * single null check rather than two.
 *
 * @param provider - Provider to resolve a config path for.
 * @param scope - Scope to resolve.
 * @param projectDir - Project directory used for the `project` scope.
 * @returns The absolute config file path, or `null` when unavailable.
 *
 * @example
 * ```typescript
 * const claudeCode = getProvider("claude-code")!;
 * const path = resolveMcpConfigPath(claudeCode, "project", "/tmp/app");
 * // e.g. "/tmp/app/.mcp.json"
 * ```
 *
 * @public
 */
export function resolveMcpConfigPath(
  provider: Provider,
  scope: McpScope,
  projectDir?: string,
): string | null {
  if (provider.capabilities.mcp === null) return null;
  return resolveProviderConfigPath(provider, scope, projectDir);
}

/**
 * List MCP server entries declared in a single provider's config file.
 *
 * @remarks
 * Reads the provider's MCP config file using the format-agnostic
 * {@link readConfig} substrate, walks the dot-notation
 * `provider.capabilities.mcp.configKey` to find the servers section,
 * and returns one {@link McpServerEntry} per child key.
 *
 * Returns an empty array (not an error) when:
 *
 * - the provider does not declare an MCP capability,
 * - the resolved config path is unavailable for the requested scope,
 * - the config file does not exist on disk,
 * - the config file is empty or unparseable,
 * - the config file exists but has no MCP servers section.
 *
 * "No file" is a normal state for an uninstalled tool, so callers
 * should treat the empty array as success and only escalate to an
 * error envelope when the user explicitly asked about a missing
 * provider.
 *
 * @param provider - Provider whose config file to read.
 * @param scope - Scope to resolve (project|global).
 * @param projectDir - Project directory used for the `project` scope
 *   (defaults to `process.cwd()`).
 * @returns Array of MCP server entries, or `[]` when nothing was found.
 *
 * @example
 * ```typescript
 * const provider = getProvider("claude-code")!;
 * const entries = await listMcpServers(provider, "project");
 * for (const entry of entries) {
 *   console.log(entry.name, entry.configPath);
 * }
 * ```
 *
 * @public
 */
export async function listMcpServers(
  provider: Provider,
  scope: McpScope,
  projectDir?: string,
): Promise<McpServerEntry[]> {
  const mcp = provider.capabilities.mcp;
  if (mcp === null) return [];

  const configPath = resolveMcpConfigPath(provider, scope, projectDir);
  if (configPath === null) return [];
  if (!existsSync(configPath)) {
    debug(`mcp.list: ${provider.id} (${scope}) — config file missing at ${configPath}`);
    return [];
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = await readConfig(configPath, mcp.configFormat);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    debug(`mcp.list: ${provider.id} parse failed at ${configPath}: ${message}`);
    return [];
  }

  const servers = getNestedValue(parsed, mcp.configKey);
  if (servers === undefined || servers === null || typeof servers !== 'object') return [];

  const out: McpServerEntry[] = [];
  for (const [name, raw] of Object.entries(servers as Record<string, unknown>)) {
    out.push({
      name,
      providerId: provider.id,
      providerName: provider.toolName,
      scope,
      configPath,
      config: (raw ?? {}) as Record<string, unknown>,
    });
  }
  return out;
}

/**
 * Map of provider id → MCP server entries for that provider.
 *
 * @remarks
 * Return shape of {@link listAllMcpServers}. Providers without an MCP
 * capability are intentionally absent from the map (rather than mapped
 * to an empty array) so callers can iterate the result and immediately
 * know which providers were probed.
 *
 * @public
 */
export type McpServerEntriesByProvider = Map<string, McpServerEntry[]>;

/**
 * List MCP server entries for every MCP-capable provider in the
 * registry at the given scope.
 *
 * @remarks
 * Iterates {@link getAllProviders}, filters to those with a
 * `capabilities.mcp` block, calls {@link listMcpServers} on each, and
 * collects the results into a map keyed by provider id.
 *
 * Each provider is probed independently — a parse failure on one
 * provider will not affect the others. The result map only contains
 * entries for providers that were actually probed (i.e. had an MCP
 * capability), so consumers can iterate `result.entries()` without
 * skipping non-MCP providers.
 *
 * @param scope - Scope to resolve for every provider.
 * @param projectDir - Project directory used for the `project` scope.
 * @returns Map of provider id → server entries.
 *
 * @example
 * ```typescript
 * const byProvider = await listAllMcpServers("global");
 * for (const [providerId, entries] of byProvider) {
 *   console.log(`${providerId}: ${entries.length} server(s)`);
 * }
 * ```
 *
 * @public
 */
export async function listAllMcpServers(
  scope: McpScope,
  projectDir?: string,
): Promise<McpServerEntriesByProvider> {
  const out: McpServerEntriesByProvider = new Map();
  for (const provider of getAllProviders()) {
    if (provider.capabilities.mcp === null) continue;
    const entries = await listMcpServers(provider, scope, projectDir);
    out.set(provider.id, entries);
  }
  return out;
}

/**
 * Probe every MCP-capable provider in the registry to determine which
 * ones have a config file on disk and how many servers are configured.
 *
 * @remarks
 * Lightweight detection used by `caamp mcp detect`. Unlike
 * {@link listAllMcpServers} this does not return individual server
 * entries — it just reports a count plus the file mtime so callers can
 * answer "which tools on my machine already have MCP configured?"
 * without paying the cost of materialising every server entry.
 *
 * @param scope - Scope to probe.
 * @param projectDir - Project directory used for the `project` scope.
 * @returns Array of detection entries, one per MCP-capable provider.
 *
 * @example
 * ```typescript
 * const hits = await detectMcpInstallations("project");
 * const installed = hits.filter((h) => h.exists);
 * console.log(`MCP found on ${installed.length} providers`);
 * ```
 *
 * @public
 */
export async function detectMcpInstallations(
  scope: McpScope,
  projectDir?: string,
): Promise<McpDetectionEntry[]> {
  const out: McpDetectionEntry[] = [];
  for (const provider of getAllProviders()) {
    const mcp = provider.capabilities.mcp;
    if (mcp === null) continue;
    const configPath = resolveMcpConfigPath(provider, scope, projectDir);
    if (configPath === null) continue;
    const exists = existsSync(configPath);
    let serverCount: number | null = null;
    let lastModified: string | null = null;
    if (exists) {
      try {
        const stats = await stat(configPath);
        lastModified = stats.mtime.toISOString();
      } catch {
        lastModified = null;
      }
      const entries = await listMcpServers(provider, scope, projectDir);
      serverCount = entries.length;
    }
    out.push({
      providerId: provider.id,
      providerName: provider.toolName,
      scope,
      configPath,
      exists,
      serverCount,
      lastModified,
    });
  }
  return out;
}
