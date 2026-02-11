/**
 * Task Engine
 *
 * Native TypeScript implementation of core task CRUD operations.
 * Reads/writes .cleo/todo.json directly without CLI subprocess.
 *
 * Supports: show, get, list, find, exists, create/add, update, complete, delete, archive
 */

import { readJsonFile, writeJsonFileAtomic, withFileLock, withMultiLock, getDataPath } from './store.js';
import { validateTask } from './schema-validator.js';
import {
  validateNewTask,
  validateTitleDescription,
  validateTimestamps,
  validateStatusTransition,
  validateHierarchy,
  hasErrors,
  type RuleViolation,
} from './validation-rules.js';
import { generateNextIdFromSet, collectAllIds } from './id-generator.js';

/**
 * Task object as stored in todo.json
 */
export interface TaskRecord {
  id: string;
  title: string;
  description: string;
  status: string;
  priority: string;
  type?: string;
  phase?: string;
  createdAt: string;
  updatedAt: string | null;
  completedAt?: string | null;
  cancelledAt?: string | null;
  parentId?: string | null;
  position?: number | null;
  positionVersion?: number;
  depends?: string[];
  relates?: Array<{
    taskId: string;
    type: string;
    reason?: string;
  }>;
  files?: string[];
  acceptance?: string[];
  notes?: string[];
  labels?: string[];
  size?: string | null;
  epicLifecycle?: string | null;
  noAutoComplete?: boolean | null;
  verification?: Record<string, unknown> | null;
  origin?: string | null;
  createdBy?: string | null;
  validatedBy?: string | null;
  testedBy?: string | null;
  lifecycleState?: string | null;
  validationHistory?: Array<Record<string, unknown>>;
  blockedBy?: string[];
  cancellationReason?: string;
}

/**
 * The full todo.json structure
 */
interface TodoFile {
  version?: string;
  project?: {
    name: string;
    currentPhase?: string | null;
    phases?: Record<string, unknown>;
    phaseHistory?: unknown[];
    releases?: unknown[];
  };
  lastUpdated?: string;
  focus?: {
    currentTask?: string | null;
    currentPhase?: string | null;
    blockedUntil?: string | null;
    sessionNote?: string | null;
    sessionNotes?: unknown[];
    nextAction?: string | null;
    primarySession?: string | null;
  };
  _meta?: {
    schemaVersion: string;
    specVersion?: string;
    checksum?: string;
    configVersion?: string;
    lastSessionId?: string | null;
    activeSession?: string | null;
    multiSessionEnabled?: boolean;
    activeSessionCount?: number;
    sessionsFile?: string | null;
    generation?: number;
  };
  tasks: TaskRecord[];
  labels?: Record<string, string[]>;
}

/**
 * Minimal task representation for find results
 */
export interface MinimalTaskRecord {
  id: string;
  title: string;
  status: string;
  priority: string;
  parentId?: string | null;
}

/**
 * Engine result wrapper
 */
export interface EngineResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
}

/**
 * Load the todo.json file
 */
function loadTodoFile(projectRoot: string): TodoFile | null {
  const todoPath = getDataPath(projectRoot, 'todo.json');
  return readJsonFile<TodoFile>(todoPath);
}

/**
 * Compute SHA-256 truncated checksum for _meta
 */
function computeChecksum(tasks: TaskRecord[]): string {
  const { createHash } = require('crypto');
  const content = JSON.stringify(tasks);
  return createHash('sha256').update(content).digest('hex').substring(0, 16);
}

/**
 * Save todo.json with updated metadata
 */
function saveTodoFile(projectRoot: string, data: TodoFile): void {
  const todoPath = getDataPath(projectRoot, 'todo.json');

  // Update metadata
  data.lastUpdated = new Date().toISOString();
  if (data._meta) {
    data._meta.checksum = computeChecksum(data.tasks);
    data._meta.generation = (data._meta.generation || 0) + 1;
  }

  writeJsonFileAtomic(todoPath, data);
}

// ===== Query Operations =====

/**
 * Get a single task by ID
 */
export function taskShow(
  projectRoot: string,
  taskId: string
): EngineResult<TaskRecord> {
  const todo = loadTodoFile(projectRoot);
  if (!todo) {
    return { success: false, error: { code: 'E_NOT_INITIALIZED', message: 'No todo.json found' } };
  }

  const task = todo.tasks.find((t) => t.id === taskId);
  if (!task) {
    return {
      success: false,
      error: {
        code: 'E_NOT_FOUND',
        message: `Task '${taskId}' not found`,
      },
    };
  }

  return { success: true, data: task };
}

/**
 * List tasks with optional filters
 */
export function taskList(
  projectRoot: string,
  params?: {
    parent?: string;
    status?: string;
    limit?: number;
  }
): EngineResult<TaskRecord[]> {
  const todo = loadTodoFile(projectRoot);
  if (!todo) {
    return { success: false, error: { code: 'E_NOT_INITIALIZED', message: 'No todo.json found' } };
  }

  let tasks = todo.tasks;

  if (params?.parent) {
    tasks = tasks.filter((t) => t.parentId === params.parent);
  }

  if (params?.status) {
    tasks = tasks.filter((t) => t.status === params.status);
  }

  if (params?.limit && params.limit > 0) {
    tasks = tasks.slice(0, params.limit);
  }

  return { success: true, data: tasks };
}

/**
 * Fuzzy search tasks by title/description/ID
 */
export function taskFind(
  projectRoot: string,
  query: string,
  limit?: number
): EngineResult<MinimalTaskRecord[]> {
  const todo = loadTodoFile(projectRoot);
  if (!todo) {
    return { success: false, error: { code: 'E_NOT_INITIALIZED', message: 'No todo.json found' } };
  }

  const queryLower = query.toLowerCase();

  // Score-based fuzzy matching
  const scored = todo.tasks
    .map((task) => {
      let score = 0;
      const idLower = task.id.toLowerCase();
      const titleLower = task.title.toLowerCase();
      const descLower = (task.description || '').toLowerCase();

      // Exact ID match
      if (idLower === queryLower) score += 100;
      // ID contains query
      else if (idLower.includes(queryLower)) score += 50;

      // Exact title match
      if (titleLower === queryLower) score += 80;
      // Title starts with query
      else if (titleLower.startsWith(queryLower)) score += 40;
      // Title contains query
      else if (titleLower.includes(queryLower)) score += 20;

      // Description contains query
      if (descLower.includes(queryLower)) score += 10;

      // Label match
      if (task.labels?.some((l) => l.toLowerCase().includes(queryLower))) {
        score += 15;
      }

      return { task, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);

  let results = scored.map((item) => ({
    id: item.task.id,
    title: item.task.title,
    status: item.task.status,
    priority: item.task.priority,
    parentId: item.task.parentId,
  }));

  if (limit && limit > 0) {
    results = results.slice(0, limit);
  }

  return { success: true, data: results };
}

/**
 * Check if a task exists
 */
export function taskExists(
  projectRoot: string,
  taskId: string
): EngineResult<{ exists: boolean; taskId: string }> {
  const todo = loadTodoFile(projectRoot);
  if (!todo) {
    return { success: true, data: { exists: false, taskId } };
  }

  const exists = todo.tasks.some((t) => t.id === taskId);
  return { success: true, data: { exists, taskId } };
}

// ===== Mutate Operations =====

/**
 * Create a new task
 */
export async function taskCreate(
  projectRoot: string,
  params: {
    title: string;
    description: string;
    parent?: string;
    depends?: string[];
    priority?: string;
    labels?: string[];
    type?: string;
  }
): Promise<EngineResult<TaskRecord>> {
  const todoPath = getDataPath(projectRoot, 'todo.json');

  return await withFileLock<EngineResult<TaskRecord>>(todoPath, () => {
    const current = loadTodoFile(projectRoot);
    if (!current || !current.tasks) {
      return {
        success: false,
        error: { code: 'E_NOT_INITIALIZED', message: 'No valid todo.json found' },
      };
    }

    // Collect all IDs for uniqueness check
    const allIds = new Set(current.tasks.map((t) => t.id));
    // Also check archive
    const archiveIds = collectAllIds(projectRoot);
    for (const id of archiveIds) allIds.add(id);

    // Generate new ID
    const newId = generateNextIdFromSet(allIds);

    // Get existing descriptions for duplicate check
    const existingDescriptions = current.tasks
      .map((t) => t.description)
      .filter(Boolean) as string[];

    // Validate
    const violations = validateNewTask(
      {
        id: newId,
        title: params.title,
        description: params.description,
        parentId: params.parent || null,
        type: params.type,
      },
      allIds,
      existingDescriptions,
      current.tasks.map((t) => ({
        id: t.id,
        parentId: t.parentId,
        type: t.type,
      }))
    );

    if (hasErrors(violations)) {
      const errorMessages = violations
        .filter((v) => v.severity === 'error')
        .map((v) => v.message);
      return {
        success: false,
        error: {
          code: 'E_VALIDATION_FAILED',
          message: errorMessages.join('; '),
          details: violations,
        },
      };
    }

    const now = new Date().toISOString();

    // Determine type from parent
    let taskType = params.type || 'task';
    if (params.parent) {
      const parent = current.tasks.find((t) => t.id === params.parent);
      if (parent) {
        if (parent.type === 'epic') taskType = 'task';
        else if (parent.type === 'task') taskType = 'subtask';
      }
    }

    const newTask: TaskRecord = {
      id: newId,
      title: params.title,
      description: params.description,
      status: 'pending',
      priority: params.priority || 'medium',
      type: taskType,
      createdAt: now,
      updatedAt: null,
      parentId: params.parent || null,
      depends: params.depends || [],
      labels: params.labels || [],
      acceptance: [],
      notes: [],
      files: [],
    };

    current.tasks.push(newTask);

    // Update metadata
    current.lastUpdated = now;
    if (current._meta) {
      current._meta.checksum = computeChecksum(current.tasks);
      current._meta.generation = (current._meta.generation || 0) + 1;
    }

    // Write back (the lock handler will write this)
    // But withLock expects us to return the full file data for writing
    // We need to restructure: return the file for writing and wrap differently

    // Actually, withLock writes the return value as the file content.
    // We need to handle this differently - write the file ourselves and return the result.
    writeJsonFileAtomic(todoPath, current);

    return { success: true, data: newTask };
  }) as EngineResult<TaskRecord>;
}

/**
 * Update a task
 */
export async function taskUpdate(
  projectRoot: string,
  taskId: string,
  updates: {
    title?: string;
    description?: string;
    status?: string;
    priority?: string;
    notes?: string;
    labels?: string[];
    depends?: string[];
    acceptance?: string[];
  }
): Promise<EngineResult<TaskRecord>> {
  const todoPath = getDataPath(projectRoot, 'todo.json');

  return await withFileLock<EngineResult<TaskRecord>>(todoPath, () => {
    const current = loadTodoFile(projectRoot);
    if (!current || !current.tasks) {
      return {
        success: false,
        error: { code: 'E_NOT_INITIALIZED', message: 'No valid todo.json found' },
      };
    }

    const taskIndex = current.tasks.findIndex((t) => t.id === taskId);
    if (taskIndex === -1) {
      return {
        success: false,
        error: { code: 'E_NOT_FOUND', message: `Task '${taskId}' not found` },
      };
    }

    const task = current.tasks[taskIndex];
    const violations: RuleViolation[] = [];

    // Validate title/description if being updated
    if (updates.title !== undefined || updates.description !== undefined) {
      const newTitle = updates.title ?? task.title;
      const newDesc = updates.description ?? task.description;
      violations.push(...validateTitleDescription(newTitle, newDesc));
    }

    // Validate status transition
    if (updates.status && updates.status !== task.status) {
      violations.push(...validateStatusTransition(task.status, updates.status));
    }

    if (hasErrors(violations)) {
      const errorMessages = violations
        .filter((v) => v.severity === 'error')
        .map((v) => v.message);
      return {
        success: false,
        error: {
          code: 'E_VALIDATION_FAILED',
          message: errorMessages.join('; '),
          details: violations,
        },
      };
    }

    const now = new Date().toISOString();

    // Apply updates
    if (updates.title !== undefined) task.title = updates.title;
    if (updates.description !== undefined) task.description = updates.description;
    if (updates.priority !== undefined) task.priority = updates.priority;
    if (updates.labels !== undefined) task.labels = updates.labels;
    if (updates.depends !== undefined) task.depends = updates.depends;
    if (updates.acceptance !== undefined) task.acceptance = updates.acceptance;

    if (updates.status !== undefined) {
      task.status = updates.status;
      if (updates.status === 'done') {
        task.completedAt = now;
      }
      if (updates.status === 'cancelled') {
        task.cancelledAt = now;
      }
    }

    // Append note if provided
    if (updates.notes) {
      if (!task.notes) task.notes = [];
      task.notes.push(`[${now}] ${updates.notes}`);
    }

    task.updatedAt = now;
    current.tasks[taskIndex] = task;

    // Save
    saveTodoFile(projectRoot, current);

    return { success: true, data: task };
  }) as EngineResult<TaskRecord>;
}

/**
 * Complete a task (set status to done)
 */
export async function taskComplete(
  projectRoot: string,
  taskId: string,
  notes?: string
): Promise<EngineResult<TaskRecord>> {
  return taskUpdate(projectRoot, taskId, {
    status: 'done',
    notes: notes || undefined,
  });
}

/**
 * Delete a task
 */
export async function taskDelete(
  projectRoot: string,
  taskId: string,
  force?: boolean
): Promise<EngineResult<{ deleted: boolean; taskId: string }>> {
  const todoPath = getDataPath(projectRoot, 'todo.json');

  return await withFileLock<EngineResult<{ deleted: boolean; taskId: string }>>(
    todoPath,
    () => {
      const current = loadTodoFile(projectRoot);
      if (!current || !current.tasks) {
        return {
          success: false,
          error: { code: 'E_NOT_INITIALIZED', message: 'No valid todo.json found' },
        };
      }

      const taskIndex = current.tasks.findIndex((t) => t.id === taskId);
      if (taskIndex === -1) {
        return {
          success: false,
          error: { code: 'E_NOT_FOUND', message: `Task '${taskId}' not found` },
        };
      }

      const task = current.tasks[taskIndex];

      // Check for children
      if (!force) {
        const children = current.tasks.filter((t) => t.parentId === taskId);
        if (children.length > 0) {
          return {
            success: false,
            error: {
              code: 'E_HAS_CHILDREN',
              message: `Task '${taskId}' has ${children.length} children. Use force=true to delete anyway.`,
            },
          };
        }
      }

      // Remove task (and optionally children if force)
      if (force) {
        const toRemove = new Set<string>([taskId]);
        // Collect all descendants
        const collectDescendants = (parentId: string) => {
          for (const t of current.tasks) {
            if (t.parentId === parentId && !toRemove.has(t.id)) {
              toRemove.add(t.id);
              collectDescendants(t.id);
            }
          }
        };
        collectDescendants(taskId);
        current.tasks = current.tasks.filter((t) => !toRemove.has(t.id));
      } else {
        current.tasks.splice(taskIndex, 1);
      }

      saveTodoFile(projectRoot, current);

      return { success: true, data: { deleted: true, taskId } };
    }
  ) as EngineResult<{ deleted: boolean; taskId: string }>;
}

/**
 * Archive completed tasks.
 * Moves done/cancelled tasks from todo.json to todo-archive.json.
 */
export async function taskArchive(
  projectRoot: string,
  taskId?: string,
  before?: string
): Promise<EngineResult<{ archived: number; taskIds: string[] }>> {
  const todoPath = getDataPath(projectRoot, 'todo.json');
  const archivePath = getDataPath(projectRoot, 'todo-archive.json');

  return await withMultiLock<EngineResult<{ archived: number; taskIds: string[] }>>(
    [todoPath, archivePath],
    () => {
      const todo = readJsonFile<TodoFile>(todoPath);
      if (!todo || !todo.tasks) {
        return {
          success: false,
          error: { code: 'E_NOT_INITIALIZED', message: 'No valid todo.json found' },
        };
      }

      // Determine which tasks to archive
      let tasksToArchive: TaskRecord[];

      if (taskId) {
        const task = todo.tasks.find((t) => t.id === taskId);
        if (!task) {
          return {
            success: false,
            error: { code: 'E_NOT_FOUND', message: `Task '${taskId}' not found` },
          };
        }
        if (task.status !== 'done' && task.status !== 'cancelled') {
          return {
            success: false,
            error: {
              code: 'E_INVALID_STATUS',
              message: `Task '${taskId}' has status '${task.status}', must be done or cancelled to archive`,
            },
          };
        }
        tasksToArchive = [task];
      } else {
        // Archive all completed tasks
        tasksToArchive = todo.tasks.filter((t) => {
          if (t.status !== 'done' && t.status !== 'cancelled') return false;
          if (before) {
            const completedDate = t.completedAt || t.cancelledAt;
            if (completedDate && completedDate > before) return false;
          }
          return true;
        });
      }

      if (tasksToArchive.length === 0) {
        return { success: true, data: { archived: 0, taskIds: [] } };
      }

      // Load or create archive
      let archive = readJsonFile<{
        version?: string;
        project?: string;
        _meta?: {
          schemaVersion: string;
          totalArchived: number;
          lastArchived: string | null;
        };
        archivedTasks: Array<TaskRecord & { _archive?: Record<string, unknown> }>;
      }>(archivePath);

      if (!archive) {
        archive = {
          _meta: {
            schemaVersion: '2.4.0',
            totalArchived: 0,
            lastArchived: null,
          },
          archivedTasks: [],
        };
      }

      const now = new Date().toISOString();
      const archivedIds: string[] = [];

      // Move tasks to archive
      for (const task of tasksToArchive) {
        const archivedTask = {
          ...task,
          _archive: {
            archivedAt: now,
            reason: taskId ? 'manual' : 'auto',
          },
        };
        archive.archivedTasks.push(archivedTask);
        archivedIds.push(task.id);
      }

      // Remove from todo
      todo.tasks = todo.tasks.filter((t) => !archivedIds.includes(t.id));

      // Update archive metadata
      if (archive._meta) {
        archive._meta.totalArchived = archive.archivedTasks.length;
        archive._meta.lastArchived = now;
      }

      // Save both files
      writeJsonFileAtomic(todoPath, todo);
      writeJsonFileAtomic(archivePath, archive);

      return {
        success: true,
        data: { archived: archivedIds.length, taskIds: archivedIds },
      };
    }
  );
}
