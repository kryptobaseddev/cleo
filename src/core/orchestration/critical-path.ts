/**
 * Critical path analysis for task dependency graphs.
 * @task T4784
 */

import { readJson } from '../../store/json.js';
import { getTaskPath } from '../paths.js';
import type { TaskFile } from '../../types/task.js';
import type { DataAccessor } from '../../store/data-accessor.js';

export interface CriticalPathNode {
  taskId: string;
  title: string;
  status: string;
  size: string;
  blockerCount: number;
}

export interface CriticalPathResult {
  path: CriticalPathNode[];
  length: number;
  totalEffort: number;
  completedInPath: number;
  remainingInPath: number;
}

/** Find the critical path (longest dependency chain) in the task graph. */
export async function getCriticalPath(
  cwd?: string,
  accessor?: DataAccessor,
): Promise<CriticalPathResult> {
  const data = accessor
    ? await accessor.loadTaskFile()
    : await readJson<TaskFile>(getTaskPath(cwd));

  const tasks = data?.tasks ?? [];

  if (tasks.length === 0) {
    return { path: [], length: 0, totalEffort: 0, completedInPath: 0, remainingInPath: 0 };
  }

  const taskMap = new Map(tasks.map(t => [t.id, t]));

  // Build dependency maps
  const dependsOn = new Map<string, Set<string>>();
  const dependents = new Map<string, Set<string>>();

  for (const task of tasks) {
    if (!dependsOn.has(task.id)) dependsOn.set(task.id, new Set());
    if (!dependents.has(task.id)) dependents.set(task.id, new Set());
    if (task.depends) {
      for (const dep of task.depends) {
        dependsOn.get(task.id)!.add(dep);
        if (!dependents.has(dep)) dependents.set(dep, new Set());
        dependents.get(dep)!.add(task.id);
      }
    }
  }

  // Find longest path using DFS with memoization
  const memo = new Map<string, string[]>();

  function longestPathEndingAt(taskId: string, visited: Set<string>): string[] {
    if (memo.has(taskId)) return memo.get(taskId)!;
    if (visited.has(taskId)) return [taskId]; // circular

    visited.add(taskId);
    const deps = dependsOn.get(taskId) || new Set();
    let longest: string[] = [];

    for (const dep of deps) {
      if (taskMap.has(dep)) {
        const path = longestPathEndingAt(dep, visited);
        if (path.length > longest.length) longest = path;
      }
    }

    visited.delete(taskId);
    const result = [...longest, taskId];
    memo.set(taskId, result);
    return result;
  }

  // Find leaf nodes
  const leafNodes = tasks.filter(t => {
    const deps = dependents.get(t.id);
    return !deps || deps.size === 0;
  });

  let criticalPath: string[] = [];
  for (const leaf of leafNodes) {
    const path = longestPathEndingAt(leaf.id, new Set());
    if (path.length > criticalPath.length) criticalPath = path;
  }

  if (criticalPath.length === 0) {
    for (const task of tasks) {
      const path = longestPathEndingAt(task.id, new Set());
      if (path.length > criticalPath.length) criticalPath = path;
    }
  }

  const sizeWeights: Record<string, number> = { small: 1, medium: 3, large: 8 };

  const annotatedPath: CriticalPathNode[] = criticalPath.map(taskId => {
    const task = taskMap.get(taskId);
    const size = task?.size || 'medium';
    const incompleteDeps = (task?.depends || []).filter(dep => {
      const depTask = taskMap.get(dep);
      return depTask && depTask.status !== 'done' && depTask.status !== 'cancelled';
    });

    return {
      taskId,
      title: task?.title || taskId,
      status: task?.status || 'unknown',
      size,
      blockerCount: incompleteDeps.length,
    };
  });

  const completedInPath = annotatedPath.filter(t => t.status === 'done' || t.status === 'cancelled').length;
  const remainingInPath = annotatedPath.length - completedInPath;
  const totalEffort = annotatedPath
    .filter(t => t.status !== 'done' && t.status !== 'cancelled')
    .reduce((sum, t) => sum + (sizeWeights[t.size] ?? 3), 0);

  return { path: annotatedPath, length: criticalPath.length, totalEffort, completedInPath, remainingInPath };
}
