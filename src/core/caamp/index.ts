/**
 * CAAMP integration module - barrel export.
 *
 * All CAAMP adapter logic lives here as the single source of truth.
 * MCP engine layer and CLI commands re-export from this module.
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
  type CaampDualScopeConfigureOptions,
  type CaampDualScopeConfigureResult,
  type CaampInjectionStatus,
  type CaampInstallResult,
  type CaampMcpServerConfig,
  type CaampProvider,
  caampBuildServerConfig,
  caampGenerateInjectionContent,
  caampGetInstructionFiles,
  // Utility Re-exports
  caampResolveAlias,
  dualScopeConfigure,
  // Types
  type EngineResult,
  // Injection Operations
  injectionCheck,
  injectionCheckAll,
  injectionUpdate,
  injectionUpdateAll,
  mcpConfigPath,
  mcpInstall,
  // MCP Config Operations
  mcpList,
  mcpListAll,
  mcpRemove,
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
