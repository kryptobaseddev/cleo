/**
 * Engine Re-exports for Dispatch Domain Handlers
 *
 * Centralizes the dispatch layer's engine imports into a single barrel.
 * All imports use dispatch/engines/ (which delegate to src/core/),
 * eliminating the prior mcp/engine coupling.
 *
 * @epic T4820
 * @task T4815
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
  taskPlan,
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
  taskDepsOverview,
  taskDepsCycles,
  taskStats,
  taskExport,
  taskHistory,
  taskLint,
  taskBatchValidate,
  taskImport,
  type TaskRecord,
  type MinimalTaskRecord,
} from '../engines/task-engine.js';

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
  sessionHandoff,
  sessionComputeHandoff,
  sessionBriefing,
  // T4959: Rich debrief + chain
  sessionComputeDebrief,
  sessionDebriefShow,
  sessionChainShow,
  type DecisionRecord,
} from '../engines/session-engine.js';
export type { Session as SessionRecord } from '../../types/session.js';

// System engine
export {
  systemDash,
  systemStats,
  systemLabels,
  systemArchiveStats,
  systemLog,
  systemContext,
  systemRuntime,
  systemSequence,
  systemSequenceRepair,
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
  type RuntimeData,
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
} from '../engines/system-engine.js';

// Config engine
export {
  configGet,
  configSet,
} from '../engines/config-engine.js';

// Init engine
export {
  initProject,
  isAutoInitEnabled,
  ensureInitialized,
  getVersion,
} from '../engines/init-engine.js';

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
} from '../engines/lifecycle-engine.js';

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
} from '../engines/validate-engine.js';

// Orchestrate engine
export {
  orchestrateStatus,
  orchestrateAnalyze,
  orchestrateReady,
  orchestrateNext,
  orchestrateWaves,
  orchestrateContext,
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
} from '../engines/orchestrate-engine.js';

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
} from '../engines/release-engine.js';

// Template parser engine
export {
  parseIssueTemplates,
  getTemplateForSubcommand,
  generateTemplateConfig,
  validateLabels,
  type IssueTemplate,
  type TemplateConfig,
  type TemplateSection,
} from '../engines/template-parser.js';
