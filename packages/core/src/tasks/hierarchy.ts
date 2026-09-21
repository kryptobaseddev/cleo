/**
 * Task hierarchy operations - parent/child tree traversal and validation.
 * Ported from lib/tasks/hierarchy.sh
 *
 * @epic T4454
 * @task T4529
 */

import type { Task, TaskType } from '@cleocode/contracts';

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
 * Whether adding a child under a parent at `parentDepth` would exceed the cap.
 *
 * `maxDepth` is the maximum depth VALUE a node may hold, INCLUSIVE — not a count
 * of tiers. The canonical spine is `saga(0) → epic(1) → task(2) → subtask(3)`
 * (see the `TaskType` TSDoc in `@cleocode/contracts`), so the default
 * `maxDepth: 3` admits a subtask and refuses anything below it.
 *
 * The inclusive reading is the one the config schema, `validateParent`, and
 * `compliance/protocol-rules.ts` have always used. The four write-path guards
 * that now delegate here used `parentDepth + 1 >= maxDepth`, an EXCLUSIVE
 * reading that was correct only while the spine was three tiers (`epic=0,
 * task=1, subtask=2` — still the wording in `core/schemas/config.schema.json`).
 * ADR-083 §2.5 / ADR-088 made `saga` a real `parent_id` container, pushing every
 * tier down one, but the comparison was never recalibrated. The saga silently
 * consumed the level the subtask needed, so `cleo add --type subtask` became
 * unreachable in every saga-rooted project. Measured on this repo's own store:
 * 163 live `saga → epic → task → subtask` rows the add path could no longer
 * create, plus two field reports of agents thrashing on `E_CLEO_DEPTH_EXCEEDED`.
 *
 * Kept as ONE function on purpose. The comparison previously existed in four
 * copies (`tasks/add.ts`, `tasks/update.ts`, `validateHierarchyPlacement`, and
 * `validateHierarchy` below) and drifted away from the two correct
 * implementations without any of them failing a test — every depth test asserted
 * the arithmetic over untyped fixtures, so inserting a tier above `epic` could
 * not fail them. The next tier change edits this line.
 *
 * @param parentDepth - Ancestor count of the prospective parent (root = 0).
 * @param maxDepth - Resolved `HierarchyPolicy.maxDepth` cap, inclusive.
 * @returns `true` when the child would sit deeper than `maxDepth`.
 *
 * @example
 * ```ts
 * // saga(0) → epic(1) → task(2): adding a subtask under the task
 * console.assert(exceedsMaxDepth(2, 3) === false, 'subtask at depth 3 is legal');
 * // adding under that subtask would be depth 4
 * console.assert(exceedsMaxDepth(3, 3) === true, 'depth 4 is refused');
 * ```
 */
export function exceedsMaxDepth(parentDepth: number, maxDepth: number): boolean {
  return parentDepth + 1 > maxDepth;
}

/**
 * Derive the tier a child takes under a given parent, per the PM-Core V2
 * containment matrix (`saga→epic`, `epic→task`, `task→subtask`).
 *
 * `currentType` pins the tier for nodes whose type is intrinsic rather than
 * positional: a saga stays a saga and an epic stays an epic wherever it is
 * moved. It is optional so the add path — which has no existing row — can ask
 * the same question as the reparent paths.
 *
 * Canonicalised here because three callers had byte-identical private copies
 * (`tasks/update.ts`, `tasks/task-reparent.ts`, and the inline expression in
 * `tasks/add.ts`), and the add path needed a fourth to cross-check its own error
 * suggestions.
 *
 * The `saga` parent branch is deliberately CREATE-ONLY (`currentType ===
 * undefined`). On the add path a typeless child of a saga is an epic. On a
 * reparent the node already has a tier, and returning `epic` there would
 * silently PROMOTE a task to an epic to satisfy the containment matrix instead
 * of rejecting the move — so an existing node falls through and is refused by
 * `isAllowedWorkGraphParentType`, exactly as the private copies did.
 *
 * @param parentType - Type of the prospective parent, or null/undefined for root.
 * @param currentType - Existing type of the node being placed, when it has one.
 * @returns The tier the child should hold under that parent.
 */
export function childTypeForParentType(
  parentType: TaskType | null | undefined,
  currentType?: TaskType,
): TaskType {
  if (currentType === 'saga') return 'saga';
  if (currentType === 'epic') return 'epic';
  if (parentType === 'task') return 'subtask';
  if (parentType === 'epic') return 'task';
  if (parentType === 'saga' && currentType === undefined) return 'epic';
  return currentType === 'subtask' ? 'task' : (currentType ?? 'task');
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
export function isAncestorOf(ancestorId: string, descendantId: string, tasks: Task[]): boolean {
  const chain = getParentChainIds(descendantId, tasks);
  return chain.includes(ancestorId);
}

/**
 * Check if a task is a descendant of another.
 */
export function isDescendantOf(descendantId: string, ancestorId: string, tasks: Task[]): boolean {
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
  policy?: { maxDepth?: number; maxSiblings?: number },
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
  if (exceedsMaxDepth(parentDepth, policy?.maxDepth ?? 3)) {
    return {
      valid: false,
      error: {
        code: 'E_DEPTH_EXCEEDED',
        message: `Maximum nesting depth ${policy?.maxDepth ?? 3} would be exceeded`,
      },
    };
  }

  // Check sibling limit
  const existingChildren = getChildren(parentId, tasks);
  const maxSiblings = policy?.maxSiblings ?? 0;
  if (maxSiblings > 0 && existingChildren.length >= maxSiblings) {
    return {
      valid: false,
      error: {
        code: 'E_SIBLING_LIMIT',
        message: `Parent ${parentId} already has ${maxSiblings} children (max)`,
      },
    };
  }

  return { valid: true };
}

/**
 * Detect circular reference if parentId were set.
 */
export function wouldCreateCircle(taskId: string, newParentId: string, tasks: Task[]): boolean {
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
