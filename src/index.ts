/**
 * CLEO V2 - TypeScript task management for AI coding agents.
 * @epic T4454
 * @task T4455
 */

// Types
export { ExitCode } from './types/exit-codes.js';
export type { Task, TodoFile, Phase, Release } from './types/task.js';

// Core
export { CleoError } from './core/errors.js';
export { formatOutput, formatSuccess, formatError } from './core/output.js';

// Tasks
export { addTask } from './core/tasks/add.js';
export { listTasks } from './core/tasks/list.js';
export { showTask } from './core/tasks/show.js';
export { findTasks } from './core/tasks/find.js';

// Phases
export {
  listPhases,
  showPhase,
  setPhase,
  startPhase,
  completePhase,
  advancePhase,
  renamePhase,
  deletePhase,
} from './core/phases/index.js';

// Dependencies
export {
  buildGraph,
  getDepsOverview,
  getTaskDeps,
  topologicalSort,
  getExecutionWaves,
  getCriticalPath,
  getImpact,
  detectCycles,
  getTaskTree,
  addRelation,
} from './core/phases/deps.js';

// Research
export {
  addResearch,
  showResearch,
  listResearch,
  pendingResearch,
  linkResearch,
  updateResearch,
  readManifest,
  appendManifest,
  queryManifest,
} from './core/research/index.js';

// Orchestration
export {
  startOrchestration,
  analyzeEpic,
  getReadyTasks,
  getNextTask,
  prepareSpawn,
  validateSpawnOutput,
  getOrchestratorContext,
  autoDispatch,
  resolveTokens,
} from './core/orchestration/index.js';

// Lifecycle
export {
  getLifecycleState,
  startStage,
  completeStage,
  skipStage,
  checkGate,
} from './core/lifecycle/index.js';

// Release
export {
  createRelease,
  planRelease,
  shipRelease,
  listReleases,
  showRelease,
  getChangelog,
} from './core/release/index.js';
export type { ShipReleaseResult } from './core/release/index.js';

// Migration
export {
  detectVersion,
  compareSemver,
  getMigrationStatus,
  runMigration,
  runAllMigrations,
} from './core/migration/index.js';
