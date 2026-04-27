/**
 * NEXUS - Cross-project intelligence system for CLEO.
 *
 * Provides project registration, permission enforcement,
 * cross-project query resolution, and global dependency analysis.
 *
 * @task T4574
 * @epic T4540
 */

// Clusters - Louvain community detection results (T1473)
export {
  getProjectClusters,
  type NexusCommunityEntry,
  type NexusClustersResult,
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
// Flows - execution flow (process) nodes (T1473)
export {
  getProjectFlows,
  type NexusFlowEntry,
  type NexusFlowsResult,
} from './flows.js';
// GEXF export - graph serialization (T1473)
export { escapeXml, generateGexf, hexToRgb } from './gexf-export.js';
// Impact - BFS upstream blast radius (T1473)
export {
  getSymbolImpact,
  type NexusImpactLayer,
  type NexusImpactNode,
  type NexusImpactOptions,
  type NexusImpactResult,
  type NexusRiskLevel,
} from './impact.js';
// Symbol ranking - priority scores for search results (T1473)
export { NODE_KIND_PRIORITY, sortMatchingNodes } from './symbol-ranking.js';
// Index diff - compare node/relation counts between git commits (T1473)
export {
  diffNexusIndex,
  type NexusDiffHealth,
  type NexusDiffOptions,
  type NexusDiffResult,
} from './diff.js';
// Projects scan - filesystem walker for CLEO project discovery (T1473)
export {
  getDevice,
  type ProjectsScanOptions,
  type ProjectsScanResult,
  type ScanAutoRegisterError,
  scanForProjects,
  walkForCleo,
} from './projects-scan.js';
export type {
  NexusDiscoverHit as DiscoverResult,
  NexusDiscoverResult,
  NexusSearchHit as SearchResult,
  NexusSearchResult,
} from '@cleocode/contracts/operations/nexus';
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
  discoverRelated,
  extractKeywords,
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
