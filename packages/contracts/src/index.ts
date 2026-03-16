/**
 * @cleocode/contracts — Provider adapter contracts for CLEO.
 *
 * @task T5240
 */

export type { CLEOProviderAdapter, AdapterHealthStatus } from './adapter.js';
export type { AdapterCapabilities } from './capabilities.js';
export type { AdapterManifest, DetectionPattern } from './discovery.js';
export type { AdapterHookProvider } from './hooks.js';
export type { AdapterInstallProvider, InstallOptions, InstallResult } from './install.js';
export type {
  MemoryBridgeConfig,
  MemoryBridgeContent,
  SessionSummary,
  BridgeLearning,
  BridgePattern,
  BridgeDecision,
  BridgeObservation,
} from './memory.js';
export type { AdapterSpawnProvider, SpawnContext, SpawnResult } from './spawn.js';
