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
// Evidence-based verification (T832 / ADR-051)
export {
  type AtomValidation,
  checkGateEvidenceMinimum,
  composeGateEvidence,
  type EvidenceTool,
  GATE_EVIDENCE_MINIMUMS,
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
export { type ListTasksOptions, type ListTasksResult, listTasks } from './list.js';
export { showTask, type TaskDetail } from './show.js';
export { type UpdateTaskOptions, type UpdateTaskResult, updateTask } from './update.js';
