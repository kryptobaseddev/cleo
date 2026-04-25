import type { EngineResult } from '../engine-result.js';
import type { SpawnCapability } from '../spawn/adapter-registry.js';

/**
 * Spawn capability flag understood by the core harness provider selector.
 */
export type HarnessSpawnCapability = SpawnCapability;

/**
 * Provider and adapter selected by the core harness for a spawn operation.
 */
export interface HarnessSpawnProviderSelection {
  /** Provider registry identifier selected for the spawn. */
  providerId: string;
  /** Registered spawn adapter identifier selected for the spawn. */
  adapterId: string;
  /** Requested capabilities that the selected provider actually supports. */
  capabilities: HarnessSpawnCapability[];
}

/**
 * Result envelope returned by core harness spawn provider selection.
 */
export type HarnessSpawnProviderSelectionResult = EngineResult<HarnessSpawnProviderSelection>;
