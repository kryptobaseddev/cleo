<!--
  WorkGraphView — the saga-scoped WORKGRAPH visualisation (T11791 →
  T11558 · E3-WORKGRAPH-VIEW).

  Renders ONE saga's epics / tasks / subtasks as a single relationship
  graph: **containment** (`parent` edges, solid) plus the **depends_on**
  (`depends`, dotted) and `blocks` (dashed) edges between them. It is a
  thin consumer of the SHARED graph kit — it builds NO new graph engine:

    - projection   → {@link tasksToGraph} (`$lib/graph/adapters/tasks-adapter`),
      scoped to the saga via `epicScope: sagaId` (the adapter's ancestor
      walk includes every descendant epic/task/subtask of the saga).
    - rendering    → {@link SvgRenderer} (`$lib/graph/renderers`), the same
      d3-force + SVG renderer GraphTab uses for ≤ 300-node relationship
      views. High-density live surfaces use CosmosRenderer; a workgraph is
      a low-density structural view so SVG is the right renderer.
    - drilldown    → click a node → the shared {@link DetailDrawer} (sibling
      to the Kanban dispatcher's drawer) with the task's parent chain +
      upstream / downstream dependency links.

  Zero hex literals reach this component — every colour comes from
  `tokens.css` via `$lib/graph/edge-kinds.ts` (edges) or the SvgRenderer's
  `getComputedStyle` status-token cache (nodes), so a `[data-theme]` switch
  (T11796) re-themes the whole graph for free.

  The component is presentational + pure-data: its `tasks` / `deps` come
  from the gateway-backed server load (`loadExplorerBundle`), never a
  direct DB read.

  @task T11791
  @task T11558
  @epic T11558
  @saga T11555
-->
<script lang="ts">
  import type { Task } from '@cleocode/contracts';
  import type { EdgeKind, GraphNode as KitGraphNode } from '$lib/graph/types.js';
  import { tasksToGraph } from '$lib/graph/adapters/tasks-adapter.js';
  import SvgRenderer from '$lib/graph/renderers/SvgRenderer.svelte';
  import {
    DetailDrawer,
    type DependencyLink,
    type ParentChainEntry,
  } from '$lib/components/tasks';
  import type { TaskDependencyEdge } from '$lib/server/tasks/explorer-loader.js';

  interface Props {
    /** Full task set (from the gateway-backed explorer bundle). */
    tasks: Task[];
    /** All dependency edges from the bundle. */
    deps: TaskDependencyEdge[];
    /**
     * The saga (or any ancestor) id to scope the graph to. Every descendant
     * epic / task / subtask is included via the adapter's ancestor walk.
     * When omitted the full bundle projects (parity with GraphTab).
     */
    sagaId?: string | null;
    /** Include cancelled epics in the projection. Default false. */
    includeCancelled?: boolean;
    /** Optional initially-selected node id (drives the drawer on mount). */
    selectedId?: string | null;
  }

  let {
    tasks,
    deps,
    sagaId = null,
    includeCancelled = false,
    selectedId = $bindable(null),
  }: Props = $props();

  // ---------------------------------------------------------------------------
  // Projection — the saga-scoped graph kit bundle.
  // ---------------------------------------------------------------------------

  const graph = $derived(
    tasksToGraph(tasks, deps, {
      epicScope: sagaId,
      includeCancelled,
      includeArchived: false,
    }),
  );

  /** Visible edge kinds — containment + both dependency families. */
  const VISIBLE_EDGE_KINDS = new Set<EdgeKind>(['parent', 'blocks', 'depends']);

  // ---------------------------------------------------------------------------
  // DetailDrawer wiring — resolved from the local selection.
  // ---------------------------------------------------------------------------

  const tasksById: Map<string, Task> = $derived(new Map(tasks.map((t) => [t.id, t])));

  const selectedTask: Task | null = $derived(
    selectedId ? (tasksById.get(selectedId) ?? null) : null,
  );

  /** Upstream dependency links: tasks the selected node depends on. */
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

  /** Downstream dependency links: tasks that depend on the selected node. */
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

  /** Containment chain: walk `parentId` up to (and including) the saga root. */
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

  function onNodeClicked(n: KitGraphNode): void {
    selectedId = n.id;
  }

  function onDrawerClose(): void {
    selectedId = null;
  }

  function onDrawerSelectDep(id: string): void {
    selectedId = id;
  }
</script>

<div class="workgraph-view">
  <div class="workgraph-meta">
    <span class="count">
      <strong>{graph.nodes.length}</strong> nodes ·
      <strong>{graph.edges.length}</strong> edges
      {#if sagaId}· scoped to <code>{sagaId}</code>{/if}
    </span>
    <span class="legend-hint">containment · depends · blocks</span>
  </div>

  <div class="workgraph-body">
    <div class="graph-wrap">
      {#if graph.nodes.length === 0}
        <div class="empty-state">
          <p>
            No tasks in this workgraph
            {#if sagaId}for <code>{sagaId}</code>{/if}.
          </p>
        </div>
      {:else}
        <SvgRenderer
          nodes={graph.nodes}
          edges={graph.edges}
          clusters={graph.clusters}
          visibleEdgeKinds={VISIBLE_EDGE_KINDS}
          selectedNodeId={selectedId}
          onNodeClick={onNodeClicked}
          showLabels="id-only"
          nodeRenderer="pill"
          showToolbar
          showLegend
          ariaLabel="Saga workgraph — containment and dependency edges"
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
  .workgraph-view {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    height: 100%;
    min-height: 0;
  }

  .workgraph-meta {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
  }

  .count {
    font-size: var(--text-xs);
    color: var(--text-dim);
  }

  .count strong {
    color: var(--text);
    font-variant-numeric: tabular-nums;
  }

  .count code {
    font-family: var(--font-mono);
    color: var(--accent);
    font-size: var(--text-2xs);
  }

  .legend-hint {
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    color: var(--text-faint);
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  .workgraph-body {
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

  .empty-state code {
    font-family: var(--font-mono);
    color: var(--text-dim);
  }
</style>
