/**
 * Native TypeScript Engine - Barrel Export
 *
 * The engine provides cross-platform data operations that work
 * without the CLEO CLI (bash). Used when MCP_EXECUTION_MODE is
 * 'native' or 'auto' (when CLI is unavailable).
 */

// Canonical EngineResult type (re-exported from dispatch layer)
export { type EngineResult, engineError, engineSuccess } from '../../dispatch/engines/_error.js';

// Store: atomic file I/O, locking, backup rotation
export {
  readJsonFile,
  writeJsonFileAtomic,
  withLock,
  withFileLock,
  withMultiLock,
  isProjectInitialized,
  resolveProjectRoot,
  getDataPath,
  listBackups,
} from './store.js';

// Schema validation (Ajv-based)
export {
  validateSchema,
  validateTask,
  clearSchemaCache,
  type ValidationResult,
  type ValidationError,
  type SchemaType,
} from './schema-validator.js';

// Anti-hallucination validation rules
export {
  validateTitleDescription,
  validateTimestamps,
  validateIdUniqueness,
  validateNoDuplicateDescription,
  validateHierarchy,
  validateStatusTransition,
  validateNewTask,
  hasErrors,
  type RuleViolation,
} from './validation-rules.js';

// Task ID generation
export {
  generateNextId,
  generateNextIdFromSet,
  collectAllIds,
  findHighestId,
  isValidTaskId,
} from './id-generator.js';

// Task engine (CRUD operations) — delegated to dispatch engine (T5100)
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
  taskAnalyze,
  taskRestore,
  taskUnarchive,
  taskReorder,
  taskReparent,
  taskPromote,
  taskReopen,
  taskRelatesAdd,
  taskComplexityEstimate,
  taskDepends,
  taskStats,
  taskExport,
  taskHistory,
  taskLint,
  taskBatchValidate,
  taskImport,
  taskPlan,
  type TaskRecord,
  type MinimalTaskRecord,
} from '../../dispatch/engines/task-engine.js';

// Session engine (delegated to dispatch engine — MCP engine deleted per T4959)
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
  sessionComputeDebrief,
  sessionDebriefShow,
  sessionChainShow,
  type SessionRecord,
  type DecisionRecord,
} from '../../dispatch/engines/session-engine.js';

// System engine (system queries + mutate operations) — dispatch canonical (T5107)
export {
  systemDash,
  systemStats,
  systemLabels,
  systemArchiveStats,
  systemLog,
  systemContext,
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
  systemRuntime,
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
  type RuntimeData,
} from '../../dispatch/engines/system-engine.js';

// Config engine (delegated to dispatch engine — MCP engine deleted per T5109-T5111)
export {
  configGet,
  configSet,
} from '../../dispatch/engines/config-engine.js';

// Init engine (delegated to dispatch engine — MCP engine deleted per T5109-T5111)
export {
  initProject,
  isAutoInitEnabled,
  ensureInitialized,
  getVersion,
} from '../../dispatch/engines/init-engine.js';

// CAAMP adapter (provider registry, MCP config, injection, batch ops)
export {
  providerList,
  providerGet,
  providerDetect,
  providerInstalled,
  providerCount,
  registryVersion,
  mcpList,
  mcpListAll,
  mcpInstall,
  mcpRemove,
  mcpConfigPath,
  injectionCheck,
  injectionCheckAll,
  injectionUpdate,
  injectionUpdateAll,
  batchInstallWithRollback,
  dualScopeConfigure,
  caampResolveAlias,
  caampBuildServerConfig,
  caampGenerateInjectionContent,
  caampGetInstructionFiles,
} from './caamp-adapter.js';

// Template parser engine
export {
  parseIssueTemplates,
  getTemplateForSubcommand,
  generateTemplateConfig,
  validateLabels,
  type IssueTemplate,
  type TemplateConfig,
  type TemplateSection,
} from './template-parser.js';

// Lifecycle engine (functions from dispatch/engines, types/constants from core/lifecycle)
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
} from '../../dispatch/engines/lifecycle-engine.js';

export {
  PIPELINE_STAGES as LIFECYCLE_STAGES,
  type Stage as LifecycleStage,
  type StageStatus,
} from '../../core/lifecycle/stages.js';

export {
  type RcasdManifest as RcsdManifest,
} from '../../core/lifecycle/index.js';

// Validate engine (delegated to dispatch engine — MCP engine deleted per T5109-T5111)
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
} from '../../dispatch/engines/validate-engine.js';

// Orchestrate engine — dispatch canonical (T5108)
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
} from '../../dispatch/engines/orchestrate-engine.js';

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

// Release engine (delegated to dispatch engine — MCP engine deleted per T5109-T5111)
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
} from '../../dispatch/engines/release-engine.js';

// Capability matrix
export {
  getOperationMode,
  canRunNatively,
  requiresCLI,
  getNativeOperations,
  generateCapabilityReport,
  getCapabilityMatrix,
  type ExecutionMode,
  type OperationCapability,
  type CapabilityReport,
} from './capability-matrix.js';
