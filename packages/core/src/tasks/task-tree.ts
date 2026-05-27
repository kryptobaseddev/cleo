/**
 * Task hierarchy tree building — buildTaskTree and related helpers.
 * @task T10064
 * @epic T9834
 */

import type { Task, TaskPriority } from '@cleocode/contracts';
import { getTaskAccessor } from '../store/data-accessor.js';
import { getDataPath, readJsonFile as storeReadJsonFile } from '../store/file-utils.js';
import { getLeafBlockers, getTransitiveBlockers } from './dependency-check.js';

/** Task record shape expected from the data layer — alias for the contracts Task type. */
type TaskRecord = Task;

/** Tree node representation for task hierarchy. */
export interface FlatTreeNode {
  /** Unique task identifier (e.g. "T001"). */
  id: string;
  /** Human-readable task title. */
  title: string;
  /** Current task status (e.g. "pending", "done"). */
  status: string;
  /**
   * Task type classification.
   * @defaultValue "task"
   */
  type?: string;
  /** Child nodes in the hierarchy tree. */
  children: FlatTreeNode[];
  /**
   * Task priority level.
   *
   * Sourced directly from the task record's `priority` field.
   * @defaultValue "medium"
   */
  priority: TaskPriority;
  /**
   * Direct dependency IDs for this task.
   *
   * Reflects the raw `depends` array from the task record. Empty array when
   * the task has no declared dependencies.
   */
  depends: string[];
  /**
   * Open (unresolved) dependency IDs that are currently blocking this task.
   *
   * A dependency is considered open when its status is not `"done"` or
   * `"cancelled"`. Empty when all dependencies are resolved.
   */
  blockedBy: string[];
  /**
   * Whether this task is immediately actionable.
   *
   * `true` when `blockedBy` is empty AND `status` is `"pending"` or
   * `"active"`. `false` for tasks that are done, cancelled, archived, or
   * blocked by open dependencies.
   */
  ready: boolean;
  /**
   * Full transitive blocker chain for this task.
   *
   * Contains every open dependency reachable by walking the `depends` graph
   * upstream from this task (deduplicated, cycle-safe).  Only populated when
   * `withBlockers` is requested at tree-build time.
   *
   * @see {@link getTransitiveBlockers}
   */
  blockerChain?: string[];
  /**
   * Leaf-level blockers — the root-cause tasks that must be resolved first.
   *
   * A subset of `blockerChain` containing only those tasks whose own
   * dependencies are all resolved (or that have no dependencies).  Resolving
   * these tasks is the minimal set of work needed to make progress.  Only
   * populated when `withBlockers` is requested at tree-build time.
   *
   * @see {@link getLeafBlockers}
   */
  leafBlockers?: string[];
}

/**
 * Recursively build a tree node for a task, sorting children by position ASC.
 *
 * Children are sorted by their `position` field (null/undefined treated as 0)
 * using a stable comparison so equal positions preserve insertion order.
 *
 * In addition to the basic identity fields, each node is annotated with
 * dependency metadata derived from `allTasks`:
 * - `priority`     — copied directly from the task record.
 * - `depends`      — raw direct dependency IDs from the task record.
 * - `blockedBy`    — subset of `depends` whose referenced tasks are not yet
 *                    done or cancelled (i.e. still open).
 * - `ready`        — `true` when `blockedBy` is empty AND the task is in a
 *                    pending or active state.
 * - `blockerChain` — full transitive blocker chain (only when `allTasksFlat`
 *                    is provided, i.e. when `withBlockers` was requested).
 * - `leafBlockers` — terminal root-cause blockers (only when `allTasksFlat`
 *                    is provided).
 *
 * @param task          - The task to build a node for.
 * @param childrenMap   - Map of parentId to ordered child list.
 * @param taskMap       - Flat lookup map of all tasks by ID, used to resolve
 *                        dependency status when computing `blockedBy`.
 * @param allTasksFlat  - Full flat task array used for transitive blocker walks.
 *                        Pass only when `withBlockers` is true; omit otherwise
 *                        to skip the blocker-chain computation entirely.
 */
export function buildTreeNode(
  task: TaskRecord,
  childrenMap: Map<string, TaskRecord[]>,
  taskMap: Map<string, TaskRecord>,
  allTasksFlat?: TaskRecord[],
): FlatTreeNode {
  const rawChildren = childrenMap.get(task.id) ?? [];
  // Sort children by position ASC; treat null/undefined as 0 for stable ordering.
  const sortedChildren = [...rawChildren].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  const children = sortedChildren.map((child) =>
    buildTreeNode(child, childrenMap, taskMap, allTasksFlat),
  );

  // Compute dependency fields.
  const depends = task.depends ?? [];
  const blockedBy = depends.filter((depId) => {
    const dep = taskMap.get(depId);
    if (!dep) return false; // unknown dep — treat as resolved
    return dep.status !== 'done' && dep.status !== 'cancelled';
  });
  const ready = blockedBy.length === 0 && (task.status === 'pending' || task.status === 'active');

  // Transitive blocker chain — only computed when allTasksFlat is supplied.
  const blockerChain = allTasksFlat ? getTransitiveBlockers(task.id, allTasksFlat) : undefined;
  const leafBlockers = allTasksFlat ? getLeafBlockers(task.id, allTasksFlat) : undefined;

  return {
    id: task.id,
    title: task.title,
    status: task.status,
    type: task.type,
    priority: task.priority,
    depends,
    blockedBy,
    ready,
    children,
    ...(blockerChain !== undefined ? { blockerChain } : {}),
    ...(leafBlockers !== undefined ? { leafBlockers } : {}),
  };
}

/**
 * Recursively build upstream dependency nodes for a task.
 *
 * @param taskId  - Starting task ID.
 * @param taskMap - Flat lookup map of all tasks by ID.
 * @param visited - Tracks visited nodes to avoid cycles.
 */
export function buildUpstreamTree(
  taskId: string,
  taskMap: Map<string, TaskRecord>,
  visited: Set<string> = new Set(),
): FlatTreeNode[] {
  const task = taskMap.get(taskId);
  if (!task?.depends?.length) return [];

  const nodes: FlatTreeNode[] = [];
  for (const depId of task.depends) {
    if (visited.has(depId)) continue;
    visited.add(depId);

    const dep = taskMap.get(depId);
    if (!dep) continue;

    const depDepends = dep.depends ?? [];
    const depBlockedBy = depDepends.filter((id) => {
      const d = taskMap.get(id);
      return d !== undefined && d.status !== 'done' && d.status !== 'cancelled';
    });
    const depReady =
      depBlockedBy.length === 0 && (dep.status === 'pending' || dep.status === 'active');

    nodes.push({
      id: dep.id,
      title: dep.title,
      status: dep.status,
      type: dep.type,
      priority: dep.priority,
      depends: depDepends,
      blockedBy: depBlockedBy,
      ready: depReady,
      children: buildUpstreamTree(depId, taskMap, visited),
    });
  }
  return nodes;
}

/** Count all nodes in a tree including children recursively. */
export function countNodes(nodes: FlatTreeNode[]): number {
  let count = nodes.length;
  for (const node of nodes) {
    count += countNodes(node.children);
  }
  return count;
}

/**
 * Read hierarchy config limits from project config file.
 *
 * @param projectRoot - Absolute path to the CLEO project root directory.
 */
export function getHierarchyLimits(projectRoot: string): { maxDepth: number; maxSiblings: number } {
  const configPath = getDataPath(projectRoot, 'config.json');
  const config = storeReadJsonFile<Record<string, unknown>>(configPath);

  let maxDepth = 3;
  let maxSiblings = 0;

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
 * Build hierarchy tree for tasks.
 *
 * @param projectRoot  - Absolute path to the CLEO project root directory.
 * @param taskId       - Optional root task ID; when provided, builds the subtree
 *                       rooted at this task.
 * @param withBlockers - When `true`, each node in the tree is annotated with
 *                       `blockerChain` (full transitive blocker IDs) and
 *                       `leafBlockers` (root-cause terminal blockers).  The task
 *                       array is converted to a flat list **once** and passed to
 *                       every `buildTreeNode` call so the graph walk is not
 *                       repeated per-DB-query.
 * @returns The tree nodes and total node count.
 *
 * @remarks
 * When no taskId is given, returns all root-level tasks with their full subtrees.
 * When a taskId is given, returns that single task as the root with its descendants.
 *
 * @example
 * ```typescript
 * const { tree, totalNodes } = await coreTaskTree('/project', 'T042');
 * console.log(`${totalNodes} nodes in subtree`);
 * ```
 *
 * @example
 * ```typescript
 * // With transitive blocker chains
 * const { tree } = await coreTaskTree('/project', undefined, true);
 * const node = tree[0];
 * console.log(node.blockerChain); // ['T010', 'T011']
 * console.log(node.leafBlockers); // ['T011']
 * ```
 *
 * @task T4790
 * @task T1206
 */
export async function coreTaskTree(
  projectRoot: string,
  taskId?: string,
  withBlockers?: boolean,
): Promise<{ tree: FlatTreeNode[]; totalNodes: number }> {
  const accessor = await getTaskAccessor(projectRoot);
  const { tasks: allTasks } = await accessor.queryTasks({});

  if (taskId) {
    const task = allTasks.find((t) => t.id === taskId);
    if (!task) {
      throw new Error(`Task '${taskId}' not found`);
    }
  }

  const childrenMap = new Map<string, TaskRecord[]>();
  // Build a flat lookup map so buildTreeNode can resolve dependency status.
  const taskMap = new Map<string, TaskRecord>(allTasks.map((t) => [t.id, t]));

  for (const task of allTasks) {
    const parentKey = task.parentId ?? '__root__';
    if (!childrenMap.has(parentKey)) {
      childrenMap.set(parentKey, []);
    }
    childrenMap.get(parentKey)!.push(task);
  }

  let roots: TaskRecord[];
  if (taskId) {
    roots = [allTasks.find((t) => t.id === taskId)!];
  } else {
    roots = childrenMap.get('__root__') ?? [];
  }

  // Pass allTasks once when blocker chains are requested so getTransitiveBlockers
  // and getLeafBlockers share the same array reference across all recursive calls.
  const allTasksFlat = withBlockers ? allTasks : undefined;

  const tree = roots.map((root) => buildTreeNode(root, childrenMap, taskMap, allTasksFlat));

  return { tree, totalNodes: countNodes(tree) };
}
