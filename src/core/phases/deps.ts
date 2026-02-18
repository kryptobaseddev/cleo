/**
 * Dependency graph resolution - topological sort, cycle detection, impact analysis.
 * @task T4464
 * @task T4659
 * @epic T4454
 * @epic T4654
 */

import { readJsonRequired, computeChecksum, saveJson } from '../../store/json.js';
import { CleoError } from '../errors.js';
import { ExitCode } from '../../types/exit-codes.js';
import type { Task, TodoFile } from '../../types/task.js';
import { getTodoPath, getBackupDir } from '../paths.js';
import type { DataAccessor } from '../../store/data-accessor.js';

/**
 * Cached TodoFile loader to avoid repeated file reads within a single operation.
 * Cache is keyed by resolved path and invalidated after 1 second.
 * @task T4659
 * @epic T4654
 */
let cachedTodoData: { path: string; data: TodoFile; timestamp: number } | null = null;
const CACHE_TTL_MS = 1000;

async function loadTodoData(cwd?: string, accessor?: DataAccessor): Promise<TodoFile> {
  if (accessor) {
    return accessor.loadTodoFile();
  }
  const todoPath = getTodoPath(cwd);
  const now = Date.now();
  if (cachedTodoData && cachedTodoData.path === todoPath && (now - cachedTodoData.timestamp) < CACHE_TTL_MS) {
    return cachedTodoData.data;
  }
  const data = await readJsonRequired<TodoFile>(todoPath);
  cachedTodoData = { path: todoPath, data, timestamp: now };
  return data;
}

/**
 * Invalidate the cached TodoFile (call after writes).
 * @task T4659
 * @epic T4654
 */
export function invalidateDepsCache(): void {
  cachedTodoData = null;
}

/** A node in the dependency graph. */
export interface DepNode {
  id: string;
  title: string;
  status: string;
  depends: string[];
  dependents: string[];
}

/** Dependency overview result. */
export interface DepsOverviewResult {
  nodes: DepNode[];
  totalTasks: number;
  withDependencies: number;
  withDependents: number;
  roots: string[];
  leaves: string[];
}

/** Single task dependency result. */
export interface TaskDepsResult {
  task: { id: string; title: string; status: string };
  upstream: Array<{ id: string; title: string; status: string }>;
  downstream: Array<{ id: string; title: string; status: string }>;
  blockedBy: Array<{ id: string; title: string; status: string }>;
}

/** Execution wave (group of parallelizable tasks). */
export interface ExecutionWave {
  wave: number;
  tasks: Array<{ id: string; title: string; status: string; depends: string[] }>;
}

/** Critical path result. */
export interface CriticalPathResult {
  path: Array<{ id: string; title: string; status: string }>;
  length: number;
}

/** Cycle detection result. */
export interface CycleResult {
  hasCycles: boolean;
  cycles: string[][];
}

/**
 * Build an adjacency graph from task dependencies.
 * @task T4464
 */
export function buildGraph(tasks: Task[]): Map<string, DepNode> {
  const graph = new Map<string, DepNode>();
  const taskMap = new Map(tasks.map(t => [t.id, t]));

  // Initialize nodes
  for (const task of tasks) {
    graph.set(task.id, {
      id: task.id,
      title: task.title,
      status: task.status,
      depends: (task.depends ?? []).filter(d => taskMap.has(d)),
      dependents: [],
    });
  }

  // Build reverse edges (dependents)
  for (const [id, node] of graph) {
    for (const depId of node.depends) {
      const depNode = graph.get(depId);
      if (depNode) {
        depNode.dependents.push(id);
      }
    }
  }

  return graph;
}

/**
 * Get dependency overview for all tasks.
 * @task T4464
 */
export async function getDepsOverview(cwd?: string, accessor?: DataAccessor): Promise<DepsOverviewResult> {
  const data = await loadTodoData(cwd, accessor);
  const graph = buildGraph(data.tasks);
  const nodes = Array.from(graph.values());

  return {
    nodes,
    totalTasks: data.tasks.length,
    withDependencies: nodes.filter(n => n.depends.length > 0).length,
    withDependents: nodes.filter(n => n.dependents.length > 0).length,
    roots: nodes.filter(n => n.depends.length === 0).map(n => n.id),
    leaves: nodes.filter(n => n.dependents.length === 0).map(n => n.id),
  };
}

/**
 * Get dependencies for a specific task.
 * @task T4464
 */
export async function getTaskDeps(taskId: string, cwd?: string, accessor?: DataAccessor): Promise<TaskDepsResult> {
  const data = await loadTodoData(cwd, accessor);
  const task = data.tasks.find(t => t.id === taskId);

  if (!task) {
    throw new CleoError(ExitCode.NOT_FOUND, `Task not found: ${taskId}`);
  }

  const graph = buildGraph(data.tasks);
  const node = graph.get(taskId)!;
  const taskMap = new Map(data.tasks.map(t => [t.id, t]));

  const toSummary = (id: string) => {
    const t = taskMap.get(id);
    return t ? { id: t.id, title: t.title, status: t.status } : { id, title: 'Unknown', status: 'unknown' };
  };

  // Find upstream dependencies that are not done (blocking this task)
  const blockedBy = node.depends
    .filter(depId => {
      const depTask = taskMap.get(depId);
      return depTask && depTask.status !== 'done';
    })
    .map(toSummary);

  return {
    task: { id: task.id, title: task.title, status: task.status },
    upstream: node.depends.map(toSummary),
    downstream: node.dependents.map(toSummary),
    blockedBy,
  };
}

/**
 * Topological sort of tasks respecting dependencies.
 * Returns tasks in execution order. Throws on cycles.
 * @task T4464
 */
export function topologicalSort(tasks: Task[]): Task[] {
  const graph = buildGraph(tasks);
  const taskMap = new Map(tasks.map(t => [t.id, t]));
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const result: string[] = [];

  function dfs(id: string): void {
    if (visited.has(id)) return;
    if (visiting.has(id)) {
      throw new CleoError(ExitCode.CIRCULAR_REFERENCE, `Circular dependency detected involving task: ${id}`);
    }

    visiting.add(id);
    const node = graph.get(id);
    if (node) {
      for (const dep of node.depends) {
        dfs(dep);
      }
    }
    visiting.delete(id);
    visited.add(id);
    result.push(id);
  }

  for (const task of tasks) {
    dfs(task.id);
  }

  return result.map(id => taskMap.get(id)!).filter(Boolean);
}

/**
 * Group tasks into parallelizable execution waves.
 * @task T4464
 */
export async function getExecutionWaves(epicId?: string, cwd?: string, accessor?: DataAccessor): Promise<ExecutionWave[]> {
  const data = await loadTodoData(cwd, accessor);
  let tasks = data.tasks.filter(t => t.status !== 'done' && t.status !== 'cancelled');

  // Scope to epic if provided
  if (epicId) {
    const epicTask = data.tasks.find(t => t.id === epicId);
    if (!epicTask) {
      throw new CleoError(ExitCode.NOT_FOUND, `Epic not found: ${epicId}`);
    }
    const childIds = new Set(data.tasks.filter(t => t.parentId === epicId).map(t => t.id));
    tasks = tasks.filter(t => childIds.has(t.id) || t.id === epicId);
  }

  const graph = buildGraph(tasks);
  const waves: ExecutionWave[] = [];
  const completed = new Set<string>();

  // Filter to only non-done tasks
  let remaining = new Set(tasks.map(t => t.id));

  let waveNum = 1;
  while (remaining.size > 0) {
    const wave: string[] = [];

    for (const id of remaining) {
      const node = graph.get(id);
      if (!node) continue;

      // Check if all dependencies are completed
      const allDepsComplete = node.depends.every(dep => completed.has(dep) || !remaining.has(dep));
      if (allDepsComplete) {
        wave.push(id);
      }
    }

    if (wave.length === 0) {
      // Remaining tasks have circular dependencies - add them all to last wave
      wave.push(...remaining);
    }

    waves.push({
      wave: waveNum,
      tasks: wave.map(id => {
        const node = graph.get(id)!;
        return {
          id,
          title: node.title,
          status: node.status,
          depends: node.depends,
        };
      }),
    });

    for (const id of wave) {
      completed.add(id);
      remaining.delete(id);
    }
    waveNum++;
  }

  return waves;
}

/**
 * Find the critical path (longest dependency chain) from a task.
 * @task T4464
 */
export async function getCriticalPath(taskId: string, cwd?: string, accessor?: DataAccessor): Promise<CriticalPathResult> {
  const data = await loadTodoData(cwd, accessor);
  const task = data.tasks.find(t => t.id === taskId);

  if (!task) {
    throw new CleoError(ExitCode.NOT_FOUND, `Task not found: ${taskId}`);
  }

  const graph = buildGraph(data.tasks);
  const taskMap = new Map(data.tasks.map(t => [t.id, t]));

  // DFS to find longest path from this task through dependents
  function findLongestPath(id: string, visited: Set<string>): string[] {
    if (visited.has(id)) return [];
    visited.add(id);

    const node = graph.get(id);
    if (!node || node.dependents.length === 0) {
      return [id];
    }

    let longest: string[] = [];
    for (const depId of node.dependents) {
      const path = findLongestPath(depId, new Set(visited));
      if (path.length > longest.length) {
        longest = path;
      }
    }

    return [id, ...longest];
  }

  const path = findLongestPath(taskId, new Set<string>());

  return {
    path: path.map(id => {
      const t = taskMap.get(id);
      return t
        ? { id: t.id, title: t.title, status: t.status }
        : { id, title: 'Unknown', status: 'unknown' };
    }),
    length: path.length,
  };
}

/**
 * Find all tasks affected by changes to a given task.
 * @task T4464
 */
export async function getImpact(taskId: string, maxDepth: number = 10, cwd?: string, accessor?: DataAccessor): Promise<string[]> {
  const data = await loadTodoData(cwd, accessor);
  const task = data.tasks.find(t => t.id === taskId);

  if (!task) {
    throw new CleoError(ExitCode.NOT_FOUND, `Task not found: ${taskId}`);
  }

  const graph = buildGraph(data.tasks);
  const impacted = new Set<string>();

  function traverse(id: string, depth: number): void {
    if (depth > maxDepth || impacted.has(id)) return;
    impacted.add(id);

    const node = graph.get(id);
    if (node) {
      for (const depId of node.dependents) {
        traverse(depId, depth + 1);
      }
    }
  }

  traverse(taskId, 0);
  impacted.delete(taskId); // Don't include the source task

  return Array.from(impacted);
}

/**
 * Detect circular dependencies in the task graph.
 * @task T4464
 */
export async function detectCycles(cwd?: string, accessor?: DataAccessor): Promise<CycleResult> {
  const data = await loadTodoData(cwd, accessor);
  const graph = buildGraph(data.tasks);
  const cycles: string[][] = [];
  const visited = new Set<string>();
  const stack = new Set<string>();
  const path: string[] = [];

  function dfs(id: string): void {
    if (visited.has(id)) return;
    if (stack.has(id)) {
      // Found a cycle
      const cycleStart = path.indexOf(id);
      if (cycleStart !== -1) {
        cycles.push([...path.slice(cycleStart), id]);
      }
      return;
    }

    stack.add(id);
    path.push(id);

    const node = graph.get(id);
    if (node) {
      for (const dep of node.depends) {
        if (graph.has(dep)) {
          dfs(dep);
        }
      }
    }

    path.pop();
    stack.delete(id);
    visited.add(id);
  }

  for (const id of graph.keys()) {
    if (!visited.has(id)) {
      dfs(id);
    }
  }

  return {
    hasCycles: cycles.length > 0,
    cycles,
  };
}

/**
 * Build task hierarchy tree.
 * @task T4464
 */
export async function getTaskTree(rootId?: string, cwd?: string, accessor?: DataAccessor): Promise<TreeNode[]> {
  const data = await loadTodoData(cwd, accessor);

  const taskMap = new Map(data.tasks.map(t => [t.id, t]));

  function buildChildren(parentId: string | null): TreeNode[] {
    const children = data.tasks
      .filter(t => (parentId ? t.parentId === parentId : !t.parentId))
      .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));

    return children.map(t => ({
      id: t.id,
      title: t.title,
      status: t.status,
      type: t.type,
      children: buildChildren(t.id),
    }));
  }

  if (rootId) {
    const root = taskMap.get(rootId);
    if (!root) {
      throw new CleoError(ExitCode.NOT_FOUND, `Task not found: ${rootId}`);
    }
    return [{
      id: root.id,
      title: root.title,
      status: root.status,
      type: root.type,
      children: buildChildren(root.id),
    }];
  }

  return buildChildren(null);
}

/** Tree node representation. */
export interface TreeNode {
  id: string;
  title: string;
  status: string;
  type?: string;
  children: TreeNode[];
}

/**
 * Manage task relationships (relates/blocks).
 * @task T4464
 */
export async function addRelation(
  taskId: string,
  relatedId: string,
  cwd?: string,
  accessor?: DataAccessor,
): Promise<{ taskId: string; relatedId: string }> {
  const todoPath = getTodoPath(cwd);
  const data = accessor
    ? await accessor.loadTodoFile()
    : await readJsonRequired<TodoFile>(todoPath);

  const task = data.tasks.find(t => t.id === taskId);
  if (!task) {
    throw new CleoError(ExitCode.NOT_FOUND, `Task not found: ${taskId}`);
  }

  const related = data.tasks.find(t => t.id === relatedId);
  if (!related) {
    throw new CleoError(ExitCode.NOT_FOUND, `Related task not found: ${relatedId}`);
  }

  // Add dependency
  if (!task.depends) task.depends = [];
  if (!task.depends.includes(relatedId)) {
    task.depends.push(relatedId);
  }

  data.lastUpdated = new Date().toISOString();
  data._meta.checksum = computeChecksum(data.tasks);

  if (accessor) {
    await accessor.saveTodoFile(data);
  } else {
    await saveJson(todoPath, data, { backupDir: getBackupDir(cwd) });
  }
  invalidateDepsCache();

  return { taskId, relatedId };
}

