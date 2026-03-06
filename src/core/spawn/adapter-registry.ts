/**
 * Spawn Adapter Registry
 *
 * Registry to manage multiple spawn adapters for different providers.
 * Provides adapter lookup by ID, by provider, and filtering by capability.
 *
 * @task T5236
 * @phase 1C
 */

import {
  getProvidersBySpawnCapability,
  getSpawnCapableProviders,
  providerSupportsById,
  type Provider,
} from '@cleocode/caamp';
import type { CLEOSpawnAdapter } from '../../types/spawn.js';

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
export function getProvidersWithSpawnCapability(
  capability: SpawnCapability,
): Provider[] {
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
 * Initialize the registry with default adapters.
 *
 * This function registers the built-in adapters for supported providers.
 * Currently registers the Claude Code adapter; additional adapters will
 * be added as they are implemented.
 *
 * @returns Promise that resolves when initialization is complete
 */
export async function initializeDefaultAdapters(): Promise<void> {
  if (!spawnRegistry.hasAdapterForProvider('claude-code')) {
    const { ClaudeCodeSpawnAdapter } = await import('./adapters/claude-code-adapter.js');
    spawnRegistry.register(new ClaudeCodeSpawnAdapter());
  }

  if (!spawnRegistry.hasAdapterForProvider('opencode')) {
    const { OpenCodeSpawnAdapter } = await import('./adapters/opencode-adapter.js');
    spawnRegistry.register(new OpenCodeSpawnAdapter());
  }
}
