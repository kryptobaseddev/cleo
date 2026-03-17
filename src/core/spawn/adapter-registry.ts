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
 * @phase 1C
 */

import {
  getProvidersBySpawnCapability,
  getSpawnCapableProviders,
  type Provider,
  providerSupportsById,
} from '@cleocode/caamp';
import type { AdapterSpawnProvider, SpawnContext, SpawnResult } from '@cleocode/contracts';
import type { CLEOSpawnAdapter, CLEOSpawnContext, CLEOSpawnResult } from '../../types/spawn.js';

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

/**
 * Bridge an AdapterSpawnProvider (from packages/adapters/) to CLEOSpawnAdapter.
 *
 * Maps between the contracts-based SpawnContext/SpawnResult types and the
 * CLEO-specific CLEOSpawnContext/CLEOSpawnResult types used by the orchestrate
 * engine and spawn registry.
 *
 * @param providerId - Provider identifier (e.g. 'claude-code', 'opencode')
 * @param delegate - The underlying AdapterSpawnProvider instance
 * @returns A CLEOSpawnAdapter wrapping the delegate
 */
function bridgeSpawnAdapter(providerId: string, delegate: AdapterSpawnProvider): CLEOSpawnAdapter {
  return {
    id: providerId,
    providerId,

    canSpawn(): Promise<boolean> {
      return delegate.canSpawn();
    },

    async spawn(context: CLEOSpawnContext): Promise<CLEOSpawnResult> {
      const contractContext: SpawnContext = {
        taskId: context.taskId,
        prompt: context.prompt,
        workingDirectory: context.workingDirectory,
        options: context.options as unknown as Record<string, unknown> | undefined,
      };
      const result: SpawnResult = await delegate.spawn(contractContext);
      return {
        instanceId: result.instanceId,
        status: result.status as CLEOSpawnResult['status'],
        taskId: result.taskId,
        providerId: result.providerId,
        timing: {
          startTime: result.startTime,
          endTime: result.endTime,
        },
      };
    },

    async listRunning(): Promise<CLEOSpawnResult[]> {
      const results: SpawnResult[] = await delegate.listRunning();
      return results.map((r) => ({
        instanceId: r.instanceId,
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
 * Initialize the registry with default adapters.
 *
 * Dynamically imports spawn providers from the adapter packages
 * (packages/adapters/claude-code/ and packages/adapters/opencode/)
 * and wraps them as CLEOSpawnAdapters via the bridge function.
 *
 * @returns Promise that resolves when initialization is complete
 */
export async function initializeDefaultAdapters(): Promise<void> {
  if (!spawnRegistry.hasAdapterForProvider('claude-code')) {
    try {
      const { ClaudeCodeSpawnProvider } = await import(
        /* webpackIgnore: true */
        '@cleocode/adapter-claude-code'
      );
      spawnRegistry.register(bridgeSpawnAdapter('claude-code', new ClaudeCodeSpawnProvider()));
    } catch {
      // Adapter package not available — skip registration
    }
  }

  if (!spawnRegistry.hasAdapterForProvider('opencode')) {
    try {
      const { OpenCodeSpawnProvider } = await import(
        /* webpackIgnore: true */
        '@cleocode/adapter-opencode'
      );
      spawnRegistry.register(bridgeSpawnAdapter('opencode', new OpenCodeSpawnProvider()));
    } catch {
      // Adapter package not available — skip registration
    }
  }
}
