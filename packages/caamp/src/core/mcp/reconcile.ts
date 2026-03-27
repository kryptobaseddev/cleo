/**
 * CLEO MCP lock reconciliation
 *
 * Infers lock metadata from live config entries and backfills
 * missing lock entries for CLEO servers installed before lock tracking.
 */

import type { McpServerEntry, SourceType } from '../../types.js';
import { getInstalledProviders } from '../registry/detection.js';
import {
  CLEO_MCP_NPM_PACKAGE,
  type CleoChannel,
  extractVersionTag,
  resolveChannelFromServerName,
} from './cleo.js';
import { getTrackedMcpServers, recordMcpInstall, removeMcpFromLock } from './lock.js';
import { listMcpServers } from './reader.js';

/**
 * Lock metadata inferred from a live MCP config entry.
 *
 * @public
 */
export interface InferredLockData {
  /** The source string (package name, command, or path). */
  source: string;
  /** Classified source type. */
  sourceType: SourceType;
  /** Inferred version string, if extractable from the config. @defaultValue undefined */
  version: string | undefined;
}

/**
 * Infer lock metadata from a live MCP config entry.
 *
 * Determines source, sourceType, and version by inspecting the command and args
 * of an existing CLEO MCP server config entry.
 *
 * @remarks
 * The inference logic checks three patterns in order: (1) if any argument
 * contains the CLEO npm package name, it is classified as a `"package"` source
 * with the version extracted from the package specifier; (2) if the channel is
 * `"dev"` or the command contains path separators, it is classified as a
 * `"command"` source; (3) otherwise, the full command + args string is used as
 * a `"command"` source.
 *
 * @param config - The raw config object from the provider's config file
 * @param channel - The resolved CLEO channel (`"stable"`, `"next"`, or `"dev"`)
 * @returns Inferred lock metadata with source, sourceType, and optional version
 *
 * @example
 * ```typescript
 * const data = inferCleoLockData(
 *   { command: "npx", args: ["-y", "@cleocode/cleo-mcp@1.2.0"] },
 *   "stable",
 * );
 * // { source: "@cleocode/cleo-mcp@1.2.0", sourceType: "package", version: "1.2.0" }
 * ```
 *
 * @public
 */
export function inferCleoLockData(
  config: Record<string, unknown>,
  channel: CleoChannel,
): InferredLockData {
  const command = typeof config.command === 'string' ? config.command : '';
  const args = Array.isArray(config.args)
    ? config.args.filter((a): a is string => typeof a === 'string')
    : [];

  // Check if any arg contains the CLEO npm package → package source
  const packageArg = args.find((a) => a.includes(CLEO_MCP_NPM_PACKAGE));

  if (packageArg) {
    const version = extractVersionTag(packageArg);
    return {
      source: packageArg,
      sourceType: 'package',
      version,
    };
  }

  // Dev channel or path-based command → command source
  if (channel === 'dev' || command.includes('/') || command.includes('\\')) {
    return {
      source: command,
      sourceType: 'command',
      version: undefined,
    };
  }

  // Fallback: reconstruct from command + args
  const full = args.length > 0 ? `${command} ${args.join(' ')}` : command;
  return {
    source: full || 'unknown',
    sourceType: 'command',
    version: undefined,
  };
}

/**
 * Options for the CLEO lock reconciliation process.
 *
 * @public
 */
export interface ReconcileOptions {
  /** Specific provider IDs to scan (if omitted, scans all installed). @defaultValue undefined */
  providerIds?: string[];
  /** Whether to scan all providers. @defaultValue undefined */
  all?: boolean;
  /** Whether to scan global-scope configs. @defaultValue undefined */
  global?: boolean;
  /** Whether to scan project-scope configs. @defaultValue undefined */
  project?: boolean;
  /** Whether to remove orphaned lock entries not found in any live config. @defaultValue undefined */
  prune?: boolean;
  /** If true, report changes without writing to the lock file. @defaultValue undefined */
  dryRun?: boolean;
}

/**
 * Result of a CLEO lock reconciliation operation.
 *
 * @public
 */
export interface ReconcileResult {
  /** Entries that were backfilled into the lock file. @defaultValue [] */
  backfilled: Array<{
    serverName: string;
    channel: CleoChannel;
    scope: 'project' | 'global';
    agents: string[];
    source: string;
    sourceType: SourceType;
    version: string | undefined;
  }>;
  /** Server names that were pruned from the lock file. */
  pruned: string[];
  /** Count of entries that were already tracked in the lock file. */
  alreadyTracked: number;
  /** Errors encountered during reconciliation. */
  errors: Array<{ message: string }>;
}

/**
 * Reconcile CLEO lock entries against live config.
 *
 * 1. Scans all providers x scopes for CLEO server entries
 * 2. Identifies entries not tracked in the lock file
 * 3. Backfills missing entries via recordMcpInstall
 * 4. Optionally prunes orphaned lock entries (in lock but not in any config)
 *
 * @remarks
 * This function bridges the gap between CLEO servers installed before lock
 * tracking was introduced and the current lock file state. It scans live
 * config files across all installed providers and requested scopes, infers
 * lock metadata from the config entries, and writes missing entries to the
 * lock file. When `prune` is enabled, it also removes lock entries for
 * CLEO servers that no longer appear in any live config.
 *
 * @param options - Reconciliation options controlling scope, providers, and behavior
 * @returns Reconciliation result with backfilled entries, pruned entries, and errors
 *
 * @example
 * ```typescript
 * const result = await reconcileCleoLock({ global: true, prune: true });
 * console.log(`Backfilled: ${result.backfilled.length}, Pruned: ${result.pruned.length}`);
 * ```
 *
 * @public
 */
export async function reconcileCleoLock(options: ReconcileOptions = {}): Promise<ReconcileResult> {
  const result: ReconcileResult = {
    backfilled: [],
    pruned: [],
    alreadyTracked: 0,
    errors: [],
  };

  const lockEntries = await getTrackedMcpServers();
  const providers = getInstalledProviders();

  // Filter providers if specific ones requested
  const targetProviders = options.providerIds?.length
    ? providers.filter((p) => options.providerIds!.includes(p.id))
    : providers;

  // Determine scopes to scan
  const scopes: Array<'project' | 'global'> = [];
  if (options.global && !options.project) {
    scopes.push('global');
  } else if (options.project && !options.global) {
    scopes.push('project');
  } else {
    scopes.push('project', 'global');
  }

  // Group key: serverName + isGlobal → collected agents and config
  interface GroupEntry {
    serverName: string;
    channel: CleoChannel;
    scope: 'project' | 'global';
    agents: string[];
    config: Record<string, unknown>;
  }

  const groups = new Map<string, GroupEntry>();
  const liveCleoServerNames = new Set<string>();

  for (const scope of scopes) {
    for (const provider of targetProviders) {
      let entries: McpServerEntry[];
      try {
        entries = await listMcpServers(provider, scope);
      } catch {
        result.errors.push({
          message: `Failed to read config for ${provider.id} (${scope})`,
        });
        continue;
      }

      for (const entry of entries) {
        const channel = resolveChannelFromServerName(entry.name);
        if (!channel) continue;

        liveCleoServerNames.add(entry.name);

        const isGlobal = scope === 'global';
        const groupKey = `${entry.name}:${isGlobal ? 'global' : 'project'}`;

        if (lockEntries[entry.name] !== undefined) {
          // Check if this specific provider is already tracked
          const existing = groups.get(groupKey);
          if (!existing) {
            result.alreadyTracked++;
          }
          continue;
        }

        const existing = groups.get(groupKey);
        if (existing) {
          if (!existing.agents.includes(provider.id)) {
            existing.agents.push(provider.id);
          }
        } else {
          groups.set(groupKey, {
            serverName: entry.name,
            channel,
            scope,
            agents: [provider.id],
            config: entry.config,
          });
        }
      }
    }
  }

  // Backfill untracked entries
  for (const group of groups.values()) {
    const inferred = inferCleoLockData(group.config, group.channel);

    if (!options.dryRun) {
      try {
        await recordMcpInstall(
          group.serverName,
          inferred.source,
          inferred.sourceType,
          group.agents,
          group.scope === 'global',
          inferred.version,
        );
      } catch (err) {
        result.errors.push({
          message: `Failed to backfill ${group.serverName}: ${err instanceof Error ? err.message : String(err)}`,
        });
        continue;
      }
    }

    result.backfilled.push({
      serverName: group.serverName,
      channel: group.channel,
      scope: group.scope,
      agents: group.agents,
      source: inferred.source,
      sourceType: inferred.sourceType,
      version: inferred.version,
    });
  }

  // Prune orphaned lock entries (CLEO entries only)
  if (options.prune) {
    for (const [serverName] of Object.entries(lockEntries)) {
      const channel = resolveChannelFromServerName(serverName);
      if (!channel) continue; // Not a CLEO entry

      if (!liveCleoServerNames.has(serverName)) {
        if (!options.dryRun) {
          try {
            await removeMcpFromLock(serverName);
          } catch (err) {
            result.errors.push({
              message: `Failed to prune ${serverName}: ${err instanceof Error ? err.message : String(err)}`,
            });
            continue;
          }
        }
        result.pruned.push(serverName);
      }
    }
  }

  return result;
}
