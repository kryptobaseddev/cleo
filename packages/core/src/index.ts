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
export * as caamp from './caamp/index.js';
export * as codebaseMap from './codebase-map/index.js';
export * as compliance from './compliance/index.js';
export * as context from './context/index.js';
export * as coreHooks from './hooks/index.js';
export * as inject from './inject/index.js';
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
// Store layer (bundled inside core)
// ---------------------------------------------------------------------------

export { createDataAccessor, getAccessor } from './store/data-accessor.js';

// ---------------------------------------------------------------------------
// Top-level utility exports (widely used, unique names)
// ---------------------------------------------------------------------------

// Errors
export { CleoError } from './errors.js';
export type { ProblemDetails } from './errors.js';

// Error catalog (RFC 9457)
export {
  ERROR_CATALOG,
  getAllErrorDefinitions,
  getErrorDefinition,
  getErrorDefinitionByLafsCode,
} from './error-catalog.js';
export type { ErrorDefinition } from './error-catalog.js';

// Error registry
export {
  getCleoErrorRegistry,
  getRegistryEntry,
  getRegistryEntryByLafsCode,
  isCleoRegisteredCode,
} from './error-registry.js';

// Config
export {
  getConfigValue,
  getRawConfig,
  getRawConfigValue,
  loadConfig,
  parseConfigValue,
  setConfigValue,
} from './config.js';

// Logger
export { closeLogger, getLogDir, getLogger, initLogger } from './logger.js';
export type { LoggerConfig } from './logger.js';

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

// Platform
export {
  detectPlatform,
  getIsoTimestamp,
  getSystemInfo,
  MINIMUM_NODE_MAJOR,
  PLATFORM,
  sha256,
} from './platform.js';
export type { Platform, SystemInfo } from './platform.js';

// Output formatting (LAFS envelope)
export { formatError, formatOutput, formatSuccess, pushWarning } from './output.js';
export type { FormatOptions } from './output.js';

// Pagination
export { createPage, paginate } from './pagination.js';

// Init
export { ensureInitialized, getVersion, initProject } from './init.js';
export type { InitOptions, InitResult } from './init.js';

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

// Audit
export { queryAudit } from './audit.js';
export { pruneAuditLog } from './audit-prune.js';

// JSON Schema validation
export { checkSchema, validateAgainstSchema } from './json-schema-validator.js';

// Project info
export { getProjectInfo, getProjectInfoSync } from './project-info.js';
export type { ProjectInfo } from './project-info.js';

// Constants
export { CORE_PROTECTED_FILES } from './constants.js';

// Engine result type (used by dispatch layer)
export type { EngineResult } from './engine-result.js';

// ---------------------------------------------------------------------------
// Flat function re-exports for direct imports (Pattern 3)
// ---------------------------------------------------------------------------

// Tasks
export { addTask } from './tasks/add.js';
export { archiveTasks } from './tasks/archive.js';
export { completeTask } from './tasks/complete.js';
export { deleteTask } from './tasks/delete.js';
export { findTasks } from './tasks/find.js';
export { listTasks } from './tasks/list.js';
export { showTask } from './tasks/show.js';
export { updateTask } from './tasks/update.js';
export { normalizeTaskId } from './tasks/id-generator.js';

// Sessions
export {
  endSession,
  listSessions,
  resumeSession,
  sessionStatus,
  startSession,
} from './sessions/index.js';

// Memory
export {
  fetchBrainEntries,
  observeBrain,
  searchBrainCompact,
  timelineBrain,
} from './memory/brain-retrieval.js';
export { searchBrain } from './memory/brain-search.js';

// Task work
export { currentTask, startTask, stopTask } from './task-work/index.js';

// Hooks
export { HookRegistry, hooks } from './hooks/registry.js';

// Adapter manager
export { AdapterManager } from './adapters/index.js';

// Cleo facade class
export { Cleo } from './cleo.js';
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
  TasksAPI,
} from './cleo.js';

// ---------------------------------------------------------------------------
// Extended flat exports (required by @cleocode/cleoctl)
// ---------------------------------------------------------------------------

// Admin
export { computeHelp } from './admin/help.js';
export { exportTasks } from './admin/export.js';
export { exportTasksPackage } from './admin/export-tasks.js';
export { importTasks } from './admin/import.js';
export { importTasksPackage } from './admin/import-tasks.js';
export { clearSyncState, getSyncStatus } from './admin/sync.js';

// ADRs
export { findAdrs } from './adrs/find.js';
export { listAdrs, showAdr, syncAdrsToDb, validateAllAdrs } from './adrs/index.js';

// Audit
export type { AuditEntry } from './audit.js';

// Compliance
export { protocolEnforcer, ProtocolEnforcer } from './compliance/protocol-enforcement.js';
export type { ViolationLogEntry } from './compliance/protocol-enforcement.js';
export {
  PROTOCOL_RULES,
} from './compliance/protocol-rules.js';
export type {
  ProtocolRule,
  ProtocolValidationResult,
  ProtocolViolation,
  RequirementLevel,
  ViolationSeverity,
} from './compliance/protocol-rules.js';

// Context
export { estimateContext } from './orchestration/context.js';

// Hooks
export type { HookEvent } from './hooks/provider-hooks.js';
export type { ProviderHookEvent } from './hooks/provider-hooks.js';
export { isProviderHookEvent } from './hooks/types.js';

// Init (additional)
export { isAutoInitEnabled } from './init.js';

// Issue
export { collectDiagnostics } from './issue/diagnostics.js';

// Lifecycle
export {
  checkGate,
  checkStagePrerequisites,
  failGate,
  getLifecycleGates,
  getLifecycleHistory,
  getLifecycleStatus,
  getStagePrerequisites,
  listEpicsWithLifecycle,
  passGate,
  recordStageProgress,
  resetStage,
  skipStageWithReason,
} from './lifecycle/index.js';
export {
  addChain,
  advanceInstance,
  createInstance,
  listChains,
  showChain,
} from './lifecycle/chain-store.js';
export { instantiateTessera, showTessera } from './lifecycle/tessera-engine.js';

// MCP helpers
export { detectEnvMode, generateMcpServerEntry, getMcpServerName } from './mcp/index.js';

// Memory — engine-compat
export {
  memoryBrainStats,
  memoryContradictions,
  memoryDecisionFind,
  memoryDecisionStore,
  memoryFetch,
  memoryFind,
  memoryGraphAdd,
  memoryGraphNeighbors,
  memoryGraphRemove,
  memoryGraphShow,
  memoryLearningFind,
  memoryLearningStats,
  memoryLearningStore,
  memoryLink,
  memoryObserve,
  memoryPatternFind,
  memoryPatternStats,
  memoryPatternStore,
  memoryReasonSimilar,
  memoryReasonWhy,
  memorySearchHybrid,
  memoryShow,
  memorySuperseded,
  memoryTimeline,
  memoryUnlink,
} from './memory/engine-compat.js';
export { migrateClaudeMem } from './memory/claude-mem-migration.js';

// Memory — pipeline manifests
export {
  pipelineManifestAppend,
  pipelineManifestArchive,
  pipelineManifestFind,
  pipelineManifestList,
  pipelineManifestPending,
  pipelineManifestShow,
  pipelineManifestStats,
  readManifestEntries,
} from './memory/pipeline-manifest-sqlite.js';

// Metrics
export {
  autoRecordDispatchTokenUsage,
  clearTokenUsage,
  deleteTokenUsage,
  listTokenUsage,
  measureTokenExchange,
  recordTokenExchange,
  showTokenUsage,
  summarizeTokenUsage,
} from './metrics/token-service.js';

// Nexus
export { searchAcrossProjects } from './nexus/discover.js';
export { blockingAnalysis, buildGlobalGraph, criticalPath, nexusDeps, orphanDetection } from './nexus/deps.js';
export { setPermission } from './nexus/permissions.js';
export { resolveTask, validateSyntax } from './nexus/query.js';
export {
  nexusGetProject,
  nexusInit,
  nexusList,
  nexusReconcile,
  nexusRegister,
  nexusSync,
  nexusSyncAll,
  nexusUnregister,
} from './nexus/registry.js';
export type { NexusPermissionLevel } from './nexus/registry.js';
export { getSharingStatus } from './nexus/sharing/index.js';

// Orchestration
export { analyzeEpic, prepareSpawn } from './orchestration/index.js';
export { endParallelExecution, getParallelStatus, startParallelExecution } from './orchestration/parallel.js';
export { getSkillContent } from './orchestration/skill-ops.js';
export { computeEpicStatus, computeOverallStatus, computeProgress, computeStartupSummary } from './orchestration/status.js';
export { getUnblockOpportunities } from './orchestration/unblock.js';
export { validateSpawnReadiness } from './orchestration/validate-spawn.js';
export { getEnrichedWaves } from './orchestration/waves.js';

// OTel
export { clearOtelData, getOtelSessions, getOtelSpawns, getOtelSummary, getRealTokenUsage } from './otel/index.js';

// Paths (additional)
export { getAgentOutputsAbsolute, getAgentsHome } from './paths.js';

// Phases
export { advancePhase, deletePhase, renamePhase, setPhase, startPhase } from './phases/index.js';
export type { ListPhasesResult } from './phases/index.js';

// Pipeline
export { listPhases, showPhase } from './pipeline/index.js';

// Platform (additional)
export { getNodeUpgradeInstructions, getNodeVersionInfo } from './platform.js';

// Release
export { channelToDistTag, describeChannel, resolveChannelFromBranch } from './release/channel.js';
export { checkDoubleListing, checkEpicCompleteness } from './release/guards.js';
export { buildPRBody, createPullRequest, isGhCliAvailable } from './release/github-pr.js';
export type { PRResult } from './release/github-pr.js';
export { getGitFlowConfig, getPushMode, loadReleaseConfig } from './release/release-config.js';
export {
  cancelRelease,
  commitRelease,
  generateReleaseChangelog,
  listManifestReleases,
  markReleasePushed,
  prepareRelease,
  pushRelease,
  rollbackRelease,
  runReleaseGates,
  showManifestRelease,
} from './release/release-manifest.js';
export type { ReleaseListOptions, ReleaseTaskRecord } from './release/release-manifest.js';
export { bumpVersionFromConfig, getVersionBumpConfig } from './release/version-bump.js';

// Remote
export { listRemotes, pull, push, removeRemote } from './remote/index.js';
// Alias for cleoctl compatibility (admin sync status)
export { getSyncStatus as getAdminSyncStatus } from './admin/sync.js';
// Remote git sync status (ahead/behind/branch)
export { getSyncStatus as getRemoteSyncStatus } from './remote/index.js';

// Routing
export {
  canRunNatively,
  generateCapabilityReport,
  getCapabilityMatrix,
  getNativeOperations,
  getOperationMode,
  requiresCLI,
} from './routing/capability-matrix.js';
export type {
  CapabilityReport,
  ExecutionMode,
  GatewayType,
  OperationCapability,
  PreferredChannel,
} from './routing/capability-matrix.js';

// Security
export {
  ALL_VALID_STATUSES,
  DEFAULT_RATE_LIMITS,
  ensureArray,
  RateLimiter,
  sanitizeContent,
  sanitizeParams,
  sanitizePath,
  sanitizeTaskId,
  validateEnum,
  VALID_DOMAINS,
  VALID_GATEWAYS,
  VALID_PRIORITIES,
} from './security/input-sanitization.js';
export type { SecurityError } from './security/input-sanitization.js';
export type { RateLimitConfig, RateLimitResult } from './security/index.js';

// Sequence
export { repairSequence } from './sequence/index.js';

// Sessions (additional)
export {
  archiveSessions,
  cleanupSessions,
  getContextDrift,
  getSessionHistory,
  parseScope,
  showSession,
  switchSession,
} from './sessions/index.js';
export type { DecisionRecord } from './sessions/types.js';
export { recordAssumption } from './sessions/assumptions.js';
export { computeBriefing } from './sessions/briefing.js';
export type { SessionBriefing } from './sessions/briefing.js';
export { injectContext } from './sessions/context-inject.js';
export type { ContextInjectionData } from './sessions/context-inject.js';
export { getCurrentSessionId } from './sessions/context-alert.js';
export { getDecisionLog, recordDecision } from './sessions/decisions.js';
export type { FindSessionsParams, MinimalSessionRecord } from './sessions/find.js';
export { computeDebrief, computeHandoff, getLastHandoff, persistHandoff } from './sessions/handoff.js';
export type { DebriefData, HandoffData } from './sessions/handoff.js';
export { generateSessionId } from './sessions/session-id.js';

// Skills
export { analyzeDependencies, getNextTask, getReadyTasks } from './skills/orchestrator/startup.js';
export { readRegistry } from './skills/agents/registry.js';
export { filterEntries } from './skills/manifests/research.js';
export type { ManifestEntry } from './skills/types.js';
export { validateContributionTask } from './skills/manifests/contribution.js';

// Snapshot
export { exportSnapshot, getDefaultSnapshotPath, importSnapshot, writeSnapshot } from './snapshot/index.js';

// Sticky
export { archiveSticky } from './sticky/archive.js';
export { convertStickyToMemory, convertStickyToSessionNote, convertStickyToTask, convertStickyToTaskNote } from './sticky/convert.js';
export { listStickies, purgeSticky } from './sticky/index.js';
export type { CreateStickyParams, ListStickiesParams, StickyNote } from './sticky/types.js';

// Store
export { createBackup, listBackups, restoreFromBackup } from './store/backup.js';
export { gitCheckpoint, gitCheckpointStatus, isCleoGitInitialized } from './store/git-checkpoint.js';
export { computeChecksum, readJson } from './store/json.js';
export { getDb } from './store/sqlite.js';
export { getBrainDb, getBrainNativeDb } from './store/brain-sqlite.js';
export { getActiveSession } from './store/session-store.js';
export { auditLog, releaseManifests } from './store/tasks-schema.js';
export { AuditLogInsertSchema } from './store/validation-schemas.js';

// System
export { getDashboard, getProjectStats } from './stats/index.js';
export type {
  AnalyzeArchiveOptions,
  ArchiveAnalyticsResult,
  ArchiveReportType,
  CycleTimesReportData,
  EmptyArchiveData,
  LabelFrequencyEntry,
  PhaseGroupEntry,
  PriorityGroupEntry,
  SummaryReportData,
  TrendsReportData,
} from './system/archive-analytics.js';
export { analyzeArchive } from './system/archive-analytics.js';
export type { ArchiveStatsResult } from './system/archive-stats.js';
export { getArchiveStats } from './system/archive-stats.js';
export { auditData } from './system/audit.js';
export type { AuditResult } from './system/audit.js';
export type { BackupResult } from './system/backup.js';
export { restoreBackup } from './system/backup.js';
export type { RestoreResult } from './system/backup.js';
export type { CleanupResult } from './system/cleanup.js';
export { cleanupSystem } from './system/cleanup.js';
export { getSystemDiagnostics, getSystemHealth, startupHealthCheck } from './system/health.js';
export type { DiagnosticsResult, HealthResult } from './system/health.js';
export {
  checkStorageMigration,
  generateInjection,
  getLabels,
  getMigrationStatus,
  getRuntimeDiagnostics,
  getSystemMetrics,
  safestop,
  uncancelTask,
} from './system/index.js';
export type {
  InjectGenerateResult,
  LabelsResult,
  RuntimeDiagnostics,
  SafestopResult,
  SystemMetricsResult,
  UncancelResult,
} from './system/index.js';

// Tasks (additional)
export { validateLabels } from './tasks/add.js';
export { getCriticalPath } from './tasks/graph-ops.js';
export type { TaskTreeNode } from './tasks/hierarchy.js';
export { toCompact } from './tasks/list.js';
export type { CompactTask } from './tasks/list.js';
export { discoverRelated } from './tasks/relates.js';
export {
  coreTaskAnalyze,
  coreTaskBatchValidate,
  coreTaskBlockers,
  coreTaskCancel,
  coreTaskComplexityEstimate,
  coreTaskDepends,
  coreTaskDeps,
  coreTaskDepsCycles,
  coreTaskDepsOverview,
  coreTaskExport,
  coreTaskHistory,
  coreTaskImport,
  coreTaskLint,
  coreTaskNext,
  coreTaskPromote,
  coreTaskRelates,
  coreTaskRelatesAdd,
  coreTaskReopen,
  coreTaskReorder,
  coreTaskReparent,
  coreTaskRestore,
  coreTaskTree,
  coreTaskUnarchive,
} from './tasks/task-ops.js';
export type { ComplexityFactor, FlatTreeNode } from './tasks/task-ops.js';

// Task work (additional)
export type { TaskWorkHistoryEntry } from './task-work/index.js';
export { getTaskHistory } from './task-work/index.js';
export { mergeTodoWriteState, analyzeChanges as analyzeTodoWriteChanges } from './task-work/todowrite-merge.js';
export type {
  TodoWriteItem,
  TodoWriteState,
  SyncSessionState,
  ChangeSet as TodoWriteChangeSet,
  TodoWriteMergeOptions,
  TodoWriteMergeResult,
} from './task-work/todowrite-merge.js';

// Templates
export { generateTemplateConfig, getTemplateForSubcommand, parseIssueTemplates } from './templates/parser.js';
export type { IssueTemplate, TemplateConfig, TemplateSection } from './templates/parser.js';

// Upgrade
export { runUpgrade } from './upgrade.js';

// Validation — param utils
export {
  buildCommanderArgs,
  buildCommanderOptionString,
  buildMcpInputSchema,
  camelToKebab,
  validateRequiredParamsDef,
} from './validation/param-utils.js';
export type { CommanderArgSplit, JSONSchemaObject, JsonSchemaProperty, JsonSchemaType } from './validation/param-utils.js';

// Validation — operation gates
export {
  GATE_VALIDATION_RULES,
  isFieldRequired,
  validateLayer1Schema,
  validateLayer2Semantic,
  validateLayer3Referential,
  validateLayer4Protocol,
  validateWorkflowGateName,
  validateWorkflowGateStatus,
  validateWorkflowGateUpdate,
  VALID_WORKFLOW_AGENTS,
  VALID_WORKFLOW_GATE_STATUSES,
} from './validation/operation-gate-validators.js';
export type { LayerResult, OperationContext } from './validation/operation-verification-gates.js';

// Validation — operation verification gates
export {
  GATE_SEQUENCE,
  getWorkflowGateDefinition,
  isValidWorkflowGateName,
  WORKFLOW_GATE_DEFINITIONS,
  WORKFLOW_GATE_SEQUENCE,
} from './validation/operation-verification-gates.js';
export type {
  GateLayer,
  GateViolation,
  WorkflowGateAgent,
  WorkflowGateDefinition,
  WorkflowGateName,
  WorkflowGateState,
  WorkflowGateStatus,
  WorkflowGateTracker,
} from './validation/operation-verification-gates.js';

// Validation — validate-ops
export {
  coreBatchValidate,
  coreCoherenceCheck,
  coreComplianceRecord,
  coreComplianceSummary,
  coreComplianceViolations,
  coreTestCoverage,
  coreTestRun,
  coreTestStatus,
  coreValidateManifest,
  coreValidateOutput,
  coreValidateProtocol,
  coreValidateSchema,
  coreValidateTask,
} from './validation/validate-ops.js';
export type { CoherenceIssue } from './validation/validate-ops.js';

// Validation — protocols
export { checkConsensusManifest, validateConsensusTask } from './validation/protocols/consensus.js';
export { checkContributionManifest, validateContributionTask as validateContributionProtocol } from './validation/protocols/contribution.js';
export { checkDecompositionManifest, validateDecompositionTask } from './validation/protocols/decomposition.js';
export { checkImplementationManifest, validateImplementationTask } from './validation/protocols/implementation.js';
export { checkSpecificationManifest, validateSpecificationTask } from './validation/protocols/specification.js';

// Validation — chain validation
export { validateChain } from './validation/chain-validation.js';

// Validation — verification gates (additional)
export { createVerificationGate } from './validation/operation-verification-gates.js';
export type { VerificationResult } from './validation/operation-verification-gates.js';

// ---------------------------------------------------------------------------
// Additional flat exports (TS2724 resolution for @cleocode/cleoctl)
// ---------------------------------------------------------------------------

// Remote (additional)
export { addRemote } from './remote/index.js';

// Sticky (additional)
export { addSticky } from './sticky/create.js';
export { getSticky } from './sticky/index.js';

// Orchestration (additional)
export { buildBrainState } from './orchestration/bootstrap.js';

// Phases (additional)
export { completePhase } from './phases/index.js';

// Tasks (additional — stats)
export { coreTaskStats } from './tasks/task-ops.js';

// Sessions (additional)
export { findSessions } from './sessions/find.js';
export { getSessionStats, suspendSession } from './sessions/index.js';

// OTel (additional)
export { getOtelStatus } from './otel/index.js';

// Roadmap
export { getRoadmap } from './roadmap/index.js';

// Lifecycle (additional)
export { listTesseraTemplates } from './lifecycle/tessera-engine.js';

// System (additional)
export type { MigrateResult } from './system/index.js';

// Snapshot (additional)
export { readSnapshot } from './snapshot/index.js';

// Store (additional)
export { resolveProjectRoot } from './store/file-utils.js';

// Release (additional)
export { tagRelease } from './release/release-manifest.js';

// Security (additional)
export {
  VALID_LIFECYCLE_STAGE_STATUSES,
  VALID_MANIFEST_STATUSES,
} from './security/input-sanitization.js';
export { TASK_PRIORITIES } from './store/tasks-schema.js';

// ---------------------------------------------------------------------------
// Additional flat exports (required by @cleocode/cleoctl)
// ---------------------------------------------------------------------------

// Build config
export { BUILD_CONFIG } from './config/build-config.js';
export type { BuildConfig } from './config/build-config.js';

// Init (additional)
export { initCoreSkills } from './init.js';

// Memory (additional)
export { writeMemoryBridge } from './memory/memory-bridge.js';
export { persistSessionMemory } from './memory/session-memory.js';
export { getSessionMemoryContext } from './memory/session-memory.js';
export type { SessionMemoryContext } from './memory/session-memory.js';

// Scaffold (additional)
export { ensureContributorMcp, ensureProjectContext, ensureGlobalTemplates } from './scaffold.js';

// Sequence (additional)
export { showSequence, checkSequence } from './sequence/index.js';

// Codebase map (additional)
export { mapCodebase } from './codebase-map/index.js';

// Sessions — grading
export { gradeSession, readGrades } from './sessions/session-grade.js';

// Compliance (additional)
export { syncComplianceMetrics } from './compliance/index.js';

// System — doctor
export { coreDoctorReport, runDoctorFixes } from './system/health.js';
export type { DoctorReport, FixResult } from './system/health.js';

// System — backup (different from store/backup.ts)
export { createBackup as systemCreateBackup } from './system/backup.js';

// Paths (additional)
export { getBackupDir, getTaskPath } from './paths.js';

// Tasks — plan, labels, suggests
export { coreTaskPlan } from './tasks/plan.js';
export { suggestRelated } from './tasks/relates.js';
export { listLabels, showLabelTasks } from './tasks/labels.js';

// Skills — precedence
export { getSkillsMapWithPrecedence, resolveSkillPathsForProvider, determineInstallationTargets } from './skills/precedence-integration.js';

// Orchestration — core versions (different signatures from skills versions)
export {
  getReadyTasks as orchestrationGetReadyTasks,
  getNextTask as orchestrationGetNextTask,
} from './orchestration/index.js';
export type { TaskReadiness } from './orchestration/index.js';
export { analyzeDependencies as orchestrationAnalyzeDependencies } from './orchestration/analyze.js';
export type { DependencyAnalysis } from './orchestration/analyze.js';
export { getCriticalPath as orchestrationGetCriticalPath } from './orchestration/critical-path.js';

// Spawn
export { initializeDefaultAdapters, spawnRegistry } from './spawn/adapter-registry.js';

// Nexus — readRegistry (exported as nexusReadRegistry to avoid name clash with skills readRegistry)
export { readRegistry as nexusReadRegistry } from './nexus/registry.js';
// Nexus — discoverRelated (exported as nexusDiscoverRelated to avoid name clash with tasks discoverRelated)
export { discoverRelated as nexusDiscoverRelated } from './nexus/discover.js';
// Nexus — searchAcrossProjects
export { searchAcrossProjects as nexusSearchAcrossProjects } from './nexus/discover.js';

// Compliance — protocol types
export { ProtocolType } from './compliance/protocol-enforcement.js';

// Verification gates — enums/classes
export { GateStatus, VerificationGate } from './validation/operation-verification-gates.js';
