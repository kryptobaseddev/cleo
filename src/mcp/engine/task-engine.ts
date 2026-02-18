/**
 * Task Engine
 *
 * Native TypeScript implementation of core task CRUD operations.
 * Uses StoreProvider (via getStore()) for task/session data access,
 * falling back to direct JSON for config and specialized operations.
 *
 * Supports: show, get, list, find, exists, create/add, update, complete, delete, archive
 *
 * @task T4657
 * @epic T4654
 */

import { readJsonFile, readLogFileEntries, getDataPath } from './store.js';
import { getAccessor } from '../../store/data-accessor.js';
import type { Task } from '../../types/task.js';
// validation-rules.js still used by other engines; core modules handle their own validation
// Core module imports for accessor-based operations
import { addTask as coreAddTask } from '../../core/tasks/add.js';
import { updateTask as coreUpdateTask } from '../../core/tasks/update.js';
import { deleteTask as coreDeleteTask } from '../../core/tasks/delete.js';
import { archiveTasks as coreArchiveTasks } from '../../core/tasks/archive.js';
import { showTask as coreShowTask } from '../../core/tasks/show.js';
import { listTasks as coreListTasks } from '../../core/tasks/list.js';
import { findTasks as coreFindTasks } from '../../core/tasks/find.js';

/**
 * Read hierarchy limits from .cleo/config.json.
 * Falls back to defaults if config is missing or unset.
 */
function getHierarchyLimits(projectRoot: string): { maxDepth: number; maxSiblings: number } {
  const configPath = getDataPath(projectRoot, 'config.json');
  const config = readJsonFile<Record<string, unknown>>(configPath);

  let maxDepth = 3;
  let maxSiblings = 7;

  if (config) {
    const hierarchy = config.hierarchy as Record<string, unknown> | undefined;
    if (hierarchy) {
      if (typeof hierarchy.maxDepth === 'number') maxDepth = hierarchy.maxDepth;
      if (typeof hierarchy.maxSiblings === 'number') maxSiblings = hierarchy.maxSiblings;
    }
  }

  return { maxDepth, maxSiblings };
}

/**
 * Load all tasks via DataAccessor.
 * Returns Task[] from the accessor abstraction layer.
 *
 * @task T4657
 * @epic T4654
 */
async function loadAllTasksAsync(projectRoot: string): Promise<Task[]> {
  const accessor = await getAccessor(projectRoot);
  const data = await accessor.loadTodoFile();
  return data.tasks;
}

/**
 * Convert a core Task to a TaskRecord for backward compatibility.
 * TaskRecord has string-typed status/priority; Task has union types.
 *
 * @task T4657
 * @epic T4654
 */
function taskToRecord(task: Task): TaskRecord {
  return task as unknown as TaskRecord;
}

/**
 * Convert an array of core Tasks to TaskRecords.
 *
 * @task T4657
 * @epic T4654
 */
function tasksToRecords(tasks: Task[]): TaskRecord[] {
  return tasks as unknown as TaskRecord[];
}

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

// Local TodoFile interface removed — DataAccessor uses the canonical TodoFile from types/task.ts.

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

// loadTodoFile and saveTodoFile removed — all operations now use DataAccessor.
// Config reads (hierarchy limits, phase meta) still use readJsonFile directly
// since they are NOT domain data (they don't go through the accessor).

// Priority normalization moved to core/tasks/add.ts (normalizePriority)

// ===== Query Operations =====

/**
 * Get a single task by ID
 * @task T4657
 * @epic T4654
 */
export async function taskShow(
  projectRoot: string,
  taskId: string
): Promise<EngineResult<TaskRecord>> {
  try {
    const accessor = await getAccessor(projectRoot);
    const detail = await coreShowTask(taskId, projectRoot, accessor);
    return { success: true, data: taskToRecord(detail) };
  } catch (err: unknown) {
    const code = (err as { code?: number })?.code;
    if (code === 5 /* NOT_FOUND */) {
      return {
        success: false,
        error: { code: 'E_NOT_FOUND', message: `Task '${taskId}' not found` },
      };
    }
    return { success: false, error: { code: 'E_NOT_INITIALIZED', message: 'No todo.json found' } };
  }
}

/**
 * List tasks with optional filters
 * @task T4657
 * @epic T4654
 */
export async function taskList(
  projectRoot: string,
  params?: {
    parent?: string;
    status?: string;
    limit?: number;
  }
): Promise<EngineResult<TaskRecord[]>> {
  try {
    const accessor = await getAccessor(projectRoot);
    const result = await coreListTasks({
      parentId: params?.parent ?? undefined,
      status: params?.status as import('../../types/task.js').TaskStatus | undefined,
      limit: params?.limit,
    }, projectRoot, accessor);
    return { success: true, data: tasksToRecords(result.tasks) };
  } catch {
    return { success: false, error: { code: 'E_NOT_INITIALIZED', message: 'No todo.json found' } };
  }
}

/**
 * Fuzzy search tasks by title/description/ID
 * @task T4657
 * @epic T4654
 */
export async function taskFind(
  projectRoot: string,
  query: string,
  limit?: number
): Promise<EngineResult<MinimalTaskRecord[]>> {
  try {
    const accessor = await getAccessor(projectRoot);
    const findResult = await coreFindTasks({
      query,
      limit: limit ?? 20,
    }, projectRoot, accessor);

    const results: MinimalTaskRecord[] = findResult.results.map((r) => ({
      id: r.id,
      title: r.title,
      status: r.status,
      priority: r.priority,
      parentId: r.parentId,
    }));

    return { success: true, data: results };
  } catch {
    return { success: false, error: { code: 'E_NOT_INITIALIZED', message: 'No todo.json found' } };
  }
}

/**
 * Check if a task exists
 * @task T4657
 * @epic T4654
 */
export async function taskExists(
  projectRoot: string,
  taskId: string
): Promise<EngineResult<{ exists: boolean; taskId: string }>> {
  try {
    const accessor = await getAccessor(projectRoot);
    const data = await accessor.loadTodoFile();
    const exists = data.tasks.some((t) => t.id === taskId);
    return { success: true, data: { exists, taskId } };
  } catch {
    return { success: true, data: { exists: false, taskId } };
  }
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
  try {
    const accessor = await getAccessor(projectRoot);
    const result = await coreAddTask({
      title: params.title,
      description: params.description,
      parentId: params.parent || null,
      depends: params.depends,
      priority: (params.priority as import('../../types/task.js').TaskPriority) || 'medium',
      labels: params.labels,
      type: (params.type as import('../../types/task.js').TaskType) || undefined,
    }, projectRoot, accessor);

    if (result.duplicate) {
      return {
        success: true,
        data: taskToRecord(result.task),
      };
    }

    return { success: true, data: taskToRecord(result.task) };
  } catch (err: unknown) {
    const cleoErr = err as { code?: number; message?: string };
    // Map CleoError exit codes to engine error codes
    if (cleoErr.code === 7 /* PARENT_NOT_FOUND */) {
      return { success: false, error: { code: 'E_PARENT_NOT_FOUND', message: cleoErr.message ?? 'Parent task not found' } };
    }
    if (cleoErr.code === 9 /* DEPTH_EXCEEDED */) {
      return { success: false, error: { code: 'E_DEPTH_EXCEEDED', message: cleoErr.message ?? 'Max hierarchy depth exceeded' } };
    }
    if (cleoErr.code === 10 /* SIBLING_LIMIT */) {
      return { success: false, error: { code: 'E_SIBLING_LIMIT', message: cleoErr.message ?? 'Max siblings exceeded' } };
    }
    if (cleoErr.code === 4 /* VALIDATION_ERROR */ || cleoErr.code === 3 /* INVALID_INPUT */) {
      return { success: false, error: { code: 'E_VALIDATION_FAILED', message: cleoErr.message ?? 'Validation failed' } };
    }
    return { success: false, error: { code: 'E_NOT_INITIALIZED', message: cleoErr.message ?? 'No valid todo.json found' } };
  }
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
  try {
    const accessor = await getAccessor(projectRoot);
    const result = await coreUpdateTask({
      taskId,
      title: updates.title,
      description: updates.description,
      status: updates.status as import('../../types/task.js').TaskStatus | undefined,
      priority: updates.priority as import('../../types/task.js').TaskPriority | undefined,
      notes: updates.notes,
      labels: updates.labels,
      depends: updates.depends,
      acceptance: updates.acceptance,
    }, projectRoot, accessor);

    return { success: true, data: taskToRecord(result.task) };
  } catch (err: unknown) {
    const cleoErr = err as { code?: number; message?: string };
    if (cleoErr.code === 5 /* NOT_FOUND */) {
      return { success: false, error: { code: 'E_NOT_FOUND', message: cleoErr.message ?? `Task '${taskId}' not found` } };
    }
    if (cleoErr.code === 4 /* VALIDATION_ERROR */ || cleoErr.code === 3 /* INVALID_INPUT */) {
      return { success: false, error: { code: 'E_VALIDATION_FAILED', message: cleoErr.message ?? 'Validation failed' } };
    }
    if (cleoErr.code === 50 /* NO_CHANGE */) {
      return { success: false, error: { code: 'E_NO_CHANGE', message: cleoErr.message ?? 'No changes specified' } };
    }
    return { success: false, error: { code: 'E_NOT_INITIALIZED', message: cleoErr.message ?? 'No valid todo.json found' } };
  }
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
  try {
    const accessor = await getAccessor(projectRoot);
    await coreDeleteTask({
      taskId,
      force: force ?? false,
      cascade: force ?? false,
    }, projectRoot, accessor);

    return { success: true, data: { deleted: true, taskId } };
  } catch (err: unknown) {
    const cleoErr = err as { code?: number; message?: string };
    if (cleoErr.code === 5 /* NOT_FOUND */) {
      return { success: false, error: { code: 'E_NOT_FOUND', message: cleoErr.message ?? `Task '${taskId}' not found` } };
    }
    if (cleoErr.code === 11 /* HAS_CHILDREN */) {
      return { success: false, error: { code: 'E_HAS_CHILDREN', message: cleoErr.message ?? `Task '${taskId}' has children` } };
    }
    return { success: false, error: { code: 'E_NOT_INITIALIZED', message: cleoErr.message ?? 'No valid todo.json found' } };
  }
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
  try {
    const accessor = await getAccessor(projectRoot);
    const result = await coreArchiveTasks({
      taskIds: taskId ? [taskId] : undefined,
      before,
    }, projectRoot, accessor);

    return {
      success: true,
      data: { archived: result.archived.length, taskIds: result.archived },
    };
  } catch (err: unknown) {
    const cleoErr = err as { code?: number; message?: string };
    if (cleoErr.code === 5 /* NOT_FOUND */) {
      return { success: false, error: { code: 'E_NOT_FOUND', message: cleoErr.message ?? `Task not found` } };
    }
    return { success: false, error: { code: 'E_NOT_INITIALIZED', message: cleoErr.message ?? 'No valid todo.json found' } };
  }
}

// ===== Scoring & Analysis Operations =====

/**
 * Priority score weights for task scoring
 */
const PRIORITY_SCORE: Record<string, number> = {
  critical: 100,
  high: 75,
  medium: 50,
  low: 25,
};

/**
 * Check if all dependencies of a task are satisfied (done/cancelled).
 */
function depsReady(task: TaskRecord, taskMap: Map<string, TaskRecord>): boolean {
  if (!task.depends || task.depends.length === 0) return true;
  return task.depends.every((depId) => {
    const dep = taskMap.get(depId);
    return dep && (dep.status === 'done' || dep.status === 'cancelled');
  });
}

/**
 * Suggest next task to work on based on priority, phase alignment, age, and dependency readiness.
 * @task T4657
 * @epic T4654
 */
export async function taskNext(
  projectRoot: string,
  params?: {
    count?: number;
    explain?: boolean;
  }
): Promise<EngineResult<{
  suggestions: Array<{
    id: string;
    title: string;
    priority: string;
    phase: string | null;
    score: number;
    reasons?: string[];
  }>;
  totalCandidates: number;
}>> {
  let allTasks: TaskRecord[];
  try {
    const tasks = await loadAllTasksAsync(projectRoot);
    allTasks = tasksToRecords(tasks);
  } catch {
    return { success: false, error: { code: 'E_NOT_INITIALIZED', message: 'No todo.json found' } };
  }

  const taskMap = new Map(allTasks.map((t) => [t.id, t]));
  // Read current phase from config (not domain data - keep as direct JSON)
  const todoPath = getDataPath(projectRoot, 'todo.json');
  const todoMeta = readJsonFile<{ project?: { currentPhase?: string | null } }>(todoPath);
  const currentPhase = todoMeta?.project?.currentPhase;

  // Filter candidates: pending, deps ready
  const candidates = allTasks.filter((t) =>
    t.status === 'pending' && depsReady(t, taskMap),
  );

  if (candidates.length === 0) {
    return {
      success: true,
      data: {
        suggestions: [],
        totalCandidates: 0,
      },
    };
  }

  // Score each candidate
  const scored = candidates.map((task) => {
    const reasons: string[] = [];
    let score = 0;

    // Priority score
    score += PRIORITY_SCORE[task.priority] ?? 50;
    reasons.push(`priority: ${task.priority} (+${PRIORITY_SCORE[task.priority] ?? 50})`);

    // Phase alignment bonus
    if (currentPhase && task.phase === currentPhase) {
      score += 20;
      reasons.push(`phase alignment: ${currentPhase} (+20)`);
    }

    // Dependencies ready bonus
    if (depsReady(task, taskMap)) {
      score += 10;
      reasons.push('all dependencies satisfied (+10)');
    }

    // Age bonus (older tasks get slight priority)
    if (task.createdAt) {
      const ageMs = Date.now() - new Date(task.createdAt).getTime();
      const ageDays = ageMs / (1000 * 60 * 60 * 24);
      if (ageDays > 7) {
        const ageBonus = Math.min(15, Math.floor(ageDays / 7));
        score += ageBonus;
        reasons.push(`age: ${Math.floor(ageDays)} days (+${ageBonus})`);
      }
    }

    return { task, score, reasons };
  }).sort((a, b) => b.score - a.score);

  const count = Math.min(params?.count || 1, scored.length);
  const explain = params?.explain ?? false;

  const suggestions = scored.slice(0, count).map(({ task, score, reasons }) => ({
    id: task.id,
    title: task.title,
    priority: task.priority,
    phase: task.phase ?? null,
    score,
    ...(explain && { reasons }),
  }));

  return {
    success: true,
    data: {
      suggestions,
      totalCandidates: candidates.length,
    },
  };
}

// ===== Blocking Chain Operations =====

/**
 * Build blocking chain for a task recursively.
 */
function buildBlockingChain(
  task: TaskRecord,
  taskMap: Map<string, TaskRecord>,
  visited: Set<string> = new Set()
): string[] {
  const chain: string[] = [];
  if (visited.has(task.id)) return chain;
  visited.add(task.id);

  if (task.depends) {
    for (const depId of task.depends) {
      const dep = taskMap.get(depId);
      if (dep && dep.status !== 'done' && dep.status !== 'cancelled') {
        chain.push(depId);
        chain.push(...buildBlockingChain(dep, taskMap, visited));
      }
    }
  }

  return chain;
}

/**
 * Show blocked tasks and analyze blocking chains.
 * @task T4657
 * @epic T4654
 */
export async function taskBlockers(
  projectRoot: string,
  params?: { analyze?: boolean }
): Promise<EngineResult<{
  blockedTasks: Array<{
    id: string;
    title: string;
    status: string;
    depends?: string[];
    blockingChain: string[];
  }>;
  criticalBlockers: Array<{
    id: string;
    title: string;
    blocksCount: number;
  }>;
  summary: string;
}>> {
  let allTasks: TaskRecord[];
  try {
    const tasks = await loadAllTasksAsync(projectRoot);
    allTasks = tasksToRecords(tasks);
  } catch {
    return { success: false, error: { code: 'E_NOT_INITIALIZED', message: 'No todo.json found' } };
  }

  const taskMap = new Map(allTasks.map((t) => [t.id, t]));
  const analyze = params?.analyze ?? false;

  // Find tasks with status 'blocked'
  const blockedTasks = allTasks.filter((t) => t.status === 'blocked');

  // Find pending tasks with unsatisfied dependencies
  const depBlockedTasks = allTasks.filter((t) =>
    t.status === 'pending' &&
    t.depends &&
    t.depends.length > 0 &&
    t.depends.some((depId) => {
      const dep = taskMap.get(depId);
      return dep && dep.status !== 'done' && dep.status !== 'cancelled';
    }),
  );

  const blockerInfos = [
    ...blockedTasks.map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      depends: t.depends,
      blockingChain: analyze ? buildBlockingChain(t, taskMap) : [],
    })),
    ...depBlockedTasks
      .filter((t) => !blockedTasks.some((bt) => bt.id === t.id))
      .map((t) => ({
        id: t.id,
        title: t.title,
        status: t.status,
        depends: t.depends,
        blockingChain: analyze ? buildBlockingChain(t, taskMap) : [],
      })),
  ];

  // Find critical blockers (tasks that block the most others)
  const blockerCounts = new Map<string, number>();
  for (const info of blockerInfos) {
    for (const depId of info.blockingChain) {
      blockerCounts.set(depId, (blockerCounts.get(depId) ?? 0) + 1);
    }
  }

  const criticalBlockers = [...blockerCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([id, count]) => {
      const task = taskMap.get(id);
      return { id, title: task?.title ?? 'Unknown', blocksCount: count };
    });

  return {
    success: true,
    data: {
      blockedTasks: blockerInfos,
      criticalBlockers,
      summary: blockerInfos.length === 0
        ? 'No blocked tasks found'
        : `${blockerInfos.length} blocked task(s)`,
    },
  };
}

// ===== Hierarchy / Tree Operations =====

/**
 * Tree node representation for task hierarchy
 */
interface TaskTreeNode {
  id: string;
  title: string;
  status: string;
  type?: string;
  children: TaskTreeNode[];
}

/**
 * Build a tree node recursively from a task
 */
function buildTreeNode(
  task: TaskRecord,
  childrenMap: Map<string, TaskRecord[]>
): TaskTreeNode {
  const children = (childrenMap.get(task.id) ?? []).map((child) =>
    buildTreeNode(child, childrenMap)
  );
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    type: task.type,
    children,
  };
}

/**
 * Build hierarchy tree. If taskId is provided, build subtree rooted at that task.
 * Otherwise, build full tree from all root tasks.
 * @task T4657
 * @epic T4654
 */
export async function taskTree(
  projectRoot: string,
  taskId?: string
): Promise<EngineResult<{ tree: TaskTreeNode[]; totalNodes: number }>> {
  let allTasks: TaskRecord[];
  try {
    const tasks = await loadAllTasksAsync(projectRoot);
    allTasks = tasksToRecords(tasks);
  } catch {
    return { success: false, error: { code: 'E_NOT_INITIALIZED', message: 'No todo.json found' } };
  }

  if (taskId) {
    const task = allTasks.find((t) => t.id === taskId);
    if (!task) {
      return {
        success: false,
        error: { code: 'E_NOT_FOUND', message: `Task '${taskId}' not found` },
      };
    }
  }

  // Build children lookup
  const childrenMap = new Map<string, TaskRecord[]>();
  for (const task of allTasks) {
    const parentKey = task.parentId ?? '__root__';
    if (!childrenMap.has(parentKey)) {
      childrenMap.set(parentKey, []);
    }
    childrenMap.get(parentKey)!.push(task);
  }

  let roots: TaskRecord[];
  if (taskId) {
    const rootTask = allTasks.find((t) => t.id === taskId)!;
    roots = [rootTask];
  } else {
    roots = childrenMap.get('__root__') ?? [];
  }

  const tree = roots.map((root) => buildTreeNode(root, childrenMap));

  // Count total nodes
  function countNodes(nodes: TaskTreeNode[]): number {
    let count = nodes.length;
    for (const node of nodes) {
      count += countNodes(node.children);
    }
    return count;
  }

  return {
    success: true,
    data: { tree, totalNodes: countNodes(tree) },
  };
}

// ===== Dependency Operations =====

/**
 * Show dependencies for a task - both what it depends on and what depends on it.
 * @task T4657
 * @epic T4654
 */
export async function taskDeps(
  projectRoot: string,
  taskId: string
): Promise<EngineResult<{
  taskId: string;
  dependsOn: Array<{ id: string; title: string; status: string }>;
  dependedOnBy: Array<{ id: string; title: string; status: string }>;
  unresolvedDeps: string[];
  allDepsReady: boolean;
}>> {
  let allTasks: TaskRecord[];
  try {
    const tasks = await loadAllTasksAsync(projectRoot);
    allTasks = tasksToRecords(tasks);
  } catch {
    return { success: false, error: { code: 'E_NOT_INITIALIZED', message: 'No todo.json found' } };
  }

  const task = allTasks.find((t) => t.id === taskId);
  if (!task) {
    return {
      success: false,
      error: { code: 'E_NOT_FOUND', message: `Task '${taskId}' not found` },
    };
  }

  const taskMap = new Map(allTasks.map((t) => [t.id, t]));
  const completedIds = new Set(
    allTasks.filter((t) => t.status === 'done' || t.status === 'cancelled').map((t) => t.id),
  );

  // What this task depends on
  const dependsOn = (task.depends ?? [])
    .map((depId) => {
      const dep = taskMap.get(depId);
      return dep ? { id: dep.id, title: dep.title, status: dep.status } : null;
    })
    .filter((d): d is { id: string; title: string; status: string } => d !== null);

  // What depends on this task
  const dependedOnBy = allTasks
    .filter((t) => t.depends?.includes(taskId))
    .map((t) => ({ id: t.id, title: t.title, status: t.status }));

  // Unresolved deps
  const unresolvedDeps = (task.depends ?? []).filter((depId) => !completedIds.has(depId));

  return {
    success: true,
    data: {
      taskId,
      dependsOn,
      dependedOnBy,
      unresolvedDeps,
      allDepsReady: unresolvedDeps.length === 0,
    },
  };
}

// ===== Relation Operations =====

/**
 * Show task relations (existing relates entries).
 * @task T4657
 * @epic T4654
 */
export async function taskRelates(
  projectRoot: string,
  taskId: string
): Promise<EngineResult<{
  taskId: string;
  relations: Array<{
    taskId: string;
    type: string;
    reason?: string;
  }>;
  count: number;
}>> {
  let allTasks: TaskRecord[];
  try {
    const tasks = await loadAllTasksAsync(projectRoot);
    allTasks = tasksToRecords(tasks);
  } catch {
    return { success: false, error: { code: 'E_NOT_INITIALIZED', message: 'No todo.json found' } };
  }

  const task = allTasks.find((t) => t.id === taskId);
  if (!task) {
    return {
      success: false,
      error: { code: 'E_NOT_FOUND', message: `Task '${taskId}' not found` },
    };
  }

  const relations = task.relates ?? [];

  return {
    success: true,
    data: {
      taskId,
      relations,
      count: relations.length,
    },
  };
}

/**
 * Add a relation between two tasks.
 */
export async function taskRelatesAdd(
  projectRoot: string,
  taskId: string,
  relatedId: string,
  type: string,
  reason?: string
): Promise<EngineResult<{ from: string; to: string; type: string; added: boolean }>> {
  try {
    const accessor = await getAccessor(projectRoot);
    const current = await accessor.loadTodoFile();
    if (!current || !current.tasks) {
      return {
        success: false,
        error: { code: 'E_NOT_INITIALIZED', message: 'No valid todo.json found' },
      };
    }

    const fromTask = current.tasks.find((t) => t.id === taskId) as TaskRecord | undefined;
    if (!fromTask) {
      return {
        success: false,
        error: { code: 'E_NOT_FOUND', message: `Task '${taskId}' not found` },
      };
    }

    const toTask = current.tasks.find((t) => t.id === relatedId);
    if (!toTask) {
      return {
        success: false,
        error: { code: 'E_NOT_FOUND', message: `Task '${relatedId}' not found` },
      };
    }

    if (!fromTask.relates) {
      fromTask.relates = [];
    }

    fromTask.relates.push({
      taskId: relatedId,
      type,
      reason: reason || undefined,
    });

    fromTask.updatedAt = new Date().toISOString();

    await accessor.saveTodoFile(current);

    return {
      success: true,
      data: { from: taskId, to: relatedId, type, added: true },
    };
  } catch {
    return {
      success: false,
      error: { code: 'E_NOT_INITIALIZED', message: 'Failed to update task relations' },
    };
  }
}

// ===== Analysis Operations =====

/**
 * Analyze a task for description quality, missing fields, and dependency health.
 * @task T4657
 * @epic T4654
 */
export async function taskAnalyze(
  projectRoot: string,
  taskId?: string
): Promise<EngineResult<{
  recommended: { id: string; title: string; leverage: number; reason: string } | null;
  bottlenecks: Array<{ id: string; title: string; blocksCount: number }>;
  tiers: {
    critical: Array<{ id: string; title: string; leverage: number }>;
    high: Array<{ id: string; title: string; leverage: number }>;
    normal: Array<{ id: string; title: string; leverage: number }>;
  };
  metrics: {
    totalTasks: number;
    actionable: number;
    blocked: number;
    avgLeverage: number;
  };
}>> {
  let allTasks: TaskRecord[];
  try {
    const loaded = await loadAllTasksAsync(projectRoot);
    allTasks = tasksToRecords(loaded);
  } catch {
    return { success: false, error: { code: 'E_NOT_INITIALIZED', message: 'No todo.json found' } };
  }

  const tasks = taskId
    ? allTasks.filter((t) => t.id === taskId || t.parentId === taskId)
    : allTasks;

  // Build dependency graph: who blocks whom
  const blocksMap: Record<string, string[]> = {};
  for (const task of tasks) {
    if (task.depends) {
      for (const dep of task.depends) {
        if (!blocksMap[dep]) blocksMap[dep] = [];
        blocksMap[dep]!.push(task.id);
      }
    }
  }

  // Calculate leverage for each task
  const leverageMap: Record<string, number> = {};
  for (const task of tasks) {
    leverageMap[task.id] = (blocksMap[task.id] ?? []).length;
  }

  // Actionable tasks (pending or active)
  const actionable = tasks.filter((t) =>
    t.status === 'pending' || t.status === 'active',
  );

  const blocked = tasks.filter((t) => t.status === 'blocked');

  // Bottlenecks: tasks blocking the most others
  const bottlenecks = tasks
    .filter((t) => (blocksMap[t.id]?.length ?? 0) > 0 && t.status !== 'done')
    .map((t) => ({ id: t.id, title: t.title, blocksCount: blocksMap[t.id]!.length }))
    .sort((a, b) => b.blocksCount - a.blocksCount)
    .slice(0, 5);

  // Score and tier actionable tasks
  const scored = actionable.map((t) => ({
    id: t.id,
    title: t.title,
    leverage: leverageMap[t.id] ?? 0,
    priority: t.priority,
  }));

  scored.sort((a, b) => {
    const priorityWeight: Record<string, number> = { critical: 100, high: 50, medium: 20, low: 5 };
    const aScore = (priorityWeight[a.priority ?? 'medium'] ?? 20) + a.leverage * 10;
    const bScore = (priorityWeight[b.priority ?? 'medium'] ?? 20) + b.leverage * 10;
    return bScore - aScore;
  });

  const critical = scored.filter((t) => t.priority === 'critical');
  const high = scored.filter((t) => t.priority === 'high');
  const normal = scored.filter((t) => t.priority !== 'critical' && t.priority !== 'high');

  const recommended = scored.length > 0
    ? {
        id: scored[0]!.id,
        title: scored[0]!.title,
        leverage: scored[0]!.leverage,
        reason: 'Highest combined priority and leverage score',
      }
    : null;

  const totalLeverage = Object.values(leverageMap).reduce((s, v) => s + v, 0);
  const avgLeverage = tasks.length > 0
    ? Math.round((totalLeverage / tasks.length) * 100) / 100
    : 0;

  return {
    success: true,
    data: {
      recommended,
      bottlenecks,
      tiers: {
        critical: critical.map(({ id, title, leverage }) => ({ id, title, leverage })),
        high: high.map(({ id, title, leverage }) => ({ id, title, leverage })),
        normal: normal.slice(0, 10).map(({ id, title, leverage }) => ({ id, title, leverage })),
      },
      metrics: {
        totalTasks: tasks.length,
        actionable: actionable.length,
        blocked: blocked.length,
        avgLeverage,
      },
    },
  };
}

// ===== Status Restoration Operations =====

/**
 * Restore a cancelled task back to pending.
 */
export async function taskRestore(
  projectRoot: string,
  taskId: string,
  params?: { cascade?: boolean; notes?: string }
): Promise<EngineResult<{ task: string; restored: string[]; count: number }>> {
  try {
    const accessor = await getAccessor(projectRoot);
    const current = await accessor.loadTodoFile();
    if (!current || !current.tasks) {
      return {
        success: false,
        error: { code: 'E_NOT_INITIALIZED', message: 'No valid todo.json found' },
      };
    }

    const task = current.tasks.find((t) => t.id === taskId);
    if (!task) {
      return {
        success: false,
        error: { code: 'E_NOT_FOUND', message: `Task '${taskId}' not found` },
      };
    }

    if (task.status !== 'cancelled') {
      return {
        success: false,
        error: {
          code: 'E_INVALID_STATUS',
          message: `Task '${taskId}' is not cancelled (status: ${task.status}). Only cancelled tasks can be restored.`,
        },
      };
    }

    // Collect tasks to restore (cast to TaskRecord for mutation)
    const tasksToRestore: TaskRecord[] = [task as unknown as TaskRecord];
    if (params?.cascade) {
      const findCancelledChildren = (parentId: string): void => {
        const children = current.tasks.filter(
          (t) => t.parentId === parentId && t.status === 'cancelled',
        );
        for (const child of children) {
          tasksToRestore.push(child as unknown as TaskRecord);
          findCancelledChildren(child.id);
        }
      };
      findCancelledChildren(taskId);
    }

    const now = new Date().toISOString();
    const restored: string[] = [];

    for (const t of tasksToRestore) {
      t.status = 'pending';
      t.cancelledAt = null;
      t.cancellationReason = undefined;
      t.updatedAt = now;

      if (!t.notes) t.notes = [];
      t.notes.push(`[${now}] Restored from cancelled${params?.notes ? ': ' + params.notes : ''}`);
      restored.push(t.id);
    }

    await accessor.saveTodoFile(current);

    return {
      success: true,
      data: { task: taskId, restored, count: restored.length },
    };
  } catch {
    return {
      success: false,
      error: { code: 'E_NOT_INITIALIZED', message: 'Failed to restore task' },
    };
  }
}

/**
 * Move an archived task back to todo.json with status 'done' (or specified status).
 */
export async function taskUnarchive(
  projectRoot: string,
  taskId: string,
  params?: { status?: string; preserveStatus?: boolean }
): Promise<EngineResult<{ task: string; unarchived: boolean; title: string; status: string }>> {
  try {
    const accessor = await getAccessor(projectRoot);
    const todo = await accessor.loadTodoFile();
    if (!todo || !todo.tasks) {
      return {
        success: false,
        error: { code: 'E_NOT_INITIALIZED', message: 'No valid todo.json found' },
      };
    }

    const archive = await accessor.loadArchive();
    if (!archive || !archive.archivedTasks) {
      return {
        success: false,
        error: { code: 'E_NOT_FOUND', message: 'No archive file found' },
      };
    }

    const taskIndex = archive.archivedTasks.findIndex((t) => t.id === taskId);
    if (taskIndex === -1) {
      return {
        success: false,
        error: { code: 'E_NOT_FOUND', message: `Task '${taskId}' not found in archive` },
      };
    }

    // Check for ID collision
    if (todo.tasks.some((t) => t.id === taskId)) {
      return {
        success: false,
        error: { code: 'E_ID_COLLISION', message: `Task '${taskId}' already exists in todo.json` },
      };
    }

    const task = archive.archivedTasks[taskIndex] as TaskRecord & { _archive?: Record<string, unknown> };

    // Remove archive metadata
    delete task._archive;

    // Set status
    if (!params?.preserveStatus) {
      const targetStatus = params?.status || 'pending';
      task.status = targetStatus;
      if (targetStatus !== 'done') {
        task.completedAt = null;
      }
    }

    task.updatedAt = new Date().toISOString();

    // Add to todo.json
    (todo.tasks as unknown as TaskRecord[]).push(task);

    // Remove from archive
    archive.archivedTasks.splice(taskIndex, 1);

    // Save both files via accessor
    await accessor.saveTodoFile(todo);
    await accessor.saveArchive(archive);

    return {
      success: true,
      data: {
        task: taskId,
        unarchived: true,
        title: task.title,
        status: task.status,
      },
    };
  } catch {
    return {
      success: false,
      error: { code: 'E_NOT_INITIALIZED', message: 'Failed to unarchive task' },
    };
  }
}

// ===== Hierarchy Mutation Operations =====

/**
 * Change task position within its sibling group.
 */
export async function taskReorder(
  projectRoot: string,
  taskId: string,
  position: number
): Promise<EngineResult<{ task: string; reordered: boolean; newPosition: number; totalSiblings: number }>> {
  try {
    const accessor = await getAccessor(projectRoot);
    const current = await accessor.loadTodoFile();
    if (!current || !current.tasks) {
      return {
        success: false,
        error: { code: 'E_NOT_INITIALIZED', message: 'No valid todo.json found' },
      };
    }

    const task = current.tasks.find((t) => t.id === taskId);
    if (!task) {
      return {
        success: false,
        error: { code: 'E_NOT_FOUND', message: `Task '${taskId}' not found` },
      };
    }

    // Get all siblings (same parent, including self), sorted by position
    const allSiblings = current.tasks
      .filter((t) => t.parentId === task.parentId)
      .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));

    const currentIndex = allSiblings.findIndex((t) => t.id === taskId);
    const newIndex = Math.max(0, Math.min(position - 1, allSiblings.length - 1));

    // Remove from current position and insert at new position
    allSiblings.splice(currentIndex, 1);
    allSiblings.splice(newIndex, 0, task);

    // Update positions on the actual tasks in current.tasks
    const now = new Date().toISOString();
    for (let i = 0; i < allSiblings.length; i++) {
      const sibling = current.tasks.find((t) => t.id === allSiblings[i]!.id);
      if (sibling) {
        sibling.position = i + 1;
        sibling.positionVersion = (sibling.positionVersion ?? 0) + 1;
        sibling.updatedAt = now;
      }
    }

    await accessor.saveTodoFile(current);

    return {
      success: true,
      data: {
        task: taskId,
        reordered: true,
        newPosition: newIndex + 1,
        totalSiblings: allSiblings.length,
      },
    };
  } catch {
    return {
      success: false,
      error: { code: 'E_NOT_INITIALIZED', message: 'Failed to reorder task' },
    };
  }
}

/**
 * Move task under a different parent.
 * Pass null or empty string for newParentId to make it a root task.
 */
export async function taskReparent(
  projectRoot: string,
  taskId: string,
  newParentId: string | null
): Promise<EngineResult<{
  task: string;
  reparented: boolean;
  oldParent: string | null;
  newParent: string | null;
  newType?: string;
}>> {
  try {
    const accessor = await getAccessor(projectRoot);
    const current = await accessor.loadTodoFile();
    if (!current || !current.tasks) {
      return {
        success: false,
        error: { code: 'E_NOT_INITIALIZED', message: 'No valid todo.json found' },
      };
    }

    const taskMap = new Map(current.tasks.map((t) => [t.id, t]));
    const task = taskMap.get(taskId);
    if (!task) {
      return {
        success: false,
        error: { code: 'E_NOT_FOUND', message: `Task '${taskId}' not found` },
      };
    }

    const effectiveParentId = newParentId || null;

    // Promote to root
    if (!effectiveParentId) {
      const oldParent = task.parentId ?? null;
      task.parentId = null;
      if (task.type === 'subtask') task.type = 'task';
      task.updatedAt = new Date().toISOString();

      await accessor.saveTodoFile(current);

      return {
        success: true,
        data: {
          task: taskId,
          reparented: true,
          oldParent,
          newParent: null,
          newType: task.type,
        },
      };
    }

    const newParent = taskMap.get(effectiveParentId);
    if (!newParent) {
      return {
        success: false,
        error: { code: 'E_PARENT_NOT_FOUND', message: `Parent task '${effectiveParentId}' not found` },
      };
    }

    // Cannot parent under a subtask
    if (newParent.type === 'subtask') {
      return {
        success: false,
        error: { code: 'E_INVALID_PARENT_TYPE', message: `Cannot parent under subtask '${effectiveParentId}'` },
      };
    }

    // Check circular reference: walk newParent's ancestors to ensure taskId is not among them
    let ancestor = newParent;
    while (ancestor) {
      if (ancestor.id === taskId) {
        return {
          success: false,
          error: { code: 'E_CIRCULAR_REFERENCE', message: `Moving '${taskId}' under '${effectiveParentId}' would create circular reference` },
        };
      }
      if (!ancestor.parentId) break;
      ancestor = taskMap.get(ancestor.parentId)!;
      if (!ancestor) break;
    }

    // Check depth limit (max 3: epic -> task -> subtask)
    let parentDepth = 0;
    let cur = newParent;
    while (cur?.parentId) {
      parentDepth++;
      cur = taskMap.get(cur.parentId)!;
      if (!cur || parentDepth > 10) break;
    }
    const reparentLimits = getHierarchyLimits(projectRoot);
    if (parentDepth + 1 >= reparentLimits.maxDepth) {
      return {
        success: false,
        error: { code: 'E_DEPTH_EXCEEDED', message: `Move would exceed max depth of ${reparentLimits.maxDepth}` },
      };
    }

    // Check sibling limit
    const siblingCount = current.tasks.filter((t) => t.parentId === effectiveParentId && t.id !== taskId).length;
    if (siblingCount >= reparentLimits.maxSiblings) {
      return {
        success: false,
        error: { code: 'E_SIBLING_LIMIT', message: `Cannot add child to ${effectiveParentId}: max siblings (${reparentLimits.maxSiblings}) exceeded` },
      };
    }

    const oldParent = task.parentId ?? null;
    task.parentId = effectiveParentId;

    // Update type based on new depth
    const newDepth = parentDepth + 1;
    if (newDepth === 1) task.type = 'task';
    else if (newDepth >= 2) task.type = 'subtask';

    task.updatedAt = new Date().toISOString();

    await accessor.saveTodoFile(current);

    return {
      success: true,
      data: {
        task: taskId,
        reparented: true,
        oldParent,
        newParent: effectiveParentId,
        newType: task.type,
      },
    };
  } catch {
    return {
      success: false,
      error: { code: 'E_NOT_INITIALIZED', message: 'Failed to reparent task' },
    };
  }
}

/**
 * Promote a subtask to task or task to root (remove parent).
 */
export async function taskPromote(
  projectRoot: string,
  taskId: string
): Promise<EngineResult<{ task: string; promoted: boolean; previousParent: string | null; typeChanged: boolean }>> {
  try {
    const accessor = await getAccessor(projectRoot);
    const current = await accessor.loadTodoFile();
    if (!current || !current.tasks) {
      return {
        success: false,
        error: { code: 'E_NOT_INITIALIZED', message: 'No valid todo.json found' },
      };
    }

    const task = current.tasks.find((t) => t.id === taskId);
    if (!task) {
      return {
        success: false,
        error: { code: 'E_NOT_FOUND', message: `Task '${taskId}' not found` },
      };
    }

    if (!task.parentId) {
      return {
        success: true,
        data: { task: taskId, promoted: false, previousParent: null, typeChanged: false },
      };
    }

    const oldParent = task.parentId;
    task.parentId = null;
    task.updatedAt = new Date().toISOString();

    let typeChanged = false;
    if (task.type === 'subtask') {
      task.type = 'task';
      typeChanged = true;
    }

    await accessor.saveTodoFile(current);

    return {
      success: true,
      data: { task: taskId, promoted: true, previousParent: oldParent, typeChanged },
    };
  } catch {
    return {
      success: false,
      error: { code: 'E_NOT_INITIALIZED', message: 'Failed to promote task' },
    };
  }
}

/**
 * Reopen a completed task (set status back to pending).
 */
export async function taskReopen(
  projectRoot: string,
  taskId: string,
  params?: { status?: string; reason?: string }
): Promise<EngineResult<{ task: string; reopened: boolean; previousStatus: string; newStatus: string }>> {
  try {
    const accessor = await getAccessor(projectRoot);
    const current = await accessor.loadTodoFile();
    if (!current || !current.tasks) {
      return {
        success: false,
        error: { code: 'E_NOT_INITIALIZED', message: 'No valid todo.json found' },
      };
    }

    const task = current.tasks.find((t) => t.id === taskId) as TaskRecord | undefined;
    if (!task) {
      return {
        success: false,
        error: { code: 'E_NOT_FOUND', message: `Task '${taskId}' not found` },
      };
    }

    if (task.status !== 'done') {
      return {
        success: false,
        error: {
          code: 'E_INVALID_STATUS',
          message: `Task '${taskId}' is not completed (status: ${task.status}). Only done tasks can be reopened.`,
        },
      };
    }

    const targetStatus = params?.status || 'pending';
    if (targetStatus !== 'pending' && targetStatus !== 'active') {
      return {
        success: false,
        error: {
          code: 'E_INVALID_INPUT',
          message: `Invalid target status: ${targetStatus}. Must be 'pending' or 'active'.`,
        },
      };
    }

    const previousStatus = task.status;
    task.status = targetStatus;
    task.completedAt = null;
    task.updatedAt = new Date().toISOString();

    // Add note about reopening
    if (!task.notes) task.notes = [];
    const reason = params?.reason;
    task.notes.push(`[${task.updatedAt}] Reopened from ${previousStatus}${reason ? ': ' + reason : ''}`);

    await accessor.saveTodoFile(current);

    return {
      success: true,
      data: {
        task: taskId,
        reopened: true,
        previousStatus,
        newStatus: targetStatus,
      },
    };
  } catch {
    return {
      success: false,
      error: { code: 'E_NOT_INITIALIZED', message: 'Failed to reopen task' },
    };
  }
}

// ===== Complexity Estimation Operations =====

/**
 * Complexity factor with name, numeric value, and detail string.
 */
interface ComplexityFactor {
  name: string;
  value: number;
  detail: string;
}

/**
 * Walk the dependency chain recursively and return the maximum depth.
 */
function measureDependencyDepth(
  taskId: string,
  taskMap: Map<string, TaskRecord>,
  visited: Set<string> = new Set()
): number {
  if (visited.has(taskId)) return 0;
  visited.add(taskId);

  const task = taskMap.get(taskId);
  if (!task || !task.depends || task.depends.length === 0) return 0;

  let maxDepth = 0;
  for (const depId of task.depends) {
    const depth = 1 + measureDependencyDepth(depId, taskMap, visited);
    if (depth > maxDepth) maxDepth = depth;
  }
  return maxDepth;
}

/**
 * Deterministic complexity scoring from task metadata.
 * NOT a time estimate. Produces a size classification (small/medium/large)
 * based on description length, acceptance criteria count, dependency depth,
 * subtask count, and file reference count.
 */
/**
 * @task T4657
 * @epic T4654
 */
export async function taskComplexityEstimate(
  projectRoot: string,
  params: { taskId: string }
): Promise<EngineResult<{
  size: 'small' | 'medium' | 'large';
  score: number;
  factors: ComplexityFactor[];
  dependencyDepth: number;
  subtaskCount: number;
  fileCount: number;
}>> {
  let allTasks: TaskRecord[];
  try {
    const loaded = await loadAllTasksAsync(projectRoot);
    allTasks = tasksToRecords(loaded);
  } catch {
    return { success: false, error: { code: 'E_NOT_INITIALIZED', message: 'No todo.json found' } };
  }

  const task = allTasks.find((t) => t.id === params.taskId);
  if (!task) {
    return {
      success: false,
      error: { code: 'E_NOT_FOUND', message: `Task '${params.taskId}' not found` },
    };
  }

  const factors: ComplexityFactor[] = [];
  let score = 0;

  // Factor 1: Description length
  const descLen = (task.description || '').length;
  let descScore: number;
  let descLabel: string;
  if (descLen < 100) {
    descScore = 1;
    descLabel = 'short';
  } else if (descLen < 500) {
    descScore = 2;
    descLabel = 'medium';
  } else {
    descScore = 3;
    descLabel = 'long';
  }
  score += descScore;
  factors.push({ name: 'descriptionLength', value: descScore, detail: `${descLabel} (${descLen} chars)` });

  // Factor 2: Acceptance criteria count
  const acceptanceCount = task.acceptance?.length ?? 0;
  const acceptanceScore = Math.min(acceptanceCount, 3);
  score += acceptanceScore;
  factors.push({ name: 'acceptanceCriteria', value: acceptanceScore, detail: `${acceptanceCount} criteria` });

  // Factor 3: Dependency depth (recursive walk)
  const taskMap = new Map(allTasks.map((t) => [t.id, t]));
  const dependencyDepth = measureDependencyDepth(params.taskId, taskMap);
  const depthScore = Math.min(dependencyDepth, 3);
  score += depthScore;
  factors.push({ name: 'dependencyDepth', value: depthScore, detail: `depth ${dependencyDepth}` });

  // Factor 4: Subtask count (direct children)
  const subtaskCount = allTasks.filter((t) => t.parentId === params.taskId).length;
  const subtaskScore = Math.min(subtaskCount, 3);
  score += subtaskScore;
  factors.push({ name: 'subtaskCount', value: subtaskScore, detail: `${subtaskCount} subtasks` });

  // Factor 5: File reference count
  const fileCount = task.files?.length ?? 0;
  const fileScore = Math.min(fileCount, 3);
  score += fileScore;
  factors.push({ name: 'fileReferences', value: fileScore, detail: `${fileCount} files` });

  // Size classification
  let size: 'small' | 'medium' | 'large';
  if (score <= 3) {
    size = 'small';
  } else if (score <= 7) {
    size = 'medium';
  } else {
    size = 'large';
  }

  return {
    success: true,
    data: {
      size,
      score,
      factors,
      dependencyDepth,
      subtaskCount,
      fileCount,
    },
  };
}

// ===== Dependency Query Operations =====

/**
 * List dependencies for a task in a given direction.
 * 'upstream' = what this task depends on
 * 'downstream' = what depends on this task
 * 'both' = both directions
 */
/**
 * @task T4657
 * @epic T4654
 */
export async function taskDepends(
  projectRoot: string,
  taskId: string,
  direction: 'upstream' | 'downstream' | 'both' = 'both'
): Promise<EngineResult<{
  taskId: string;
  direction: string;
  upstream: Array<{ id: string; title: string; status: string }>;
  downstream: Array<{ id: string; title: string; status: string }>;
}>> {
  let allTasks: TaskRecord[];
  try {
    const loaded = await loadAllTasksAsync(projectRoot);
    allTasks = tasksToRecords(loaded);
  } catch {
    return { success: false, error: { code: 'E_NOT_INITIALIZED', message: 'No todo.json found' } };
  }

  const task = allTasks.find((t) => t.id === taskId);
  if (!task) {
    return {
      success: false,
      error: { code: 'E_NOT_FOUND', message: `Task '${taskId}' not found` },
    };
  }

  const taskMap = new Map(allTasks.map((t) => [t.id, t]));

  // Upstream: tasks this task depends on
  const upstream: Array<{ id: string; title: string; status: string }> = [];
  if (direction === 'upstream' || direction === 'both') {
    for (const depId of task.depends ?? []) {
      const dep = taskMap.get(depId);
      if (dep) {
        upstream.push({ id: dep.id, title: dep.title, status: dep.status });
      }
    }
  }

  // Downstream: tasks that depend on this task
  const downstream: Array<{ id: string; title: string; status: string }> = [];
  if (direction === 'downstream' || direction === 'both') {
    for (const t of allTasks) {
      if (t.depends?.includes(taskId)) {
        downstream.push({ id: t.id, title: t.title, status: t.status });
      }
    }
  }

  return {
    success: true,
    data: { taskId, direction, upstream, downstream },
  };
}

// ===== Statistics Operations =====

/**
 * Compute task statistics, optionally scoped to an epic.
 */
/**
 * @task T4657
 * @epic T4654
 */
export async function taskStats(
  projectRoot: string,
  epicId?: string
): Promise<EngineResult<{
  total: number;
  pending: number;
  active: number;
  blocked: number;
  done: number;
  cancelled: number;
  byPriority: Record<string, number>;
  byType: Record<string, number>;
}>> {
  let allTasks: TaskRecord[];
  try {
    const loaded = await loadAllTasksAsync(projectRoot);
    allTasks = tasksToRecords(loaded);
  } catch {
    return { success: false, error: { code: 'E_NOT_INITIALIZED', message: 'No todo.json found' } };
  }

  let tasks = allTasks;

  // Scope to epic if provided
  if (epicId) {
    const epicIds = new Set<string>();
    epicIds.add(epicId);
    // Collect all descendants
    const collectChildren = (parentId: string) => {
      for (const t of allTasks) {
        if (t.parentId === parentId && !epicIds.has(t.id)) {
          epicIds.add(t.id);
          collectChildren(t.id);
        }
      }
    };
    collectChildren(epicId);
    tasks = allTasks.filter((t) => epicIds.has(t.id));
  }

  const byStatus: Record<string, number> = {};
  const byPriority: Record<string, number> = {};
  const byType: Record<string, number> = {};

  for (const task of tasks) {
    byStatus[task.status] = (byStatus[task.status] ?? 0) + 1;
    byPriority[task.priority] = (byPriority[task.priority] ?? 0) + 1;
    const taskType = task.type ?? 'task';
    byType[taskType] = (byType[taskType] ?? 0) + 1;
  }

  return {
    success: true,
    data: {
      total: tasks.length,
      pending: byStatus['pending'] ?? 0,
      active: byStatus['active'] ?? 0,
      blocked: byStatus['blocked'] ?? 0,
      done: byStatus['done'] ?? 0,
      cancelled: byStatus['cancelled'] ?? 0,
      byPriority,
      byType,
    },
  };
}

// ===== Export Operations =====

/**
 * Export tasks as JSON or CSV.
 */
/**
 * @task T4657
 * @epic T4654
 */
export async function taskExport(
  projectRoot: string,
  params?: {
    format?: 'json' | 'csv';
    status?: string;
    parent?: string;
  }
): Promise<EngineResult<unknown>> {
  let allTasks: TaskRecord[];
  try {
    const loaded = await loadAllTasksAsync(projectRoot);
    allTasks = tasksToRecords(loaded);
  } catch {
    return { success: false, error: { code: 'E_NOT_INITIALIZED', message: 'No todo.json found' } };
  }

  let tasks = allTasks;

  if (params?.status) {
    tasks = tasks.filter((t) => t.status === params.status);
  }

  if (params?.parent) {
    // Collect parent + all descendants
    const parentIds = new Set<string>();
    parentIds.add(params.parent);
    const collectChildren = (parentId: string) => {
      for (const t of allTasks) {
        if (t.parentId === parentId && !parentIds.has(t.id)) {
          parentIds.add(t.id);
          collectChildren(t.id);
        }
      }
    };
    collectChildren(params.parent);
    tasks = tasks.filter((t) => parentIds.has(t.id));
  }

  if (params?.format === 'csv') {
    // Build CSV output
    const headers = ['id', 'title', 'status', 'priority', 'type', 'parentId', 'createdAt'];
    const rows = tasks.map((t) => [
      t.id,
      `"${(t.title || '').replace(/"/g, '""')}"`,
      t.status,
      t.priority,
      t.type ?? 'task',
      t.parentId ?? '',
      t.createdAt,
    ].join(','));
    const csv = [headers.join(','), ...rows].join('\n');
    return { success: true, data: { format: 'csv', content: csv, taskCount: tasks.length } };
  }

  // Default: JSON format
  return {
    success: true,
    data: {
      format: 'json',
      tasks,
      taskCount: tasks.length,
    },
  };
}

// ===== History Operations =====

/**
 * Get task history from the log file.
 */
/**
 * @task T4657
 * @epic T4654
 */
export async function taskHistory(
  projectRoot: string,
  taskId: string,
  limit?: number
): Promise<EngineResult<Array<Record<string, unknown>>>> {
  const logPath = getDataPath(projectRoot, 'todo-log.jsonl');
  const entries = readLogFileEntries(logPath);

  // Filter entries that reference this task
  const taskEntries = entries.filter((entry) => {
    // Check multiple fields where task ID might appear
    if (entry.taskId === taskId) return true;
    if (entry.id === taskId) return true;
    if (typeof entry.details === 'string' && entry.details.includes(taskId)) return true;
    if (typeof entry.message === 'string' && entry.message.includes(taskId)) return true;
    return false;
  });

  // Sort by timestamp descending (most recent first)
  taskEntries.sort((a, b) => {
    const timeA = String(a.timestamp ?? a.date ?? '');
    const timeB = String(b.timestamp ?? b.date ?? '');
    return timeB.localeCompare(timeA);
  });

  const result = limit && limit > 0 ? taskEntries.slice(0, limit) : taskEntries;

  return { success: true, data: result };
}

// ===== Lint Operations =====

/**
 * Lint tasks for common issues.
 */
/**
 * @task T4657
 * @epic T4654
 */
export async function taskLint(
  projectRoot: string,
  taskId?: string
): Promise<EngineResult<Array<{
  taskId: string;
  severity: 'error' | 'warning';
  rule: string;
  message: string;
}>>> {
  let allTasks: TaskRecord[];
  try {
    const loaded = await loadAllTasksAsync(projectRoot);
    allTasks = tasksToRecords(loaded);
  } catch {
    return { success: false, error: { code: 'E_NOT_INITIALIZED', message: 'No todo.json found' } };
  }

  const tasks = taskId
    ? allTasks.filter((t) => t.id === taskId)
    : allTasks;

  if (taskId && tasks.length === 0) {
    return {
      success: false,
      error: { code: 'E_NOT_FOUND', message: `Task '${taskId}' not found` },
    };
  }

  const issues: Array<{
    taskId: string;
    severity: 'error' | 'warning';
    rule: string;
    message: string;
  }> = [];

  const allDescriptions = new Set<string>();
  const allIds = new Set<string>();

  for (const task of allTasks) {
    // Check ID uniqueness
    if (allIds.has(task.id)) {
      issues.push({
        taskId: task.id,
        severity: 'error',
        rule: 'unique-id',
        message: `Duplicate task ID: ${task.id}`,
      });
    }
    allIds.add(task.id);

    // Only lint targeted tasks
    if (taskId && task.id !== taskId) {
      if (task.description) allDescriptions.add(task.description.toLowerCase());
      continue;
    }

    // Check title present
    if (!task.title || task.title.trim().length === 0) {
      issues.push({
        taskId: task.id,
        severity: 'error',
        rule: 'title-required',
        message: 'Task is missing a title',
      });
    }

    // Check description present
    if (!task.description || task.description.trim().length === 0) {
      issues.push({
        taskId: task.id,
        severity: 'warning',
        rule: 'description-required',
        message: 'Task is missing a description',
      });
    }

    // Check title != description
    if (task.title && task.description && task.title.trim() === task.description.trim()) {
      issues.push({
        taskId: task.id,
        severity: 'warning',
        rule: 'title-description-different',
        message: 'Title and description should not be identical',
      });
    }

    // Check duplicate descriptions
    if (task.description) {
      const descLower = task.description.toLowerCase();
      if (allDescriptions.has(descLower)) {
        issues.push({
          taskId: task.id,
          severity: 'warning',
          rule: 'unique-description',
          message: 'Duplicate task description found',
        });
      }
      allDescriptions.add(descLower);
    }

    // Check valid status
    const validStatuses = ['pending', 'active', 'blocked', 'done', 'cancelled'];
    if (!validStatuses.includes(task.status)) {
      issues.push({
        taskId: task.id,
        severity: 'error',
        rule: 'valid-status',
        message: `Invalid status: ${task.status}`,
      });
    }

    // Check future timestamps
    const now = new Date();
    if (task.createdAt && new Date(task.createdAt) > now) {
      issues.push({
        taskId: task.id,
        severity: 'warning',
        rule: 'no-future-timestamps',
        message: 'createdAt is in the future',
      });
    }

    // Check orphaned parent references
    if (task.parentId && !allTasks.some((t) => t.id === task.parentId)) {
      issues.push({
        taskId: task.id,
        severity: 'error',
        rule: 'valid-parent',
        message: `Parent task '${task.parentId}' does not exist`,
      });
    }

    // Check orphaned dependency references
    for (const depId of task.depends ?? []) {
      if (!allTasks.some((t) => t.id === depId)) {
        issues.push({
          taskId: task.id,
          severity: 'warning',
          rule: 'valid-dependency',
          message: `Dependency '${depId}' does not exist`,
        });
      }
    }
  }

  return { success: true, data: issues };
}

// ===== Batch Validate Operations =====

/**
 * Validate multiple tasks at once.
 */
/**
 * @task T4657
 * @epic T4654
 */
export async function taskBatchValidate(
  projectRoot: string,
  taskIds: string[],
  checkMode: 'full' | 'quick' = 'full'
): Promise<EngineResult<{
  results: Record<string, Array<{
    severity: 'error' | 'warning';
    rule: string;
    message: string;
  }>>;
  summary: {
    totalTasks: number;
    validTasks: number;
    invalidTasks: number;
    totalIssues: number;
    errors: number;
    warnings: number;
  };
}>> {
  let allTasks: TaskRecord[];
  try {
    const loaded = await loadAllTasksAsync(projectRoot);
    allTasks = tasksToRecords(loaded);
  } catch {
    return { success: false, error: { code: 'E_NOT_INITIALIZED', message: 'No todo.json found' } };
  }

  const results: Record<string, Array<{
    severity: 'error' | 'warning';
    rule: string;
    message: string;
  }>> = {};

  let totalErrors = 0;
  let totalWarnings = 0;

  for (const id of taskIds) {
    const task = allTasks.find((t) => t.id === id);
    if (!task) {
      results[id] = [{ severity: 'error', rule: 'exists', message: `Task '${id}' not found` }];
      totalErrors++;
      continue;
    }

    const taskIssues: Array<{ severity: 'error' | 'warning'; rule: string; message: string }> = [];

    // Quick mode: basic checks
    if (!task.title || task.title.trim().length === 0) {
      taskIssues.push({ severity: 'error', rule: 'title-required', message: 'Missing title' });
    }
    if (!task.description || task.description.trim().length === 0) {
      taskIssues.push({ severity: 'warning', rule: 'description-required', message: 'Missing description' });
    }

    const validStatuses = ['pending', 'active', 'blocked', 'done', 'cancelled'];
    if (!validStatuses.includes(task.status)) {
      taskIssues.push({ severity: 'error', rule: 'valid-status', message: `Invalid status: ${task.status}` });
    }

    // Full mode: additional checks
    if (checkMode === 'full') {
      if (task.title && task.description && task.title.trim() === task.description.trim()) {
        taskIssues.push({ severity: 'warning', rule: 'title-description-different', message: 'Title equals description' });
      }

      if (task.parentId && !allTasks.some((t) => t.id === task.parentId)) {
        taskIssues.push({ severity: 'error', rule: 'valid-parent', message: `Parent '${task.parentId}' not found` });
      }

      for (const depId of task.depends ?? []) {
        if (!allTasks.some((t) => t.id === depId)) {
          taskIssues.push({ severity: 'warning', rule: 'valid-dependency', message: `Dependency '${depId}' not found` });
        }
      }

      const now = new Date();
      if (task.createdAt && new Date(task.createdAt) > now) {
        taskIssues.push({ severity: 'warning', rule: 'no-future-timestamps', message: 'createdAt in future' });
      }
    }

    results[id] = taskIssues;
    totalErrors += taskIssues.filter((i) => i.severity === 'error').length;
    totalWarnings += taskIssues.filter((i) => i.severity === 'warning').length;
  }

  const invalidTasks = Object.values(results).filter((issues) =>
    issues.some((i) => i.severity === 'error')
  ).length;

  return {
    success: true,
    data: {
      results,
      summary: {
        totalTasks: taskIds.length,
        validTasks: taskIds.length - invalidTasks,
        invalidTasks,
        totalIssues: totalErrors + totalWarnings,
        errors: totalErrors,
        warnings: totalWarnings,
      },
    },
  };
}

// ===== Import Operations =====

/**
 * Import tasks from a JSON source string or export package.
 */
export async function taskImport(
  projectRoot: string,
  source: string,
  overwrite?: boolean
): Promise<EngineResult<{ imported: number; skipped: number; errors: string[]; remapTable?: Record<string, string> }>> {
  try {
    const accessor = await getAccessor(projectRoot);
    const current = await accessor.loadTodoFile();
    if (!current || !current.tasks) {
      return {
        success: false,
        error: { code: 'E_NOT_INITIALIZED', message: 'No valid todo.json found' },
      };
    }

    // Parse the source JSON
    let importData: unknown;
    try {
      importData = JSON.parse(source);
    } catch {
      return {
        success: false,
        error: { code: 'E_INVALID_INPUT', message: 'Invalid JSON in import source' },
      };
    }

    // Extract tasks from various formats
    let importTasks: TaskRecord[] = [];
    if (Array.isArray(importData)) {
      importTasks = importData as TaskRecord[];
    } else if (typeof importData === 'object' && importData !== null) {
      const data = importData as Record<string, unknown>;
      if (Array.isArray(data.tasks)) {
        importTasks = data.tasks as TaskRecord[];
      } else if (data._meta && Array.isArray(data.tasks)) {
        // Export package format
        importTasks = data.tasks as TaskRecord[];
      }
    }

    if (importTasks.length === 0) {
      return {
        success: true,
        data: { imported: 0, skipped: 0, errors: ['No tasks found in import source'] },
      };
    }

    const existingIds = new Set(current.tasks.map((t) => t.id));
    const allIds = new Set(current.tasks.map((t) => t.id));
    const errors: string[] = [];
    let imported = 0;
    let skipped = 0;
    const remapTable: Record<string, string> = {};

    // Generate new IDs for imported tasks
    let nextIdNum = 0;
    for (const t of current.tasks) {
      const num = parseInt(t.id.replace('T', ''), 10);
      if (!isNaN(num) && num > nextIdNum) nextIdNum = num;
    }

    const tasksList = current.tasks as unknown as TaskRecord[];

    for (const importTask of importTasks) {
      if (!importTask.id || !importTask.title) {
        errors.push(`Skipped task with missing id or title`);
        skipped++;
        continue;
      }

      if (existingIds.has(importTask.id) && !overwrite) {
        skipped++;
        continue;
      }

      // Generate new ID if collision
      let newId = importTask.id;
      if (allIds.has(importTask.id) && !overwrite) {
        nextIdNum++;
        newId = `T${String(nextIdNum).padStart(3, '0')}`;
        remapTable[importTask.id] = newId;
      }

      const now = new Date().toISOString();
      const newTask: TaskRecord = {
        ...importTask,
        id: newId,
        createdAt: importTask.createdAt || now,
        updatedAt: now,
      };

      if (overwrite && existingIds.has(importTask.id)) {
        // Replace existing
        const idx = tasksList.findIndex((t) => t.id === importTask.id);
        if (idx !== -1) {
          tasksList[idx] = newTask;
        }
      } else {
        tasksList.push(newTask);
      }

      allIds.add(newId);
      imported++;
    }

    if (imported > 0) {
      await accessor.saveTodoFile(current);
    }

    return {
      success: true,
      data: {
        imported,
        skipped,
        errors,
        ...(Object.keys(remapTable).length > 0 ? { remapTable } : {}),
      },
    };
  } catch {
    return {
      success: false,
      error: { code: 'E_NOT_INITIALIZED', message: 'Failed to import tasks' },
    };
  }
}
