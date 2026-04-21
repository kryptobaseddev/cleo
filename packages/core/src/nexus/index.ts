/**
 * NEXUS - Cross-project intelligence system for CLEO.
 *
 * Provides project registration, permission enforcement,
 * cross-project query resolution, and global dependency analysis.
 *
 * @task T4574
 * @epic T4540
 */

// Deps - global dependency graph and analysis
export {
  type BlockingAnalysisResult,
  blockingAnalysis,
  buildGlobalGraph,
  type CriticalPathResult,
  criticalPath,
  type DepsEntry,
  type DepsResult,
  // Operations
  invalidateGraphCache,
  type NexusGlobalGraph,
  type NexusGraphEdge,
  type NexusGraphNode,
  nexusDeps,
  type OrphanEntry,
  orphanDetection,
  resolveCrossDeps,
} from './deps.js';
// Discovery - cross-project task discovery and search
export {
  type DiscoverResult,
  discoverRelated,
  extractKeywords,
  type NexusDiscoverResult,
  type NexusSearchResult,
  type SearchResult,
  searchAcrossProjects,
} from './discover.js';
// Hash - canonical project identity hash
export { generateProjectHash } from './hash.js';
// Permissions - three-tier access control
export {
  canExecute,
  canRead,
  canWrite,
  checkPermission,
  checkPermissionDetail,
  getPermission,
  type PermissionCheckResult,
  // Operations
  permissionLevel,
  requirePermission,
  setPermission,
} from './permissions.js';
// Query - cross-project task resolution
export {
  getCurrentProject,
  getProjectFromQuery,
  type NexusParsedQuery,
  type NexusResolvedTask,
  parseQuery,
  resolveProjectPath,
  resolveTask,
  // Operations
  validateSyntax,
} from './query.js';
// Registry - project registration and management
export {
  getNexusCacheDir,
  // Path helpers
  getNexusHome,
  type NexusHealthStatus,
  type NexusPermissionLevel,
  // Types
  type NexusProject,
  type NexusProjectStats,
  type NexusRegistryFile,
  nexusGetProject,
  nexusInit,
  nexusList,
  nexusProjectExists,
  nexusReconcile,
  nexusRegister,
  nexusSetPermission,
  nexusSync,
  nexusSyncAll,
  nexusUnregister,
  nexusUpdateIndexStats,
  // Operations
  readRegistry,
  readRegistryRequired,
  resetNexusDbState,
} from './registry.js';
// Sharing - multi-contributor .cleo/ state management
export {
  // Operations
  getSharingStatus,
  // Types
  type SharingStatus,
  syncGitignore,
} from './sharing/index.js';
// Tasks Bridge - git-log sweeper linking task IDs to nexus symbols
export {
  getSymbolsForTask,
  getTasksForSymbol,
  linkTaskToSymbols,
  runGitLogTaskLinker,
} from './tasks-bridge.js';
// Transfer - cross-project task transfer
export { executeTransfer, previewTransfer } from './transfer.js';
export type {
  ImportFromPackageOptions,
  ImportFromPackageResult,
  TransferManifest,
  TransferManifestEntry,
  TransferMode,
  TransferOnConflict,
  TransferOnMissingDep,
  TransferParams,
  TransferResult,
  TransferScope,
} from './transfer-types.js';
export type {
  ParsedDirective,
  ProjectACL,
  RouteResult,
  WorkspaceAgent,
  WorkspaceProjectSummary,
  WorkspaceStatus,
} from './workspace.js';
// Workspace - cross-project orchestration (ORCH-PLAN Phase B)
export {
  parseDirective,
  routeDirective,
  workspaceAgents,
  workspaceStatus,
} from './workspace.js';
