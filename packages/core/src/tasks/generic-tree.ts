/**
 * Generic task-graph walker — produces a typed {@link TreeResponse} that
 * covers BOTH `parent_id` edges AND `task_relations.relation_type='groups'`
 * edges from any root, recursively to full depth.
 *
 * Used by `cleo tree <id>` to surface the complete task graph rooted at a
 * given task. Walks downward via parent edges + groups edges, and emits a
 * separate ancestor chain (parent edges only) so the caller sees where the
 * root sits in the broader hierarchy.
 *
 * @epic T10114
 * @task T10134
 * @see ADR-077-human-render-contract.md
 * @see ADR-073-above-epic-naming.md §1 — Saga ↔ Epic linkage
 */

import type {
  FlatTreeNode,
  Task,
  TaskPriority,
  TaskStatus,
  TreeNodeKind,
  TreeNodeStatus,
  TreeResponse,
} from '@cleocode/contracts';
import { SAGA_GROUPS_RELATION, SAGA_LABEL } from '../sagas/constants.js';
import { getTaskAccessor } from '../store/data-accessor.js';
import { getLeafBlockers, getTransitiveBlockers } from './dependency-check.js';

/**
 * Edge type that placed a node under its parent in the rendered tree.
 *
 * - `'parent'` — node was reached via the `parent_id` column (default hierarchy).
 * - `'groups'` — node was reached via `task_relations.relation_type='groups'`
 *                (saga membership edge).
 * - `'root'`   — the node is the rendered root; it has no incoming edge.
 *
 * Used by the renderer to prefix saga-membership rows with
 * {@link RelationIcon.GROUPS} (`⊂`) so the user can distinguish a parent edge
 * from a groups edge at a glance.
 */
export type GenericTreeEdgeType = 'parent' | 'groups' | 'root';

/**
 * Per-node metadata carried in {@link FlatTreeNode.metadata} for every row
 * produced by {@link buildGenericTaskTree}.
 *
 * Mirrors the dependency-annotation fields exposed by the legacy
 * `FlatTreeNode` in `task-tree.ts` so the CLI's existing `--withDeps` and
 * `--blockers` annotations continue to work without a second DB round-trip.
 */
export interface GenericTreeMetadata {
  /**
   * Edge that placed this node under its parent. `'root'` for the rendered
   * root itself.
   */
  readonly edgeType: GenericTreeEdgeType;
  /** Task priority. Defaulted to `'medium'` when the source row omits it. */
  readonly priority: TaskPriority;
  /** Raw `depends` IDs from the task record. Empty when the task has no deps. */
  readonly depends: ReadonlyArray<string>;
  /**
   * Open (unresolved) dependency IDs that are currently blocking this task.
   *
   * A dependency is considered open when its status is not `'done'` or
   * `'cancelled'`.
   */
  readonly blockedBy: ReadonlyArray<string>;
  /**
   * Whether this task is immediately actionable — `true` when `blockedBy`
   * is empty AND the task's status is `'pending'` or `'active'`.
   */
  readonly ready: boolean;
  /**
   * Full transitive blocker chain. Populated only when the caller requests
   * blocker enrichment (`withBlockers: true`).
   */
  readonly blockerChain?: ReadonlyArray<string>;
  /**
   * Leaf-level blockers — root-cause tasks that must be resolved first.
   * Populated only when the caller requests blocker enrichment.
   */
  readonly leafBlockers?: ReadonlyArray<string>;
}

/**
 * Result of {@link buildGenericTaskTree}.
 *
 * The returned `tree` envelope walks downward from `rootId` (covering both
 * parent and groups edges). The optional `ancestors` array carries the upward
 * chain from `rootId` to the eventual root of the broader hierarchy — strict
 * parent-only walk, useful when `rootId` is a leaf task and the caller wants
 * to show context above it.
 */
export interface GenericTreeResult {
  /** Flat, pre-order tree envelope rooted at the requested task. */
  readonly tree: TreeResponse<GenericTreeMetadata>;
  /**
   * Ancestor chain from the rendered root upward through parent_id edges.
   * Ordered nearest-first (immediate parent at index 0). Empty when the
   * rendered root has no parent.
   */
  readonly ancestors: ReadonlyArray<FlatTreeNode<GenericTreeMetadata>>;
}

/**
 * Options for {@link buildGenericTaskTree}.
 */
export interface BuildGenericTreeOptions {
  /**
   * Enrich each node with `blockerChain` and `leafBlockers` metadata.
   * Equivalent to the `withBlockers` flag on the legacy `coreTaskTree`.
   *
   * @defaultValue false
   */
  readonly withBlockers?: boolean;
}

/**
 * Map a CLEO {@link TaskStatus} to the typed {@link TreeNodeStatus}.
 *
 * `'active'` collapses to `'in_progress'` (renderer naming); `'proposed'`
 * collapses to `'pending'` since the tree contract does not carry a
 * proposed-only state.
 */
function toTreeStatus(status: TaskStatus): TreeNodeStatus {
  switch (status) {
    case 'active':
      return 'in_progress';
    case 'pending':
    case 'proposed':
      return 'pending';
    case 'done':
      return 'done';
    case 'blocked':
      return 'blocked';
    case 'cancelled':
      return 'cancelled';
    case 'archived':
      return 'archived';
  }
}

/**
 * Map a {@link Task} record to the typed {@link TreeNodeKind} discriminator.
 *
 * Sagas are stored as `type='epic'` rows that carry the `'saga'` label —
 * those resolve to `'saga'`. Everything else maps 1:1 from `Task.type`,
 * with `'task'` as the safe fallback when the type column is missing.
 */
function toTreeKind(task: Task): TreeNodeKind {
  if (task.type === 'epic' && (task.labels ?? []).includes(SAGA_LABEL)) return 'saga';
  if (task.type === 'epic') return 'epic';
  if (task.type === 'subtask') return 'subtask';
  return 'task';
}

/**
 * Resolve members linked from `task` through `task_relations.type='groups'`
 * edges. Preserves edge order and deduplicates by member ID.
 */
function resolveGroupsMembers(task: Task): string[] {
  const seen = new Set<string>();
  const memberIds: string[] = [];
  for (const relation of task.relates ?? []) {
    if (relation.type !== SAGA_GROUPS_RELATION) continue;
    if (seen.has(relation.taskId)) continue;
    seen.add(relation.taskId);
    memberIds.push(relation.taskId);
  }
  return memberIds;
}

/**
 * Build the typed tree envelope rooted at `rootId`, walking BOTH parent edges
 * AND groups edges to full depth. Cycle-safe via a single visited set spanning
 * both edge types.
 *
 * Children of a node are emitted in this stable order:
 *   1. `parent_id` children (sorted by `position ASC` like the legacy walker)
 *   2. `groups` members (in edge-insertion order)
 *
 * The two sets do not overlap in well-formed data because sagas hold members
 * via `groups` edges instead of `parent_id`. If a future schema change allows
 * overlap, the visited set guarantees each node is emitted exactly once and
 * the first edge wins.
 *
 * Each emitted node carries {@link GenericTreeMetadata} so the renderer (and
 * downstream `--withDeps`/`--blockers` annotations) has everything it needs
 * without a second DB round-trip.
 *
 * @param projectRoot - Absolute project root used to resolve the data accessor.
 * @param rootId      - Task ID to root the tree at. Required — the legacy
 *                      "all roots" walk is intentionally not supported here
 *                      because `cleo tree <id>` always takes a positional ID.
 * @param opts        - Optional enrichment flags.
 * @throws `Error` with `E_NOT_FOUND` semantics when `rootId` is unknown.
 */
export async function buildGenericTaskTree(
  projectRoot: string,
  rootId: string,
  opts: BuildGenericTreeOptions = {},
): Promise<GenericTreeResult> {
  const accessor = await getTaskAccessor(projectRoot);
  const { tasks: allTasks } = await accessor.queryTasks({});
  const taskMap = new Map<string, Task>(allTasks.map((t) => [t.id, t]));

  const rootTask = taskMap.get(rootId);
  if (!rootTask) {
    throw new Error(`Task '${rootId}' not found`);
  }

  // Precompute parent_id → ordered child list once so DFS lookups are O(1).
  const childrenByParent = new Map<string, Task[]>();
  for (const task of allTasks) {
    if (task.parentId === null || task.parentId === undefined) continue;
    const bucket = childrenByParent.get(task.parentId);
    if (bucket) bucket.push(task);
    else childrenByParent.set(task.parentId, [task]);
  }
  for (const bucket of childrenByParent.values()) {
    bucket.sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  }

  // For blocker enrichment the helpers want the raw flat array — capture the
  // reference once so the recursive walk doesn't re-materialise it per node.
  const allTasksFlat = opts.withBlockers === true ? allTasks : undefined;

  const flat: FlatTreeNode<GenericTreeMetadata>[] = [];
  const visited = new Set<string>();

  /**
   * DFS walker — pushes one row per visited task into `flat`.
   *
   * @param task     - Task being emitted.
   * @param depth    - Distance from the rendered root (root = 0).
   * @param parentId - Edge target; `null` only for the root.
   * @param edgeType - Edge that placed this task under `parentId`.
   */
  function emit(
    task: Task,
    depth: number,
    parentId: string | null,
    edgeType: GenericTreeEdgeType,
  ): void {
    if (visited.has(task.id)) return;
    visited.add(task.id);

    flat.push(buildFlatNode(task, depth, parentId, edgeType, taskMap, allTasksFlat));

    // 1. parent_id children (sorted by position ASC).
    const parentChildren = childrenByParent.get(task.id) ?? [];
    for (const child of parentChildren) {
      emit(child, depth + 1, task.id, 'parent');
    }

    // 2. groups members (saga membership edges).
    const memberIds = resolveGroupsMembers(task);
    for (const memberId of memberIds) {
      const member = taskMap.get(memberId);
      if (!member) continue; // dangling edge — skip silently
      emit(member, depth + 1, task.id, 'groups');
    }
  }

  emit(rootTask, 0, null, 'root');

  // Ancestor chain — strict parent_id walk upward from the rendered root.
  // Cycle-safe via the existing `visited` set so we never re-emit a node.
  const ancestorChain: FlatTreeNode<GenericTreeMetadata>[] = [];
  let cursor: Task | undefined = rootTask;
  // Use a parallel set so an unrelated ancestor doesn't get blocked by a
  // duplicate ID inside the downstream tree.
  const ancestorSeen = new Set<string>([rootTask.id]);
  while (cursor && cursor.parentId !== null && cursor.parentId !== undefined) {
    const parent = taskMap.get(cursor.parentId);
    if (!parent) break;
    if (ancestorSeen.has(parent.id)) break;
    ancestorSeen.add(parent.id);
    ancestorChain.push(
      buildFlatNode(parent, ancestorChain.length, null, 'parent', taskMap, allTasksFlat),
    );
    cursor = parent;
  }

  let maxDepth = 0;
  for (const row of flat) {
    if (row.depth > maxDepth) maxDepth = row.depth;
  }

  const tree: TreeResponse<GenericTreeMetadata> = {
    tree: flat,
    root: rootId,
    totalNodes: flat.length,
    maxDepth,
  };

  return { tree, ancestors: ancestorChain };
}

/**
 * Build one {@link FlatTreeNode} row with full metadata.
 */
function buildFlatNode(
  task: Task,
  depth: number,
  parentId: string | null,
  edgeType: GenericTreeEdgeType,
  taskMap: ReadonlyMap<string, Task>,
  allTasksFlat: ReadonlyArray<Task> | undefined,
): FlatTreeNode<GenericTreeMetadata> {
  const depends = task.depends ?? [];
  const blockedBy = depends.filter((depId) => {
    const dep = taskMap.get(depId);
    if (!dep) return false;
    return dep.status !== 'done' && dep.status !== 'cancelled';
  });
  const ready = blockedBy.length === 0 && (task.status === 'pending' || task.status === 'active');

  const blockerChain = allTasksFlat ? getTransitiveBlockers(task.id, [...allTasksFlat]) : undefined;
  const leafBlockers = allTasksFlat ? getLeafBlockers(task.id, [...allTasksFlat]) : undefined;

  const metadata: GenericTreeMetadata = {
    edgeType,
    priority: task.priority,
    depends,
    blockedBy,
    ready,
    ...(blockerChain !== undefined ? { blockerChain } : {}),
    ...(leafBlockers !== undefined ? { leafBlockers } : {}),
  };

  return {
    id: task.id,
    parentId,
    depth,
    kind: toTreeKind(task),
    status: toTreeStatus(task.status),
    title: task.title,
    metadata,
  };
}
