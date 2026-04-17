<!--
  Tasks Relations Graph — 2D force-directed SVG rendering.

  Displays the tasks hierarchy (EPIC → TASK → SUBTASK) plus overlay edges
  for `blocked_by` and `depends`. Uses d3-force (already in studio's deps
  tree via d3 ^7.9.0) for layout but renders SVG directly to keep the
  bundle small and navigation snappy.

  Click a node → navigate to /tasks/{id}.
  Toggle archived / focus-on-epic via URL query params (SSR-preserved).

  @task T879
  @epic T876 (owner-labelled T900)
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/stores';
  import * as d3 from 'd3';
  import type { PageData } from './$types';
  import type { GraphNode, GraphEdge } from './+page.server.js';

  interface Props {
    data: PageData;
  }
  let { data }: Props = $props();

  const nodes: GraphNode[] = data.graph?.nodes ?? [];
  const edges: GraphEdge[] = data.graph?.edges ?? [];
  const counts = data.graph?.counts ?? { nodes: 0, parentEdges: 0, blocksEdges: 0, dependsEdges: 0 };
  const filters = data.graph?.filters ?? { showArchived: false, epic: null };

  let svgEl: SVGSVGElement | null = $state(null);
  let hoverId: string | null = $state(null);

  // ---------------------------------------------------------------------------
  // Visual encoding
  // ---------------------------------------------------------------------------
  function nodeFill(n: GraphNode): string {
    if (n.status === 'done') return '#22c55e';
    if (n.status === 'cancelled') return '#64748b';
    if (n.status === 'archived') return '#475569';
    if (n.status === 'active') return '#3b82f6';
    return '#a855f7';
  }
  function nodeStroke(n: GraphNode): string {
    if (n.type === 'epic') return '#fbbf24';
    if (n.type === 'subtask') return '#94a3b8';
    return '#2d3748';
  }
  function nodeRadius(n: GraphNode): number {
    if (n.type === 'epic') return 12;
    if (n.type === 'subtask') return 6;
    return 8;
  }
  function edgeStroke(e: GraphEdge): string {
    if (e.kind === 'parent') return '#334155';
    if (e.kind === 'blocks') return '#ef4444';
    return '#f59e0b';
  }
  function edgeDash(e: GraphEdge): string | null {
    if (e.kind === 'blocks') return '4 4';
    if (e.kind === 'depends') return '2 3';
    return null;
  }

  /**
   * Run a d3-force layout over the node/edge set. Mutates `simNodes` /
   * `simLinks` with x,y positions that we then render via SVG bindings.
   */
  type SimNode = GraphNode & { x?: number; y?: number; fx?: number | null; fy?: number | null };
  type SimLink = GraphEdge & { source: string | SimNode; target: string | SimNode };

  let simNodes: SimNode[] = $state(nodes.map((n) => ({ ...n })));
  let simLinks: SimLink[] = $state(edges.map((e) => ({ ...e })));

  onMount(() => {
    if (simNodes.length === 0) return;

    const width = svgEl?.clientWidth ?? 1000;
    const height = svgEl?.clientHeight ?? 600;

    const sim = d3
      .forceSimulation<SimNode>(simNodes)
      .force(
        'link',
        d3
          .forceLink<SimNode, SimLink>(simLinks)
          .id((d) => d.id)
          .distance((l) => (l.kind === 'parent' ? 40 : 80))
          .strength((l) => (l.kind === 'parent' ? 1 : 0.2)),
      )
      .force('charge', d3.forceManyBody().strength(-120))
      .force('center', d3.forceCenter(width / 2, height / 2))
      .force(
        'collide',
        d3.forceCollide<SimNode>((n) => nodeRadius(n) + 3),
      )
      .on('tick', () => {
        // Force Svelte re-render by re-assigning the arrays.
        simNodes = [...simNodes];
        simLinks = [...simLinks];
      });

    // Stop after 300 ticks or 5s — hierarchical graphs stabilise quickly.
    setTimeout(() => sim.stop(), 5000);

    return () => sim.stop();
  });

  function onNodeClick(n: GraphNode): void {
    goto(`/tasks/${n.id}`);
  }

  function toggleArchived(): string {
    const next = new URL($page.url);
    if (next.searchParams.get('archived') === '1') next.searchParams.delete('archived');
    else next.searchParams.set('archived', '1');
    return next.pathname + (next.search ? next.search : '');
  }

  function clearEpicFilter(): string {
    const next = new URL($page.url);
    next.searchParams.delete('epic');
    return next.pathname + (next.search ? next.search : '');
  }

  function resolveEndpoint(link: SimLink, end: 'source' | 'target'): SimNode | null {
    const v = link[end];
    if (typeof v === 'string') return simNodes.find((n) => n.id === v) ?? null;
    return v ?? null;
  }
</script>

<svelte:head>
  <title>Graph — CLEO Studio</title>
</svelte:head>

<div class="graph-page">
  <div class="page-header">
    <div class="header-left">
      <h1 class="page-title">Relations Graph</h1>
      <nav class="tasks-nav">
        <a href="/tasks" class="nav-tab">Dashboard</a>
        <a href="/tasks/pipeline" class="nav-tab">Pipeline</a>
        <a href="/tasks/graph" class="nav-tab active">Graph</a>
        <a href="/tasks/sessions" class="nav-tab">Sessions</a>
      </nav>
    </div>
    <div class="header-right">
      <span class="counts">
        <strong>{counts.nodes}</strong> nodes
        · <strong>{counts.parentEdges}</strong> parent
        · <strong>{counts.blocksEdges}</strong> blocks
        · <strong>{counts.dependsEdges}</strong> depends
      </span>
    </div>
  </div>

  <div class="filter-bar">
    <a
      href={toggleArchived()}
      class="filter-chip"
      class:active={filters.showArchived}
      data-sveltekit-noscroll
    >
      <span class="chip-check">{filters.showArchived ? '✓' : ' '}</span>
      Show archived
    </a>
    {#if filters.epic}
      <span class="filter-chip active">
        <span class="chip-check">✓</span>
        Subtree: {filters.epic}
        <a href={clearEpicFilter()} class="chip-x" title="Clear epic filter">✕</a>
      </span>
    {/if}
    <div class="legend">
      <span class="legend-item"><span class="dot dot-parent"></span> parent</span>
      <span class="legend-item"><span class="dot dot-blocks"></span> blocks</span>
      <span class="legend-item"><span class="dot dot-depends"></span> depends</span>
    </div>
  </div>

  {#if simNodes.length === 0}
    <div class="empty-state">
      <p>No tasks to graph. Create some tasks first with <code>cleo add "..."</code>.</p>
    </div>
  {:else}
    <div class="graph-wrap">
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <svg
        bind:this={svgEl}
        role="img"
        aria-label="Task relations graph"
        class="graph-svg"
        viewBox="0 0 1200 700"
        preserveAspectRatio="xMidYMid meet"
      >
        <!-- Edges first so nodes render on top -->
        <g class="edges">
          {#each simLinks as link}
            {@const s = resolveEndpoint(link, 'source')}
            {@const t = resolveEndpoint(link, 'target')}
            {#if s && t && s.x !== undefined && s.y !== undefined && t.x !== undefined && t.y !== undefined}
              <line
                x1={s.x}
                y1={s.y}
                x2={t.x}
                y2={t.y}
                stroke={edgeStroke(link)}
                stroke-width={link.kind === 'parent' ? 1.2 : 1}
                stroke-dasharray={edgeDash(link)}
                opacity={hoverId && link.source !== hoverId && link.target !== hoverId ? 0.2 : 0.8}
              />
            {/if}
          {/each}
        </g>

        <!-- Nodes -->
        <g class="nodes">
          {#each simNodes as n}
            {#if n.x !== undefined && n.y !== undefined}
              <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
              <g
                role="button"
                tabindex="0"
                class="node"
                class:hover={hoverId === n.id}
                transform="translate({n.x},{n.y})"
                onmouseenter={() => (hoverId = n.id)}
                onmouseleave={() => (hoverId = null)}
                onclick={() => onNodeClick(n)}
                onkeydown={(e) => {
                  if (e.key === 'Enter') onNodeClick(n);
                }}
              >
                <circle
                  r={nodeRadius(n)}
                  fill={nodeFill(n)}
                  stroke={nodeStroke(n)}
                  stroke-width={n.type === 'epic' ? 2 : 1}
                />
                <text
                  y={nodeRadius(n) + 10}
                  text-anchor="middle"
                  fill="#94a3b8"
                  font-size="9"
                  font-family="monospace"
                >
                  {n.id}
                </text>
              </g>
            {/if}
          {/each}
        </g>
      </svg>

      {#if hoverId}
        {@const nh = simNodes.find((x) => x.id === hoverId)}
        {#if nh}
          <div class="tooltip">
            <div class="t-head">
              <span class="t-id">{nh.id}</span>
              <span class="t-type">{nh.type ?? 'task'}</span>
            </div>
            <div class="t-title">{nh.title}</div>
            <div class="t-meta">
              <span class="t-status t-status-{nh.status}">{nh.status}</span>
              <span class="t-priority t-priority-{nh.priority}">{nh.priority}</span>
              {#if nh.pipelineStage}
                <span class="t-stage">{nh.pipelineStage}</span>
              {/if}
            </div>
          </div>
        {/if}
      {/if}
    </div>
  {/if}
</div>

<style>
  .graph-page {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    max-width: 1400px;
    margin: 0 auto;
    height: 100%;
  }

  .page-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 1rem;
  }
  .header-left {
    display: flex;
    align-items: center;
    gap: 1.5rem;
  }
  .page-title {
    font-size: 1.5rem;
    font-weight: 700;
    color: #f1f5f9;
  }
  .tasks-nav {
    display: flex;
    gap: 0.25rem;
  }
  .nav-tab {
    padding: 0.25rem 0.75rem;
    border-radius: 4px;
    text-decoration: none;
    font-size: 0.8125rem;
    font-weight: 500;
    color: #64748b;
    transition: color 0.15s, background 0.15s;
  }
  .nav-tab:hover {
    color: #e2e8f0;
    background: #2d3748;
  }
  .nav-tab.active {
    color: #a855f7;
    background: rgba(168, 85, 247, 0.1);
  }
  .counts {
    font-size: 0.75rem;
    color: #94a3b8;
  }
  .counts strong {
    color: #e2e8f0;
    font-variant-numeric: tabular-nums;
  }

  .filter-bar {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    flex-wrap: wrap;
  }
  .filter-chip {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.375rem 0.75rem;
    border-radius: 6px;
    font-size: 0.75rem;
    font-weight: 500;
    color: #94a3b8;
    background: #1a1f2e;
    border: 1px solid #2d3748;
    text-decoration: none;
    transition: all 0.15s;
  }
  .filter-chip:hover {
    color: #e2e8f0;
    background: #21273a;
  }
  .filter-chip.active {
    color: #a855f7;
    border-color: rgba(168, 85, 247, 0.5);
    background: rgba(168, 85, 247, 0.08);
  }
  .chip-check {
    display: inline-block;
    width: 0.875rem;
    text-align: center;
    font-size: 0.75rem;
    opacity: 0.9;
  }
  .chip-x {
    margin-left: 0.25rem;
    color: inherit;
    text-decoration: none;
    opacity: 0.7;
  }
  .chip-x:hover {
    opacity: 1;
  }

  .legend {
    display: inline-flex;
    gap: 0.75rem;
    margin-left: auto;
    font-size: 0.7rem;
    color: #64748b;
  }
  .legend-item {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
  }
  .dot {
    width: 10px;
    height: 2px;
    border-radius: 1px;
    display: inline-block;
  }
  .dot-parent {
    background: #334155;
  }
  .dot-blocks {
    background: #ef4444;
  }
  .dot-depends {
    background: #f59e0b;
  }

  .graph-wrap {
    position: relative;
    flex: 1;
    min-height: 600px;
    background: #0f1419;
    border: 1px solid #2d3748;
    border-radius: 8px;
    overflow: hidden;
  }
  .graph-svg {
    width: 100%;
    height: 100%;
    display: block;
  }

  .node {
    cursor: pointer;
    transition: transform 0.15s;
  }
  .node:hover,
  .node.hover {
    transform-origin: center;
  }
  .node:hover circle,
  .node.hover circle {
    filter: drop-shadow(0 0 6px rgba(168, 85, 247, 0.6));
  }

  .tooltip {
    position: absolute;
    right: 1rem;
    top: 1rem;
    min-width: 240px;
    max-width: 340px;
    padding: 0.75rem;
    background: #1a1f2e;
    border: 1px solid #2d3748;
    border-radius: 6px;
    font-size: 0.8rem;
    pointer-events: none;
  }
  .t-head {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    margin-bottom: 0.25rem;
  }
  .t-id {
    color: #a855f7;
    font-weight: 600;
    font-family: monospace;
  }
  .t-type {
    font-size: 0.675rem;
    color: #64748b;
    text-transform: uppercase;
  }
  .t-title {
    color: #e2e8f0;
    margin-bottom: 0.5rem;
  }
  .t-meta {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
    font-size: 0.7rem;
  }
  .t-status {
    padding: 0.1rem 0.375rem;
    border-radius: 3px;
    text-transform: uppercase;
    font-weight: 600;
    letter-spacing: 0.03em;
  }
  .t-status-done {
    background: rgba(34, 197, 94, 0.15);
    color: #22c55e;
  }
  .t-status-active {
    background: rgba(59, 130, 246, 0.15);
    color: #3b82f6;
  }
  .t-status-cancelled {
    background: rgba(100, 116, 139, 0.15);
    color: #94a3b8;
  }
  .t-status-pending {
    background: rgba(168, 85, 247, 0.15);
    color: #a855f7;
  }
  .t-status-archived {
    background: rgba(71, 85, 105, 0.15);
    color: #64748b;
  }
  .t-priority {
    color: #94a3b8;
    font-weight: 500;
  }
  .t-priority-critical {
    color: #ef4444;
  }
  .t-priority-high {
    color: #f97316;
  }
  .t-stage {
    color: #475569;
    background: #1e2435;
    padding: 0.1rem 0.375rem;
    border-radius: 3px;
  }

  .empty-state {
    padding: 3rem;
    text-align: center;
    color: #64748b;
    background: #1a1f2e;
    border: 1px dashed #2d3748;
    border-radius: 8px;
  }
  .empty-state code {
    background: #0f1419;
    padding: 0.125rem 0.375rem;
    border-radius: 3px;
    font-family: monospace;
    color: #a855f7;
  }
</style>
