/**
 * Pure helpers for the Task Explorer Hierarchy tab (T953).
 *
 * All tree construction, filtering, virtualization windowing, and dependency
 * counting logic is extracted here so it can be unit-tested in a plain Node
 * environment (the studio vitest harness runs `environment: 'node'`, no
 * jsdom). The companion `HierarchyTab.svelte` consumes this module and renders
 * the result with Svelte 5 runes.
 *
 * Spec reference: `docs/specs/CLEO-TASK-DASHBOARD-SPEC.md` §5.2.
 *
 * ## Modes
 *
 * The Hierarchy tab has two modes driven by
 * {@link import('../../stores/task-filters.svelte.js').TaskFilters.state.epic}:
 *
 * - **Global tree (`epic === null`)** — roots are every task where
 *   `parentId` is nullish OR points to a task that is missing / archived
 *   from the payload. Orphans are grouped under a synthetic `__unparented`
 *   pseudo-root so they remain visible (§5.2 "Unparented bucket").
 * - **Epic-scoped (`epic !== null`)** — only the subtree rooted at
 *   `filters.state.epic` is rendered (the descendant walk includes the epic
 *   itself as the tree root).
 *
 * ## Ordering
 *
 * Siblings are sorted by (`position ?? Number.MAX_SAFE_INTEGER`, `id`). This
 * matches the CLI `cleo list --parent` ordering and keeps tasks without an
 * explicit position at the tail in a stable, deterministic order.
 *
 * ## Virtualization
 *
 * The component renders only rows within a viewport window. Rather than
 * pulling in a new dependency, we flatten the visible tree to a 1-D array
 * and slice by index. {@link windowRows} returns `{ startIndex, visible }`
 * given `scrollTop`, `rowHeight`, and `viewportHeight`, with a configurable
 * `buffer` above/below.
 *
 * @task T953
 * @epic T949
 */

import type { Task } from '@cleocode/contracts';
import type { TaskDependencyEdge } from '../../server/tasks/explorer-loader.js';
import type { TaskFilterState } from '../../stores/task-filters.svelte.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Synthetic sentinel ID used for the "Unparented" pseudo-root bucket.
 *
 * Prefixed with `__` so it cannot collide with a real `T###` task ID. The UI
 * renders this row as a non-selectable grouping header.
 */
export const UNPARENTED_BUCKET_ID = '__unparented';

/**
 * A single node in the hierarchy tree.
 *
 * `depth` is zero-based from the rendered root (global mode treats every real
 * root as depth 0; epic-scoped mode treats the scoped epic as depth 0).
 */
export interface HierarchyNode {
  /** Task ID or {@link UNPARENTED_BUCKET_ID}. */
  id: string;
  /** Backing {@link Task} row, or `null` for the unparented bucket. */
  task: Task | null;
  /** Children in sibling-sorted order. */
  children: HierarchyNode[];
  /** Depth from the rendered root (0-based). */
  depth: number;
  /** Inbound dependency count — tasks that depend on this one. */
  depsIn: number;
  /** Outbound dependency count — tasks this one depends on. */
  depsOut: number;
}

/**
 * A flattened row of the expanded tree, produced by {@link flattenTree}.
 *
 * One entry per rendered row (collapsed subtrees are omitted). The flattened
 * shape drives virtualization and keyboard navigation.
 */
export interface FlatRow {
  /** Stable row key — the node's {@link HierarchyNode.id}. */
  id: string;
  /** Backing {@link Task} row, or `null` for the unparented bucket. */
  task: Task | null;
  /** Depth relative to the rendered root. */
  depth: number;
  /** Inbound dep count (unchanged from the source node). */
  depsIn: number;
  /** Outbound dep count (unchanged from the source node). */
  depsOut: number;
  /** Whether this row is an epic node (renders with progress summary). */
  isEpic: boolean;
  /** Whether this row has at least one child to expand. */
  hasChildren: boolean;
  /** Whether this row is currently expanded. */
  expanded: boolean;
  /**
   * Total count of descendants under this node (recursive), used for the
   * inline descendant-count chip in the UI.
   */
  descendantCount: number;
}

/**
 * Windowed slice of {@link FlatRow}s for virtualization.
 *
 * The component renders `visible` inside a container with a top spacer of
 * height `startIndex * rowHeight` and a bottom spacer completing the total
 * tree height. This preserves scrollbar fidelity while only mounting
 * `visible.length` DOM rows.
 */
export interface Window {
  /** Index in the full flattened list where the visible slice begins. */
  startIndex: number;
  /** The rows that should be rendered right now. */
  visible: FlatRow[];
  /** Total number of rows in the flattened tree (for the scrollbar). */
  totalRows: number;
}

// ---------------------------------------------------------------------------
// Dependency counts
// ---------------------------------------------------------------------------

/**
 * Bucketed dependency counts keyed by task ID.
 */
export interface DepCountMap {
  /** `taskId -> inboundDepCount` (tasks that depend on `taskId`). */
  in: Map<string, number>;
  /** `taskId -> outboundDepCount` (tasks `taskId` depends on). */
  out: Map<string, number>;
}

/**
 * Compute inbound/outbound dependency counts for every task ID that appears
 * in either endpoint of the given edge set.
 *
 * The convention (matching the `task_dependencies` SQLite table) is that
 * `taskId` depends on `dependsOn`:
 * - Inbound (`in`) count for task `X` = edges where `dependsOn === X`
 *   (X is a blocker — other tasks depend on it; displayed as `← N`).
 * - Outbound (`out`) count for task `X` = edges where `taskId === X`
 *   (X is blocked by others; displayed as `→ N`).
 *
 * @param deps - Dependency edges.
 * @returns {@link DepCountMap} with maps for inbound + outbound counts.
 */
export function computeDepCounts(deps: readonly TaskDependencyEdge[]): DepCountMap {
  const inCounts = new Map<string, number>();
  const outCounts = new Map<string, number>();
  for (const edge of deps) {
    outCounts.set(edge.taskId, (outCounts.get(edge.taskId) ?? 0) + 1);
    inCounts.set(edge.dependsOn, (inCounts.get(edge.dependsOn) ?? 0) + 1);
  }
  return { in: inCounts, out: outCounts };
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

/**
 * Apply the user's query / status / priority / label filters to a single task.
 *
 * Used to decide which nodes are "matched". Tree pruning keeps ancestors of
 * matched tasks so the tree remains navigable — see {@link pruneTree}.
 *
 * Matching rules (case-insensitive for query; exact for enums):
 * - If `query` is non-empty, `title.toLowerCase().includes(q)` OR
 *   `id.toLowerCase().includes(q)` must be true.
 * - If `status` list is non-empty, `task.status` must be in the list.
 * - If `priority` list is non-empty, `task.priority` must be in the list.
 * - If `labels` list is non-empty, at least one of `task.labels` must be in
 *   the list (ANY-match, not ALL).
 * - If `cancelled` is false, tasks with `status = 'cancelled'` are excluded
 *   unless they have `type !== 'epic'` (the toggle is per-§10 epic-scoped).
 *
 * @param task - The task to test.
 * @param filters - The active filter state.
 * @returns `true` if the task matches.
 */
export function matchesFilters(task: Task, filters: TaskFilterState): boolean {
  // Cancelled epics are hidden unless the toggle is on.
  if (!filters.cancelled && task.type === 'epic' && task.status === 'cancelled') {
    return false;
  }

  if (filters.status.length > 0 && !filters.status.includes(task.status)) {
    return false;
  }
  if (filters.priority.length > 0 && !filters.priority.includes(task.priority)) {
    return false;
  }
  if (filters.labels.length > 0) {
    const have = new Set(task.labels ?? []);
    let anyMatch = false;
    for (const wanted of filters.labels) {
      if (have.has(wanted)) {
        anyMatch = true;
        break;
      }
    }
    if (!anyMatch) return false;
  }

  if (filters.query.length > 0) {
    const q = filters.query.toLowerCase();
    const title = task.title.toLowerCase();
    const id = task.id.toLowerCase();
    if (!title.includes(q) && !id.includes(q)) {
      return false;
    }
  }

  return true;
}

// ---------------------------------------------------------------------------
// Tree construction
// ---------------------------------------------------------------------------

/**
 * Build the global hierarchy tree from a flat task list.
 *
 * - Roots are tasks with `parentId == null`.
 * - Tasks with a non-null `parentId` that does NOT appear in the payload
 *   (missing / archived parent) are classified as orphans and grouped under
 *   the {@link UNPARENTED_BUCKET_ID} pseudo-root.
 * - Siblings are sorted by (`position ?? MAX_SAFE_INTEGER`, `id`).
 *
 * @param tasks - All tasks to include.
 * @param depCounts - Precomputed dep counts from {@link computeDepCounts}.
 * @returns The synthetic root nodes (real roots first, then `__unparented`
 *   if it has any children).
 */
export function buildGlobalTree(tasks: readonly Task[], depCounts: DepCountMap): HierarchyNode[] {
  const byId = new Map<string, Task>();
  for (const t of tasks) byId.set(t.id, t);

  const childrenOf = new Map<string, Task[]>();
  const roots: Task[] = [];
  const orphans: Task[] = [];

  for (const t of tasks) {
    if (t.parentId === null || t.parentId === undefined) {
      roots.push(t);
      continue;
    }
    if (!byId.has(t.parentId)) {
      orphans.push(t);
      continue;
    }
    const list = childrenOf.get(t.parentId);
    if (list) list.push(t);
    else childrenOf.set(t.parentId, [t]);
  }

  sortSiblings(roots);
  sortSiblings(orphans);
  for (const list of childrenOf.values()) sortSiblings(list);

  const nodes: HierarchyNode[] = [];
  for (const root of roots) {
    nodes.push(buildNode(root, childrenOf, depCounts, 0));
  }
  if (orphans.length > 0) {
    const children: HierarchyNode[] = [];
    for (const orphan of orphans) {
      children.push(buildNode(orphan, childrenOf, depCounts, 1));
    }
    nodes.push({
      id: UNPARENTED_BUCKET_ID,
      task: null,
      children,
      depth: 0,
      depsIn: 0,
      depsOut: 0,
    });
  }
  return nodes;
}

/**
 * Build the epic-scoped subtree rooted at `epicId`.
 *
 * When the epic is missing from the payload (e.g. archived), returns an
 * empty array — the UI surfaces an empty state in that case.
 *
 * @param tasks - All tasks to include.
 * @param depCounts - Precomputed dep counts from {@link computeDepCounts}.
 * @param epicId - The root epic's task ID.
 * @returns A single-element array containing the epic's subtree, or `[]`.
 */
export function buildEpicSubtree(
  tasks: readonly Task[],
  depCounts: DepCountMap,
  epicId: string,
): HierarchyNode[] {
  const byId = new Map<string, Task>();
  for (const t of tasks) byId.set(t.id, t);

  const epic = byId.get(epicId);
  if (!epic) return [];

  const childrenOf = new Map<string, Task[]>();
  for (const t of tasks) {
    if (t.parentId === null || t.parentId === undefined) continue;
    const list = childrenOf.get(t.parentId);
    if (list) list.push(t);
    else childrenOf.set(t.parentId, [t]);
  }
  for (const list of childrenOf.values()) sortSiblings(list);

  return [buildNode(epic, childrenOf, depCounts, 0)];
}

/**
 * Recursive tree node factory — internal helper.
 */
function buildNode(
  task: Task,
  childrenOf: Map<string, Task[]>,
  depCounts: DepCountMap,
  depth: number,
): HierarchyNode {
  const kids = childrenOf.get(task.id) ?? [];
  const children: HierarchyNode[] = [];
  for (const kid of kids) {
    children.push(buildNode(kid, childrenOf, depCounts, depth + 1));
  }
  return {
    id: task.id,
    task,
    children,
    depth,
    depsIn: depCounts.in.get(task.id) ?? 0,
    depsOut: depCounts.out.get(task.id) ?? 0,
  };
}

/**
 * Sort an array of tasks by (`position ?? MAX_SAFE_INTEGER`, `id`) in place.
 *
 * Matches `cleo list --parent` ordering.
 */
function sortSiblings(tasks: Task[]): void {
  tasks.sort((a, b) => {
    const pa = a.position ?? Number.MAX_SAFE_INTEGER;
    const pb = b.position ?? Number.MAX_SAFE_INTEGER;
    if (pa !== pb) return pa - pb;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

// ---------------------------------------------------------------------------
// Filter pruning
// ---------------------------------------------------------------------------

/**
 * Prune a tree so that only nodes whose {@link Task} matches the filters
 * — AND any ancestor of such a node — remain.
 *
 * This keeps the tree visually navigable when a filter narrows the matches:
 * matched rows retain their parent chain so the user can see context.
 *
 * The unparented pseudo-root is preserved iff at least one orphan passes
 * the filter.
 *
 * @param nodes - The tree roots to prune.
 * @param filters - Active filter state.
 * @returns Pruned tree (new array; input is not mutated).
 */
export function pruneTree(
  nodes: readonly HierarchyNode[],
  filters: TaskFilterState,
): HierarchyNode[] {
  const out: HierarchyNode[] = [];
  for (const node of nodes) {
    const kept = pruneNode(node, filters);
    if (kept) out.push(kept);
  }
  return out;
}

/**
 * Recursive node pruner — returns a filtered clone, or `null` if neither the
 * node nor any descendant matches.
 */
function pruneNode(node: HierarchyNode, filters: TaskFilterState): HierarchyNode | null {
  const keptChildren: HierarchyNode[] = [];
  for (const child of node.children) {
    const kept = pruneNode(child, filters);
    if (kept) keptChildren.push(kept);
  }

  // Unparented pseudo-root: keep only if any orphan survives pruning.
  if (node.task === null) {
    if (keptChildren.length === 0) return null;
    return { ...node, children: keptChildren };
  }

  const selfMatches = matchesFilters(node.task, filters);
  if (!selfMatches && keptChildren.length === 0) {
    return null;
  }
  return { ...node, children: keptChildren };
}

// ---------------------------------------------------------------------------
// Flattening
// ---------------------------------------------------------------------------

/**
 * Flatten an expanded tree into an array of {@link FlatRow}s for rendering.
 *
 * Only rows whose ancestors are all in `expandedIds` appear in the output
 * (collapsed subtrees are omitted). The root nodes themselves are always
 * included (their `id` being absent from `expandedIds` only omits THEIR
 * children, not the root itself).
 *
 * @param roots - The pruned tree roots.
 * @param expandedIds - Set of node IDs whose children should be visible.
 * @returns Flattened rows in depth-first pre-order, suitable for slicing.
 */
export function flattenTree(
  roots: readonly HierarchyNode[],
  expandedIds: ReadonlySet<string>,
): FlatRow[] {
  const out: FlatRow[] = [];

  function descendantCount(node: HierarchyNode): number {
    let count = 0;
    for (const child of node.children) {
      count += 1 + descendantCount(child);
    }
    return count;
  }

  function walk(node: HierarchyNode): void {
    const hasChildren = node.children.length > 0;
    const expanded = expandedIds.has(node.id);
    const isEpic = node.task?.type === 'epic';
    const descendants = descendantCount(node);

    out.push({
      id: node.id,
      task: node.task,
      depth: node.depth,
      depsIn: node.depsIn,
      depsOut: node.depsOut,
      isEpic,
      hasChildren,
      expanded,
      descendantCount: descendants,
    });

    if (hasChildren && expanded) {
      for (const child of node.children) {
        walk(child);
      }
    }
  }

  for (const root of roots) {
    walk(root);
  }
  return out;
}

/**
 * Collect every node ID in the tree (recursive). Used to implement "Expand
 * all" by producing the universal expanded-set.
 *
 * @param roots - Tree roots.
 * @returns Set of every node ID across every depth.
 */
export function collectAllIds(roots: readonly HierarchyNode[]): Set<string> {
  const out = new Set<string>();
  function walk(node: HierarchyNode): void {
    out.add(node.id);
    for (const child of node.children) walk(child);
  }
  for (const r of roots) walk(r);
  return out;
}

// ---------------------------------------------------------------------------
// Virtualization windowing
// ---------------------------------------------------------------------------

/**
 * Options for {@link windowRows}.
 */
export interface WindowOptions {
  /** Current scroll-top of the virtualization container (px). */
  scrollTop: number;
  /** Visible viewport height (px). */
  viewportHeight: number;
  /** Fixed row height (px). */
  rowHeight: number;
  /**
   * Extra rows to render above/below the viewport to smooth scrolling.
   * Matches the spec's ~50-row buffer guidance. @defaultValue 50
   */
  buffer?: number;
}

/**
 * Compute the windowed slice of flat rows to render for virtualization.
 *
 * Only rows intersecting the viewport (plus a `buffer` of rows above and
 * below) are returned. Callers spread a top spacer of `startIndex *
 * rowHeight` and a bottom spacer covering the remainder.
 *
 * ## Threshold
 *
 * The Hierarchy tab skips virtualization entirely when the total row count
 * is below a small threshold (~200) — callers can detect this via the spec
 * recommendation and render without spacers. {@link windowRows} still
 * returns a correct `{ startIndex: 0, visible: rows }` slice in that case.
 *
 * @param rows - Full flattened tree.
 * @param opts - Viewport parameters.
 * @returns {@link Window} slice.
 */
export function windowRows(rows: readonly FlatRow[], opts: WindowOptions): Window {
  const { scrollTop, viewportHeight, rowHeight } = opts;
  const buffer = opts.buffer ?? 50;
  const totalRows = rows.length;

  if (totalRows === 0) {
    return { startIndex: 0, visible: [], totalRows: 0 };
  }
  if (rowHeight <= 0 || viewportHeight <= 0) {
    return { startIndex: 0, visible: rows.slice(), totalRows };
  }

  const firstVisible = Math.floor(scrollTop / rowHeight);
  const viewportRows = Math.ceil(viewportHeight / rowHeight);

  const startIndex = Math.max(0, firstVisible - buffer);
  const endIndex = Math.min(totalRows, firstVisible + viewportRows + buffer);
  return {
    startIndex,
    visible: rows.slice(startIndex, endIndex),
    totalRows,
  };
}
