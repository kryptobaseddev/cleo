/**
 * Topological sort for import order using Kahn's algorithm.
 * Ported from lib/data/import-sort.sh
 *
 * Ensures tasks are imported in dependency order where:
 * 1. Parents are imported before children (parentId references)
 * 2. Dependencies are imported before dependents (depends[] references)
 *
 * @task T4552
 * @epic T4545
 */

import { CleoError } from '../core/errors.js';
import { ExitCode } from '../types/exit-codes.js';

/** Minimal task shape needed for topological sorting. */
export interface SortableTask {
  id: string;
  parentId?: string | null;
  depends?: string[];
}

/** Graph node used during topological sort. */
interface GraphNode {
  id: string;
  inDegree: number;
  children: string[];
  dependents: string[];
}

/**
 * Topological sort for task import order using Kahn's algorithm.
 *
 * Ensures tasks are imported in dependency order:
 * - Parents before children (parentId references)
 * - Dependencies before dependents (depends[] references)
 * - Only counts edges to tasks within the set (external deps ignored)
 *
 * @task T4552
 */
export function topologicalSortTasks(tasks: SortableTask[]): string[] {
  if (tasks.length === 0) return [];

  // Build lookup from id to index
  const idToIndex = new Map<string, number>();
  for (let i = 0; i < tasks.length; i++) {
    idToIndex.set(tasks[i]!.id, i);
  }

  // Initialize graph nodes
  const nodes: GraphNode[] = tasks.map((task) => {
    // Count in-degree: edges from parentId + depends that are within the set
    let inDegree = 0;

    if (task.parentId && idToIndex.has(task.parentId)) {
      inDegree++;
    }

    const deps = task.depends ?? [];
    for (const dep of deps) {
      if (idToIndex.has(dep)) {
        inDegree++;
      }
    }

    return {
      id: task.id,
      inDegree,
      children: [],
      dependents: [],
    };
  });

  // Build reverse edges (parent -> children, dep -> dependents)
  for (const task of tasks) {
    // Add to parent's children list
    if (task.parentId) {
      const parentIdx = idToIndex.get(task.parentId);
      if (parentIdx !== undefined) {
        nodes[parentIdx]!.children.push(task.id);
      }
    }

    // Add to each dep's dependents list
    const deps = task.depends ?? [];
    for (const dep of deps) {
      const depIdx = idToIndex.get(dep);
      if (depIdx !== undefined) {
        nodes[depIdx]!.dependents.push(task.id);
      }
    }
  }

  // Build node lookup by ID for efficient access
  const nodeById = new Map<string, GraphNode>();
  for (const node of nodes) {
    nodeById.set(node.id, node);
  }

  // Kahn's algorithm: initialize queue with zero in-degree nodes
  const queue: string[] = [];
  for (const node of nodes) {
    if (node.inDegree === 0) {
      queue.push(node.id);
    }
  }

  const result: string[] = [];

  while (queue.length > 0) {
    const current = queue.shift()!;
    result.push(current);

    const currentNode = nodeById.get(current)!;

    // Process all successors (children + dependents)
    const successors = [...currentNode.children, ...currentNode.dependents];

    for (const successorId of successors) {
      const successor = nodeById.get(successorId);
      if (!successor) continue;

      successor.inDegree--;

      if (successor.inDegree === 0) {
        queue.push(successorId);
      }
    }
  }

  // Cycle detection
  if (result.length !== tasks.length) {
    const processed = new Set(result);
    const unprocessed = tasks
      .map((t) => t.id)
      .filter((id) => !processed.has(id));

    throw new CleoError(
      ExitCode.VALIDATION_ERROR,
      `Cycle detected in task dependencies. Tasks in cycle: ${unprocessed.join(', ')}`,
    );
  }

  return result;
}

/**
 * Detect cycles in task dependency graph.
 * Returns true if no cycles, false if cycles detected.
 * @task T4552
 */
export function detectCycles(tasks: SortableTask[]): boolean {
  try {
    topologicalSortTasks(tasks);
    return true; // No cycles
  } catch {
    return false; // Cycles detected
  }
}
