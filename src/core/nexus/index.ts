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
  NexusGlobalGraphSchema,
  type NexusGraphEdge,
  NexusGraphEdgeSchema,
  type NexusGraphNode,
  // Types & schemas
  NexusGraphNodeSchema,
  nexusDeps,
  type OrphanEntry,
  orphanDetection,
  resolveCrossDeps,
} from './deps.js';
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
  PermissionCheckResultSchema,
  // Types & schemas
  PermissionLevelSchema,
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
  // Types & schemas
  NexusParsedQuerySchema,
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
  NexusHealthStatusSchema,
  type NexusPermissionLevel,
  // Types & schemas
  NexusPermissionLevelSchema,
  type NexusProject,
  NexusProjectSchema,
  type NexusRegistryFile,
  NexusRegistryFileSchema,
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
