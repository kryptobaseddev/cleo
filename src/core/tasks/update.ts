/**
 * Task update logic.
 * @task T4461
 * @epic T4454
 */

import { readJsonRequired, saveJson, computeChecksum } from '../../store/json.js';
import { CleoError } from '../errors.js';
import { ExitCode } from '../../types/exit-codes.js';
import type { Task, TaskStatus, TaskPriority, TaskType, TaskSize, TodoFile } from '../../types/task.js';
import { getTodoPath, getLogPath, getBackupDir } from '../paths.js';
import {
  validateStatus,
  normalizePriority,
  validateTaskType,
  validateSize,
  validateLabels,
  validateTitle,
  logOperation,
} from './add.js';
import type { DataAccessor } from '../../store/data-accessor.js';

/** Options for updating a task. */
export interface UpdateTaskOptions {
  taskId: string;
  title?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  type?: TaskType;
  size?: TaskSize;
  phase?: string;
  description?: string;
  labels?: string[];
  addLabels?: string[];
  removeLabels?: string[];
  depends?: string[];
  addDepends?: string[];
  removeDepends?: string[];
  notes?: string;
  acceptance?: string[];
  files?: string[];
  blockedBy?: string;
  parentId?: string | null;
  noAutoComplete?: boolean;
}

/** Result of updating a task. */
export interface UpdateTaskResult {
  task: Task;
  changes: string[];
}

/**
 * Update a task's fields.
 * @task T4461
 */
export async function updateTask(options: UpdateTaskOptions, cwd?: string, accessor?: DataAccessor): Promise<UpdateTaskResult> {
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
  const changes: string[] = [];
  const now = new Date().toISOString();

  // Update fields
  if (options.title !== undefined) {
    validateTitle(options.title);
    task.title = options.title;
    changes.push('title');
  }

  if (options.status !== undefined) {
    validateStatus(options.status);
    const oldStatus = task.status;
    task.status = options.status;
    changes.push('status');
    if (options.status === 'done' && oldStatus !== 'done') {
      task.completedAt = now;
    }
    if (options.status === 'cancelled' && oldStatus !== 'cancelled') {
      task.cancelledAt = now;
    }
  }

  if (options.priority !== undefined) {
    const normalizedPriority = normalizePriority(options.priority);
    task.priority = normalizedPriority;
    changes.push('priority');
  }

  if (options.type !== undefined) {
    validateTaskType(options.type);
    task.type = options.type;
    changes.push('type');
  }

  if (options.size !== undefined) {
    validateSize(options.size);
    task.size = options.size;
    changes.push('size');
  }

  if (options.phase !== undefined) {
    task.phase = options.phase;
    changes.push('phase');
  }

  if (options.description !== undefined) {
    task.description = options.description;
    changes.push('description');
  }

  if (options.labels !== undefined) {
    if (options.labels.length) validateLabels(options.labels);
    task.labels = options.labels;
    changes.push('labels');
  }

  if (options.addLabels?.length) {
    validateLabels(options.addLabels);
    const existing = new Set(task.labels ?? []);
    for (const l of options.addLabels) existing.add(l.trim());
    task.labels = [...existing];
    changes.push('labels');
  }

  if (options.removeLabels?.length) {
    const toRemove = new Set(options.removeLabels.map(l => l.trim()));
    task.labels = (task.labels ?? []).filter(l => !toRemove.has(l));
    changes.push('labels');
  }

  if (options.depends !== undefined) {
    task.depends = options.depends;
    changes.push('depends');
  }

  if (options.addDepends?.length) {
    const existing = new Set(task.depends ?? []);
    for (const d of options.addDepends) existing.add(d.trim());
    task.depends = [...existing];
    changes.push('depends');
  }

  if (options.removeDepends?.length) {
    const toRemove = new Set(options.removeDepends.map(d => d.trim()));
    task.depends = (task.depends ?? []).filter(d => !toRemove.has(d));
    changes.push('depends');
  }

  if (options.notes !== undefined) {
    const timestampedNote = `${new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC')}: ${options.notes}`;
    if (!task.notes) task.notes = [];
    task.notes.push(timestampedNote);
    changes.push('notes');
  }

  if (options.acceptance !== undefined) {
    task.acceptance = options.acceptance;
    changes.push('acceptance');
  }

  if (options.files !== undefined) {
    task.files = options.files;
    changes.push('files');
  }

  if (options.blockedBy !== undefined) {
    task.blockedBy = options.blockedBy;
    changes.push('blockedBy');
  }

  if (options.noAutoComplete !== undefined) {
    task.noAutoComplete = options.noAutoComplete;
    changes.push('noAutoComplete');
  }

  if (changes.length === 0) {
    throw new CleoError(ExitCode.NO_CHANGE, 'No changes specified');
  }

  task.updatedAt = now;
  data.tasks[taskIdx] = task;

  // Update checksum
  data._meta.checksum = computeChecksum(data.tasks);
  data.lastUpdated = now;

  if (accessor) {
    await accessor.saveTodoFile(data);
    await accessor.appendLog({
      id: `log-${Math.floor(Date.now() / 1000)}-${(await import('node:crypto')).randomBytes(3).toString('hex')}`,
      timestamp: new Date().toISOString(),
      action: 'task_updated',
      taskId: options.taskId,
      actor: 'system',
      details: { changes, title: task.title },
      before: null,
      after: { changes, title: task.title },
    });
  } else {
    await saveJson(todoPath, data, { backupDir });
    await logOperation(logPath, 'task_updated', options.taskId, {
      changes,
      title: task.title,
    });
  }

  return { task, changes };
}
