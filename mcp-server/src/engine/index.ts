/**
 * Native TypeScript Engine - Barrel Export
 *
 * The engine provides cross-platform data operations that work
 * without the CLEO CLI (bash). Used when MCP_EXECUTION_MODE is
 * 'native' or 'auto' (when CLI is unavailable).
 */

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

// Task engine (CRUD operations)
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
  type TaskRecord,
  type MinimalTaskRecord,
} from './task-engine.js';

// Session engine
export {
  sessionStatus,
  sessionList,
  sessionShow,
  focusGet,
  focusSet,
  focusClear,
  sessionStart,
  sessionEnd,
  type SessionRecord,
} from './session-engine.js';

// Config engine
export {
  configGet,
  configSet,
} from './config-engine.js';

// Init engine
export {
  initProject,
  isAutoInitEnabled,
  ensureInitialized,
  getVersion,
} from './init-engine.js';

// CAAMP adapter (provider registry, MCP config, injection)
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

// Research engine
export {
  researchShow,
  researchList,
  researchQuery,
  researchPending,
  researchStats,
  researchManifestRead,
  researchLink,
  researchManifestAppend,
  researchManifestArchive,
  readManifestEntries,
  filterEntries as filterManifestEntries,
  type ManifestEntry as ResearchManifestEntry,
} from './research-engine.js';

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
} from './lifecycle-engine.js';

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
} from './validate-engine.js';

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
} from './orchestrate-engine.js';

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
} from './release-engine.js';

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
