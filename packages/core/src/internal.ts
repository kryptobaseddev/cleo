/**
 * @cleocode/core/internal — Internal API for @cleocode/cleo.
 *
 * This entry point is a SUPERSET of the public API. It re-exports everything
 * from `@cleocode/core` plus additional symbols needed by the dispatch layer,
 * CLI commands, MCP gateways, and engine adapters inside @cleocode/cleo.
 *
 * External consumers should import from `@cleocode/core` (the public API).
 * Only @cleocode/cleo should import from `@cleocode/core/internal`.
 *
 * @package @cleocode/core
 * @internal
 */

// ---------------------------------------------------------------------------
// Re-export the entire public API (superset)
// ---------------------------------------------------------------------------

export * from './index.js';

// ---------------------------------------------------------------------------
// Extended flat exports (required by @cleocode/cleo)
// ---------------------------------------------------------------------------

export { exportTasks } from './admin/export.js';
export { exportTasksPackage } from './admin/export-tasks.js';
// Admin
export { computeHelp } from './admin/help.js';
export { importTasks } from './admin/import.js';
export { importFromPackage, importTasksPackage } from './admin/import-tasks.js';
// ADRs
export { findAdrs } from './adrs/find.js';
export { listAdrs, showAdr, syncAdrsToDb, validateAllAdrs } from './adrs/index.js';
// Audit
export type { AuditEntry } from './audit.js';
// Backfill
export type { BackfillOptions, BackfillResult, BackfillTaskChange } from './backfill/index.js';
export { backfillTasks, generateAcFromDescription } from './backfill/index.js';
export type { BootstrapContext, BootstrapOptions } from './bootstrap.js';
// Bootstrap (global setup)
export {
  bootstrapGlobalCleo,
  installMcpToProviders,
  installSkillsGlobally,
} from './bootstrap.js';
export type { ViolationLogEntry } from './compliance/protocol-enforcement.js';
// Compliance
export { ProtocolEnforcer, protocolEnforcer } from './compliance/protocol-enforcement.js';
export type {
  ProtocolRule,
  ProtocolValidationResult,
  ProtocolViolation,
  RequirementLevel,
  ViolationSeverity,
} from './compliance/protocol-rules.js';
export { PROTOCOL_RULES } from './compliance/protocol-rules.js';
export type { PayloadValidationResult } from './hooks/payload-schemas.js';
export { validatePayload } from './hooks/payload-schemas.js';
// Hooks
export type { HookEvent, ProviderHookEvent } from './hooks/provider-hooks.js';
export { isProviderHookEvent } from './hooks/types.js';

// Init (additional)
export { isAutoInitEnabled } from './init.js';
export {
  analyzeChangeImpact,
  analyzeTaskImpact,
  calculateBlastRadius,
  predictImpact,
} from './intelligence/impact.js';
export {
  extractPatternsFromHistory,
  matchPatterns,
  storeDetectedPattern,
  updatePatternStats,
} from './intelligence/patterns.js';
export {
  calculateTaskRisk,
  gatherLearningContext,
  predictValidationOutcome,
} from './intelligence/prediction.js';
// Intelligence — quality prediction and pattern extraction
export type {
  AffectedTask,
  BlastRadius,
  BlastRadiusSeverity,
  ChangeImpact,
  ChangeType,
  DetectedPattern,
  ImpactAssessment,
  ImpactedTask,
  ImpactReport,
  LearningContext,
  PatternExtractionOptions,
  PatternMatch,
  PatternStatsUpdate,
  RiskAssessment,
  RiskFactor,
  ValidationPrediction,
} from './intelligence/types.js';
export { type AddIssueParams, type AddIssueResult, addIssue } from './issue/create.js';
// Issue
export { collectDiagnostics } from './issue/diagnostics.js';
// Lib — shared primitives
export {
  computeDelay,
  type RetryablePredicate,
  type RetryContext,
  type RetryOptions,
  withRetry as withRetryShared,
} from './lib/retry.js';
export {
  addChain,
  advanceInstance,
  createInstance,
  listChains,
  showChain,
} from './lifecycle/chain-store.js';
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
export { instantiateTessera, showTessera } from './lifecycle/tessera-engine.js';

// MCP helpers
export { detectEnvMode, generateMcpServerEntry, getMcpServerName } from './mcp/index.js';
// Memory — brain lifecycle (temporal decay + consolidation)
export type { ConsolidationResult, DecayResult } from './memory/brain-lifecycle.js';
export { applyTemporalDecay, consolidateMemories } from './memory/brain-lifecycle.js';
// Memory — brain maintenance
export type {
  BrainMaintenanceConsolidationResult,
  BrainMaintenanceDecayResult,
  BrainMaintenanceEmbeddingsResult,
  BrainMaintenanceOptions,
  BrainMaintenanceReconciliationResult,
  BrainMaintenanceResult,
} from './memory/brain-maintenance.js';
export { runBrainMaintenance } from './memory/brain-maintenance.js';
export type {
  PopulateEmbeddingsOptions,
  PopulateEmbeddingsResult,
} from './memory/brain-retrieval.js';
export { populateEmbeddings } from './memory/brain-retrieval.js';
export { migrateClaudeMem } from './memory/claude-mem-migration.js';
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
export {
  blockingAnalysis,
  buildGlobalGraph,
  criticalPath,
  nexusDeps,
  orphanDetection,
} from './nexus/deps.js';
// Nexus
export { searchAcrossProjects } from './nexus/discover.js';
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
} from './nexus/registry.js';
export { getSharingStatus } from './nexus/sharing/index.js';
// Context
export { estimateContext } from './orchestration/context.js';
// Orchestration
export { analyzeEpic, prepareSpawn } from './orchestration/index.js';
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
// OTel
export {
  clearOtelData,
  getOtelSessions,
  getOtelSpawns,
  getOtelSummary,
  getRealTokenUsage,
} from './otel/index.js';
// Paths (additional)
export { getAgentOutputsAbsolute, getAgentsHome } from './paths.js';
// Phases — dependency graph (taskId-scoped critical path; distinct from tasks/graph-ops getCriticalPath)
export type { CriticalPathResult as DepsCriticalPathResult } from './phases/deps.js';
export { getCriticalPath as depsCriticalPath } from './phases/deps.js';
export type { ListPhasesResult } from './phases/index.js';
// Phases
export { advancePhase, deletePhase, renamePhase, setPhase, startPhase } from './phases/index.js';
// Pipeline
export { listPhases, showPhase } from './pipeline/index.js';
// Platform (additional)
export { getNodeUpgradeInstructions, getNodeVersionInfo } from './platform.js';
// Reconciliation (additional)
export {
  createLink,
  getLinkByExternalId,
  getLinksByProvider,
  getLinksByTaskId,
  removeLinksByProvider,
  touchLink,
} from './reconciliation/link-store.js';
// Release
export { channelToDistTag, describeChannel, resolveChannelFromBranch } from './release/channel.js';
export type { PRResult } from './release/github-pr.js';
export { buildPRBody, createPullRequest, isGhCliAvailable } from './release/github-pr.js';
export { checkDoubleListing, checkEpicCompleteness } from './release/guards.js';
export { getGitFlowConfig, getPushMode, loadReleaseConfig } from './release/release-config.js';
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
} from './release/release-manifest.js';
export { bumpVersionFromConfig, getVersionBumpConfig } from './release/version-bump.js';
// Remote
// Remote git sync status (ahead/behind/branch)
export {
  getSyncStatus as getRemoteSyncStatus,
  listRemotes,
  pull,
  push,
  removeRemote,
} from './remote/index.js';
export type {
  CapabilityReport,
  ExecutionMode,
  GatewayType,
  OperationCapability,
  PreferredChannel,
} from './routing/capability-matrix.js';
// Routing
export {
  canRunNatively,
  generateCapabilityReport,
  getCapabilityMatrix,
  getNativeOperations,
  getOperationMode,
  requiresCLI,
} from './routing/capability-matrix.js';
export type { RateLimitConfig, RateLimitResult } from './security/index.js';
// Security
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
  VALID_PRIORITIES,
  validateEnum,
} from './security/input-sanitization.js';
// Sequence
export { repairSequence } from './sequence/index.js';
export { recordAssumption } from './sessions/assumptions.js';
export type { SessionBriefing } from './sessions/briefing.js';
export { computeBriefing } from './sessions/briefing.js';
export { getCurrentSessionId } from './sessions/context-alert.js';
export type { ContextInjectionData } from './sessions/context-inject.js';
export { injectContext } from './sessions/context-inject.js';
export { getDecisionLog, recordDecision } from './sessions/decisions.js';
export type { FindSessionsParams, MinimalSessionRecord } from './sessions/find.js';
export type { DebriefData, HandoffData } from './sessions/handoff.js';
export {
  computeDebrief,
  computeHandoff,
  getLastHandoff,
  persistHandoff,
} from './sessions/handoff.js';
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
export { generateSessionId } from './sessions/session-id.js';
export type { DecisionRecord } from './sessions/types.js';
export { readRegistry } from './skills/agents/registry.js';
export { validateContributionTask } from './skills/manifests/contribution.js';
export { filterEntries } from './skills/manifests/research.js';
// Skills
export { analyzeDependencies, getNextTask, getReadyTasks } from './skills/orchestrator/startup.js';
export type { ManifestEntry } from './skills/types.js';
// Snapshot
export {
  exportSnapshot,
  getDefaultSnapshotPath,
  importSnapshot,
  writeSnapshot,
} from './snapshot/index.js';
// System
export { getDashboard, getProjectStats } from './stats/index.js';
// Workflow telemetry (T065)
export {
  getWorkflowComplianceReport,
  type WorkflowComplianceReport,
  type WorkflowRuleMetric,
} from './stats/workflow-telemetry.js';
// Sticky
export { archiveSticky } from './sticky/archive.js';
export {
  convertStickyToMemory,
  convertStickyToSessionNote,
  convertStickyToTask,
  convertStickyToTaskNote,
} from './sticky/convert.js';
export { listStickies, purgeSticky } from './sticky/index.js';
export type { CreateStickyParams, ListStickiesParams, StickyNote } from './sticky/types.js';
// Store
export { createBackup, listBackups, restoreFromBackup } from './store/backup.js';
export { getBrainDb, getBrainNativeDb } from './store/brain-sqlite.js';
export {
  gitCheckpoint,
  gitCheckpointStatus,
  isCleoGitInitialized,
} from './store/git-checkpoint.js';
export { computeChecksum, readJson } from './store/json.js';
export { createSession, getActiveSession } from './store/session-store.js';
export {
  checkSignaldockDbHealth,
  ensureSignaldockDb,
  getSignaldockDbPath,
  SIGNALDOCK_SCHEMA_VERSION,
} from './store/signaldock-sqlite.js';
export { getDb, getNativeDb } from './store/sqlite.js';
export { createTask, getTask } from './store/task-store.js';
export {
  auditLog,
  externalTaskLinks,
  releaseManifests,
  taskDependencies,
  tasks,
} from './store/tasks-schema.js';
export { AuditLogInsertSchema } from './store/validation-schemas.js';
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
export type { AuditResult } from './system/audit.js';
export { auditData } from './system/audit.js';
export type { BackupEntry, BackupResult, RestoreResult } from './system/backup.js';
export { listSystemBackups, restoreBackup } from './system/backup.js';
export type { CleanupResult } from './system/cleanup.js';
export { cleanupSystem } from './system/cleanup.js';
export type { DiagnosticsResult, HealthResult } from './system/health.js';
export { getSystemDiagnostics, getSystemHealth, startupHealthCheck } from './system/health.js';
export type {
  InjectGenerateResult,
  LabelsResult,
  RuntimeDiagnostics,
  SafestopResult,
  SystemMetricsResult,
  UncancelResult,
} from './system/index.js';
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
// Task work (additional)
export type { TaskWorkHistoryEntry } from './task-work/index.js';
export { getTaskHistory } from './task-work/index.js';
// Tasks (additional)
export { validateLabels } from './tasks/add.js';
export { getCriticalPath } from './tasks/graph-ops.js';
export type { TaskTreeNode } from './tasks/hierarchy.js';
export type { CompactTask } from './tasks/list.js';
export { toCompact } from './tasks/list.js';
export { discoverRelated } from './tasks/relates.js';
export type { ComplexityFactor, FlatTreeNode } from './tasks/task-ops.js';
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
export type { IssueTemplate, TemplateConfig, TemplateSection } from './templates/parser.js';
// Templates
export {
  generateTemplateConfig,
  getTemplateForSubcommand,
  parseIssueTemplates,
} from './templates/parser.js';
export type { DiagnoseFinding, DiagnoseResult, UpgradeSummary } from './upgrade.js';
// Upgrade
export { diagnoseUpgrade, runUpgrade } from './upgrade.js';
// Validation — chain validation
export { validateChain } from './validation/chain-validation.js';
// Validation — operation gates
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
// Validation — operation verification gates
// Validation — verification gates (additional)
export {
  createVerificationGate,
  GATE_SEQUENCE,
  GateLayer,
  getWorkflowGateDefinition,
  isValidWorkflowGateName,
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
// Validation — param utils
export {
  buildCommanderArgs,
  buildCommanderOptionString,
  buildMcpInputSchema,
  camelToKebab,
  validateRequiredParamsDef,
} from './validation/param-utils.js';
// Validation — protocols
export { checkConsensusManifest, validateConsensusTask } from './validation/protocols/consensus.js';
export {
  checkContributionManifest,
  validateContributionTask as validateContributionProtocol,
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

// ---------------------------------------------------------------------------
// Additional flat exports (TS2724 resolution for @cleocode/cleo)
// ---------------------------------------------------------------------------

// Lifecycle (additional)
export { listTesseraTemplates } from './lifecycle/tessera-engine.js';
// Orchestration (additional)
export { buildBrainState } from './orchestration/bootstrap.js';
// OTel (additional)
export { getOtelStatus } from './otel/index.js';
// Phases (additional)
export { completePhase } from './phases/index.js';
// Release (additional)
export { tagRelease } from './release/release-manifest.js';
// Remote (additional)
export { addRemote } from './remote/index.js';
// Roadmap
export { getRoadmap } from './roadmap/index.js';
// Security (additional)
export {
  VALID_LIFECYCLE_STAGE_STATUSES,
  VALID_MANIFEST_STATUSES,
} from './security/input-sanitization.js';
// Sessions (additional)
export { findSessions } from './sessions/find.js';
export { getSessionStats, suspendSession } from './sessions/index.js';
// Snapshot (additional)
export { readSnapshot } from './snapshot/index.js';
// Sticky (additional)
export { addSticky } from './sticky/create.js';
export { getSticky } from './sticky/index.js';

// Store (additional)
export { resolveProjectRoot } from './store/file-utils.js';
export { TASK_PRIORITIES } from './store/tasks-schema.js';
// System (additional)
export type { MigrateResult } from './system/index.js';
// Tasks (additional — stats)
export { coreTaskStats } from './tasks/task-ops.js';

// ---------------------------------------------------------------------------
// Additional flat exports (required by @cleocode/cleo)
// ---------------------------------------------------------------------------

export type {
  AgentExecutionEvent,
  AgentExecutionOutcome,
  AgentHealthReport,
  AgentHealthStatus,
  AgentPerformanceSummary,
  AgentRecoveryResult,
  CapacitySummary,
  HealingSuggestion,
  ListAgentFilters,
  RegisterAgentOptions,
  RetryPolicy,
  RetryResult,
  UpdateStatusOptions,
} from './agents/index.js';
// Agents — runtime registry, health, retry, capacity
export {
  // health-monitor functions (T039)
  checkAgentHealth,
  // registry / capacity / retry
  classifyError,
  createRetryPolicy,
  DEFAULT_RETRY_POLICY,
  deregisterAgent,
  detectCrashedAgents,
  detectStaleAgents,
  findLeastLoadedAgent,
  findStaleAgentRows,
  generateAgentId,
  getAgentErrorHistory,
  getAgentInstance,
  getAgentPerformanceHistory,
  getAvailableCapacity,
  getCapacitySummary,
  getHealthReport,
  getSelfHealingSuggestions,
  HEARTBEAT_INTERVAL_MS,
  heartbeat,
  incrementTasksCompleted,
  isOverloaded,
  listAgentInstances,
  markCrashed,
  processAgentLifecycleEvent,
  recordAgentExecution,
  recordFailurePattern,
  recordHeartbeat,
  recoverCrashedAgents,
  registerAgent as registerAgentInstance,
  STALE_THRESHOLD_MS,
  storeHealingStrategy,
  updateAgentStatus,
  updateCapacity,
  withRetry,
} from './agents/index.js';
// Codebase map (additional)
export { mapCodebase } from './codebase-map/index.js';
// Compliance (additional)
export { syncComplianceMetrics } from './compliance/index.js';
// Compliance — protocol types
export { ProtocolType } from './compliance/protocol-enforcement.js';
export type { BuildConfig } from './config/build-config.js';
// Build config
export { BUILD_CONFIG } from './config/build-config.js';
// Init (additional)
export { initCoreSkills } from './init.js';
// Memory — auto-extract (additional)
export { extractFromTranscript } from './memory/auto-extract.js';
// Memory — brain embedding (additional)
export { initDefaultProvider } from './memory/brain-embedding.js';
// Memory — brain row types
export type {
  BrainAnchor,
  BrainConsolidationObservationRow,
  BrainDecisionNode,
  BrainFtsRow,
  BrainIdCheckRow,
  BrainKnnRow,
  BrainNarrativeRow,
  BrainSearchHit,
  BrainTimelineNeighborRow,
} from './memory/brain-row-types.js';
// Memory (additional)
export { generateContextAwareContent, writeMemoryBridge } from './memory/memory-bridge.js';
export type { SessionMemoryContext } from './memory/session-memory.js';
export {
  buildSummarizationPrompt,
  getSessionMemoryContext,
  ingestStructuredSummary,
  persistSessionMemory,
} from './memory/session-memory.js';
// Nexus — discoverRelated (exported as nexusDiscoverRelated to avoid name clash with tasks discoverRelated)
// Nexus — searchAcrossProjects
export {
  discoverRelated as nexusDiscoverRelated,
  searchAcrossProjects as nexusSearchAcrossProjects,
} from './nexus/discover.js';
// Nexus — readRegistry (exported as nexusReadRegistry to avoid name clash with skills readRegistry)
export { readRegistry as nexusReadRegistry } from './nexus/registry.js';
// Nexus — transfer
export { executeTransfer, previewTransfer } from './nexus/transfer.js';
export type {
  TransferParams,
  TransferResult,
} from './nexus/transfer-types.js';
export type { DependencyAnalysis } from './orchestration/analyze.js';
export { analyzeDependencies as orchestrationAnalyzeDependencies } from './orchestration/analyze.js';
export { getCriticalPath as orchestrationGetCriticalPath } from './orchestration/critical-path.js';
export type { TaskReadiness } from './orchestration/index.js';
// Orchestration — core versions (different signatures from skills versions)
export {
  getNextTask as orchestrationGetNextTask,
  getReadyTasks as orchestrationGetReadyTasks,
} from './orchestration/index.js';
// Paths (additional)
export { getBackupDir, getTaskPath } from './paths.js';
// Scaffold (additional)
export { ensureContributorMcp, ensureGlobalTemplates, ensureProjectContext } from './scaffold.js';
// Sequence (additional)
export { checkSequence, showSequence } from './sequence/index.js';
// Sessions — grading
export { gradeSession, readGrades } from './sessions/session-grade.js';
// Skills — precedence
export {
  determineInstallationTargets,
  getSkillsMapWithPrecedence,
  resolveSkillPathsForProvider,
} from './skills/precedence-integration.js';
// Spawn
export { initializeDefaultAdapters, spawnRegistry } from './spawn/adapter-registry.js';
// System — backup (different from store/backup.ts)
export { createBackup as systemCreateBackup } from './system/backup.js';
export type { DoctorReport, FixResult } from './system/health.js';
// System — doctor
export { coreDoctorReport, runDoctorFixes } from './system/health.js';
export { listLabels, showLabelTasks } from './tasks/labels.js';
// Tasks — plan, labels, suggests
export { coreTaskPlan } from './tasks/plan.js';
export { suggestRelated } from './tasks/relates.js';
// Verification gates — enums/classes
export { GateStatus, VerificationGate } from './validation/operation-verification-gates.js';

// ---------------------------------------------------------------------------
// Test helpers (used by cleo test files)
// ---------------------------------------------------------------------------

// Store — project detection (used by cleo init tests)
export { detectProjectType } from './store/project-detect.js';
export { closeAllDatabases, closeDb, resetDbState } from './store/sqlite.js';
export { createSqliteDataAccessor } from './store/sqlite-data-accessor.js';
// Validation — doctor checks (used by cleo init tests)
export { checkRootGitignore } from './validation/doctor/checks.js';

// ---------------------------------------------------------------------------
// Agent Registry + Conduit (T170 Unification)
// ---------------------------------------------------------------------------

export { ConduitClient } from './conduit/conduit-client.js';
export { createConduit } from './conduit/factory.js';
export { HttpTransport } from './conduit/http-transport.js';
export { decrypt, encrypt } from './crypto/credentials.js';
export { AgentRegistryAccessor } from './store/agent-registry-accessor.js';
export { agentCredentials } from './store/tasks-schema.js';
