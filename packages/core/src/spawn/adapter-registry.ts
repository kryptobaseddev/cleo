/**
 * Spawn Adapter Registry
 *
 * Registry to manage multiple spawn adapters for different providers.
 * Provides adapter lookup by ID, by provider, and filtering by capability.
 *
 * Delegates to adapter packages in packages/adapters/ via bridge adapters
 * that map between CLEOSpawnAdapter and AdapterSpawnProvider interfaces.
 *
 * @task T5236
 * @task T14357 — the bridge forwards and enforces the lead tool strip
 * @phase 1C
 */

import { pathToFileURL } from 'node:url';
import {
  getProvidersBySpawnCapability,
  getSpawnCapableProviders,
  type Provider,
  providerSupportsById,
} from '@cleocode/caamp';
import type {
  AdapterSpawnProvider,
  CLEOSpawnAdapter,
  CLEOSpawnContext,
  CLEOSpawnResult,
  LeadDeniedTool,
  SpawnContext,
  SpawnResult,
} from '@cleocode/contracts';
import { E_LEAD_TOOLS_UNSTRIPPED, ExitCode } from '@cleocode/contracts/exit-codes.js';
import { getProjectRoot } from '../paths.js';

/**
 * Spawn capability type - subset of provider capabilities related to spawning
 */
export type SpawnCapability =
  | 'supportsSubagents'
  | 'supportsProgrammaticSpawn'
  | 'supportsInterAgentComms'
  | 'supportsParallelSpawn';

/**
 * Registry to manage spawn adapters.
 *
 * Maintains mappings between adapter IDs, provider IDs, and adapter instances.
 * Supports registration, lookup, and capability-based filtering.
 */
export class SpawnAdapterRegistry {
  /** Map of adapter ID to adapter instance */
  private adapters: Map<string, CLEOSpawnAdapter> = new Map();

  /** Map of provider ID to adapter ID */
  private providerAdapters: Map<string, string> = new Map();

  /**
   * Register an adapter with the registry.
   *
   * @param adapter - The adapter instance to register
   */
  register(adapter: CLEOSpawnAdapter): void {
    this.adapters.set(adapter.id, adapter);
    this.providerAdapters.set(adapter.providerId, adapter.id);
  }

  /**
   * Get an adapter by its unique ID.
   *
   * @param adapterId - The adapter identifier
   * @returns The adapter instance, or undefined if not found
   */
  get(adapterId: string): CLEOSpawnAdapter | undefined {
    return this.adapters.get(adapterId);
  }

  /**
   * Get the adapter registered for a specific provider.
   *
   * @param providerId - The provider identifier
   * @returns The adapter instance, or undefined if no adapter is registered for this provider
   */
  getForProvider(providerId: string): CLEOSpawnAdapter | undefined {
    const adapterId = this.providerAdapters.get(providerId);
    return adapterId ? this.adapters.get(adapterId) : undefined;
  }

  /**
   * Check if an adapter is registered for a given provider.
   *
   * @param providerId - The provider identifier
   * @returns True if an adapter exists for the provider
   */
  hasAdapterForProvider(providerId: string): boolean {
    return this.providerAdapters.has(providerId);
  }

  /**
   * List all registered adapters.
   *
   * @returns Array of all registered adapter instances
   */
  list(): CLEOSpawnAdapter[] {
    return Array.from(this.adapters.values());
  }

  /**
   * List adapters for providers that have spawn capability.
   *
   * Queries CAAMP for spawn-capable providers and returns the
   * corresponding registered adapters.
   *
   * @returns Promise resolving to array of spawn-capable adapters
   */
  async listSpawnCapable(): Promise<CLEOSpawnAdapter[]> {
    await initializeDefaultAdapters();
    const providers = getSpawnCapableProviders();
    return providers
      .filter((p: Provider) => providerSupportsById(p.id, 'spawn.supportsSubagents'))
      .map((p: Provider) => this.getForProvider(p.id))
      .filter((a: CLEOSpawnAdapter | undefined): a is CLEOSpawnAdapter => a !== undefined);
  }

  /**
   * Check if a provider can spawn subagents.
   *
   * Uses providerSupportsById to check if the provider supports
   * the spawn.supportsSubagents capability.
   *
   * @param providerId - The provider identifier
   * @returns True if the provider supports spawning
   */
  async canProviderSpawn(providerId: string): Promise<boolean> {
    await initializeDefaultAdapters();
    return providerSupportsById(providerId, 'spawn.supportsSubagents');
  }

  /**
   * Clear all adapter registrations.
   *
   * Removes all adapters and provider mappings from the registry.
   */
  clear(): void {
    this.adapters.clear();
    this.providerAdapters.clear();
  }
}

/**
 * Get providers by specific spawn capability
 *
 * Queries CAAMP for providers that support a specific spawn capability.
 *
 * @param capability - The spawn capability to filter by
 * @returns Array of providers with the specified capability
 */
export function getProvidersWithSpawnCapability(capability: SpawnCapability): Provider[] {
  return getProvidersBySpawnCapability(capability);
}

/**
 * Check if any provider supports parallel spawn
 *
 * @returns True if at least one provider supports parallel spawn
 */
export function hasParallelSpawnProvider(): boolean {
  return getProvidersWithSpawnCapability('supportsParallelSpawn').length > 0;
}

/**
 * Singleton registry instance.
 *
 * Use this instance for all spawn adapter registration and lookup operations.
 */
export const spawnRegistry = new SpawnAdapterRegistry();

const spawnAdapterFailures = new Map<string, string>();

/**
 * Thrown by the spawn bridge when a lead spawn reaches a provider that does
 * not declare `leadToolStrip: 'enforced'`. An absent declaration counts as
 * unsupported, so a provider that never opted in fails closed.
 *
 * @task T14357
 */
export class LeadToolsUnstrippedError extends Error {
  /** Stable LAFS error code string for envelope emission. */
  readonly code = E_LEAD_TOOLS_UNSTRIPPED;
  /** Numeric exit code aligned with {@link ExitCode.SPAWN_VALIDATION_FAILED} (63). */
  readonly exitCode: ExitCode = ExitCode.SPAWN_VALIDATION_FAILED;

  /**
   * @param providerId - Provider that refused the lead spawn.
   * @param deniedTools - Tools the lead had to lose.
   */
  constructor(
    public readonly providerId: string,
    public readonly deniedTools: readonly LeadDeniedTool[],
  ) {
    super(
      `${E_LEAD_TOOLS_UNSTRIPPED}: provider '${providerId}' does not enforce the lead tool ` +
        `strip [${deniedTools.join(', ')}]. Spawn the lead on a provider that does ` +
        `(claude-code, claude-sdk) or turn off orchestrate.leadWorker.v1.`,
    );
    this.name = 'LeadToolsUnstrippedError';
  }
}

/**
 * Bridge an AdapterSpawnProvider (from packages/adapters/) to CLEOSpawnAdapter.
 *
 * Maps between the contracts-based SpawnContext/SpawnResult types and the
 * CLEO-specific CLEOSpawnContext/CLEOSpawnResult types used by the orchestrate
 * engine and spawn registry. A lead spawn (non-empty `leadDeniedTools`) is
 * forwarded to the delegate only when it declares `leadToolStrip: 'enforced'`;
 * otherwise it is refused here, before the delegate runs (T14357).
 *
 * @param providerId - Provider identifier (e.g. 'claude-code', 'opencode')
 * @param delegate - The underlying AdapterSpawnProvider instance
 * @returns A CLEOSpawnAdapter wrapping the delegate
 */
export function bridgeSpawnAdapter(
  providerId: string,
  delegate: AdapterSpawnProvider,
): CLEOSpawnAdapter {
  return {
    id: providerId,
    providerId,

    canSpawn(): Promise<boolean> {
      return delegate.canSpawn();
    },

    async spawn(context: CLEOSpawnContext): Promise<CLEOSpawnResult> {
      const denied = context.leadDeniedTools;
      const isLead = denied !== undefined && denied.length > 0;
      if (
        isLead &&
        (delegate.leadToolStrip !== 'enforced' ||
          (context.leadTerminalLauncher && providerId !== 'claude-code'))
      ) {
        // @sync-invariant none:input-shape a lead spawn on a provider that cannot strip its tools is refused before anything runs
        throw new LeadToolsUnstrippedError(providerId, denied);
      }
      const contractContext: SpawnContext = {
        taskId: context.taskId,
        prompt: context.prompt,
        workingDirectory: context.workingDirectory,
        options: context.options,
        ...(context.workerSession ? { workerSession: context.workerSession } : {}),
        ...(context.coordinatorSessionId
          ? { coordinatorSessionId: context.coordinatorSessionId }
          : {}),
        ...(context.protocolResolution ? { protocolResolution: context.protocolResolution } : {}),
        ...(isLead ? { leadDeniedTools: denied } : {}),
        ...(isLead && context.onLeadStarted ? { onLeadStarted: context.onLeadStarted } : {}),
        ...(isLead && context.leadTerminalLauncher
          ? { leadTerminalLauncher: context.leadTerminalLauncher }
          : {}),
      };
      const result: SpawnResult = await delegate.spawn(contractContext);
      return {
        instanceId: result.instanceId,
        output: result.output ?? '',
        exitCode: result.exitCode ?? 0,
        status: result.status as CLEOSpawnResult['status'],
        taskId: result.taskId,
        providerId: result.providerId,
        timing: {
          startTime: result.startTime,
          endTime: result.endTime,
        },
        // T14359 — the worker record stores the pid/pgid of a detached worker.
        ...(result.ownership ? { ownership: result.ownership } : {}),
        // T14423 — which MCP servers a lead loaded.
        ...(result.leadMcp ? { leadMcp: result.leadMcp } : {}),
        ...(result.leadTempDir ? { leadTempDir: result.leadTempDir } : {}),
        ...(result.leadTerminal ? { leadTerminal: result.leadTerminal } : {}),
      };
    },

    async listRunning(): Promise<CLEOSpawnResult[]> {
      const results: SpawnResult[] = await delegate.listRunning();
      return results.map((r) => ({
        instanceId: r.instanceId,
        output: r.output ?? '',
        exitCode: r.exitCode ?? 0,
        status: r.status as CLEOSpawnResult['status'],
        taskId: r.taskId,
        providerId: r.providerId,
        timing: {
          startTime: r.startTime,
          endTime: r.endTime,
        },
      }));
    },

    terminate(instanceId: string): Promise<void> {
      return delegate.terminate(instanceId);
    },
  };
}

/**
 * Initialize spawn adapters dynamically from discovered adapter manifests.
 *
 * Scans all discovered manifests for adapters with `capabilities.supportsSpawn`,
 * dynamically imports their spawn provider, and bridges it into the spawn registry.
 *
 * Zero hardcoded adapter names — everything derives from manifests.
 *
 * @param manifests - Discovered adapter manifests (from AdapterManager.discover())
 * @returns Promise that resolves when initialization is complete
 */
export async function initializeSpawnAdapters(
  manifests: import('@cleocode/contracts').AdapterManifest[],
): Promise<void> {
  for (const manifest of manifests) {
    if (!manifest.capabilities?.supportsSpawn) continue;
    if (spawnRegistry.hasAdapterForProvider(manifest.provider)) continue;

    spawnAdapterFailures.delete(manifest.provider);
    try {
      const { join } = await import('node:path');
      const modulePath = join(manifest.packagePath, manifest.entryPoint);
      const adapterModule = await import(pathToFileURL(modulePath).href);

      // Look for an exported spawn provider class — convention: <Name>SpawnProvider
      let SpawnProviderClass: (new () => AdapterSpawnProvider) | undefined;
      for (const [exportName, exportValue] of Object.entries(adapterModule)) {
        if (exportName.endsWith('SpawnProvider') && typeof exportValue === 'function') {
          SpawnProviderClass = exportValue as new () => AdapterSpawnProvider;
          break;
        }
      }

      if (SpawnProviderClass) {
        const provider = new SpawnProviderClass();
        spawnRegistry.register(bridgeSpawnAdapter(manifest.provider, provider));
      } else {
        spawnAdapterFailures.set(manifest.provider, 'module exports no SpawnProvider');
      }
    } catch (error) {
      spawnAdapterFailures.set(
        manifest.provider,
        `spawn provider could not load: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

/**
 * Initialize the registry with default adapters.
 *
 * Discovers adapters shipped with the CLI, plus optional project adapters,
 * and delegates to initializeSpawnAdapters().
 *
 * @returns Promise that resolves when initialization is complete
 */
export async function initializeDefaultAdapters(): Promise<void> {
  const { discoverAdapterManifests } = await import('../adapters/discovery.js');
  const manifests = discoverAdapterManifests(getProjectRoot());
  await initializeSpawnAdapters(manifests);
}

/**
 * Explain the discovered adapters and how to select one after a spawn refusal.
 * Includes load failures, capability mismatches and runtime availability.
 */
export async function getSpawnAdapterFix(
  capabilities: readonly SpawnCapability[] = ['supportsSubagents'],
): Promise<string> {
  const { discoverAdapterManifests } = await import('../adapters/discovery.js');
  const manifests = discoverAdapterManifests(getProjectRoot());
  const ids = new Set([
    ...manifests.map((manifest) => manifest.id),
    ...spawnRegistry.list().map((adapter) => adapter.id),
  ]);
  const reasons: string[] = [];
  for (const id of ids) {
    const manifest = manifests.find((candidate) => candidate.id === id);
    const adapter =
      spawnRegistry.get(id) ??
      (manifest ? spawnRegistry.getForProvider(manifest.provider) : undefined);
    if (!adapter) {
      reasons.push(
        `${id}: ${manifest?.capabilities.supportsSpawn ? (spawnAdapterFailures.get(manifest.provider) ?? 'spawn provider not registered') : 'manifest does not support spawning'}`,
      );
      continue;
    }
    const missing = capabilities.filter(
      (capability) => !providerSupportsById(adapter.providerId, `spawn.${capability}`),
    );
    if (missing.length) {
      reasons.push(`${id}: provider lacks ${missing.join(', ')}`);
      continue;
    }
    try {
      const available = await adapter.canSpawn();
      const cli = manifest?.detectionPatterns
        .filter((pattern) => pattern.type === 'cli')
        .map((pattern) => pattern.pattern);
      reasons.push(
        `${id}: ${available ? 'available' : `cannot spawn in this environment (canSpawn returned false${cli?.length ? `; requires CLI on PATH: ${cli.join(', ')}` : ''})`}`,
      );
    } catch (error) {
      reasons.push(
        `${id}: availability check failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return `Install or enable a compatible provider. For explicit adapter selection, use cleo orchestrate spawn-execute <taskId> --adapter claude-code or cleo orchestrate lead <epicId> --adapter <id>. Found adapters: ${reasons.join('; ') || 'none; reinstall @cleocode/cleo with its @cleocode/adapters dependency'}.`;
}
