/**
 * Engine Re-exports for Dispatch Domain Handlers
 *
 * Centralizes the dispatch layer's engine imports into a single barrel.
 * All imports use dispatch/engines/ (which delegate to src/core/).
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
  taskCancel,
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
  taskRelatesFind,
  taskLabelList,
  taskLabelShow,
  type TaskRecord,
  type MinimalTaskRecord,
  type CompactTask,
} from '../engines/task-engine.js';

// Session engine
export {
  sessionStatus,
  sessionList,
  sessionShow,
  taskCurrentGet,
  taskStart,
  taskStop,
  taskWorkHistory,
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
  // T5119: Lightweight session discovery
  sessionFind,
  sessionContextInject,
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
  systemDoctor,
  systemFix,
  systemDiagnostics,
  systemHelp,
  systemRoadmap,
  systemCompliance,
  systemBackup,
  systemRestore,
  backupRestore,
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
  // T5327: Protocol validation operations
  validateProtocolConsensus,
  validateProtocolContribution,
  validateProtocolDecomposition,
  validateProtocolImplementation,
  validateProtocolSpecification,
  validateGateVerify,
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
  orchestrateHandoff,
  orchestrateSpawnExecute,
  orchestrateStartup,
  orchestrateBootstrap,
  orchestrateCriticalPath,
  orchestrateUnblockOpportunities,
  orchestrateParallelStart,
  orchestrateParallelEnd,
  orchestrateCheck,
  orchestrateSkillInject,
} from '../engines/orchestrate-engine.js';

// Memory engine — brain.db cognitive memory (T5241 cutover)
export {
  memoryShow,
  memoryBrainStats,
  memoryDecisionFind,
  memoryDecisionStore,
  memoryFind,
  memoryTimeline,
  memoryFetch,
  memoryObserve,
  memoryPatternStore,
  memoryPatternFind,
  memoryPatternStats,
  memoryLearningStore,
  memoryLearningFind,
  memoryLearningStats,
  memoryContradictions,
  memorySuperseded,
  memoryLink,
  memoryUnlink,
  memoryGraphAdd,
  memoryGraphShow,
  memoryGraphNeighbors,
  memoryGraphRemove,
  memoryReasonWhy,
  memoryReasonSimilar,
  memorySearchHybrid,
} from '../engines/memory-engine.js';

// Pipeline manifest functions (moved from memory domain in T5241)
export {
  pipelineManifestShow,
  pipelineManifestList,
  pipelineManifestFind,
  pipelineManifestPending,
  pipelineManifestStats,
  pipelineManifestAppend,
  pipelineManifestArchive,
  readManifestEntries,
  filterEntries as filterManifestEntries,
  type ManifestEntry as ResearchManifestEntry,
} from '../../core/memory/pipeline-manifest-sqlite.js';

// Pipeline engine (Phase operations)
export {
  phaseList,
  phaseShow,
  phaseSet,
  phaseStart,
  phaseComplete,
  phaseAdvance,
  phaseRename,
  phaseDelete,
} from '../engines/pipeline-engine.js';

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
  releaseCancel,
  releasePush,
  releaseShip,
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
