/**
 * NEXUS - Cross-project intelligence system for CLEO.
 *
 * Provides project registration, permission enforcement,
 * cross-project query resolution, and global dependency analysis.
 *
 * @task T4574
 * @epic T4540
 */

// Hash - canonical project identity hash
export { generateProjectHash } from './hash.js';

// Registry - project registration and management
export {
  // Types & schemas
  NexusPermissionLevelSchema,
  NexusHealthStatusSchema,
  NexusProjectSchema,
  NexusRegistryFileSchema,
  type NexusPermissionLevel,
  type NexusHealthStatus,
  type NexusProject,
  type NexusRegistryFile,
  // Path helpers
  getNexusHome,
  getNexusCacheDir,
  // Operations
  readRegistry,
  readRegistryRequired,
  nexusInit,
  nexusRegister,
  nexusUnregister,
  nexusList,
  nexusGetProject,
  nexusProjectExists,
  nexusSync,
  nexusSyncAll,
  nexusSetPermission,
  nexusReconcile,
  resetNexusDbState,
} from './registry.js';

// Permissions - three-tier access control
export {
  // Types & schemas
  PermissionLevelSchema,
  PermissionCheckResultSchema,
  type PermissionCheckResult,
  // Operations
  permissionLevel,
  getPermission,
  setPermission,
  checkPermission,
  requirePermission,
  checkPermissionDetail,
  canRead,
  canWrite,
  canExecute,
} from './permissions.js';

// Query - cross-project task resolution
export {
  // Types & schemas
  NexusParsedQuerySchema,
  type NexusParsedQuery,
  type NexusResolvedTask,
  // Operations
  validateSyntax,
  parseQuery,
  getCurrentProject,
  resolveProjectPath,
  resolveTask,
  getProjectFromQuery,
} from './query.js';

// Deps - global dependency graph and analysis
export {
  // Types & schemas
  NexusGraphNodeSchema,
  NexusGraphEdgeSchema,
  NexusGlobalGraphSchema,
  type NexusGraphNode,
  type NexusGraphEdge,
  type NexusGlobalGraph,
  type DepsResult,
  type DepsEntry,
  type CriticalPathResult,
  type BlockingAnalysisResult,
  type OrphanEntry,
  // Operations
  invalidateGraphCache,
  buildGlobalGraph,
  nexusDeps,
  resolveCrossDeps,
  criticalPath,
  blockingAnalysis,
  orphanDetection,
} from './deps.js';

// Sharing - multi-contributor .cleo/ state management
export {
  // Types
  type SharingStatus,
  // Operations
  getSharingStatus,
  syncGitignore,
} from './sharing/index.js';
