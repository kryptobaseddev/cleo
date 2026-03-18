/**
 * Task operations barrel export.
 * @task T4460
 * @epic T4454
 */

export {
  type AddTaskOptions,
  type AddTaskResult,
  addTask,
  findRecentDuplicate,
  generateTaskId,
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
export { type DeleteTaskOptions, type DeleteTaskResult, deleteTask } from './delete.js';
export {
  type FindResult,
  type FindTasksOptions,
  type FindTasksResult,
  findTasks,
  fuzzyScore,
} from './find.js';
export { type ListTasksOptions, type ListTasksResult, listTasks } from './list.js';
export { showTask, type TaskDetail } from './show.js';
export { type UpdateTaskOptions, type UpdateTaskResult, updateTask } from './update.js';
