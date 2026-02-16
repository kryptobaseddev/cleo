/**
 * Task hierarchy operations - parent/child tree traversal and validation.
 * Ported from lib/tasks/hierarchy.sh
 *
 * @epic T4454
 * @task T4529
 */

import type { Task } from '../../types/task.js';

/** Maximum nesting depth (epic -> task -> subtask). */
const MAX_DEPTH = 3;

/** Maximum siblings per parent. */
const MAX_SIBLINGS = 7;

/**
 * Get direct children of a task.
 */
export function getChildren(taskId: string, tasks: Task[]): Task[] {
  return tasks.filter((t) => t.parentId === taskId);
}

/**
 * Get direct child IDs.
 */
export function getChildIds(taskId: string, tasks: Task[]): string[] {
  return getChildren(taskId, tasks).map((t) => t.id);
}

/**
 * Get all descendants of a task (recursive).
 */
export function getDescendants(taskId: string, tasks: Task[]): Task[] {
  const result: Task[] = [];
  const queue = [taskId];
  const visited = new Set<string>();

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);

    const children = getChildren(current, tasks);
    for (const child of children) {
      result.push(child);
      queue.push(child.id);
    }
  }

  return result;
}

/**
 * Get all descendant IDs (flat list).
 */
export function getDescendantIds(taskId: string, tasks: Task[]): string[] {
  return getDescendants(taskId, tasks).map((t) => t.id);
}

/**
 * Get the parent chain (ancestors) from a task up to the root.
 * Returns ordered from immediate parent to root.
 */
export function getParentChain(taskId: string, tasks: Task[]): Task[] {
  const chain: Task[] = [];
  const taskMap = new Map(tasks.map((t) => [t.id, t]));
  let current = taskMap.get(taskId);
  const visited = new Set<string>();

  while (current?.parentId) {
    if (visited.has(current.parentId)) break; // circular reference guard
    visited.add(current.parentId);
    const parent = taskMap.get(current.parentId);
    if (!parent) break;
    chain.push(parent);
    current = parent;
  }

  return chain;
}

/**
 * Get the parent chain as IDs.
 */
export function getParentChainIds(taskId: string, tasks: Task[]): string[] {
  return getParentChain(taskId, tasks).map((t) => t.id);
}

/**
 * Calculate depth of a task in the hierarchy (0-based).
 * Root tasks have depth 0, their children depth 1, etc.
 */
export function getDepth(taskId: string, tasks: Task[]): number {
  return getParentChain(taskId, tasks).length;
}

/**
 * Get the root ancestor of a task.
 */
export function getRootAncestor(taskId: string, tasks: Task[]): Task | null {
  const chain = getParentChain(taskId, tasks);
  return chain.length > 0 ? chain[chain.length - 1] : null;
}

/**
 * Check if a task is an ancestor of another.
 */
export function isAncestorOf(
  ancestorId: string,
  descendantId: string,
  tasks: Task[],
): boolean {
  const chain = getParentChainIds(descendantId, tasks);
  return chain.includes(ancestorId);
}

/**
 * Check if a task is a descendant of another.
 */
export function isDescendantOf(
  descendantId: string,
  ancestorId: string,
  tasks: Task[],
): boolean {
  return isAncestorOf(ancestorId, descendantId, tasks);
}

/**
 * Get sibling tasks (same parent).
 */
export function getSiblings(taskId: string, tasks: Task[]): Task[] {
  const task = tasks.find((t) => t.id === taskId);
  if (!task) return [];

  if (task.parentId) {
    return tasks.filter((t) => t.parentId === task.parentId && t.id !== taskId);
  }
  // Root-level siblings: tasks with no parent, excluding self
  return tasks.filter((t) => !t.parentId && t.id !== taskId);
}

/**
 * Validate that adding a child to a parent would not violate constraints.
 */
export interface HierarchyValidation {
  valid: boolean;
  error?: {
    code: string;
    message: string;
  };
}

export function validateHierarchy(
  parentId: string | null,
  tasks: Task[],
): HierarchyValidation {
  if (!parentId) {
    return { valid: true };
  }

  const parent = tasks.find((t) => t.id === parentId);
  if (!parent) {
    return {
      valid: false,
      error: { code: 'E_PARENT_NOT_FOUND', message: `Parent task ${parentId} not found` },
    };
  }

  // Check depth
  const parentDepth = getDepth(parentId, tasks);
  if (parentDepth + 1 >= MAX_DEPTH) {
    return {
      valid: false,
      error: {
        code: 'E_DEPTH_EXCEEDED',
        message: `Maximum nesting depth ${MAX_DEPTH} would be exceeded`,
      },
    };
  }

  // Check sibling limit
  const existingChildren = getChildren(parentId, tasks);
  if (existingChildren.length >= MAX_SIBLINGS) {
    return {
      valid: false,
      error: {
        code: 'E_SIBLING_LIMIT',
        message: `Parent ${parentId} already has ${MAX_SIBLINGS} children (max)`,
      },
    };
  }

  return { valid: true };
}

/**
 * Detect circular reference if parentId were set.
 */
export function wouldCreateCircle(
  taskId: string,
  newParentId: string,
  tasks: Task[],
): boolean {
  if (taskId === newParentId) return true;
  const descendants = getDescendantIds(taskId, tasks);
  return descendants.includes(newParentId);
}

/**
 * Build a tree structure from flat task list.
 */
export interface TaskTreeNode {
  task: Task;
  children: TaskTreeNode[];
}

export function buildTree(tasks: Task[]): TaskTreeNode[] {
  const childrenMap = new Map<string | null, Task[]>();

  for (const task of tasks) {
    const parentKey = task.parentId ?? null;
    if (!childrenMap.has(parentKey)) {
      childrenMap.set(parentKey, []);
    }
    childrenMap.get(parentKey)!.push(task);
  }

  function buildNode(task: Task): TaskTreeNode {
    const children = (childrenMap.get(task.id) ?? []).map(buildNode);
    return { task, children };
  }

  const roots = childrenMap.get(null) ?? [];
  return roots.map(buildNode);
}

/**
 * Flatten a tree back to a list (depth-first).
 */
export function flattenTree(nodes: TaskTreeNode[]): Task[] {
  const result: Task[] = [];
  for (const node of nodes) {
    result.push(node.task);
    result.push(...flattenTree(node.children));
  }
  return result;
}
