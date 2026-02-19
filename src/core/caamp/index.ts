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
  // Types
  type EngineResult,
  type CaampProvider,
  type CaampMcpServerConfig,
  type CaampDetectionResult,
  type CaampInstallResult,
  type CaampInjectionStatus,
  type CaampBatchInstallOptions,
  type CaampBatchInstallResult,
  type CaampDualScopeConfigureOptions,
  type CaampDualScopeConfigureResult,
  // Provider Operations
  providerList,
  providerGet,
  providerDetect,
  providerInstalled,
  providerCount,
  registryVersion,
  // MCP Config Operations
  mcpList,
  mcpListAll,
  mcpInstall,
  mcpRemove,
  mcpConfigPath,
  // Injection Operations
  injectionCheck,
  injectionCheckAll,
  injectionUpdate,
  injectionUpdateAll,
  // Batch / Orchestration Operations
  batchInstallWithRollback,
  dualScopeConfigure,
  // Utility Re-exports
  caampResolveAlias,
  caampBuildServerConfig,
  caampGenerateInjectionContent,
  caampGetInstructionFiles,
} from './adapter.js';
