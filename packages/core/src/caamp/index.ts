/**
 * CAAMP integration module - barrel export.
 *
 * All CAAMP adapter logic lives here as the single source of truth.
 * CLI dispatch layer re-exports from this module.
 *
 * @task T4678
 * @epic T4663
 */

export {
  // Batch / Orchestration Operations
  batchInstallWithRollback,
  type CaampBatchInstallOptions,
  type CaampBatchInstallResult,
  type CaampDetectionResult,
  type CaampInjectionStatus,
  type CaampProvider,
  caampGenerateInjectionContent,
  caampGetInstructionFiles,
  // Utility Re-exports
  caampResolveAlias,
  // Types
  type EngineResult,
  // Injection Operations
  injectionCheck,
  injectionCheckAll,
  injectionUpdate,
  injectionUpdateAll,
  providerCount,
  providerDetect,
  providerGet,
  providerInstalled,
  // Provider Operations
  providerList,
  registryVersion,
} from './adapter.js';

// Capability Checking
export {
  checkProviderCapabilities,
  checkProviderCapability,
} from './capability-check.js';
