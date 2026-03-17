/**
 * @cleocode/core — CLEO core business logic package.
 *
 * Re-exports all public APIs from src/core/ via the root barrel export.
 * This package is a thin wrapper that makes the core layer consumable
 * as a standalone npm workspace package.
 *
 * Consumers: @cleocode/cleo (cli + mcp + dispatch layers)
 *
 * @package @cleocode/core
 * @epic T5701
 * @task T5713
 * @task T5716
 */

export * from '../../../src/core/index.js';

// Cleo facade class for project-bound API access
export { Cleo } from './cleo.js';
export type {
  AdminAPI,
  CleoInitOptions,
  CleoTasksApi,
  LifecycleAPI,
  MemoryAPI,
  OrchestrationAPI,
  ReleaseAPI,
  SessionsAPI,
  TasksAPI,
} from './cleo.js';

// Individual function exports for tree-shaking (Pattern 2)
export {
  addTask,
  archiveTasks,
  completeTask,
  deleteTask,
  findTasks,
  listTasks,
  showTask,
  updateTask,
} from '../../../src/core/tasks/index.js';

export {
  endSession,
  listSessions,
  resumeSession,
  sessionStatus,
  startSession,
} from '../../../src/core/sessions/index.js';

export {
  fetchBrainEntries,
  observeBrain,
  searchBrainCompact,
  timelineBrain,
} from '../../../src/core/memory/brain-retrieval.js';

export { searchBrain } from '../../../src/core/memory/brain-search.js';

// DataAccessor type and factory for Pattern 3 (custom store)
export type { DataAccessor } from '../../../src/store/data-accessor.js';
export { createDataAccessor, getAccessor } from '../../../src/store/data-accessor.js';
