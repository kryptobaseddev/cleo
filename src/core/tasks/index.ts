/**
 * Task operations barrel export.
 * @task T4460
 * @epic T4454
 */

export { addTask, type AddTaskOptions, type AddTaskResult } from './add.js';
export {
  validateTitle,
  validateStatus,
  validatePriority,
  validateTaskType,
  validateSize,
  validateLabels,
  validatePhaseFormat,
  validateDepends,
  validateParent,
  generateTaskId,
  getTaskDepth,
  inferTaskType,
  getNextPosition,
  findRecentDuplicate,
  logOperation,
} from './add.js';
export { listTasks, type ListTasksOptions, type ListTasksResult } from './list.js';
export { showTask, type TaskDetail } from './show.js';
export { findTasks, fuzzyScore, type FindTasksOptions, type FindTasksResult, type FindResult } from './find.js';
export { completeTask, type CompleteTaskOptions, type CompleteTaskResult } from './complete.js';
export { updateTask, type UpdateTaskOptions, type UpdateTaskResult } from './update.js';
export { deleteTask, type DeleteTaskOptions, type DeleteTaskResult } from './delete.js';
export { archiveTasks, type ArchiveTasksOptions, type ArchiveTasksResult } from './archive.js';
