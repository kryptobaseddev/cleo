/**
 * Task completion logic.
 * @task T4461
 * @epic T4454
 */

import { readJsonRequired, saveJson, computeChecksum } from '../../store/json.js';
import { CleoError } from '../errors.js';
import { ExitCode } from '../../types/exit-codes.js';
import type { Task, TodoFile } from '../../types/task.js';
import { getTodoPath, getLogPath, getBackupDir } from '../paths.js';
import { logOperation } from './add.js';
import type { DataAccessor } from '../../store/data-accessor.js';

/** Options for completing a task. */
export interface CompleteTaskOptions {
  taskId: string;
  notes?: string;
  changeset?: string;
}

/** Result of completing a task. */
export interface CompleteTaskResult {
  task: Task;
  autoCompleted?: string[];
}

/**
 * Complete a task by ID.
 * Handles dependency checking and optional auto-completion of epics.
 * @task T4461
 */
export async function completeTask(options: CompleteTaskOptions, cwd?: string, accessor?: DataAccessor): Promise<CompleteTaskResult> {
  const todoPath = getTodoPath(cwd);
  const logPath = getLogPath(cwd);
  const backupDir = getBackupDir(cwd);

  const data = accessor
    ? await accessor.loadTodoFile()
    : await readJsonRequired<TodoFile>(todoPath);

  const taskIdx = data.tasks.findIndex(t => t.id === options.taskId);
  if (taskIdx === -1) {
    throw new CleoError(
      ExitCode.NOT_FOUND,
      `Task not found: ${options.taskId}`,
      { fix: `Use 'cleo find "${options.taskId}"' to search` },
    );
  }

  const task = data.tasks[taskIdx]!;

  // Already done
  if (task.status === 'done') {
    throw new CleoError(
      ExitCode.TASK_COMPLETED,
      `Task ${options.taskId} is already completed`,
    );
  }

  // Check if task has incomplete dependencies
  if (task.depends?.length) {
    const incompleteDeps = task.depends.filter(depId => {
      const dep = data.tasks.find(t => t.id === depId);
      return dep && dep.status !== 'done';
    });
    if (incompleteDeps.length > 0) {
      throw new CleoError(
        ExitCode.DEPENDENCY_ERROR,
        `Task ${options.taskId} has incomplete dependencies: ${incompleteDeps.join(', ')}`,
        { fix: `Complete dependencies first: ${incompleteDeps.map(d => `cleo complete ${d}`).join(', ')}` },
      );
    }
  }

  // Check if task has incomplete children
  const children = data.tasks.filter(t => t.parentId === options.taskId);
  const incompleteChildren = children.filter(c => c.status !== 'done' && c.status !== 'cancelled');
  if (incompleteChildren.length > 0 && task.type === 'epic') {
    if (!task.noAutoComplete) {
      throw new CleoError(
        ExitCode.HAS_CHILDREN,
        `Epic ${options.taskId} has ${incompleteChildren.length} incomplete children: ${incompleteChildren.map(c => c.id).join(', ')}`,
        { fix: `Complete children first or use 'cleo update ${options.taskId} --no-auto-complete'` },
      );
    }
  }

  const now = new Date().toISOString();
  const before = { ...task };

  // Update task
  task.status = 'done';
  task.completedAt = now;
  task.updatedAt = now;

  if (options.notes) {
    const timestampedNote = `${new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC')}: ${options.notes}`;
    if (!task.notes) task.notes = [];
    task.notes.push(timestampedNote);
  }

  if (options.changeset) {
    if (!task.notes) task.notes = [];
    task.notes.push(`Changeset: ${options.changeset}`);
  }

  data.tasks[taskIdx] = task;

  // Check if parent epic should auto-complete
  const autoCompleted: string[] = [];
  if (task.parentId) {
    const parent = data.tasks.find(t => t.id === task.parentId);
    if (parent && parent.type === 'epic' && !parent.noAutoComplete) {
      const parentChildren = data.tasks.filter(t => t.parentId === parent.id);
      const allDone = parentChildren.every(c => c.status === 'done' || c.status === 'cancelled');
      if (allDone) {
        parent.status = 'done';
        parent.completedAt = now;
        parent.updatedAt = now;
        autoCompleted.push(parent.id);
      }
    }
  }

  // Update checksum
  data._meta.checksum = computeChecksum(data.tasks);
  data.lastUpdated = now;

  if (accessor) {
    await accessor.saveTodoFile(data);
    await accessor.appendLog({
      id: `log-${Math.floor(Date.now() / 1000)}-${(await import('node:crypto')).randomBytes(3).toString('hex')}`,
      timestamp: new Date().toISOString(),
      action: 'task_completed',
      taskId: options.taskId,
      actor: 'system',
      details: { title: task.title, previousStatus: before.status },
      before: null,
      after: { title: task.title, previousStatus: before.status },
    });
  } else {
    await saveJson(todoPath, data, { backupDir });
    await logOperation(logPath, 'task_completed', options.taskId, {
      title: task.title,
      previousStatus: before.status,
    });
  }

  return { task, ...(autoCompleted.length > 0 && { autoCompleted }) };
}
