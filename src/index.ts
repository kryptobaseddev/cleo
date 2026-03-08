/**
 * CLEO V2 - TypeScript task management for AI coding agents.
 * @epic T4454
 * @task T4455
 */

// Core
export { CleoError } from './core/errors.js';
// Lifecycle
export {
  checkGate,
  completeStage,
  getLifecycleState,
  skipStage,
  startStage,
} from './core/lifecycle/index.js';
// Research
export {
  addResearch,
  appendManifest,
  linkResearch,
  listResearch,
  pendingResearch,
  queryManifest,
  readManifest,
  showResearch,
  updateResearch,
} from './core/memory/index.js';
export type {
  MigrationResult,
  MigrationStatus,
  SchemaVersion,
} from './core/migration/index.js';
// Migration compatibility exports (package-root API)
export {
  compareSemver,
  detectVersion,
  getMigrationStatus,
  runAllMigrations,
  runMigration,
} from './core/migration/index.js';
// Orchestration
export {
  analyzeEpic,
  autoDispatch,
  getNextTask,
  getOrchestratorContext,
  getReadyTasks,
  prepareSpawn,
  resolveTokens,
  startOrchestration,
  validateSpawnOutput,
} from './core/orchestration/index.js';
export { formatError, formatOutput, formatSuccess } from './core/output.js';
// Dependencies
export {
  addRelation,
  buildGraph,
  detectCycles,
  getCriticalPath,
  getDepsOverview,
  getExecutionWaves,
  getImpact,
  getTaskDeps,
  getTaskTree,
  topologicalSort,
} from './core/phases/deps.js';

// Phases
export {
  advancePhase,
  completePhase,
  deletePhase,
  listPhases,
  renamePhase,
  setPhase,
  showPhase,
  startPhase,
} from './core/phases/index.js';
export type { MigrateResult, MigrateResult as SystemMigrateResult } from './core/system/migrate.js';
// System migration status + storage preflight
export { getMigrationStatus as getSystemMigrationStatus } from './core/system/migrate.js';
export type { PreflightResult } from './core/system/storage-preflight.js';
export { checkStorageMigration } from './core/system/storage-preflight.js';
// Tasks
export { addTask } from './core/tasks/add.js';
export { findTasks } from './core/tasks/find.js';
export { listTasks } from './core/tasks/list.js';
export { showTask } from './core/tasks/show.js';
// Types
export { ExitCode } from './types/exit-codes.js';
export type { Phase, Release, Task, TaskFile } from './types/task.js';
