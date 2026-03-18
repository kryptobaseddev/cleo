/**
 * CLEO core module — comprehensive barrel export.
 *
 * Re-exports all public APIs from core submodules and top-level utilities.
 * Uses namespace re-exports to avoid naming conflicts across submodules.
 *
 * Usage:
 *   import { tasks, sessions, memory, release } from '../core/index.js';
 *   const result = await tasks.addTask(...);
 *
 * @task T5709
 * @epic T5701
 */

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
// Top-level utility re-exports (widely used, unique names)
// ---------------------------------------------------------------------------

// LAFS type guards (from types layer, re-exported for convenience)
export type {
  CleoResponse,
  GatewayEnvelope,
  GatewayError,
  GatewayMeta,
  GatewaySuccess,
  LafsAlternative,
  LafsErrorDetail,
} from '../types/lafs.js';
export { isGatewayEnvelope, isLafsError, isLafsSuccess } from '../types/lafs.js';
// Audit
export type { AuditEntry } from './audit.js';
export { queryAudit } from './audit.js';
// Audit prune
export type { PruneResult } from './audit-prune.js';
export { pruneAuditLog } from './audit-prune.js';
// CAAMP bootstrap
export { bootstrapCaamp } from './caamp-init.js';

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
// Engine result type
export type { EngineResult } from './engine-result.js';
// Error catalog (RFC 9457)
export type { ErrorDefinition } from './error-catalog.js';
export {
  ERROR_CATALOG,
  getAllErrorDefinitions,
  getErrorDefinition,
  getErrorDefinitionByLafsCode,
} from './error-catalog.js';
// Error registry
export type { CleoRegistryEntry } from './error-registry.js';
export {
  getCleoErrorRegistry,
  getRegistryEntry,
  getRegistryEntryByLafsCode,
  isCleoRegisteredCode,
} from './error-registry.js';
// Errors
export type { ProblemDetails } from './errors.js';
export { CleoError } from './errors.js';
// Git hooks
export type { EnsureGitHooksOptions, HookCheckResult, ManagedHook } from './hooks.js';
export { checkGitHooks, ensureGitHooks, MANAGED_HOOKS } from './hooks.js';
// Init
export type { InitOptions, InitResult } from './init.js';
export {
  ensureInitialized,
  getVersion,
  initAgentDefinition,
  initCoreSkills,
  initMcpServer,
  initNexusRegistration,
  initProject,
  isAutoInitEnabled,
  updateDocs,
} from './init.js';
// Injection
export type { InjectionCheckResult } from './injection.js';
export {
  buildContributorInjectionBlock,
  checkInjection,
  ensureInjection,
  getInjectionTemplateContent,
} from './injection.js';
// JSON Schema validation
export {
  checkSchema,
  validateAgainstSchema,
  validateAgainstSchemaFile,
} from './json-schema-validator.js';
// Logger
export type { LoggerConfig } from './logger.js';
export { closeLogger, getLogDir, getLogger, initLogger } from './logger.js';
// Output formatting (LAFS envelope)
export type { FormatOptions, LafsEnvelope, LafsError, LafsSuccess } from './output.js';
export { formatError, formatOutput, formatSuccess, pushWarning } from './output.js';
// Pagination
export type { PaginateInput } from './pagination.js';
export { createPage, paginate } from './pagination.js';
// Paths — foundational utilities used across the entire codebase
export {
  getAgentOutputsAbsolute,
  getAgentOutputsDir,
  getAgentsHome,
  getArchivePath,
  getBackupDir,
  getClaudeAgentsDir,
  getClaudeDir,
  getClaudeMemDbPath,
  getClaudeSettingsPath,
  getCleoCacheDir,
  getCleoConfigDir,
  getCleoDir,
  getCleoDirAbsolute,
  getCleoDocsDir,
  getCleoHome,
  getCleoLogDir,
  getCleoSchemasDir,
  getCleoTempDir,
  getCleoTemplatesDir,
  getConfigPath,
  getGlobalConfigPath,
  getLogPath,
  getManifestArchivePath,
  getManifestPath,
  getProjectRoot,
  getSessionsPath,
  getTaskPath,
  isAbsolutePath,
  isProjectInitialized,
  resolveProjectPath,
} from './paths.js';
// Platform utilities
export type { Platform, SystemInfo } from './platform.js';
export {
  checkRequiredTools,
  commandExists,
  createTempFilePath,
  dateDaysAgo,
  detectPlatform,
  generateRandomHex,
  // Store utilities re-exported via platform
  getDataPath,
  getFileMtime,
  getFileSize,
  getIsoTimestamp,
  getNodeUpgradeInstructions,
  getNodeVersionInfo,
  getSystemInfo,
  isoToEpoch,
  MINIMUM_NODE_MAJOR,
  PLATFORM,
  readJsonFile,
  requireTool,
  resolveProjectRoot,
  sha256,
  writeJsonFileAtomic,
} from './platform.js';
// Project info
export type { ProjectInfo } from './project-info.js';
export { getProjectInfo, getProjectInfoSync } from './project-info.js';
// Repair
export type { RepairAction } from './repair.js';
export {
  repairMissingCompletedAt,
  repairMissingSizes,
  runAllRepairs,
} from './repair.js';
// Scaffold
export {
  type CheckResult as ScaffoldCheckResult,
  type CheckStatus,
  CLEO_GITIGNORE_FALLBACK,
  checkBrainDb,
  checkCleoGitRepo,
  checkCleoStructure,
  checkConfig,
  checkGlobalHome,
  checkGlobalTemplates,
  checkLogDir,
  checkMemoryBridge,
  checkProjectContext,
  checkProjectInfo,
  checkSqliteDb,
  createDefaultConfig,
  ensureBrainDb,
  ensureCleoGitRepo,
  ensureCleoStructure,
  ensureConfig,
  ensureContributorMcp,
  ensureGitignore,
  ensureGlobalHome,
  ensureGlobalScaffold,
  ensureGlobalTemplates,
  ensureProjectContext,
  ensureProjectInfo,
  ensureSqliteDb,
  fileExists,
  generateProjectHash,
  getCleoVersion,
  getGitignoreContent,
  getPackageRoot,
  REQUIRED_CLEO_SUBDIRS,
  REQUIRED_GLOBAL_SUBDIRS,
  removeCleoFromRootGitignore,
  type ScaffoldResult,
  stripCLEOBlocks,
} from './scaffold.js';
// Schema management
export type { InstalledSchema, SchemaInstallResult, StalenessReport } from './schema-management.js';
export {
  checkGlobalSchemas,
  checkSchemaStaleness,
  cleanProjectSchemas,
  ensureGlobalSchemas,
  getSchemaVersion,
  listInstalledSchemas,
  resolveSchemaPath,
} from './schema-management.js';

// Upgrade
export type { UpgradeAction, UpgradeResult } from './upgrade.js';
export { runUpgrade } from './upgrade.js';

// ---------------------------------------------------------------------------
// Flat re-exports for dispatch layer (T5718)
// These are in addition to the namespace re-exports above, allowing
// dispatch engines to use: import { addTask } from '@cleocode/core'
// ---------------------------------------------------------------------------

// Adapters
export { AdapterManager } from './adapters/index.js';

// Admin submodules (sync not in admin/index.ts)
export { exportTasks } from './admin/export.js';
export { exportTasksPackage } from './admin/export-tasks.js';
export { computeHelp } from './admin/help.js';
export { importTasks } from './admin/import.js';
export { importTasksPackage } from './admin/import-tasks.js';
export { clearSyncState, getSyncStatus } from './admin/sync.js';

// ADRs
export {
  findAdrs,
  listAdrs,
  showAdr,
  syncAdrsToDb,
  validateAllAdrs,
} from './adrs/index.js';
export type { ViolationLogEntry } from './compliance/protocol-enforcement.js';
// Compliance (protocol enforcement)
export {
  ProtocolEnforcer,
  ProtocolType,
  protocolEnforcer,
} from './compliance/protocol-enforcement.js';
export type {
  ProtocolRule,
  ProtocolValidationResult,
  ProtocolViolation,
  RequirementLevel,
  ViolationSeverity,
} from './compliance/protocol-rules.js';
// Compliance (protocol rules)
export { PROTOCOL_RULES } from './compliance/protocol-rules.js';

// Hooks singleton and registry
export { HookRegistry, hooks } from './hooks/registry.js';

// Hooks types
export type { HookEvent, ProviderHookEvent } from './hooks/types.js';
export { isProviderHookEvent } from './hooks/types.js';

// Issue diagnostics
export { collectDiagnostics } from './issue/diagnostics.js';
// Lifecycle chain-store
export {
  addChain,
  advanceInstance,
  createInstance,
  listChains,
  showChain,
} from './lifecycle/chain-store.js';
// Lifecycle (flat re-exports alongside namespace)
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

// Lifecycle tessera-engine
export {
  instantiateTessera,
  listTesseraTemplates,
  showTessera,
} from './lifecycle/tessera-engine.js';

// Memory engine-compat (memory ops via engine layer)
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

// Memory pipeline manifest
export type { ManifestEntry } from './memory/pipeline-manifest-sqlite.js';
export {
  filterEntries,
  pipelineManifestAppend,
  pipelineManifestArchive,
  pipelineManifestFind,
  pipelineManifestList,
  pipelineManifestPending,
  pipelineManifestShow,
  pipelineManifestStats,
  readManifestEntries,
} from './memory/pipeline-manifest-sqlite.js';

// Metrics token service
export {
  autoRecordDispatchTokenUsage,
  clearTokenUsage,
  deleteTokenUsage,
  listTokenUsage,
  recordTokenExchange,
  showTokenUsage,
  summarizeTokenUsage,
} from './metrics/token-service.js';

// Nexus submodules
export {
  blockingAnalysis,
  buildGlobalGraph,
  criticalPath,
  nexusDeps,
  orphanDetection,
} from './nexus/deps.js';
export { discoverRelated, searchAcrossProjects } from './nexus/discover.js';
export { setPermission } from './nexus/permissions.js';
export { resolveTask, validateSyntax } from './nexus/query.js';
export type { NexusPermissionLevel } from './nexus/registry.js';
export {
  nexusGetProject,
  nexusInit,
  nexusList,
  nexusReconcile,
  nexusRegister,
  nexusSync,
  nexusSyncAll,
  nexusUnregister,
  readRegistry,
} from './nexus/registry.js';
export { getSharingStatus } from './nexus/sharing/index.js';

// Orchestration submodules (flat re-exports alongside namespace)
export { analyzeDependencies } from './orchestration/analyze.js';
export { buildBrainState } from './orchestration/bootstrap.js';
export { estimateContext } from './orchestration/context.js';
export { getCriticalPath } from './orchestration/critical-path.js';
export {
  analyzeEpic,
  getNextTask,
  getReadyTasks,
  prepareSpawn,
} from './orchestration/index.js';
export {
  endParallelExecution,
  getParallelStatus,
  startParallelExecution,
} from './orchestration/parallel.js';
export { getSkillContent } from './orchestration/skill-ops.js';
export {
  computeEpicStatus,
  computeOverallStatus,
  computeProgress,
  computeStartupSummary,
} from './orchestration/status.js';
export { getUnblockOpportunities } from './orchestration/unblock.js';
export { validateSpawnReadiness } from './orchestration/validate-spawn.js';
export { getEnrichedWaves } from './orchestration/waves.js';

// Phases
export {
  advancePhase,
  completePhase,
  deletePhase,
  type ListPhasesResult,
  listPhases,
  renamePhase,
  setPhase,
  showPhase,
  startPhase,
} from './phases/index.js';

// Release submodules (flat re-exports alongside namespace)
export {
  channelToDistTag,
  describeChannel,
  resolveChannelFromBranch,
} from './release/channel.js';
export type { PRResult } from './release/github-pr.js';
export {
  buildPRBody,
  createPullRequest,
  isGhCliAvailable,
} from './release/github-pr.js';
export { checkDoubleListing, checkEpicCompleteness } from './release/guards.js';
export {
  getGitFlowConfig,
  getPushMode,
  loadReleaseConfig,
} from './release/release-config.js';
export type { ReleaseListOptions, ReleaseTaskRecord } from './release/release-manifest.js';
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
  tagRelease,
} from './release/release-manifest.js';
export { bumpVersionFromConfig, getVersionBumpConfig } from './release/version-bump.js';

// Roadmap
export { getRoadmap } from './roadmap/index.js';

// Routing
export type {
  CapabilityReport,
  ExecutionMode,
  GatewayType,
  OperationCapability,
  PreferredChannel,
} from './routing/capability-matrix.js';
export {
  canRunNatively,
  generateCapabilityReport,
  getCapabilityMatrix,
  getNativeOperations,
  getOperationMode,
  requiresCLI,
} from './routing/capability-matrix.js';

// Security input sanitization
export type { RateLimitConfig, RateLimitResult } from './security/input-sanitization.js';
export {
  ALL_VALID_STATUSES,
  DEFAULT_RATE_LIMITS,
  ensureArray,
  RateLimiter,
  SecurityError,
  sanitizeContent,
  sanitizeParams,
  sanitizePath,
  sanitizeTaskId,
  VALID_DOMAINS,
  VALID_GATEWAYS,
  VALID_LIFECYCLE_STAGE_STATUSES,
  VALID_MANIFEST_STATUSES,
  VALID_PRIORITIES,
  validateEnum,
} from './security/input-sanitization.js';

// Sequence
export { repairSequence } from './sequence/index.js';
export type { SessionBriefing } from './sessions/briefing.js';
// Sessions context alert (session ID access)
export { getCurrentSessionId } from './sessions/context-alert.js';
export type { ContextInjectionData } from './sessions/context-inject.js';
export { injectContext } from './sessions/context-inject.js';
export type { FindSessionsParams, MinimalSessionRecord } from './sessions/find.js';
export type {
  ComputeDebriefOptions,
  DebriefData,
  DebriefDecision,
  HandoffData,
} from './sessions/handoff.js';
export { computeDebrief } from './sessions/handoff.js';
// Sessions submodules (flat alongside namespace)
export {
  archiveSessions,
  cleanupSessions,
  computeBriefing,
  computeHandoff,
  endSession,
  findSessions,
  gcSessions,
  getContextDrift,
  getDecisionLog,
  getLastHandoff,
  getSessionHistory,
  getSessionStats,
  listSessions,
  parseScope,
  persistHandoff,
  readSessions,
  recordAssumption,
  recordDecision,
  resumeSession,
  saveSessions,
  sessionStatus,
  showSession,
  startSession,
  suspendSession,
  switchSession,
} from './sessions/index.js';
export { generateSessionId } from './sessions/session-id.js';
export type { DecisionRecord } from './sessions/types.js';

// Snapshot
export {
  exportSnapshot,
  getDefaultSnapshotPath,
  importSnapshot,
  readSnapshot,
  writeSnapshot,
} from './snapshot/index.js';

// Stats
export { getDashboard, getProjectStats } from './stats/index.js';
export {
  addSticky,
  archiveSticky,
  convertStickyToMemory,
  convertStickyToSessionNote,
  convertStickyToTask,
  convertStickyToTaskNote,
  getSticky,
  listStickies,
  purgeSticky,
} from './sticky/index.js';
// Sticky
export type { CreateStickyParams, ListStickiesParams, StickyNote } from './sticky/types.js';

// System submodules (flat re-exports alongside namespace)
export type { ArchiveStatsResult } from './system/archive-stats.js';
export { getArchiveStats } from './system/archive-stats.js';
export type { AuditResult } from './system/audit.js';
export { auditData } from './system/audit.js';
export type { BackupResult, RestoreResult } from './system/backup.js';
export { createBackup, restoreBackup } from './system/backup.js';
export type { CleanupResult } from './system/cleanup.js';
export { cleanupSystem } from './system/cleanup.js';
export type { DiagnosticsResult, HealthResult, StartupHealthResult } from './system/health.js';
export { getSystemDiagnostics, getSystemHealth, startupHealthCheck } from './system/health.js';
export type { InjectGenerateResult } from './system/inject-generate.js';
export { generateInjection } from './system/inject-generate.js';
export type { LabelsResult } from './system/labels.js';
export { getLabels } from './system/labels.js';
export type { SystemMetricsResult } from './system/metrics.js';
export { getSystemMetrics } from './system/metrics.js';
export type { MigrateResult } from './system/migrate.js';
export { getMigrationStatus } from './system/migrate.js';
export type { RuntimeDiagnostics } from './system/runtime.js';
export { getRuntimeDiagnostics } from './system/runtime.js';
export type { SafestopResult, UncancelResult } from './system/safestop.js';
export { safestop, uncancelTask } from './system/safestop.js';

// Task work
export type { TaskWorkHistoryEntry } from './task-work/index.js';
export { currentTask, getTaskHistory, startTask, stopTask } from './task-work/index.js';

// Tasks submodules (flat re-exports alongside namespace)
export { addTask } from './tasks/add.js';
export { archiveTasks } from './tasks/archive.js';
export { completeTask } from './tasks/complete.js';
export { deleteTask } from './tasks/delete.js';
export { findTasks } from './tasks/find.js';
// Tasks ID generator
export { normalizeTaskId } from './tasks/id-generator.js';
export type { CompactTask } from './tasks/list.js';
export { listTasks, toCompact } from './tasks/list.js';
export { showTask } from './tasks/show.js';
export type {
  ComplexityFactor,
  TaskTreeNode,
} from './tasks/task-ops.js';
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
  coreTaskStats,
  coreTaskTree,
  coreTaskUnarchive,
} from './tasks/task-ops.js';
export { updateTask } from './tasks/update.js';

// Templates parser
export type {
  IssueTemplate,
  TemplateConfig,
  TemplateSection,
} from './templates/parser.js';
export {
  generateTemplateConfig,
  getTemplateForSubcommand,
  parseIssueTemplates,
  validateLabels,
} from './templates/parser.js';

// Validation submodules (flat re-exports alongside namespace)
export { validateChain } from './validation/chain-validation.js';
// Gate validators
export {
  GATE_VALIDATION_RULES,
  isFieldRequired,
  VALID_WORKFLOW_AGENTS,
  VALID_WORKFLOW_GATE_STATUSES,
  validateLayer1Schema,
  validateLayer2Semantic,
  validateLayer3Referential,
  validateLayer4Protocol,
  validateWorkflowGateName,
  validateWorkflowGateStatus,
  validateWorkflowGateUpdate,
} from './validation/operation-gate-validators.js';
export type {
  GateViolation,
  LayerResult,
  OperationContext,
  VerificationResult,
  WorkflowGateAgent,
  WorkflowGateDefinition,
  WorkflowGateState,
  WorkflowGateStatus,
} from './validation/operation-verification-gates.js';
export {
  createVerificationGate,
  GATE_SEQUENCE,
  GateLayer,
  GateStatus,
  getWorkflowGateDefinition,
  isValidWorkflowGateName,
  VerificationGate,
  WORKFLOW_GATE_DEFINITIONS,
  WORKFLOW_GATE_SEQUENCE,
  WorkflowGateName,
  WorkflowGateTracker,
} from './validation/operation-verification-gates.js';
export type {
  CommanderArgSplit,
  JSONSchemaObject,
  JsonSchemaProperty,
  JsonSchemaType,
} from './validation/param-utils.js';
export {
  buildCommanderArgs,
  buildCommanderOptionString,
  buildMcpInputSchema,
  camelToKebab,
  validateRequiredParamsDef,
} from './validation/param-utils.js';
export {
  checkConsensusManifest,
  validateConsensusTask,
} from './validation/protocols/consensus.js';
export {
  checkContributionManifest,
  validateContributionTask,
} from './validation/protocols/contribution.js';
export {
  checkDecompositionManifest,
  validateDecompositionTask,
} from './validation/protocols/decomposition.js';
export {
  checkImplementationManifest,
  validateImplementationTask,
} from './validation/protocols/implementation.js';
export {
  checkSpecificationManifest,
  validateSpecificationTask,
} from './validation/protocols/specification.js';
export type { CoherenceIssue } from './validation/validate-ops.js';
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

// ---------------------------------------------------------------------------
// Additional flat re-exports for CLI layer (T5719)
// ---------------------------------------------------------------------------

// MCP server entry generation
export type { McpEnvMode } from './mcp/index.js';
export { detectEnvMode, generateMcpServerEntry, getMcpServerName } from './mcp/index.js';

// Memory claude-mem migration
export type {
  ClaudeMemMigrationOptions,
  ClaudeMemMigrationResult,
} from './memory/claude-mem-migration.js';
export { migrateClaudeMem } from './memory/claude-mem-migration.js';
// Metrics token service (measureTokenExchange not yet flat-exported)
export { measureTokenExchange } from './metrics/token-service.js';
// OTel operations
export {
  clearOtelData,
  getOtelSessions,
  getOtelSpawns,
  getOtelStatus,
  getOtelSummary,
  getRealTokenUsage,
} from './otel/index.js';
// Remote git operations (prefixed to avoid conflict with admin getSyncStatus)
export type { PullResult, PushResult, RemoteConfig, RemoteInfo } from './remote/index.js';
export {
  addRemote,
  getCurrentBranch,
  getSyncStatus as getRemoteSyncStatus,
  listRemotes,
  pull,
  push,
  removeRemote,
} from './remote/index.js';
// System storage preflight
export type { PreflightResult } from './system/storage-preflight.js';
export { checkStorageMigration } from './system/storage-preflight.js';

// Validation doctor checks (flat re-export)
export { checkRootGitignore } from './validation/doctor/checks.js';
