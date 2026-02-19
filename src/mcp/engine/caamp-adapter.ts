/**
 * CAAMP Adapter - MCP engine re-export layer.
 *
 * Delegates to the canonical adapter in src/core/caamp/adapter.ts.
 * MCP domain handlers import from this file for co-location convenience;
 * all logic lives in core.
 *
 * @task T4678
 * @epic T4663
 */

// Re-export everything from the canonical core adapter
export {
  // Types
  type EngineResult,
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
} from '../../core/caamp/adapter.js';
