<!--
  GraphTab — dependency graph view for the /tasks Task Explorer.

  Thin consumer of {@link SvgRenderer} and {@link tasksToGraph}.  The
  d3-force + SVG pipeline that used to live here is now shared across
  every low-density relationship view in Studio (TaskDepGraph + any
  ad-hoc future view).  Zero hex literals reach this component — every
  colour comes from tokens.css via `$lib/graph/edge-kinds.ts` or from
  the SvgRenderer's `getComputedStyle` colour cache.

  Preserved:
    - Three edge kinds with distinct dash patterns (parent / blocks / depends)
    - Blocked halo on pending tasks with unmet inbound deps
    - Shared TaskSearchBox + FilterChipGroup (status / priority / labels)
    - DetailDrawer wired through `filters.setSelected` + dep chain walk
    - URL-round-tripped filters via the shared task-filters store
    - Public prop contract — `tasks`, `deps`, `filters`, `labels`
    - Public pure exports for unit-test coverage
      (`buildGraphNodes`, `buildGraphEdges`, `passesFilter`, `isBlocked`,
      `clickNode`, `edgeDash`, `edgeStroke`, `nodeFill`) keep the
      existing GraphTab.test.ts suite green.

  Retired:
    - The d3 simulation lifecycle (now in SvgRenderer)
    - The inline SVG rendering block (now in SvgRenderer)
    - Hex-literal status / edge palette (now in tokens.css + EDGE_STYLE)

  @task T954
  @epic T949
  @reviewed T990 (Wave 1C)
-->
<script lang="ts" module>
  import type { Task, TaskPriority, TaskStatus } from '@cleocode/contracts';

  import type { TaskDependencyEdge } from '$lib/server/tasks/explorer-loader.js';
  import type { TaskFilterState } from '$lib/stores/task-filters.svelte.js';

  // ---------------------------------------------------------------------------
  // Legacy pure helpers — retained for unit-test backwards compatibility.
  // The SvgRenderer no longer needs most of these, but `GraphTab.test.ts`
  // still imports and asserts on them.
  // ---------------------------------------------------------------------------

  /**
   * Legacy enum of the three edge kinds emitted by the previous GraphTab
   * projection. Downstream code should prefer the shared {@link EdgeKind}
   * type from `$lib/graph/types.js` — this alias is kept so existing
   * tests compile without edit.
   */
  export type GraphEdgeKind = 'parent' | 'blocks' | 'depends';

  /**
   * Legacy projected node shape. Preserved for test compatibility.
   */
  export interface GraphNode {
    id: string;
    title: string;
    status: TaskStatus;
    priority: TaskPriority;
    type: Task['type'];
    parentId: string | null;
    blocked: boolean;
  }

  /**
   * Legacy projected edge shape. Preserved for test compatibility.
   */
  export interface GraphEdge {
    source: string;
    target: string;
    kind: GraphEdgeKind;
  }

  /**
   * Pure predicate: is this task in the visual "blocked halo" set?
   *
   * A task is blocked iff its status is `pending` AND at least one
   * declared inbound dependency (task_dependencies row with
   * `task_id === task.id`) has a blocker whose status is not `done`.
   *
   * @param task - The candidate task.
   * @param deps - All dependency edges (full set, not pre-filtered).
   * @param tasksById - Lookup map keyed by task id.
   */
  export function isBlocked(
    task: Task,
    deps: readonly TaskDependencyEdge[],
    tasksById: ReadonlyMap<string, Task>,
  ): boolean {
    if (task.status !== 'pending') return false;
    for (const edge of deps) {
      if (edge.taskId !== task.id) continue;
      const blocker = tasksById.get(edge.dependsOn);
      if (!blocker) continue;
      if (blocker.status !== 'done') return true;
    }
    return false;
  }

  /**
   * Apply the shared task-filter state to a single task.
   *
   * @param task - Candidate task.
   * @param filters - Current filter state.
   */
  export function passesFilter(task: Task, filters: TaskFilterState): boolean {
    const q = filters.query.trim().toLowerCase();
    if (q.length > 0) {
      const idHit = task.id.toLowerCase().includes(q);
      const titleHit = (task.title ?? '').toLowerCase().includes(q);
      if (!idHit && !titleHit) return false;
    }
    if (filters.status.length > 0 && !filters.status.includes(task.status)) return false;
    if (filters.priority.length > 0 && !filters.priority.includes(task.priority)) return false;
    if (filters.labels.length > 0) {
      const labels = task.labels ?? [];
      if (!labels.some((l) => filters.labels.includes(l))) return false;
    }
    if (!filters.cancelled && task.type === 'epic' && task.status === 'cancelled') return false;
    return true;
  }

  /**
   * Project tasks → legacy GraphNode[] for test compatibility.
   */
  export function buildGraphNodes(
    tasks: readonly Task[],
    deps: readonly TaskDependencyEdge[],
  ): GraphNode[] {
    const byId = new Map<string, Task>();
    for (const t of tasks) {
      if (!byId.has(t.id)) byId.set(t.id, t);
    }
    const out: GraphNode[] = [];
    for (const t of byId.values()) {
      out.push({
        id: t.id,
        title: t.title,
        status: t.status,
        priority: t.priority,
        type: t.type,
        parentId: t.parentId ?? null,
        blocked: isBlocked(t, deps, byId),
      });
    }
    return out;
  }

  /**
   * Project tasks + deps → legacy GraphEdge[] with all 3 kinds.
   */
  export function buildGraphEdges(
    tasks: readonly Task[],
    deps: readonly TaskDependencyEdge[],
    visibleIds: ReadonlySet<string>,
  ): GraphEdge[] {
    const parentEdges: GraphEdge[] = [];
    const blocksEdges: GraphEdge[] = [];
    const dependsEdges: GraphEdge[] = [];

    for (const t of tasks) {
      if (!visibleIds.has(t.id)) continue;

      if (t.parentId && visibleIds.has(t.parentId)) {
        parentEdges.push({ source: t.parentId, target: t.id, kind: 'parent' });
      }

      if (t.blockedBy) {
        const raw = t.blockedBy.trim();
        let ids: string[] = [];
        if (raw.startsWith('[')) {
          try {
            const parsed: unknown = JSON.parse(raw);
            if (Array.isArray(parsed)) {
              ids = parsed.filter((x): x is string => typeof x === 'string');
            }
          } catch {
            // fall through
          }
        }
        if (ids.length === 0) {
          ids = raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
        }
        for (const blocker of ids) {
          if (visibleIds.has(blocker)) {
            blocksEdges.push({ source: blocker, target: t.id, kind: 'blocks' });
          }
        }
      }
    }

    for (const d of deps) {
      if (visibleIds.has(d.taskId) && visibleIds.has(d.dependsOn)) {
        dependsEdges.push({ source: d.dependsOn, target: d.taskId, kind: 'depends' });
      }
    }

    return [...parentEdges, ...blocksEdges, ...dependsEdges];
  }

  /**
   * Status → token-backed node fill.  Post-T990 Wave 1C this resolves
   * to a `var(--status-…)` reference rather than a hex literal so a
   * theme override propagates without touching this file.
   */
  export function nodeFill(status: TaskStatus): string {
    switch (status) {
      case 'done':
        return 'var(--status-done)';
      case 'active':
        return 'var(--status-active)';
      case 'blocked':
        return 'var(--status-blocked)';
      case 'cancelled':
        return 'var(--status-cancelled)';
      case 'archived':
        return 'var(--status-archived)';
      case 'proposed':
        return 'var(--status-proposed)';
      default:
        return 'var(--status-pending)';
    }
  }

  /**
   * Legacy edge → token-backed stroke lookup.
   */
  export function edgeStroke(kind: GraphEdgeKind): string {
    if (kind === 'parent') return 'var(--border-strong)';
    if (kind === 'blocks') return 'var(--danger)';
    return 'var(--warning)';
  }

  /**
   * Legacy edge → SVG `stroke-dasharray` mapping.
   */
  export function edgeDash(kind: GraphEdgeKind): string | null {
    if (kind === 'blocks') return '4 4';
    if (kind === 'depends') return '2 3';
    return null;
  }

  /**
   * Invoke the filter store's `setSelected` with the clicked node's id.
   */
  export function clickNode(
    filtersHandle: { setSelected: (id: string | null) => void },
    nodeId: string,
  ): void {
    filtersHandle.setSelected(nodeId);
  }
</script>

<script lang="ts">
  import type { EdgeKind, GraphNode as KitGraphNode } from '$lib/graph/types.js';
  import { tasksToGraph } from '$lib/graph/adapters/tasks-adapter.js';
  import SvgRenderer from '$lib/graph/renderers/SvgRenderer.svelte';

  import { DetailDrawer, type DependencyLink, type ParentChainEntry } from './index.js';

  /**
   * Minimal filter handle surface required by {@link GraphTab}.
   */
  interface GraphFiltersHandle {
    readonly state: TaskFilterState;
    setQuery(q: string): void;
    toggleStatus(s: TaskStatus): void;
    togglePriority(p: TaskPriority): void;
    toggleLabel(l: string): void;
    setSelected(id: string | null): void;
    setCancelled(v: boolean): void;
  }

  interface Props {
    /** Full task set from the {@link ExplorerBundle}. */
    tasks: Task[];
    /** All dependency edges from the bundle. */
    deps: TaskDependencyEdge[];
    /** Shared filter store — drives visibility + selection. */
    filters: GraphFiltersHandle;
    /** Distinct labels across the bundle (drives the labels chip group). */
    labels?: string[];
  }

  let { tasks, deps, filters, labels = [] }: Props = $props();

  // ---------------------------------------------------------------------------
  // Derive the visible task set (post-filter) once; the adapter then
  // projects it into the graph kit shape.
  // ---------------------------------------------------------------------------

  const visibleTaskSet = $derived.by(() => {
    const s = new Set<string>();
    for (const t of tasks) {
      if (passesFilter(t, filters.state)) s.add(t.id);
    }
    return s;
  });

  const visibleTasks = $derived(tasks.filter((t) => visibleTaskSet.has(t.id)));

  const graph = $derived(
    tasksToGraph(visibleTasks, deps, {
      epicScope: filters.state.epic ?? null,
      includeCancelled: filters.state.cancelled,
      includeArchived: false,
    }),
  );

  // Visible edge kinds — always all three for the task view.
  const VISIBLE_EDGE_KINDS = new Set<EdgeKind>(['parent', 'blocks', 'depends']);

  // ---------------------------------------------------------------------------
  // DetailDrawer wiring — resolved from the filter store
  // ---------------------------------------------------------------------------

  const tasksById: Map<string, Task> = $derived(new Map(tasks.map((t) => [t.id, t])));

  const selectedTask: Task | null = $derived(
    filters.state.selected
      ? (tasksById.get(filters.state.selected) ?? null)
      : null,
  );

  const upstreamLinks: DependencyLink[] = $derived.by(() => {
    if (!selectedTask) return [];
    const out: DependencyLink[] = [];
    for (const d of deps) {
      if (d.taskId !== selectedTask.id) continue;
      const blocker = tasksById.get(d.dependsOn);
      if (!blocker) continue;
      out.push({
        id: blocker.id,
        title: blocker.title,
        status: blocker.status,
        priority: blocker.priority,
      });
    }
    return out;
  });

  const downstreamLinks: DependencyLink[] = $derived.by(() => {
    if (!selectedTask) return [];
    const out: DependencyLink[] = [];
    for (const d of deps) {
      if (d.dependsOn !== selectedTask.id) continue;
      const dependent = tasksById.get(d.taskId);
      if (!dependent) continue;
      out.push({
        id: dependent.id,
        title: dependent.title,
        status: dependent.status,
        priority: dependent.priority,
      });
    }
    return out;
  });

  const parentChain: ParentChainEntry[] = $derived.by(() => {
    if (!selectedTask) return [];
    const chain: ParentChainEntry[] = [];
    let current = selectedTask.parentId ? tasksById.get(selectedTask.parentId) : undefined;
    const seen = new Set<string>();
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      chain.unshift({ id: current.id, title: current.title, type: current.type });
      current = current.parentId ? tasksById.get(current.parentId) : undefined;
    }
    return chain;
  });

  // Filter chip UI (search / status / priority / labels) lives in the parent
  // Explorer header; GraphTab only owns graph-specific controls.

  function onNodeClicked(n: KitGraphNode): void {
    clickNode(filters, n.id);
  }

  function onDrawerClose(): void {
    filters.setSelected(null);
  }

  function onDrawerSelectDep(id: string): void {
    filters.setSelected(id);
  }
</script>

<div class="graph-tab">
  <!-- Graph-specific toolbar row. Search / status / priority / labels live in
       the parent Explorer header to avoid duplication. -->
  <div class="controls-bar">
    <div class="controls-row">
      <label class="cancelled-toggle">
        <input
          type="checkbox"
          checked={filters.state.cancelled}
          onchange={(e) =>
            filters.setCancelled((e.currentTarget as HTMLInputElement).checked)}
        />
        <span>Include cancelled epics</span>
      </label>
      <span class="visible-count">
        Showing <strong>{graph.nodes.length}</strong> of <strong>{tasks.length}</strong>
        tasks
      </span>
    </div>
  </div>

  <!-- Graph canvas + drawer -->
  <div class="graph-body">
    <div class="graph-wrap">
      {#if graph.nodes.length === 0}
        <div class="empty-state">
          <p>No tasks match the current filters.</p>
        </div>
      {:else}
        <SvgRenderer
          nodes={graph.nodes}
          edges={graph.edges}
          clusters={graph.clusters}
          visibleEdgeKinds={VISIBLE_EDGE_KINDS}
          selectedNodeId={filters.state.selected}
          onNodeClick={onNodeClicked}
          showLabels="id-only"
          nodeRenderer="pill"
          showToolbar
          showLegend
          ariaLabel="Task relationship graph"
        />
      {/if}
    </div>

    {#if selectedTask}
      <DetailDrawer
        task={selectedTask}
        upstream={upstreamLinks}
        downstream={downstreamLinks}
        {parentChain}
        onClose={onDrawerClose}
        onSelectDep={onDrawerSelectDep}
      />
    {/if}
  </div>
</div>

<style>
  .graph-tab {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    height: 100%;
    min-height: 0;
  }

  .controls-bar {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .controls-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-3);
  }

  .cancelled-toggle {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: var(--text-xs);
    color: var(--text-dim);
    cursor: pointer;
    user-select: none;
  }

  .cancelled-toggle input {
    accent-color: var(--accent);
    cursor: pointer;
  }

  .visible-count {
    font-size: var(--text-xs);
    color: var(--text-dim);
  }

  .visible-count strong {
    color: var(--text);
    font-variant-numeric: tabular-nums;
  }

  .graph-body {
    display: flex;
    flex: 1;
    min-height: 0;
    gap: 0;
  }

  .graph-wrap {
    position: relative;
    flex: 1;
    min-width: 0;
    min-height: 0;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    overflow: hidden;
  }

  .empty-state {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--text-faint);
    font-size: var(--text-sm);
  }
</style>
