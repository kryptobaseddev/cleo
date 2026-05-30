/**
 * buildTaskTree — pure-functional task hierarchy builder.
 *
 * Accepts a flat array of tasks and constructs a tree of {@link TaskTreeNode}
 * objects. No I/O, no DB access — all input supplied by the caller.
 *
 * @arch SDK Tool (Category B) — pure, no side effects, contracts-typed
 * @task T10068
 * @epic T9835
 */

import type {
  BuildTaskTreeInput,
  BuildTaskTreeOptions,
  BuildTaskTreeResult,
  TaskTreeNode,
} from '@cleocode/contracts';

const SATISFIED_STATUSES = new Set<string>(['done', 'cancelled']);
const ACTIONABLE_STATUSES = new Set<string>(['pending', 'active']);

function getTransitiveBlockers(
  taskId: string,
  taskMap: Map<string, BuildTaskTreeInput>,
  visited: Set<string> = new Set(),
): string[] {
  if (visited.has(taskId)) return [];
  visited.add(taskId);

  const task = taskMap.get(taskId);
  if (!task?.depends?.length) return [];

  const blockers: string[] = [];
  for (const depId of task.depends) {
    const dep = taskMap.get(depId);
    if (!dep) continue;
    if (!SATISFIED_STATUSES.has(dep.status)) {
      blockers.push(depId);
    }
    blockers.push(...getTransitiveBlockers(depId, taskMap, visited));
  }
  return [...new Set(blockers)];
}

function getLeafBlockers(taskId: string, taskMap: Map<string, BuildTaskTreeInput>): string[] {
  const chain = getTransitiveBlockers(taskId, taskMap);
  return chain.filter((id) => {
    const t = taskMap.get(id);
    if (!t) return false;
    const deps = t.depends ?? [];
    return deps.every((depId) => {
      const dep = taskMap.get(depId);
      return !dep || SATISFIED_STATUSES.has(dep.status);
    });
  });
}

function buildNode(
  task: BuildTaskTreeInput,
  childrenMap: Map<string, BuildTaskTreeInput[]>,
  taskMap: Map<string, BuildTaskTreeInput>,
  withBlockers: boolean,
): TaskTreeNode {
  const rawChildren = childrenMap.get(task.id) ?? [];
  const sortedChildren = [...rawChildren].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  const children = sortedChildren.map((c) => buildNode(c, childrenMap, taskMap, withBlockers));

  const depends = task.depends ?? [];
  const blockedBy = depends.filter((depId) => {
    const dep = taskMap.get(depId);
    return dep !== undefined && !SATISFIED_STATUSES.has(dep.status);
  });
  const ready = blockedBy.length === 0 && ACTIONABLE_STATUSES.has(task.status);

  const node: TaskTreeNode = {
    id: task.id,
    title: task.title,
    status: task.status,
    type: task.type,
    priority: task.priority,
    depends,
    blockedBy,
    ready,
    children,
  };

  if (withBlockers) {
    node.blockerChain = getTransitiveBlockers(task.id, taskMap);
    node.leafBlockers = getLeafBlockers(task.id, taskMap);
  }

  return node;
}

function countNodes(nodes: TaskTreeNode[]): number {
  let count = nodes.length;
  for (const n of nodes) {
    count += countNodes(n.children);
  }
  return count;
}

/**
 * Build a task hierarchy tree from a flat array of tasks.
 *
 * Pure functional — no I/O. The caller is responsible for loading tasks and
 * passing them in. When `rootId` is provided, only the subtree rooted at that
 * task is returned. When `opts.withBlockers` is true, each node is annotated
 * with `blockerChain` and `leafBlockers`.
 *
 * @param tasks - Flat array of all tasks (or a pre-filtered subset)
 * @param rootId - Optional root task ID; returns full tree when omitted
 * @param opts - Tree-build options
 * @returns Tree nodes and total node count
 *
 * @example
 * ```typescript
 * const { tree, totalNodes } = buildTaskTree(allTasks, 'T042');
 * console.log(`${totalNodes} nodes in subtree`);
 * ```
 *
 * @example
 * ```typescript
 * const { tree } = buildTaskTree(allTasks, undefined, { withBlockers: true });
 * console.log(tree[0].blockerChain);
 * ```
 */
export function buildTaskTree(
  tasks: BuildTaskTreeInput[],
  rootId?: string,
  opts?: BuildTaskTreeOptions,
): BuildTaskTreeResult {
  const taskMap = new Map<string, BuildTaskTreeInput>(tasks.map((t) => [t.id, t]));
  const childrenMap = new Map<string, BuildTaskTreeInput[]>();

  for (const task of tasks) {
    const key = task.parentId ?? '__root__';
    if (!childrenMap.has(key)) childrenMap.set(key, []);
    childrenMap.get(key)!.push(task);
  }

  let roots: BuildTaskTreeInput[];
  if (rootId) {
    const root = taskMap.get(rootId);
    if (!root) throw new Error(`Task '${rootId}' not found`);
    roots = [root];
  } else {
    roots = childrenMap.get('__root__') ?? [];
  }

  const withBlockers = opts?.withBlockers ?? false;
  const tree = roots.map((r) => buildNode(r, childrenMap, taskMap, withBlockers));

  return { tree, totalNodes: countNodes(tree) };
}
