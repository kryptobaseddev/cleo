/**
 * Task data query operations — deps overview, cycles, stats, depends, deps, and relations.
 * @task T10064
 * @epic T9834
 */

import type {
  Task,
  TaskRef,
  TasksRelatesAddBatchEntry,
  TasksRelatesAddBatchResult,
} from '@cleocode/contracts';
import { getTaskAccessor } from '../store/data-accessor.js';
import {
  detectCircularDeps,
  getBlockedTasks,
  getLeafBlockers,
  getReadyTasks,
  getTransitiveBlockers,
  validateDependencies,
} from './dependency-check.js';
import { addBatchRelations } from './relates.js';

/** Task record shape expected from the data layer. */
type TaskRecord = Task;

async function loadAllTasks(projectRoot: string): Promise<TaskRecord[]> {
  const accessor = await getTaskAccessor(projectRoot);
  const { tasks } = await accessor.queryTasks({});
  return tasks;
}

/**
 * Overview of all dependencies across the project.
 *
 * @param projectRoot - Absolute path to the CLEO project root directory
 * @returns Project-wide dependency summary including blocked tasks, ready tasks, and validation results
 *
 * @remarks
 * Aggregates dependency data across all tasks to provide a high-level view of
 * the dependency graph health, including which tasks are blocked and what would unblock them.
 *
 * @example
 * ```typescript
 * const overview = await coreTaskDepsOverview('/project');
 * console.log(`${overview.blockedTasks.length} blocked, ${overview.readyTasks.length} ready`);
 * ```
 *
 * @task T5157
 */
export async function coreTaskDepsOverview(projectRoot: string): Promise<{
  totalTasks: number;
  tasksWithDeps: number;
  blockedTasks: Array<TaskRef & { unblockedBy: string[] }>;
  readyTasks: TaskRef[];
  validation: { valid: boolean; errorCount: number; warningCount: number };
}> {
  const allTasks = await loadAllTasks(projectRoot);
  const tasksAsTask = allTasks;

  const tasksWithDeps = allTasks.filter((t) => t.depends && t.depends.length > 0);
  const blocked = getBlockedTasks(tasksAsTask);
  const ready = getReadyTasks(tasksAsTask);
  const validation = validateDependencies(tasksAsTask);

  return {
    totalTasks: allTasks.length,
    tasksWithDeps: tasksWithDeps.length,
    blockedTasks: blocked.map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      unblockedBy: (t.depends ?? []).filter((depId) => {
        const dep = allTasks.find((x) => x.id === depId);
        return dep && dep.status !== 'done' && dep.status !== 'cancelled';
      }),
    })),
    readyTasks: ready
      .filter((t) => t.status !== 'done' && t.status !== 'cancelled')
      .map((t) => ({
        id: t.id,
        title: t.title,
        status: t.status,
      })),
    validation: {
      valid: validation.valid,
      errorCount: validation.errors.length,
      warningCount: validation.warnings.length,
    },
  };
}

/**
 * Detect circular dependencies across the project.
 *
 * @param projectRoot - Absolute path to the CLEO project root directory
 * @returns Whether cycles exist and the list of detected cycles with their task paths
 *
 * @remarks
 * Iterates through all tasks with dependencies and uses cycle detection to find
 * circular chains. Each cycle includes the full path (e.g. [A, B, C, A]) and
 * the tasks involved with their titles.
 *
 * @example
 * ```typescript
 * const { hasCycles, cycles } = await coreTaskDepsCycles('/project');
 * if (hasCycles) console.log('Circular deps:', cycles.map(c => c.path.join(' -> ')));
 * ```
 *
 * @task T5157
 */
export async function coreTaskDepsCycles(projectRoot: string): Promise<{
  hasCycles: boolean;
  cycles: Array<{ path: string[]; tasks: Array<Pick<TaskRef, 'id' | 'title'>> }>;
}> {
  const allTasks = await loadAllTasks(projectRoot);
  const tasksAsTask = allTasks;
  const taskMap = new Map(allTasks.map((t) => [t.id, t]));

  const visited = new Set<string>();
  const cycles: Array<{ path: string[]; tasks: Array<Pick<TaskRef, 'id' | 'title'>> }> = [];

  for (const task of allTasks) {
    if (visited.has(task.id)) continue;
    if (!task.depends?.length) continue;

    const cycle = detectCircularDeps(task.id, tasksAsTask);
    if (cycle.length > 0) {
      cycles.push({
        path: cycle,
        // Deduplicate: detectCircularDeps returns [A,B,C,A] where
        // last element closes the cycle. Use Set for robustness.
        tasks: [...new Set(cycle)].map((id) => {
          const t = taskMap.get(id);
          return { id, title: t?.title ?? 'unknown' };
        }),
      });
      for (const id of cycle) {
        visited.add(id);
      }
    }
  }

  return { hasCycles: cycles.length > 0, cycles };
}

/**
 * Compute task statistics.
 *
 * @param projectRoot - Absolute path to the CLEO project root directory
 * @param epicId - Optional epic ID to scope stats to that subtree
 * @returns Status counts, priority distribution, and type distribution
 *
 * @remarks
 * When an epicId is provided, statistics are scoped to that epic and all its
 * transitive children. Without an epicId, stats cover the entire project.
 *
 * @example
 * ```typescript
 * const stats = await coreTaskStats('/project', 'T001');
 * console.log(`${stats.done}/${stats.total} complete`);
 * ```
 *
 * @task T4790
 */
export async function coreTaskStats(
  projectRoot: string,
  epicId?: string,
): Promise<{
  total: number;
  pending: number;
  active: number;
  blocked: number;
  done: number;
  cancelled: number;
  byPriority: Record<string, number>;
  byType: Record<string, number>;
}> {
  const allTasks = await loadAllTasks(projectRoot);

  let tasks = allTasks;

  if (epicId) {
    const epicIds = new Set<string>();
    epicIds.add(epicId);
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
    total: tasks.length,
    pending: byStatus['pending'] ?? 0,
    active: byStatus['active'] ?? 0,
    blocked: byStatus['blocked'] ?? 0,
    done: byStatus['done'] ?? 0,
    cancelled: byStatus['cancelled'] ?? 0,
    byPriority,
    byType,
  };
}

/**
 * List dependencies for a task in a given direction.
 *
 * @param projectRoot - Absolute path to the CLEO project root directory
 * @param taskId - The task ID to inspect
 * @param direction - Direction to traverse: "upstream" (what this task depends on), "downstream" (what depends on it), or "both"
 * @param options - Optional display configuration
 * @param options.tree - When true, includes a recursive upstream dependency tree
 * @returns Upstream and downstream deps, transitive chain length, leaf blockers, and readiness status
 *
 * @remarks
 * Combines direct dependency lookups with transitive analysis. Leaf blockers are
 * the deepest unresolved tasks in the dependency chain -- resolving them first
 * has the most impact on unblocking.
 *
 * @example
 * ```typescript
 * const deps = await coreTaskDepends('/project', 'T100', 'both', { tree: true });
 * console.log('Leaf blockers:', deps.leafBlockers.map(b => b.id));
 * ```
 *
 * @task T4790
 */
export async function coreTaskDepends(
  projectRoot: string,
  taskId: string,
  direction: 'upstream' | 'downstream' | 'both' = 'both',
  options?: { tree?: boolean },
): Promise<{
  taskId: string;
  direction: string;
  upstream: TaskRef[];
  downstream: TaskRef[];
  unresolvedChain: number;
  leafBlockers: TaskRef[];
  allDepsReady: boolean;
  hint?: string;
  upstreamTree?: import('./task-tree.js').FlatTreeNode[];
}> {
  const allTasks = await loadAllTasks(projectRoot);

  const task = allTasks.find((t) => t.id === taskId);
  if (!task) {
    throw new Error(`Task '${taskId}' not found`);
  }

  const taskMap = new Map(allTasks.map((t) => [t.id, t]));

  const upstream: TaskRef[] = [];
  if (direction === 'upstream' || direction === 'both') {
    for (const depId of task.depends ?? []) {
      const dep = taskMap.get(depId);
      if (dep) {
        upstream.push({ id: dep.id, title: dep.title, status: dep.status });
      }
    }
  }

  const downstream: TaskRef[] = [];
  if (direction === 'downstream' || direction === 'both') {
    for (const t of allTasks) {
      if (t.depends?.includes(taskId)) {
        downstream.push({ id: t.id, title: t.title, status: t.status });
      }
    }
  }

  // Transitive dependency hints
  const tasksAsTask = allTasks;
  const transitiveIds = getTransitiveBlockers(taskId, tasksAsTask);
  const unresolvedChain = transitiveIds.length;

  const leafIds = getLeafBlockers(taskId, tasksAsTask);
  const leafBlockers = leafIds.map((id) => {
    const t = taskMap.get(id)!;
    return { id: t.id, title: t.title, status: t.status };
  });

  const allDepsReady = unresolvedChain === 0;
  const hint =
    unresolvedChain > 0
      ? `Run 'cleo deps show ${taskId} --tree' for full dependency graph (gh-399)`
      : undefined;

  // Optional upstream tree
  let upstreamTree: import('./task-tree.js').FlatTreeNode[] | undefined;
  if (options?.tree) {
    const { buildUpstreamTree } = await import('./task-tree.js');
    upstreamTree = buildUpstreamTree(taskId, taskMap);
  }

  return {
    taskId,
    direction,
    upstream,
    downstream,
    unresolvedChain,
    leafBlockers,
    allDepsReady,
    ...(hint && { hint }),
    ...(upstreamTree && { upstreamTree }),
  };
}

/**
 * Show dependencies for a task.
 *
 * @param projectRoot - Absolute path to the CLEO project root directory
 * @param taskId - The task ID to inspect dependencies for
 * @returns Upstream and downstream dependencies, unresolved deps, and readiness flag
 *
 * @remarks
 * Returns both the tasks this task depends on (upstream) and the tasks that depend
 * on it (downstream). Unresolved deps are those not yet done or cancelled.
 *
 * @example
 * ```typescript
 * const deps = await coreTaskDeps('/project', 'T100');
 * if (!deps.allDepsReady) console.log('Blocked by:', deps.unresolvedDeps);
 * ```
 *
 * @task T4790
 */
export async function coreTaskDeps(
  projectRoot: string,
  taskId: string,
): Promise<import('@cleocode/contracts').TaskDepsResult> {
  const allTasks = await loadAllTasks(projectRoot);
  const task = allTasks.find((t) => t.id === taskId);
  if (!task) {
    throw new Error(`Task '${taskId}' not found`);
  }

  const taskMap = new Map(allTasks.map((t) => [t.id, t]));
  const completedIds = new Set(
    allTasks.filter((t) => t.status === 'done' || t.status === 'cancelled').map((t) => t.id),
  );

  const dependsOn = (task.depends ?? [])
    .map((depId) => {
      const dep = taskMap.get(depId);
      return dep ? { id: dep.id, title: dep.title, status: dep.status } : null;
    })
    .filter((d) => d !== null);

  const dependedOnBy = allTasks
    .filter((t) => t.depends?.includes(taskId))
    .map((t) => ({ id: t.id, title: t.title, status: t.status }));

  const unresolvedDeps = (task.depends ?? []).filter((depId) => !completedIds.has(depId));

  return {
    taskId,
    dependsOn,
    dependedOnBy,
    unresolvedDeps,
    allDepsReady: unresolvedDeps.length === 0,
  };
}

/**
 * Show task relations.
 *
 * @param projectRoot - Absolute path to the CLEO project root directory
 * @param taskId - The task ID to retrieve relations for
 * @returns The task's relations array and count
 *
 * @remarks
 * Relations are non-dependency links between tasks (e.g. "related-to", "duplicates").
 * Unlike dependencies, relations do not affect blocking or scheduling.
 *
 * @example
 * ```typescript
 * const { relations, count } = await coreTaskRelates('/project', 'T050');
 * console.log(`${count} relations found`);
 * ```
 *
 * @task T4790
 */
export type TaskRelatesDirection = 'out' | 'in' | 'both';

export interface CoreTaskRelatesOptions {
  /** Which side of a stored edge should match `taskId`. Defaults to both. */
  direction?: TaskRelatesDirection;
  /** Relation/dependency type filter. Use `depends`/`depends_on` for scheduler dependency edges. */
  type?: string;
  /** Include scheduler dependency edges alongside task_relations edges. Defaults to true. */
  includeDependencies?: boolean;
}

type CoreTaskRelationEntry = {
  taskId: string;
  type: string;
  reason?: string;
  direction?: 'out' | 'in';
  source?: 'relation' | 'dependency';
  ready?: boolean;
  status?: string;
};

function dependencyReady(task: TaskRecord | undefined): boolean {
  return task?.status === 'done';
}

function relationTypeMatches(type: string, requested: string | undefined): boolean {
  if (!requested) return true;
  if (requested === 'depends' || requested === 'depends_on') return type === 'depends';
  return type === requested;
}

export async function coreTaskRelates(
  projectRoot: string,
  taskId: string,
  options: CoreTaskRelatesOptions = {},
): Promise<{
  taskId: string;
  direction: TaskRelatesDirection;
  relations: CoreTaskRelationEntry[];
  count: number;
}> {
  const allTasks = await loadAllTasks(projectRoot);
  const task = allTasks.find((t) => t.id === taskId);
  if (!task) {
    throw new Error(`Task '${taskId}' not found`);
  }

  const direction = options.direction ?? 'both';
  const includeDependencies = options.includeDependencies ?? true;
  const taskById = new Map(allTasks.map((t) => [t.id, t]));
  const relations: CoreTaskRelationEntry[] = [];

  if (direction === 'out' || direction === 'both') {
    for (const relation of task.relates ?? []) {
      if (!relationTypeMatches(relation.type, options.type)) continue;
      relations.push({ ...relation, direction: 'out', source: 'relation' });
    }
  }

  if (direction === 'in' || direction === 'both') {
    for (const other of allTasks) {
      if (other.id === taskId) continue;
      for (const relation of other.relates ?? []) {
        if (relation.taskId !== taskId || !relationTypeMatches(relation.type, options.type))
          continue;
        relations.push({
          taskId: other.id,
          type: relation.type,
          reason: relation.reason,
          direction: 'in',
          source: 'relation',
        });
      }
    }
  }

  if (includeDependencies && relationTypeMatches('depends', options.type)) {
    if (direction === 'out' || direction === 'both') {
      for (const depId of task.depends ?? []) {
        const dep = taskById.get(depId);
        relations.push({
          taskId: depId,
          type: 'depends',
          direction: 'out',
          source: 'dependency',
          ready: dependencyReady(dep),
          status: dep?.status,
        });
      }
    }

    if (direction === 'in' || direction === 'both') {
      for (const other of allTasks) {
        if (other.id === taskId) continue;
        if (!(other.depends ?? []).includes(taskId)) continue;
        relations.push({
          taskId: other.id,
          type: 'depends',
          direction: 'in',
          source: 'dependency',
          ready: dependencyReady(task),
          status: other.status,
        });
      }
    }
  }

  return { taskId, direction, relations, count: relations.length };
}

/**
 * Add a relation between two tasks.
 *
 * @param projectRoot - Absolute path to the CLEO project root directory
 * @param taskId - The source task ID
 * @param relatedId - The target task ID to relate to
 * @param type - Relation type (e.g. "related-to", "duplicates", "blocks")
 * @param reason - Optional human-readable reason for the relation
 * @returns Confirmation of the added relation with source, target, and type
 *
 * @remarks
 * Persists the relation both on the task's `relates` array and in the
 * `task_relations` table for bidirectional querying.
 *
 * @example
 * ```typescript
 * const result = await coreTaskRelatesAdd('/project', 'T010', 'T020', 'related-to', 'Shared scope');
 * console.log(result.added); // true
 * ```
 *
 * @task T4790
 */
export async function coreTaskRelatesAdd(
  projectRoot: string,
  taskId: string,
  relatedId: string,
  type: string,
  reason?: string,
): Promise<{ from: string; to: string; type: string; reason?: string; added: boolean }> {
  const accessor = await getTaskAccessor(projectRoot);

  const fromTask = await accessor.loadSingleTask(taskId);
  if (!fromTask) {
    throw new Error(`Task '${taskId}' not found`);
  }

  const toExists = await accessor.taskExists(relatedId);
  if (!toExists) {
    throw new Error(`Task '${relatedId}' not found`);
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
  await accessor.upsertSingleTask(fromTask);

  // Persist to task_relations table (T5168)
  await accessor.addRelation(taskId, relatedId, type, reason);

  return { from: taskId, to: relatedId, type, reason, added: true };
}

/**
 * Remove a relation between two tasks.
 *
 * @param projectRoot - Absolute path to the CLEO project root directory
 * @param taskId - The source task ID
 * @param relatedId - The target task ID whose relation is to be removed
 * @param type - Optional relation type to narrow the deletion; omit to remove any type
 * @returns Confirmation of the removed relation
 *
 * @task T9240
 */
export async function coreTaskRelatesAddBatch(
  projectRoot: string,
  params: {
    relations?: TasksRelatesAddBatchEntry[];
    edges?: TasksRelatesAddBatchEntry[];
    dryRun?: boolean;
    reasonWaiver?: string;
  },
): Promise<TasksRelatesAddBatchResult> {
  const relations = params.relations ?? params.edges ?? [];
  return addBatchRelations(relations, {
    cwd: projectRoot,
    dryRun: params.dryRun,
    reasonWaiver: params.reasonWaiver,
  });
}

export async function coreTaskRelatesRemove(
  projectRoot: string,
  taskId: string,
  relatedId: string,
  type?: string,
): Promise<{ from: string; to: string; type?: string; removed: boolean }> {
  const accessor = await getTaskAccessor(projectRoot);
  const { removeRelation: relatesRemoveRelation } = await import('./relates.js');
  const result = await relatesRemoveRelation(taskId, relatedId, type, projectRoot, accessor);
  return {
    from: taskId,
    to: relatedId,
    type,
    removed: (result as { removed?: boolean }).removed ?? true,
  };
}
