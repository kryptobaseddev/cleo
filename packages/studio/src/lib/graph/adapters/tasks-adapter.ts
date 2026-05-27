/**
 * Tasks → Graph kit adapter.
 *
 * Projects a `Task[]` + `TaskDependencyEdge[]` bundle (the exact shape
 * returned by the SvelteKit `explorer-loader`) into the engine-agnostic
 * {@link GraphNode} / {@link GraphEdge} / {@link GraphCluster} primitives
 * consumed by {@link SvgRenderer}, the /tasks GraphTab, and the
 * per-task {@link TaskDepGraph} mini view.
 *
 * The adapter is pure. It has zero DOM / d3 / svelte dependencies, so it
 * is unit-tested in isolation (`./__tests__/tasks-adapter.test.ts`) and
 * can be imported server-side if the `/api/tasks/graph` endpoint ever
 * wants to pre-render a bundle.
 *
 * Edge semantics mirror the operator-approved reference viz:
 *
 *   - `parent`  — `task.parentId` → `task.id` (solid, heavy spring)
 *   - `blocks`  — CSV / JSON parse of `task.blockedBy` (dashed, weak)
 *   - `depends` — rows from the `task_dependencies` table (dotted, weak)
 *
 * Clusters group tasks by their top-level ancestor epic — the same
 * grouping the Kanban swim-lanes use, so both surfaces agree on what an
 * "epic family" means.
 *
 * @task T990
 * @wave 1C
 */

import type { Task } from '@cleocode/contracts';
import type { EdgeKind, GraphCluster, GraphEdge, GraphNode } from '$lib/graph/types.js';
import type { TaskDependencyEdge } from '$lib/server/tasks/explorer-loader.js';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/**
 * Options controlling which tasks participate in the projection.
 */
export interface TasksToGraphOpts {
  /**
   * When set, only tasks in the subtree rooted at this id (or the epic
   * itself) are emitted. `null` / absent = project the full bundle.
   */
  epicScope?: string | null;
  /** When false (default), cancelled epics are filtered out. */
  includeCancelled?: boolean;
  /** When false (default), archived tasks are filtered out. */
  includeArchived?: boolean;
}

/**
 * Result bundle returned by {@link tasksToGraph}.
 */
export interface TasksToGraphResult {
  /** Projected nodes, de-duplicated on `id`. Order matches input task order. */
  nodes: GraphNode[];
  /** Projected edges (parent | blocks | depends), id-deterministic. */
  edges: GraphEdge[];
  /** One cluster per top-level ancestor epic. Singletons filtered out. */
  clusters: GraphCluster[];
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Priority → weight mapping. Clamped to [0, 1] so the renderer can use it
 * as a radius multiplier.
 */
function priorityWeight(p: Task['priority']): number {
  if (p === 'critical') return 1;
  if (p === 'high') return 0.8;
  if (p === 'medium') return 0.6;
  return 0.4;
}

/**
 * Convert `updatedAt` ISO timestamp → freshness in [0, 1]. Tasks touched
 * within an hour = 1; older than a week = 0; linear interpolation in
 * between. Missing timestamps resolve to 0.
 */
function computeFreshness(isoUpdatedAt: string | null | undefined, now = Date.now()): number {
  if (!isoUpdatedAt) return 0;
  const ts = Date.parse(isoUpdatedAt);
  if (!Number.isFinite(ts)) return 0;
  const ageMinutes = (now - ts) / 60_000;
  if (ageMinutes <= 60) return 1;
  const weekMinutes = 60 * 24 * 7;
  if (ageMinutes >= weekMinutes) return 0;
  return 1 - (ageMinutes - 60) / (weekMinutes - 60);
}

/**
 * Parse the free-form `blockedBy` field (JSON array or CSV) into a clean
 * list of blocker task ids. Never throws — invalid inputs yield `[]`.
 *
 * @param raw - Raw `task.blockedBy` string.
 * @returns Deduplicated id list.
 */
export function parseBlockedBy(raw: string | undefined | null): string[] {
  if (!raw) return [];
  const trimmed = raw.trim();
  if (trimmed.length === 0) return [];

  // JSON first — tolerant.
  if (trimmed.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        const ids = parsed.filter((x): x is string => typeof x === 'string');
        return [...new Set(ids.map((s) => s.trim()).filter((s) => s.length > 0))];
      }
    } catch {
      // fall through to CSV
    }
  }

  // CSV fallback.
  return [
    ...new Set(
      trimmed
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    ),
  ];
}

/**
 * Walk `parentId` pointers to find the top-level ancestor epic id.
 *
 * - If `task.type === 'epic'` and it has no epic parent, returns
 *   `task.id`.
 * - If an ancestor of type `epic` exists, returns the OUTERMOST one.
 * - If no ancestor is an epic, returns `null`.
 *
 * @param task - The candidate task.
 * @param byId - Id → Task lookup built once by the caller.
 * @returns Root-epic id or `null`.
 */
export function findRootEpicId(task: Task, byId: ReadonlyMap<string, Task>): string | null {
  const seen = new Set<string>();
  let lastEpic: string | null = task.type === 'epic' ? task.id : null;
  let cursor: Task | undefined = task;

  while (cursor) {
    if (seen.has(cursor.id)) break; // guard: cycle protection
    seen.add(cursor.id);
    if (cursor.type === 'epic') lastEpic = cursor.id;
    if (!cursor.parentId) break;
    cursor = byId.get(cursor.parentId);
  }
  return lastEpic;
}

/**
 * Project a `Task` into a {@link GraphNode}. The node kind = task type
 * (or `'task'` when the type is missing), category = root epic id.
 *
 * @param task - Input task.
 * @param rootEpicId - Pre-resolved root epic id, or `null`.
 * @returns Graph node with substrate = `'tasks'`.
 */
function toGraphNode(task: Task, rootEpicId: string | null): GraphNode {
  return {
    id: task.id,
    substrate: 'tasks',
    kind: task.type ?? 'task',
    label: task.title,
    category: rootEpicId,
    weight: priorityWeight(task.priority),
    freshness: computeFreshness(task.updatedAt ?? task.createdAt ?? null),
    meta: {
      status: task.status,
      priority: task.priority,
      parentId: task.parentId ?? null,
      updatedAt: task.updatedAt ?? null,
    },
  };
}

/**
 * Build the deterministic edge id. Including the kind lets `parent` and
 * `depends` edges coexist between the same two endpoints without
 * colliding.
 */
function edgeId(source: string, target: string, kind: EdgeKind): string {
  return `${source}->${target}:${kind}`;
}

// ---------------------------------------------------------------------------
// Public: tasks → graph projection
// ---------------------------------------------------------------------------

/**
 * Main entry point — project a Task bundle into the shared graph kit
 * shape.
 *
 * Behaviours:
 *
 * 1. Tasks are de-duplicated by id. First occurrence wins.
 * 2. `opts.epicScope` filters to the subtree rooted at the id. When
 *    omitted the full bundle projects.
 * 3. `includeCancelled=false` (default) hides cancelled epics. Cancelled
 *    tasks/subtasks continue to project with a muted palette.
 * 4. `includeArchived=false` (default) hides archived tasks.
 * 5. Clusters are one per root epic id, filtered to groups of ≥ 3
 *    members so isolated subtrees do not clutter the backdrop layer.
 *
 * @param tasks - All tasks from the loader bundle.
 * @param deps  - All dependency edges from the loader bundle.
 * @param opts  - Optional scope / filter flags.
 * @returns Projected nodes / edges / clusters.
 */
export function tasksToGraph(
  tasks: readonly Task[],
  deps: readonly TaskDependencyEdge[],
  opts: TasksToGraphOpts = {},
): TasksToGraphResult {
  const includeCancelled = opts.includeCancelled ?? false;
  const includeArchived = opts.includeArchived ?? false;

  // 1. De-dupe + index.
  const byId = new Map<string, Task>();
  for (const t of tasks) {
    if (!byId.has(t.id)) byId.set(t.id, t);
  }

  // 2. Apply scope + cancel/archive filters. Subtree walk is O(n) via
  //    ancestor lookups keyed on the already-built id map.
  const inScope = new Set<string>();
  const scopeRoot = opts.epicScope ?? null;

  function isInScope(task: Task): boolean {
    if (!scopeRoot) return true;
    let cursor: Task | undefined = task;
    const seen = new Set<string>();
    while (cursor) {
      if (seen.has(cursor.id)) return false;
      if (cursor.id === scopeRoot) return true;
      seen.add(cursor.id);
      if (!cursor.parentId) return false;
      cursor = byId.get(cursor.parentId);
    }
    return false;
  }

  for (const task of byId.values()) {
    if (!includeArchived && task.status === 'archived') continue;
    if (!includeCancelled && task.type === 'epic' && task.status === 'cancelled') continue;
    if (!isInScope(task)) continue;
    inScope.add(task.id);
  }

  // 3. Project nodes (stable order = input order of first occurrence).
  //    Precompute the "blocked halo" flag: a pending task whose inbound
  //    blockers (from `blockedBy` or `deps`) have not all completed.
  const incomingBlockers = new Map<string, string[]>();
  for (const task of byId.values()) {
    const ids = parseBlockedBy(task.blockedBy);
    if (ids.length > 0) incomingBlockers.set(task.id, ids);
  }
  for (const d of deps) {
    const list = incomingBlockers.get(d.taskId) ?? [];
    if (!list.includes(d.dependsOn)) list.push(d.dependsOn);
    incomingBlockers.set(d.taskId, list);
  }

  const nodes: GraphNode[] = [];
  const rootEpicByTask = new Map<string, string | null>();
  for (const task of byId.values()) {
    if (!inScope.has(task.id)) continue;
    const rootEpic = findRootEpicId(task, byId);
    rootEpicByTask.set(task.id, rootEpic);
    const projected = toGraphNode(task, rootEpic);
    // Attach halo flag when the task is pending and at least one blocker is not done.
    if (task.status === 'pending') {
      const blockers = incomingBlockers.get(task.id) ?? [];
      const stillBlocked = blockers.some((bid) => {
        const blocker = byId.get(bid);
        return blocker ? blocker.status !== 'done' : false;
      });
      if (stillBlocked) {
        projected.meta = { ...projected.meta, blocked: true };
      }
    }
    nodes.push(projected);
  }

  // 4. Project edges. Parent first (z-order), then blocks, then depends.
  const parentEdges: GraphEdge[] = [];
  const blocksEdges: GraphEdge[] = [];
  const dependsEdges: GraphEdge[] = [];

  for (const task of byId.values()) {
    if (!inScope.has(task.id)) continue;

    if (task.parentId && inScope.has(task.parentId)) {
      parentEdges.push({
        id: edgeId(task.parentId, task.id, 'parent'),
        source: task.parentId,
        target: task.id,
        kind: 'parent',
        weight: 1,
        directional: false,
      });
    }

    for (const blockerId of parseBlockedBy(task.blockedBy)) {
      if (inScope.has(blockerId)) {
        blocksEdges.push({
          id: edgeId(blockerId, task.id, 'blocks'),
          source: blockerId,
          target: task.id,
          kind: 'blocks',
          weight: 0.8,
          directional: true,
        });
      }
    }
  }

  for (const d of deps) {
    if (inScope.has(d.taskId) && inScope.has(d.dependsOn)) {
      dependsEdges.push({
        id: edgeId(d.dependsOn, d.taskId, 'depends'),
        source: d.dependsOn,
        target: d.taskId,
        kind: 'depends',
        weight: 0.7,
        directional: true,
      });
    }
  }

  const edges: GraphEdge[] = [...parentEdges, ...blocksEdges, ...dependsEdges];

  // 5. Clusters (one per root epic, minimum 3 members).
  const byEpic = new Map<string, string[]>();
  for (const node of nodes) {
    const epicId = node.category;
    if (!epicId) continue;
    const list = byEpic.get(epicId);
    if (list) {
      list.push(node.id);
    } else {
      byEpic.set(epicId, [node.id]);
    }
  }

  const clusters: GraphCluster[] = [];
  for (const [epicId, memberIds] of byEpic.entries()) {
    if (memberIds.length < 3) continue;
    const epicTask = byId.get(epicId);
    clusters.push({
      id: epicId,
      label: epicTask ? `${epicId}: ${epicTask.title}` : epicId,
      substrate: 'tasks',
      memberIds,
    });
  }

  return { nodes, edges, clusters };
}

// ---------------------------------------------------------------------------
// Secondary projection: ego / focal-task graph (for TaskDepGraph)
// ---------------------------------------------------------------------------

/**
 * Options for {@link tasksToEgoGraph}.
 */
export interface TasksToEgoGraphOpts {
  /** Focal task id — the ego of the projection. */
  focusId: string;
  /** How many upstream hops to include. Default 1. */
  upstream?: number;
  /** How many downstream hops to include. Default 1. */
  downstream?: number;
  /** When true, include parent + sibling edges. Default true. */
  includeParent?: boolean;
}

/**
 * Project a focal task's 1-hop (or deeper) neighbourhood into the kit
 * shape. Used by {@link TaskDepGraph} on `/tasks/[id]`.
 *
 * @param tasks - All tasks.
 * @param deps  - All dependency edges.
 * @param opts  - Focus id + depth knobs.
 * @returns Projected nodes / edges / clusters (clusters always empty for
 *   ego graphs — the focal node is the visual anchor).
 */
export function tasksToEgoGraph(
  tasks: readonly Task[],
  deps: readonly TaskDependencyEdge[],
  opts: TasksToEgoGraphOpts,
): TasksToGraphResult {
  const upHops = Math.max(0, opts.upstream ?? 1);
  const downHops = Math.max(0, opts.downstream ?? 1);
  const includeParent = opts.includeParent ?? true;

  const byId = new Map<string, Task>();
  for (const t of tasks) {
    if (!byId.has(t.id)) byId.set(t.id, t);
  }
  const focal = byId.get(opts.focusId);
  if (!focal) return { nodes: [], edges: [], clusters: [] };

  // Build undirected adjacency sets for BFS.
  const upstreamOf = new Map<string, Set<string>>();
  const downstreamOf = new Map<string, Set<string>>();

  const addEdge = (src: string, tgt: string): void => {
    let s = downstreamOf.get(src);
    if (!s) {
      s = new Set<string>();
      downstreamOf.set(src, s);
    }
    s.add(tgt);
    let t = upstreamOf.get(tgt);
    if (!t) {
      t = new Set<string>();
      upstreamOf.set(tgt, t);
    }
    t.add(src);
  };

  for (const task of byId.values()) {
    for (const blockerId of parseBlockedBy(task.blockedBy)) {
      addEdge(blockerId, task.id);
    }
  }
  for (const d of deps) {
    addEdge(d.dependsOn, d.taskId);
  }

  const keep = new Set<string>([focal.id]);

  // Upstream BFS.
  let frontier: string[] = [focal.id];
  for (let hop = 0; hop < upHops; hop += 1) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const up of upstreamOf.get(id) ?? []) {
        if (!keep.has(up)) {
          keep.add(up);
          next.push(up);
        }
      }
    }
    frontier = next;
  }

  // Downstream BFS.
  frontier = [focal.id];
  for (let hop = 0; hop < downHops; hop += 1) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const down of downstreamOf.get(id) ?? []) {
        if (!keep.has(down)) {
          keep.add(down);
          next.push(down);
        }
      }
    }
    frontier = next;
  }

  // Optional parent — one hop above the focal.
  if (includeParent && focal.parentId && byId.has(focal.parentId)) {
    keep.add(focal.parentId);
  }

  // Project.
  const nodes: GraphNode[] = [];
  for (const id of keep) {
    const task = byId.get(id);
    if (!task) continue;
    const rootEpic = findRootEpicId(task, byId);
    const projected = toGraphNode(task, rootEpic);
    // Mark the ego node so renderers can style it.
    projected.meta = { ...projected.meta, focal: id === focal.id };
    nodes.push(projected);
  }

  const edges: GraphEdge[] = [];

  if (includeParent && focal.parentId && keep.has(focal.parentId)) {
    edges.push({
      id: edgeId(focal.parentId, focal.id, 'parent'),
      source: focal.parentId,
      target: focal.id,
      kind: 'parent',
      weight: 1,
      directional: false,
    });
  }

  for (const task of byId.values()) {
    if (!keep.has(task.id)) continue;
    for (const blockerId of parseBlockedBy(task.blockedBy)) {
      if (keep.has(blockerId)) {
        edges.push({
          id: edgeId(blockerId, task.id, 'blocks'),
          source: blockerId,
          target: task.id,
          kind: 'blocks',
          weight: 0.8,
          directional: true,
        });
      }
    }
  }
  for (const d of deps) {
    if (keep.has(d.taskId) && keep.has(d.dependsOn)) {
      edges.push({
        id: edgeId(d.dependsOn, d.taskId, 'depends'),
        source: d.dependsOn,
        target: d.taskId,
        kind: 'depends',
        weight: 0.7,
        directional: true,
      });
    }
  }

  return { nodes, edges, clusters: [] };
}
