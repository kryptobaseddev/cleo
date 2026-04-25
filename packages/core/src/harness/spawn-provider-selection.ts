import {
  getAllProviders,
  getProvidersBySpawnCapability,
  type Provider,
  providerSupportsById,
} from '@cleocode/caamp';
import type { CLEOSpawnAdapter } from '@cleocode/contracts';
import type { EngineResult } from '../engine-result.js';
import {
  initializeDefaultAdapters,
  type SpawnCapability,
  spawnRegistry,
} from '../spawn/adapter-registry.js';
import type { HarnessSpawnProviderSelection } from './types.js';

/**
 * Build a typed error result for harness provider selection.
 */
function selectionError<T>(code: string, message: string, exitCode: number): EngineResult<T> {
  return {
    success: false,
    error: {
      code,
      message,
      exitCode,
    },
  };
}

/**
 * Return providers that satisfy every requested spawn capability.
 */
async function getMatchingProviders(capabilities: readonly SpawnCapability[]): Promise<Provider[]> {
  if (capabilities.length === 1) {
    return getProvidersBySpawnCapability(capabilities[0]);
  }

  const providerSets = capabilities.map(
    (capability) =>
      new Set(getProvidersBySpawnCapability(capability).map((provider) => provider.id)),
  );
  const providersById = new Map(getAllProviders().map((provider) => [provider.id, provider]));
  const spawnCapableAdapters = await spawnRegistry.listSpawnCapable();

  return spawnCapableAdapters
    .filter((adapter) => providerSets.every((providerSet) => providerSet.has(adapter.providerId)))
    .map((adapter) => providersById.get(adapter.providerId))
    .filter((provider): provider is Provider => provider !== undefined);
}

/**
 * Return the first registered spawn adapter for the selected providers.
 */
function getFirstRegisteredAdapter(providers: readonly Provider[]): CLEOSpawnAdapter | undefined {
  for (const provider of providers) {
    const adapter = spawnRegistry.getForProvider(provider.id);
    if (adapter) {
      return adapter;
    }
  }

  return undefined;
}

/**
 * Select a spawn-capable provider and registered adapter from the core harness.
 *
 * This is the SDK-owned provider-selection primitive used by CLI and future
 * harness surfaces. Provider registry discovery, adapter registry lookup, and
 * capability verification live here so surfaces do not duplicate harness
 * authority.
 *
 * @param capabilities - Required spawn capabilities for the operation
 * @returns Provider and adapter selection, or a typed engine error
 */
export async function selectHarnessSpawnProvider(
  capabilities: readonly SpawnCapability[],
): Promise<EngineResult<HarnessSpawnProviderSelection>> {
  if (capabilities.length === 0) {
    return selectionError('E_INVALID_INPUT', 'At least one capability is required', 2);
  }

  try {
    await initializeDefaultAdapters();

    const matchingProviders = await getMatchingProviders(capabilities);
    if (matchingProviders.length === 0) {
      return selectionError(
        'E_SPAWN_NO_PROVIDER',
        `No provider found with all required capabilities: ${capabilities.join(', ')}`,
        60,
      );
    }

    const adapter = getFirstRegisteredAdapter(matchingProviders);
    if (!adapter) {
      return selectionError(
        'E_SPAWN_NO_ADAPTER',
        'No spawn adapter registered for matching providers',
        60,
      );
    }

    const canSpawn = await adapter.canSpawn();
    if (!canSpawn) {
      return selectionError(
        'E_SPAWN_ADAPTER_UNAVAILABLE',
        `Selected adapter '${adapter.id}' cannot spawn in current environment`,
        63,
      );
    }

    return {
      success: true,
      data: {
        providerId: adapter.providerId,
        adapterId: adapter.id,
        capabilities: capabilities.filter((capability) =>
          providerSupportsById(adapter.providerId, `spawn.${capability}`),
        ),
      },
    };
  } catch (error) {
    return selectionError('E_GENERAL', error instanceof Error ? error.message : String(error), 1);
  }
}
