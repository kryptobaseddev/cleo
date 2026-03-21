/**
 * @cleocode/core — CLEO core business logic kernel.
 *
 * This is the standalone package consumers install for programmatic
 * task management, sessions, memory, orchestration, and lifecycle.
 *
 * Import patterns:
 *   // Pattern 1: Facade (recommended)
 *   import { Cleo } from '@cleocode/core';
 *   const cleo = await Cleo.init('./project');
 *
 *   // Pattern 2: Namespace access
 *   import { tasks, sessions, memory } from '@cleocode/core';
 *
 *   // Pattern 3: Direct function imports (tree-shakeable)
 *   import { addTask, startSession, observeBrain } from '@cleocode/core';
 *
 * @package @cleocode/core
 */

// ---------------------------------------------------------------------------
// Re-export ALL contracts types (consumers get types from @cleocode/core)
// ---------------------------------------------------------------------------

export * from '@cleocode/contracts';

// ---------------------------------------------------------------------------
// Submodule namespace re-exports
// ---------------------------------------------------------------------------

export * as adapters from './adapters/index.js';
export * as admin from './admin/index.js';
export * as adrs from './adrs/index.js';
export * as agents from './agents/index.js';
export * as caamp from './caamp/index.js';
export * as codebaseMap from './codebase-map/index.js';
export * as compliance from './compliance/index.js';
export * as context from './context/index.js';
export * as coreHooks from './hooks/index.js';
export * as inject from './inject/index.js';
export * as intelligence from './intelligence/index.js';
export * as issue from './issue/index.js';
export * as lifecycle from './lifecycle/index.js';
export * as coreMcp from './mcp/index.js';
export * as memory from './memory/index.js';
export * as metrics from './metrics/index.js';
export * as migration from './migration/index.js';
export * as nexus from './nexus/index.js';
export * as observability from './observability/index.js';
export * as orchestration from './orchestration/index.js';
export * as otel from './otel/index.js';
export * as phases from './phases/index.js';
export * as pipeline from './pipeline/index.js';
export * as reconciliation from './reconciliation/index.js';
export * as release from './release/index.js';
export * as remote from './remote/index.js';
export * as research from './research/index.js';
export * as roadmap from './roadmap/index.js';
export * as routing from './routing/index.js';
export * as security from './security/index.js';
export * as sequence from './sequence/index.js';
export * as sessions from './sessions/index.js';
export * as signaldock from './signaldock/index.js';
export * as skills from './skills/index.js';
export * as snapshot from './snapshot/index.js';
export * as spawn from './spawn/index.js';
export * as stats from './stats/index.js';
export * as sticky from './sticky/index.js';
export * as system from './system/index.js';
export * as taskWork from './task-work/index.js';
export * as tasks from './tasks/index.js';
export * as templates from './templates/index.js';
export * as ui from './ui/index.js';
export * as validation from './validation/index.js';

// ---------------------------------------------------------------------------
// Canonical Zod enum schemas (flat re-exports for Pattern 3 imports)
// ---------------------------------------------------------------------------

export {
  // Governance enums
  adrStatusSchema,
  // Agent enums
  agentInstanceStatusSchema,
  agentTypeSchema,
  brainConfidenceLevelSchema,
  brainDecisionTypeSchema,
  brainEdgeTypeSchema,
  brainImpactLevelSchema,
  brainLinkTypeSchema,
  brainMemoryTypeSchema,
  brainNodeTypeSchema,
  brainObservationSourceTypeSchema,
  // Brain enums
  brainObservationTypeSchema,
  brainOutcomeTypeSchema,
  brainPatternTypeSchema,
  brainStickyColorSchema,
  brainStickyPrioritySchema,
  brainStickyStatusSchema,
  externalLinkTypeSchema,
  gateStatusSchema,
  insertAgentErrorLogSchema,
  // Agent insert/select schemas
  insertAgentInstanceSchema,
  insertExternalTaskLinkSchema,
  insertPipelineManifestSchema,
  insertReleaseManifestSchema,
  insertSessionSchema,
  // Insert/select schemas
  insertTaskSchema,
  lifecycleEvidenceTypeSchema,
  lifecycleGateResultSchema,
  // Lifecycle enums
  lifecyclePipelineStatusSchema,
  lifecycleStageNameSchema,
  lifecycleStageStatusSchema,
  lifecycleTransitionTypeSchema,
  manifestStatusSchema,
  selectAgentErrorLogSchema,
  selectAgentInstanceSchema,
  selectExternalTaskLinkSchema,
  selectPipelineManifestSchema,
  selectReleaseManifestSchema,
  selectSessionSchema,
  selectTaskSchema,
  // Session enums
  sessionStatusSchema,
  syncDirectionSchema,
  taskPrioritySchema,
  // Relation / link enums
  taskRelationTypeSchema,
  taskSizeSchema,
  // Task enums
  taskStatusSchema,
  taskTypeSchema,
  tokenUsageConfidenceSchema,
  // Token usage enums
  tokenUsageMethodSchema,
  tokenUsageTransportSchema,
} from './store/validation-schemas.js';

// ---------------------------------------------------------------------------
// Store layer (bundled inside core)
// ---------------------------------------------------------------------------

export { createDataAccessor, getAccessor } from './store/data-accessor.js';

// ---------------------------------------------------------------------------
// Top-level utility exports (widely used, unique names)
// ---------------------------------------------------------------------------

// Audit
export { queryAudit } from './audit.js';
export { pruneAuditLog } from './audit-prune.js';
// Config
export {
  getConfigValue,
  getRawConfig,
  getRawConfigValue,
  loadConfig,
  parseConfigValue,
  setConfigValue,
} from './config.js';
// Constants
export { CORE_PROTECTED_FILES } from './constants.js';
// Engine result type (used by dispatch layer)
export type { EngineResult } from './engine-result.js';
export type { ErrorDefinition } from './error-catalog.js';
// Error catalog (RFC 9457)
export {
  ERROR_CATALOG,
  getAllErrorDefinitions,
  getErrorDefinition,
  getErrorDefinitionByLafsCode,
} from './error-catalog.js';
// Error registry
export {
  getCleoErrorRegistry,
  getRegistryEntry,
  getRegistryEntryByLafsCode,
  isCleoRegisteredCode,
} from './error-registry.js';
export type { ProblemDetails } from './errors.js';
// Errors
export { CleoError } from './errors.js';
export type { InitOptions, InitResult } from './init.js';
// Init
export { ensureInitialized, getVersion, initProject } from './init.js';
// JSON Schema validation
export { checkSchema, validateAgainstSchema } from './json-schema-validator.js';
export type { LoggerConfig } from './logger.js';
// Logger
export { closeLogger, getLogDir, getLogger, initLogger } from './logger.js';
export type { FormatOptions } from './output.js';
// Output formatting (LAFS envelope)
export { formatError, formatOutput, formatSuccess, pushWarning } from './output.js';
// Pagination
export { createPage, paginate } from './pagination.js';
// Paths
export {
  getCleoDir,
  getCleoDirAbsolute,
  getCleoHome,
  getConfigPath,
  getGlobalConfigPath,
  getProjectRoot,
  isProjectInitialized,
  resolveProjectPath,
} from './paths.js';
export type { Platform, SystemInfo } from './platform.js';
// Platform
export {
  detectPlatform,
  getIsoTimestamp,
  getSystemInfo,
  MINIMUM_NODE_MAJOR,
  PLATFORM,
  sha256,
} from './platform.js';
export type { ProjectInfo } from './project-info.js';
// Project info
export { getProjectInfo, getProjectInfoSync } from './project-info.js';
// Scaffold
export {
  ensureCleoStructure,
  ensureGlobalHome,
  ensureGlobalScaffold,
  ensureSqliteDb,
  fileExists,
  getCleoVersion,
  getPackageRoot,
} from './scaffold.js';

// ---------------------------------------------------------------------------
// Flat function re-exports for direct imports (Pattern 3)
// ---------------------------------------------------------------------------

// Adapter manager
export { AdapterManager } from './adapters/index.js';
export type { BootstrapContext, BootstrapOptions } from './bootstrap.js';
// Bootstrap — used by postinstall and install-global
export { bootstrapGlobalCleo } from './bootstrap.js';
export type {
  AdminAPI,
  CleoInitOptions,
  LifecycleAPI,
  MemoryAPI,
  NexusAPI,
  OrchestrationAPI,
  ReleaseAPI,
  SessionsAPI,
  StickyAPI,
  SyncAPI,
  TasksAPI,
} from './cleo.js';
// Cleo facade class
export { Cleo } from './cleo.js';
// Hooks
export { HookRegistry, hooks } from './hooks/registry.js';
// Memory
export {
  fetchBrainEntries,
  observeBrain,
  searchBrainCompact,
  timelineBrain,
} from './memory/brain-retrieval.js';
export { searchBrain } from './memory/brain-search.js';
// Migration (flat re-exports for backward compatibility)
export {
  compareSemver,
  detectVersion,
  getMigrationStatus,
  runAllMigrations,
  runMigration,
} from './migration/index.js';
// Reconciliation
export { reconcile } from './reconciliation/index.js';
// Sessions
export {
  endSession,
  listSessions,
  resumeSession,
  sessionStatus,
  startSession,
} from './sessions/index.js';
export { getMigrationStatus as getSystemMigrationStatus } from './system/migrate.js';
export { checkStorageMigration } from './system/storage-preflight.js';
// Task work
export { currentTask, startTask, stopTask } from './task-work/index.js';
// Tasks
export { addTask } from './tasks/add.js';
export { archiveTasks } from './tasks/archive.js';
export { completeTask } from './tasks/complete.js';
export { deleteTask } from './tasks/delete.js';
export { findTasks } from './tasks/find.js';
export { normalizeTaskId } from './tasks/id-generator.js';
export { listTasks } from './tasks/list.js';
export { showTask } from './tasks/show.js';
export { updateTask } from './tasks/update.js';
