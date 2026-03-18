/**
 * Dependency analysis for orchestration.
 *
 * Provides dependency graph building, circular dependency detection (DFS),
 * and missing dependency identification for epic task hierarchies.
 *
 * @task T5702
 */

import type { Task } from '@cleocode/contracts';

/** A circular dependency cycle found via DFS traversal. */
export type CircularDependency = string[];

/** A missing dependency reference within an epic. */
export interface MissingDependency {
  taskId: string;
  missingDep: string;
}

/** Full dependency analysis result for an epic. */
export interface DependencyAnalysis {
  dependencyGraph: Record<string, string[]>;
  circularDependencies: CircularDependency[];
  missingDependencies: MissingDependency[];
}

/**
 * Build a dependency graph for a set of tasks.
 *
 * Returns a Map from task ID to the set of task IDs it depends on.
 */
export function buildDependencyGraph(tasks: Task[]): Map<string, Set<string>> {
  const graph = new Map<string, Set<string>>();
  for (const task of tasks) {
    if (!graph.has(task.id)) {
      graph.set(task.id, new Set());
    }
    if (task.depends) {
      for (const dep of task.depends) {
        graph.get(task.id)!.add(dep);
      }
    }
  }
  return graph;
}

/**
 * Detect circular dependencies using DFS traversal.
 *
 * @param tasks - The set of tasks to analyze
 * @param graph - Pre-built dependency graph (optional; built from tasks if not provided)
 * @returns Array of circular dependency cycles (each cycle is an array of task IDs)
 */
export function detectCircularDependencies(
  tasks: Task[],
  graph?: Map<string, Set<string>>,
): CircularDependency[] {
  const depGraph = graph ?? buildDependencyGraph(tasks);
  const circularDeps: CircularDependency[] = [];
  const visited = new Set<string>();
  const recursionStack = new Set<string>();

  function dfs(taskId: string, path: string[]): void {
    visited.add(taskId);
    recursionStack.add(taskId);
    const deps = depGraph.get(taskId) || new Set();
    for (const dep of deps) {
      if (!visited.has(dep)) {
        dfs(dep, [...path, taskId]);
      } else if (recursionStack.has(dep)) {
        circularDeps.push([...path, taskId, dep]);
      }
    }
    recursionStack.delete(taskId);
  }

  for (const task of tasks) {
    if (!visited.has(task.id)) {
      dfs(task.id, []);
    }
  }

  return circularDeps;
}

/**
 * Find missing dependencies — deps that reference tasks outside the epic
 * that are not yet completed.
 *
 * @param children - Child tasks of the epic
 * @param allTasks - All tasks in the project (to check if deps are completed elsewhere)
 * @returns Array of missing dependency references
 */
export function findMissingDependencies(children: Task[], allTasks: Task[]): MissingDependency[] {
  const childIds = new Set(children.map((t) => t.id));
  const missingDeps: MissingDependency[] = [];

  for (const task of children) {
    if (task.depends) {
      for (const dep of task.depends) {
        if (!childIds.has(dep) && !allTasks.find((t) => t.id === dep && t.status === 'done')) {
          missingDeps.push({ taskId: task.id, missingDep: dep });
        }
      }
    }
  }

  return missingDeps;
}

/**
 * Perform full dependency analysis for an epic's children.
 *
 * Combines dependency graph building, circular detection, and missing dep
 * identification into a single analysis result.
 *
 * @param children - Child tasks of the epic
 * @param allTasks - All tasks in the project
 * @returns Complete dependency analysis
 */
export function analyzeDependencies(children: Task[], allTasks: Task[]): DependencyAnalysis {
  const graph = buildDependencyGraph(children);
  const circularDependencies = detectCircularDependencies(children, graph);
  const missingDependencies = findMissingDependencies(children, allTasks);

  const dependencyGraph: Record<string, string[]> = {};
  for (const [key, value] of graph.entries()) {
    dependencyGraph[key] = Array.from(value);
  }

  return {
    dependencyGraph,
    circularDependencies,
    missingDependencies,
  };
}
