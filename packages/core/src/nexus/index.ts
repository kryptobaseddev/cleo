/**
 * NEXUS - Cross-project intelligence system for CLEO.
 *
 * Provides project registration, permission enforcement,
 * cross-project query resolution, and global dependency analysis.
 *
 * @task T4574
 * @epic T4540
 */

export type {
  NexusDiscoverHit as DiscoverResult,
  NexusDiscoverResult,
  NexusSearchHit as SearchResult,
  NexusSearchResult,
} from '@cleocode/contracts/operations/nexus';
// Clusters - Louvain community detection results (T1473)
export {
  getProjectClusters,
  type NexusClustersResult,
  type NexusCommunityEntry,
} from './clusters.js';
// Context - symbol caller/callee/process context (T1473)
export {
  getSymbolContext,
  type NexusContextNode,
  type NexusContextOptions,
  type NexusContextProcess,
  type NexusContextRelation,
  type NexusContextResult,
  type NexusSourceContent,
} from './context.js';
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
  // EngineResult wrappers (T1569)
  nexusBlockers,
  nexusCriticalPath,
  nexusDeps,
  nexusDepsQuery,
  nexusGraph,
  nexusOrphans,
  type OrphanEntry,
  orphanDetection,
  resolveCrossDeps,
} from './deps.js';
// Index diff - compare node/relation counts between git commits (T1473)
export {
  diffNexusIndex,
  type NexusDiffHealth,
  type NexusDiffOptions,
  type NexusDiffResult,
} from './diff.js';
// Discovery - cross-project task discovery and search
export {
  discoverRelated,
  extractKeywords,
  searchAcrossProjects,
} from './discover.js';
// Flows - execution flow (process) nodes (T1473)
export {
  getProjectFlows,
  type NexusFlowEntry,
  type NexusFlowsResult,
} from './flows.js';
// GEXF export - graph serialization (T1473)
export { escapeXml, generateGexf, hexToRgb } from './gexf-export.js';
// Hash - canonical project identity hash
export { generateProjectHash } from './hash.js';
// Impact - BFS upstream blast radius (T1473)
export {
  getSymbolImpact,
  type NexusImpactLayer,
  type NexusImpactNode,
  type NexusImpactOptions,
  type NexusImpactResult,
  type NexusRiskLevel,
  // EngineResult wrapper (T1569)
  nexusImpact,
} from './impact.js';
// Ops registry — type source for OpsFromCore<typeof nexus.nexusCoreOps> (T1440)
export type { nexusCoreOps } from './ops.js';
// Permissions - three-tier access control
export {
  canExecute,
  canRead,
  canWrite,
  checkPermission,
  checkPermissionDetail,
  getPermission,
  nexusSetPermission,
  type PermissionCheckResult,
  // Operations
  permissionLevel,
  requirePermission,
  setPermission,
} from './permissions.js';
// Projects clean - bulk purge project registry rows (T1473)
export {
  type CleanProjectsOptions,
  type CleanProjectsResult,
  cleanProjects,
  InvalidPatternError,
  NoCriteriaError,
} from './projects-clean.js';
// Projects scan - filesystem walker for CLEO project discovery (T1473)
export {
  getDevice,
  type ProjectsScanOptions,
  type ProjectsScanResult,
  type ScanAutoRegisterError,
  scanForProjects,
  walkForCleo,
} from './projects-scan.js';
// Query - cross-project task resolution
export {
  getCurrentProject,
  getProjectFromQuery,
  type NexusParsedQuery,
  type NexusResolvedTask,
  // EngineResult wrappers (T1569)
  nexusResolve,
  nexusTopEntries,
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
  // EngineResult wrappers (T1569)
  nexusInitialize,
  nexusList,
  nexusListProjects,
  nexusProjectExists,
  nexusProjectsList,
  nexusProjectsRegister,
  nexusProjectsRemove,
  nexusReconcile,
  nexusReconcileProject,
  nexusRegister,
  nexusRegisterProject,
  nexusShowProject,
  nexusStatus,
  nexusSync,
  nexusSyncAll,
  nexusSyncProject,
  nexusUnregister,
  nexusUnregisterProject,
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
export type { SigilCard, SigilInput } from './sigil.js';
// Sigil (peer-card identity) SDK (T1148 Wave 8)
export { getSigil, listSigils, upsertSigil } from './sigil.js';
// Sigil sync — populate sigils table from canonical CANT agents (T1386)
export type { CanonicalCantFiles, SigilSyncResult } from './sigil-sync.js';
export {
  parseSigilFromCant,
  resolveCanonicalCantFiles,
  syncCanonicalSigils,
} from './sigil-sync.js';
// Symbol ranking - priority scores for search results (T1473)
export { NODE_KIND_PRIORITY, sortMatchingNodes } from './symbol-ranking.js';
// Tasks Bridge - git-log sweeper linking task IDs to nexus symbols
export {
  getSymbolsForTask,
  getTasksForSymbol,
  linkTaskToSymbols,
  runGitLogTaskLinker,
} from './tasks-bridge.js';
export type {
  ExportUserProfileResult,
  ImportUserProfileResult,
} from './transfer.js';
// Transfer - cross-project task transfer + user-profile import/export (T1079)
export {
  executeTransfer,
  exportUserProfile,
  getDefaultUserProfilePath,
  importUserProfile,
  previewTransfer,
} from './transfer.js';
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
// User-profile CRUD SDK (T1078)
export {
  getUserProfileTrait,
  listUserProfile,
  reinforceTrait,
  supersedeTrait,
  upsertUserProfileTrait,
} from './user-profile.js';
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
