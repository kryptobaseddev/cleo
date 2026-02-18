/**
 * Task creation logic.
 * @task T4460
 * @epic T4454
 */

import { randomBytes } from 'node:crypto';
import { readJsonRequired } from '../../store/json.js';
import { CleoError } from '../errors.js';
import { ExitCode } from '../../types/exit-codes.js';
import type { Task, TaskStatus, TaskPriority, TaskType, TaskSize, TodoFile } from '../../types/task.js';
import { getTodoPath, getLogPath, getArchivePath, getBackupDir } from '../paths.js';
import { saveJson, appendJsonl, computeChecksum } from '../../store/json.js';
import type { DataAccessor } from '../../store/data-accessor.js';
import { loadConfig } from '../config.js';

/** Options for creating a task. */
export interface AddTaskOptions {
  title: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  type?: TaskType;
  parentId?: string | null;
  size?: TaskSize;
  phase?: string;
  description?: string;
  labels?: string[];
  files?: string[];
  acceptance?: string[];
  depends?: string[];
  notes?: string;
  position?: number;
  addPhase?: boolean;
  dryRun?: boolean;
}

/** Result of adding a task. */
export interface AddTaskResult {
  task: Task;
  duplicate?: boolean;
  dryRun?: boolean;
}

/**
 * Validate a task title.
 * @task T4460
 */
export function validateTitle(title: string): void {
  if (!title || title.trim().length === 0) {
    throw new CleoError(ExitCode.INVALID_INPUT, 'Task title is required');
  }
  if (title.length > 200) {
    throw new CleoError(ExitCode.VALIDATION_ERROR, 'Task title must be 200 characters or less');
  }
}

/**
 * Validate task status.
 * @task T4460
 */
export function validateStatus(status: string): asserts status is TaskStatus {
  const valid: TaskStatus[] = ['pending', 'active', 'blocked', 'done', 'cancelled'];
  if (!valid.includes(status as TaskStatus)) {
    throw new CleoError(
      ExitCode.VALIDATION_ERROR,
      `Invalid status: ${status} (must be ${valid.join('|')})`,
    );
  }
}

/**
 * Mapping from numeric priority (1-9) to string priority names.
 * 1-2 = critical, 3-4 = high, 5-6 = medium, 7-9 = low.
 * @task T4572
 */
const NUMERIC_PRIORITY_MAP: Record<number, TaskPriority> = {
  1: 'critical',
  2: 'critical',
  3: 'high',
  4: 'high',
  5: 'medium',
  6: 'medium',
  7: 'low',
  8: 'low',
  9: 'low',
};

/** Valid string priority values. */
export const VALID_PRIORITIES: readonly TaskPriority[] = ['critical', 'high', 'medium', 'low'] as const;

/**
 * Normalize priority to canonical string format.
 * Accepts both string names ("critical","high","medium","low") and numeric (1-9).
 * Returns the canonical string format per todo.schema.json.
 * @task T4572
 */
export function normalizePriority(priority: string | number): TaskPriority {
  // Handle numeric input
  if (typeof priority === 'number') {
    const mapped = NUMERIC_PRIORITY_MAP[priority];
    if (!mapped) {
      throw new CleoError(
        ExitCode.VALIDATION_ERROR,
        `Invalid numeric priority: ${priority} (must be 1-9)`,
      );
    }
    return mapped;
  }

  // Handle string input - check for numeric string first
  const asNumber = Number(priority);
  if (!Number.isNaN(asNumber) && Number.isInteger(asNumber) && asNumber >= 1 && asNumber <= 9) {
    return NUMERIC_PRIORITY_MAP[asNumber]!;
  }

  // Canonical string validation
  const lower = priority.toLowerCase().trim();
  if (VALID_PRIORITIES.includes(lower as TaskPriority)) {
    return lower as TaskPriority;
  }

  throw new CleoError(
    ExitCode.VALIDATION_ERROR,
    `Invalid priority: ${priority} (must be ${VALID_PRIORITIES.join('|')} or numeric 1-9)`,
  );
}

/**
 * Validate task priority.
 * @task T4460
 * @task T4572
 */
export function validatePriority(priority: string): asserts priority is TaskPriority {
  normalizePriority(priority);
}

/**
 * Validate task type.
 * @task T4460
 */
export function validateTaskType(type: string): asserts type is TaskType {
  const valid: TaskType[] = ['epic', 'task', 'subtask'];
  if (!valid.includes(type as TaskType)) {
    throw new CleoError(
      ExitCode.VALIDATION_ERROR,
      `Invalid task type: ${type} (must be ${valid.join('|')})`,
    );
  }
}

/**
 * Validate task size.
 * @task T4460
 */
export function validateSize(size: string): asserts size is TaskSize {
  const valid: TaskSize[] = ['small', 'medium', 'large'];
  if (!valid.includes(size as TaskSize)) {
    throw new CleoError(
      ExitCode.VALIDATION_ERROR,
      `Invalid size: ${size} (must be ${valid.join('|')})`,
    );
  }
}

/**
 * Validate label format.
 * @task T4460
 */
export function validateLabels(labels: string[]): void {
  for (const label of labels) {
    const trimmed = label.trim();
    if (!/^[a-z][a-z0-9.-]*$/.test(trimmed)) {
      throw new CleoError(
        ExitCode.VALIDATION_ERROR,
        `Invalid label format: '${trimmed}' (must be lowercase alphanumeric with hyphens/periods)`,
      );
    }
  }
}

/**
 * Validate phase slug format.
 * @task T4460
 */
export function validatePhaseFormat(phase: string): void {
  if (!/^[a-z][a-z0-9-]*$/.test(phase)) {
    throw new CleoError(
      ExitCode.VALIDATION_ERROR,
      `Invalid phase format: ${phase} (must be lowercase alphanumeric with hyphens)`,
    );
  }
}

/**
 * Validate dependency IDs exist.
 * @task T4460
 */
export function validateDepends(depends: string[], tasks: Task[]): void {
  const existingIds = new Set(tasks.map(t => t.id));
  for (const depId of depends) {
    const trimmed = depId.trim();
    if (!/^T\d{3,}$/.test(trimmed)) {
      throw new CleoError(
        ExitCode.VALIDATION_ERROR,
        `Invalid dependency ID format: '${trimmed}' (must be T### format)`,
      );
    }
    if (!existingIds.has(trimmed)) {
      throw new CleoError(
        ExitCode.NOT_FOUND,
        `Dependency task not found: ${trimmed}`,
      );
    }
  }
}

/**
 * Generate the next task ID by scanning existing tasks and archive.
 * @task T4460
 */
export function generateTaskId(tasks: Task[], archivedTasks?: Array<{ id: string }>): string {
  let maxId = 0;
  const allTasks = [...tasks, ...(archivedTasks ?? [])];
  for (const task of allTasks) {
    const match = task.id.match(/^T(\d+)$/);
    if (match) {
      const num = parseInt(match[1]!, 10);
      if (num > maxId) maxId = num;
    }
  }
  return `T${String(maxId + 1).padStart(3, '0')}`;
}

/**
 * Validate parent hierarchy constraints.
 * @task T4460
 */
export function validateParent(
  parentId: string,
  tasks: Task[],
  maxDepth: number = 3,
  maxSiblings: number = 7,
): void {
  // Check parent exists
  const parent = tasks.find(t => t.id === parentId);
  if (!parent) {
    throw new CleoError(
      ExitCode.PARENT_NOT_FOUND,
      `Parent task not found: ${parentId}`,
      { fix: `Use 'cleo show ${parentId}' to check or create as standalone task` },
    );
  }

  // Check parent type allows children
  if (parent.type === 'subtask') {
    throw new CleoError(
      ExitCode.INVALID_PARENT_TYPE,
      `Cannot add child to ${parentId}: subtasks cannot have children`,
      { fix: `Create as standalone task or add to parent's parent instead` },
    );
  }

  // Check depth
  const depth = getTaskDepth(parentId, tasks);
  if (depth >= maxDepth) {
    throw new CleoError(
      ExitCode.DEPTH_EXCEEDED,
      `Cannot add child to ${parentId}: max hierarchy depth (${maxDepth}) would be exceeded`,
    );
  }

  // Check sibling count
  if (maxSiblings > 0) {
    const siblingCount = tasks.filter(t => t.parentId === parentId).length;
    if (siblingCount >= maxSiblings) {
      throw new CleoError(
        ExitCode.SIBLING_LIMIT,
        `Cannot add child to ${parentId}: max siblings (${maxSiblings}) exceeded`,
        { fix: `Create as standalone task or increase hierarchy.maxSiblings in config` },
      );
    }
  }
}

/**
 * Get the depth of a task in the hierarchy.
 * @task T4460
 */
export function getTaskDepth(taskId: string, tasks: Task[]): number {
  let depth = 0;
  let currentId: string | null | undefined = taskId;
  const visited = new Set<string>();

  while (currentId) {
    if (visited.has(currentId)) break; // circular reference guard
    visited.add(currentId);
    const task = tasks.find(t => t.id === currentId);
    if (!task?.parentId) break;
    depth++;
    currentId = task.parentId;
  }
  return depth;
}

/**
 * Infer task type from parent context.
 * @task T4460
 */
export function inferTaskType(parentId: string | null | undefined, tasks: Task[]): TaskType {
  if (!parentId) return 'task';
  const parent = tasks.find(t => t.id === parentId);
  if (!parent) return 'task';
  if (parent.type === 'epic') return 'task';
  return 'subtask';
}

/**
 * Get the next position for a task within a parent scope.
 * @task T4460
 */
export function getNextPosition(parentId: string | null | undefined, tasks: Task[]): number {
  const siblings = tasks.filter(t =>
    parentId ? t.parentId === parentId : (!t.parentId || t.parentId === null),
  );
  let maxPos = 0;
  for (const s of siblings) {
    if (s.position !== undefined && s.position !== null && s.position > maxPos) {
      maxPos = s.position;
    }
  }
  return maxPos + 1;
}

/**
 * Log an operation to the audit log.
 * @task T4460
 */
export async function logOperation(
  logPath: string,
  operation: string,
  taskId: string,
  details: Record<string, unknown>,
  accessor?: import('../../store/data-accessor.js').DataAccessor,
): Promise<void> {
  const logId = `log-${Math.floor(Date.now() / 1000)}-${randomBytes(3).toString('hex')}`;
  const entry = {
    id: logId,
    timestamp: new Date().toISOString(),
    action: operation,
    taskId,
    actor: 'system',
    details,
    before: null,
    after: details,
  };

  try {
    if (accessor) {
      await accessor.appendLog(entry);
    } else {
      await appendJsonl(logPath, entry);
    }
  } catch {
    // Log failure is non-fatal
  }
}

/**
 * Check for recent duplicate task.
 * @task T4460
 */
export function findRecentDuplicate(
  title: string,
  phase: string | undefined,
  tasks: Task[],
  windowSeconds: number = 60,
): Task | null {
  const now = Date.now();
  const cutoff = now - windowSeconds * 1000;

  for (const task of tasks) {
    if (task.title !== title) continue;
    if (phase) {
      if (task.phase !== phase) continue;
    } else {
      if (task.phase && task.phase !== '') continue;
    }
    const created = new Date(task.createdAt).getTime();
    if (created > cutoff) return task;
  }
  return null;
}

/**
 * Add a new task to the todo file.
 * @task T4460
 */
export async function addTask(options: AddTaskOptions, cwd?: string, accessor?: DataAccessor): Promise<AddTaskResult> {
  const todoPath = getTodoPath(cwd);
  const logPath = getLogPath(cwd);
  const archivePath = getArchivePath(cwd);
  const backupDir = getBackupDir(cwd);

  // Validate title
  validateTitle(options.title);

  // Read current data
  const data = accessor
    ? await accessor.loadTodoFile()
    : await readJsonRequired<TodoFile>(todoPath);

  // Read archive for ID generation
  let archivedTasks: Array<{ id: string }> = [];
  try {
    if (accessor) {
      const archive = await accessor.loadArchive();
      if (archive?.archivedTasks) {
        archivedTasks = archive.archivedTasks;
      }
    } else {
      const { readJson } = await import('../../store/json.js');
      const archive = await readJson<{ archivedTasks: Array<{ id: string }> }>(archivePath);
      if (archive?.archivedTasks) {
        archivedTasks = archive.archivedTasks;
      }
    }
  } catch {
    // Archive may not exist
  }

  // Resolve defaults
  const status = options.status ?? 'pending';
  const priority = normalizePriority(options.priority ?? 'medium');
  const size = options.size ?? 'medium';
  let taskType = options.type;
  const parentId = options.parentId ?? null;

  // Validate inputs
  validateStatus(status);
  // priority is already normalized above
  validateSize(size);
  if (options.labels?.length) validateLabels(options.labels);
  if (options.depends?.length) validateDepends(options.depends, data.tasks);

  // Phase validation
  let phase = options.phase;
  if (phase) {
    validatePhaseFormat(phase);
    // Check if phase exists in project
    const phases = data.project?.phases ?? {};
    if (!phases[phase]) {
      if (!options.addPhase) {
        const validPhases = Object.keys(phases).join(', ');
        throw new CleoError(
          ExitCode.NOT_FOUND,
          `Phase '${phase}' not found. Valid phases: ${validPhases || 'none'}. Use --add-phase to create new.`,
        );
      }
      // Create phase
      const order = Object.keys(phases).length + 1;
      const name = phase.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
      if (!data.project) {
        (data as unknown as Record<string, unknown>).project = { name: '', phases: {} };
      }
      if (!data.project.phases) data.project.phases = {};
      data.project.phases[phase] = { order, name, status: 'pending' as const };
    }
  } else {
    // Inherit from project.currentPhase
    if (data.project?.currentPhase) {
      phase = data.project.currentPhase;
    }
  }

  // Parent hierarchy validation
  if (parentId) {
    if (!/^T\d{3,}$/.test(parentId)) {
      throw new CleoError(ExitCode.INVALID_INPUT, `Invalid parent ID format: ${parentId}`);
    }
    // Read hierarchy limits from config
    const config = await loadConfig(cwd);
    const maxDepth = (config as any).hierarchy?.maxDepth ?? 3;
    const maxSiblings = (config as any).hierarchy?.maxSiblings ?? 7;
    validateParent(parentId, data.tasks, maxDepth, maxSiblings);

    // Validate type constraints
    if (taskType === 'epic') {
      throw new CleoError(
        ExitCode.VALIDATION_ERROR,
        'Epic tasks cannot have a parent - they must be root-level',
        { fix: "Remove --parent flag or change --type to task|subtask" },
      );
    }
  }

  if (taskType === 'subtask' && !parentId) {
    throw new CleoError(
      ExitCode.VALIDATION_ERROR,
      'Subtask tasks require a parent - specify with --parent',
      { fix: "Add --parent T### flag or change --type to task|epic" },
    );
  }

  if (taskType) {
    validateTaskType(taskType);
  } else {
    taskType = inferTaskType(parentId, data.tasks);
  }

  // Duplicate detection
  const duplicate = findRecentDuplicate(options.title, phase, data.tasks);
  if (duplicate) {
    return { task: duplicate, duplicate: true };
  }

  // Generate ID
  const taskId = generateTaskId(data.tasks, archivedTasks);

  // ID uniqueness check
  if (data.tasks.some(t => t.id === taskId)) {
    throw new CleoError(ExitCode.ID_COLLISION, `Generated ID ${taskId} already exists`);
  }

  const now = new Date().toISOString();
  const position = options.position ?? getNextPosition(parentId, data.tasks);

  // Build task object
  const task: Task = {
    id: taskId,
    title: options.title,
    status,
    priority,
    type: taskType,
    parentId: parentId || null,
    position,
    positionVersion: 0,
    size,
    createdAt: now,
    updatedAt: now,
  };

  // Add optional fields
  if (phase) task.phase = phase;
  if (options.description) task.description = options.description;
  if (options.labels?.length) task.labels = options.labels.map(l => l.trim());
  if (options.files?.length) task.files = options.files.map(f => f.trim());
  if (options.acceptance?.length) task.acceptance = options.acceptance.map(a => a.trim());
  if (options.depends?.length) task.depends = options.depends.map(d => d.trim());
  if (options.notes) {
    const timestampedNote = `${new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC')}: ${options.notes}`;
    task.notes = [timestampedNote];
  }
  if (status === 'blocked' && options.description) {
    task.blockedBy = options.description;
  }
  if (status === 'done') {
    task.completedAt = now;
  }

  // Dry run
  if (options.dryRun) {
    return { task, dryRun: true };
  }

  // Position shuffling if explicit position was given
  if (options.position !== undefined) {
    for (const t of data.tasks) {
      const isInScope = parentId
        ? t.parentId === parentId
        : (!t.parentId || t.parentId === null);
      if (isInScope && t.position !== undefined && t.position !== null && t.position >= options.position) {
        t.position = t.position + 1;
        t.positionVersion = (t.positionVersion ?? 0) + 1;
      }
    }
  }

  // Add task to array
  data.tasks.push(task);

  // Update checksum and timestamp
  const checksum = computeChecksum(data.tasks);
  data._meta.checksum = checksum;
  data.lastUpdated = now;

  // Save atomically
  if (accessor) {
    await accessor.saveTodoFile(data);
    await accessor.appendLog({
      id: `log-${Math.floor(Date.now() / 1000)}-${randomBytes(3).toString('hex')}`,
      timestamp: new Date().toISOString(),
      action: 'task_created',
      taskId,
      actor: 'system',
      details: { title: options.title, status, priority },
      before: null,
      after: { title: options.title, status, priority },
    });
  } else {
    await saveJson(todoPath, data, { backupDir });
    await logOperation(logPath, 'task_created', taskId, {
      title: options.title,
      status,
      priority,
    });
  }

  return { task };
}
