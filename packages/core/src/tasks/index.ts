/**
 * Task operations barrel export.
 * @task T4460
 * @epic T4454
 */

export {
  type AddTaskOptions,
  type AddTaskResult,
  addTask,
  buildDefaultVerification,
  findRecentDuplicate,
  getNextPosition,
  getTaskDepth,
  inferTaskType,
  logOperation,
  normalizePriority,
  VALID_PRIORITIES,
  validateDepends,
  validateLabels,
  validateParent,
  validatePhaseFormat,
  validatePriority,
  validateSize,
  validateStatus,
  validateTaskType,
  validateTitle,
} from './add.js';
export { type ArchiveTasksOptions, type ArchiveTasksResult, archiveTasks } from './archive.js';
export { type CompleteTaskOptions, type CompleteTaskResult, completeTask } from './complete.js';
// Canonical task view — unified derivation (T943)
export {
  computeTaskView,
  computeTaskViews,
  type TaskView,
  type TaskViewChildRollup,
  type TaskViewGatesStatus,
  type TaskViewLifecycleProgress,
  type TaskViewNextAction,
  type TaskViewPipelineStage,
} from './compute-task-view.js';
export { type DeleteTaskOptions, type DeleteTaskResult, deleteTask } from './delete.js';
// Dependency graph helpers (sentient loop consumers).
export {
  type DependencyCheckResult,
  type DependencyError,
  type DependencyWarning,
  detectCircularDeps,
  getBlockedTasks,
  getDependentIds,
  getDependents,
  getLeafBlockers,
  getReadyTasks,
  getTransitiveBlockers,
  getUnresolvedDeps,
  topologicalSort,
  validateDependencies,
  validateDependencyRefs,
  wouldCreateCycle,
} from './dependency-check.js';
// Engine-layer converter types and functions (T1568 / ADR-057 / ADR-058)
export {
  type IvtrHistoryEntry,
  type LifecycleStageEntry,
  tasksToRecords,
  taskToRecord,
  toHistoryEntry,
} from './engine-converters.js';
// Evidence-based verification (T832 / ADR-051, T1534 / ADR-061)
export {
  type AtomValidation,
  CANONICAL_TOOLS,
  checkGateEvidenceMinimum,
  composeGateEvidence,
  type EvidenceTool,
  GATE_EVIDENCE_MINIMUMS,
  isValidToolName,
  type ParsedAtom,
  type ParsedEvidence,
  parseEvidence,
  type RevalidationResult,
  revalidateEvidence,
  TOOL_COMMANDS,
  VALID_TOOLS,
  validateAtom,
} from './evidence.js';
export {
  type FindResult,
  type FindTasksOptions,
  type FindTasksResult,
  findTasks,
  fuzzyScore,
  taskFind,
} from './find.js';
// Gate audit trail (T832 / ADR-051, T947 / ADR-054 draft)
export {
  type AuditHistoryReport,
  appendForceBypassLine,
  appendGateAuditLine,
  appendSignedGateAuditLine,
  type ForceBypassRecord,
  type GateAuditRecord,
  getForceBypassPath,
  getGateAuditPath,
  type SignedGateAuditRecord,
  verifyAuditHistory,
} from './gate-audit.js';
// Pre-dispatch inference for cleo add (T1490)
export {
  type InferAddParamsInput,
  type InferAddParamsResult,
  inferFilesViaGitNexus,
  inferTaskAddParams,
  parseAcceptanceCriteria,
} from './infer-add-params.js';
export { taskLabelList, taskLabelShow } from './labels.js';
export { type ListTasksOptions, type ListTasksResult, listTasks, taskList } from './list.js';
// Task Core operation signatures for OpsFromCore inference (T1445)
export type { tasksCoreOps } from './ops.js';
export { taskPlan } from './plan.js';
// Engine-layer EngineResult-returning wrappers (T1568 / ADR-057 / ADR-058) — Wave 2
export {
  showTask,
  type TaskDetail,
  taskExists,
  taskShow,
  taskShowIvtrHistory,
  taskShowWithHistory,
} from './show.js';
// Sync sub-domain (T1568 / ADR-057 / ADR-058) — Wave 3
export { taskSyncLinks, taskSyncLinksRemove, taskSyncReconcile } from './sync-ops.js';
export {
  taskAnalyze,
  taskBatchValidate,
  taskBlockers,
  taskCancel,
  taskClaim,
  taskComplexityEstimate,
  taskDepends,
  taskDeps,
  taskDepsCycles,
  taskDepsOverview,
  taskExport,
  taskHistory,
  taskImpact,
  taskImport,
  taskLint,
  taskNext,
  taskPromote,
  taskRelates,
  taskRelatesAdd,
  taskRelatesFind,
  taskReopen,
  taskReorder,
  taskReparent,
  taskRestore,
  taskStats,
  taskTree,
  taskUnarchive,
  taskUnclaim,
} from './task-ops.js';
// Tool result cache + cross-process semaphore (T1534 / ADR-061)
export {
  cacheEntryPath,
  captureDirtyFingerprint,
  captureHead,
  clearToolCache,
  computeCacheKey,
  type RunToolOptions,
  readCacheEntry,
  runToolCached,
  type ToolCacheEntry,
  type ToolRunResult,
  writeCacheEntry,
} from './tool-cache.js';
// Project-agnostic tool resolution (T1534 / ADR-061)
export {
  type CanonicalTool,
  listValidToolNames,
  type ResolutionSource,
  type ResolvedToolCommand,
  type ResolveToolResult,
  resolveToolCommand,
} from './tool-resolver.js';
// Cross-process global per-tool concurrency semaphore (T1534 / ADR-061)
export {
  type AcquireSlotOptions,
  acquireGlobalSlot,
  defaultMaxConcurrent,
  type ReleaseSlotFn,
  resolveMaxConcurrent,
  semaphoreDir,
} from './tool-semaphore.js';
export { type UpdateTaskOptions, type UpdateTaskResult, updateTask } from './update.js';
