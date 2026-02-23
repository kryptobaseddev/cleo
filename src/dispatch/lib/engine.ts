/**
 * Engine Re-exports for Dispatch Domain Handlers
 *
 * Centralizes the dispatch layer's dependency on mcp/engine into a single file.
 * Domain handlers import from here instead of directly from ../../mcp/engine/.
 *
 * This file will be replaced with direct core imports as the engine functions
 * are migrated to src/core/ modules.
 *
 * @epic T4820
 */

// Task engine (CRUD + non-CRUD operations)
export {
  taskShow,
  taskList,
  taskFind,
  taskExists,
  taskCreate,
  taskUpdate,
  taskComplete,
  taskDelete,
  taskArchive,
  taskNext,
  taskBlockers,
  taskTree,
  taskDeps,
  taskRelates,
  taskRelatesAdd,
  taskAnalyze,
  taskRestore,
  taskUnarchive,
  taskReorder,
  taskReparent,
  taskPromote,
  taskReopen,
  taskComplexityEstimate,
  taskDepends,
  taskStats,
  taskExport,
  taskHistory,
  taskLint,
  taskBatchValidate,
  taskImport,
  type TaskRecord,
  type MinimalTaskRecord,
} from '../../mcp/engine/task-engine.js';

// Session engine
export {
  sessionStatus,
  sessionList,
  sessionShow,
  taskCurrentGet,
  taskStart,
  taskStop,
  sessionStart,
  sessionEnd,
  sessionResume,
  sessionGc,
  sessionSuspend,
  sessionHistory,
  sessionCleanup,
  sessionRecordDecision,
  sessionDecisionLog,
  sessionContextDrift,
  sessionRecordAssumption,
  sessionStats,
  sessionSwitch,
  sessionArchive,
  type SessionRecord,
  type DecisionRecord,
} from '../../mcp/engine/session-engine.js';

// System engine
export {
  systemDash,
  systemStats,
  systemLabels,
  systemArchiveStats,
  systemLog,
  systemContext,
  systemSequence,
  systemInjectGenerate,
  systemMetrics,
  systemHealth,
  systemDiagnostics,
  systemHelp,
  systemRoadmap,
  systemCompliance,
  systemBackup,
  systemRestore,
  systemMigrate,
  systemCleanup,
  systemAudit,
  systemSync,
  systemSafestop,
  systemUncancel,
  type DashboardData,
  type StatsData,
  type LabelsData,
  type ArchiveStatsData,
  type LogQueryData,
  type ContextData,
  type SequenceData,
  type InjectGenerateData,
  type MetricsData,
  type HealthData,
  type DiagnosticsData,
  type HelpData,
  type RoadmapData,
  type ComplianceData,
  type BackupData,
  type RestoreData,
  type MigrateData,
  type CleanupData,
  type AuditData,
  type SyncData,
  type SafestopData,
  type UncancelData,
} from '../../mcp/engine/system-engine.js';

// Config engine
export {
  configGet,
  configSet,
} from '../../mcp/engine/config-engine.js';

// Init engine
export {
  initProject,
  isAutoInitEnabled,
  ensureInitialized,
  getVersion,
} from '../../mcp/engine/init-engine.js';

// Lifecycle engine
export {
  lifecycleStatus,
  lifecycleHistory,
  lifecycleGates,
  lifecyclePrerequisites,
  lifecycleCheck,
  lifecycleProgress,
  lifecycleSkip,
  lifecycleReset,
  lifecycleGatePass,
  lifecycleGateFail,
  LIFECYCLE_STAGES,
  type LifecycleStage,
  type StageStatus,
  type RcsdManifest,
} from '../../mcp/engine/lifecycle-engine.js';

// Validate engine
export {
  validateSchemaOp,
  validateTask as validateTaskOp,
  validateProtocol,
  validateManifest as validateManifestOp,
  validateOutput,
  validateComplianceSummary,
  validateComplianceViolations,
  validateComplianceRecord,
  validateTestStatus,
  validateTestCoverage,
  validateCoherenceCheck,
  validateTestRun,
  validateBatchValidate,
} from '../../mcp/engine/validate-engine.js';

// Orchestrate engine
export {
  orchestrateStatus,
  orchestrateAnalyze,
  orchestrateReady,
  orchestrateNext,
  orchestrateWaves,
  orchestrateContext,
  orchestrateSkillList,
  orchestrateValidate,
  orchestrateSpawn,
  orchestrateStartup,
  orchestrateBootstrap,
  orchestrateCriticalPath,
  orchestrateUnblockOpportunities,
  orchestrateParallelStart,
  orchestrateParallelEnd,
  orchestrateCheck,
  orchestrateSkillInject,
} from '../../mcp/engine/orchestrate-engine.js';

// Memory engine (formerly research-engine)
export {
  memoryShow as researchShow,
  memoryList as researchList,
  memoryQuery as researchQuery,
  memoryPending as researchPending,
  memoryStats as researchStats,
  memoryManifestRead as researchManifestRead,
  memoryLink as researchLink,
  memoryManifestAppend as researchManifestAppend,
  memoryManifestArchive as researchManifestArchive,
  memoryContradictions as researchContradictions,
  memorySuperseded as researchSuperseded,
  memoryInject as researchInject,
  memoryCompact as researchCompact,
  memoryValidate as researchValidateOp,
  readManifestEntries,
  filterEntries as filterManifestEntries,
  type ManifestEntry as ResearchManifestEntry,
} from '../../core/memory/engine-compat.js';

// Release engine
export {
  releasePrepare,
  releaseChangelog,
  releaseList,
  releaseShow,
  releaseCommit,
  releaseTag,
  releaseGatesRun,
  releaseRollback,
  releasePush,
} from '../../mcp/engine/release-engine.js';

// Template parser engine
export {
  parseIssueTemplates,
  getTemplateForSubcommand,
  generateTemplateConfig,
  validateLabels,
  type IssueTemplate,
  type TemplateConfig,
  type TemplateSection,
} from '../../mcp/engine/template-parser.js';
