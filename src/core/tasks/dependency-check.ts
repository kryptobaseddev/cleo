/**
 * Dependency checking - validate task dependency graphs.
 * Ported from lib/tasks/dependency-check.sh
 *
 * @epic T4454
 * @task T4529
 */

import type { Task } from '../../types/task.js';

/** Result of a dependency validation check. */
export interface DependencyCheckResult {
  valid: boolean;
  errors: DependencyError[];
  warnings: DependencyWarning[];
}

/** A dependency error. */
export interface DependencyError {
  code: string;
  taskId: string;
  message: string;
  relatedIds?: string[];
}

/** A dependency warning. */
export interface DependencyWarning {
  code: string;
  taskId: string;
  message: string;
}

/**
 * Detect circular dependencies using DFS.
 * Returns the cycle path if found, empty array otherwise.
 */
export function detectCircularDeps(
  taskId: string,
  tasks: Task[],
): string[] {
  const taskMap = new Map(tasks.map((t) => [t.id, t]));

  const visited = new Set<string>();
  const recursionStack = new Set<string>();
  const path: string[] = [];

  function dfs(id: string): string[] {
    visited.add(id);
    recursionStack.add(id);
    path.push(id);

    const task = taskMap.get(id);
    if (task?.depends) {
      for (const depId of task.depends) {
        if (!visited.has(depId)) {
          const cycle = dfs(depId);
          if (cycle.length > 0) return cycle;
        } else if (recursionStack.has(depId)) {
          // Found cycle - return path from depId to current + depId
          const cycleStart = path.indexOf(depId);
          return [...path.slice(cycleStart), depId];
        }
      }
    }

    path.pop();
    recursionStack.delete(id);
    return [];
  }

  return dfs(taskId);
}

/**
 * Check if adding a dependency would create a cycle.
 */
export function wouldCreateCycle(
  fromId: string,
  toId: string,
  tasks: Task[],
): boolean {
  // Temporarily add the dependency and check
  const modified = tasks.map((t) => {
    if (t.id === fromId) {
      return { ...t, depends: [...(t.depends ?? []), toId] };
    }
    return t;
  });
  return detectCircularDeps(fromId, modified).length > 0;
}

/**
 * Get tasks that are blocked (have unmet dependencies).
 */
export function getBlockedTasks(tasks: Task[]): Task[] {
  const completedIds = new Set(
    tasks.filter((t) => t.status === 'done' || t.status === 'cancelled').map((t) => t.id),
  );

  return tasks.filter((t) => {
    if (!t.depends?.length) return false;
    if (t.status === 'done' || t.status === 'cancelled') return false;
    return t.depends.some((depId) => !completedIds.has(depId));
  });
}

/**
 * Get tasks that are ready (all dependencies met).
 */
export function getReadyTasks(tasks: Task[]): Task[] {
  const completedIds = new Set(
    tasks.filter((t) => t.status === 'done' || t.status === 'cancelled').map((t) => t.id),
  );

  return tasks.filter((t) => {
    if (t.status === 'done' || t.status === 'cancelled') return false;
    if (!t.depends?.length) return true;
    return t.depends.every((depId) => completedIds.has(depId));
  });
}

/**
 * Get tasks that depend on a given task.
 */
export function getDependents(taskId: string, tasks: Task[]): Task[] {
  return tasks.filter((t) => t.depends?.includes(taskId));
}

/**
 * Get dependent IDs.
 */
export function getDependentIds(taskId: string, tasks: Task[]): string[] {
  return getDependents(taskId, tasks).map((t) => t.id);
}

/**
 * Get unresolved dependencies for a task (deps that are not done/cancelled).
 */
export function getUnresolvedDeps(taskId: string, tasks: Task[]): string[] {
  const task = tasks.find((t) => t.id === taskId);
  if (!task?.depends?.length) return [];

  const completedIds = new Set(
    tasks.filter((t) => t.status === 'done' || t.status === 'cancelled').map((t) => t.id),
  );

  return task.depends.filter((depId) => !completedIds.has(depId));
}

/**
 * Validate dependencies for missing references.
 */
export function validateDependencyRefs(tasks: Task[]): DependencyError[] {
  const taskIds = new Set(tasks.map((t) => t.id));
  const errors: DependencyError[] = [];

  for (const task of tasks) {
    if (!task.depends?.length) continue;
    for (const depId of task.depends) {
      if (!taskIds.has(depId)) {
        errors.push({
          code: 'E_DEP_NOT_FOUND',
          taskId: task.id,
          message: `Task ${task.id} depends on ${depId}, which does not exist`,
          relatedIds: [depId],
        });
      }
    }
  }

  return errors;
}

/**
 * Full dependency graph validation.
 */
export function validateDependencies(tasks: Task[]): DependencyCheckResult {
  const errors: DependencyError[] = [];
  const warnings: DependencyWarning[] = [];

  // Check for missing references
  errors.push(...validateDependencyRefs(tasks));

  // Check for circular dependencies
  const visited = new Set<string>();
  for (const task of tasks) {
    if (visited.has(task.id)) continue;
    if (!task.depends?.length) continue;

    const cycle = detectCircularDeps(task.id, tasks);
    if (cycle.length > 0) {
      errors.push({
        code: 'E_CIRCULAR_DEP',
        taskId: task.id,
        message: `Circular dependency detected: ${cycle.join(' -> ')}`,
        relatedIds: cycle,
      });
      // Mark all in cycle as visited to avoid duplicate reports
      cycle.forEach((id) => visited.add(id));
    }
  }

  // Check for self-dependencies
  for (const task of tasks) {
    if (task.depends?.includes(task.id)) {
      errors.push({
        code: 'E_SELF_DEP',
        taskId: task.id,
        message: `Task ${task.id} depends on itself`,
      });
    }
  }

  // Warn about completed tasks with unmet dependencies
  for (const task of tasks) {
    if (task.status === 'done' && task.depends?.length) {
      const unresolved = getUnresolvedDeps(task.id, tasks);
      if (unresolved.length > 0) {
        warnings.push({
          code: 'W_COMPLETED_WITH_UNMET_DEPS',
          taskId: task.id,
          message: `Completed task ${task.id} has unmet dependencies: ${unresolved.join(', ')}`,
        });
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Topological sort of tasks by dependencies.
 * Returns sorted task IDs or null if cycle detected.
 */
export function topologicalSort(tasks: Task[]): string[] | null {
  const inDegree = new Map<string, number>();
  const adjList = new Map<string, string[]>();

  // Initialize
  for (const task of tasks) {
    inDegree.set(task.id, 0);
    adjList.set(task.id, []);
  }

  // Build adjacency list (dependency -> dependent)
  for (const task of tasks) {
    if (!task.depends?.length) continue;
    for (const depId of task.depends) {
      if (adjList.has(depId)) {
        adjList.get(depId)!.push(task.id);
        inDegree.set(task.id, (inDegree.get(task.id) ?? 0) + 1);
      }
    }
  }

  // Kahn's algorithm
  const queue: string[] = [];
  for (const [id, degree] of inDegree) {
    if (degree === 0) queue.push(id);
  }

  const sorted: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    sorted.push(id);

    for (const dependent of adjList.get(id) ?? []) {
      const newDegree = (inDegree.get(dependent) ?? 1) - 1;
      inDegree.set(dependent, newDegree);
      if (newDegree === 0) queue.push(dependent);
    }
  }

  // If not all tasks sorted, there's a cycle
  if (sorted.length !== tasks.length) return null;
  return sorted;
}
