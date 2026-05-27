<!--
  /code/community/[id] — community drill-down.

  Scoped graph of every member symbol + every internal edge.  Edges are
  type-coloured; cluster caption is a single halo around the centroid.

  @task T990
  @wave 1B
-->
<script lang="ts">
  import type { PageData } from './$types';
  import { goto } from '$app/navigation';

  import CosmosRenderer from '$lib/graph/renderers/CosmosRenderer.svelte';
  import {
    adaptNexusRows,
    type NexusNodeRow,
    type NexusRelationRow,
  } from '$lib/graph/adapters/nexus-adapter.js';
  import { EDGE_STYLE, describeEdgeKind } from '$lib/graph/edge-kinds.js';
  import type { EdgeKind, GraphNode } from '$lib/graph/types.js';
  import { Breadcrumb, Card, Chip, ChipGroup } from '$lib/ui';

  interface Props {
    data: PageData;
  }
  let { data }: Props = $props();

  // Adapt to the kit shape (all members are in the same community).
  const adapted = $derived.by(() => {
    const rows: NexusNodeRow[] = data.nodes.map((n) => ({
      id: n.id,
      label: n.label,
      kind: n.kind,
      filePath: n.filePath,
      callerCount: n.callerCount,
      communityId: data.communityId,
    }));
    const relations: NexusRelationRow[] = data.edges.map((e) => ({
      source: e.source,
      target: e.target,
      type: e.type,
    }));
    return adaptNexusRows(rows, relations);
  });

  const graphNodes = $derived(adapted.nodes);
  const graphEdges = $derived(adapted.edges);
  const graphClusters = $derived(adapted.clusters);

  const COMMUNITY_EDGE_KINDS: readonly EdgeKind[] = [
    'calls',
    'extends',
    'implements',
    'has_method',
    'has_property',
    'defines',
    'imports',
    'accesses',
    'references',
  ];

  const MEMBER_KINDS = [
    'class',
    'interface',
    'function',
    'method',
    'enum',
    'type_alias',
    'file',
  ];

  let visibleEdgeKinds = $state<Set<EdgeKind>>(new Set(COMMUNITY_EDGE_KINDS));
  let visibleNodeKinds = $state<Set<string>>(new Set(MEMBER_KINDS));
  let highlightedNodeId = $state<string | null>(null);
  let selectedNode = $state<GraphNode | null>(null);

  function toggleEdge(kind: EdgeKind): void {
    const next = new Set(visibleEdgeKinds);
    if (next.has(kind)) next.delete(kind);
    else next.add(kind);
    visibleEdgeKinds = next;
  }

  function toggleLabel(kind: string): void {
    const next = new Set(visibleNodeKinds);
    if (next.has(kind)) next.delete(kind);
    else next.add(kind);
    visibleNodeKinds = next;
  }

  function onNodeClick(node: GraphNode): void {
    selectedNode = node;
    if (node.kind !== 'community') {
      void goto(`/code/symbol/${encodeURIComponent(node.label)}`);
    }
  }

  // Top members by caller count for the side panel.
  const topMembers = $derived(
    [...data.nodes]
      .sort((a, b) => b.callerCount - a.callerCount)
      .slice(0, 20),
  );

  function shortPath(filePath: string): string {
    const parts = filePath.split('/');
    return parts.slice(-2).join('/');
  }

  // Edge-kind distribution for the legend (non-zero kinds get a count).
  const edgeKindCounts = $derived.by(() => {
    const counts = new Map<EdgeKind, number>();
    for (const e of graphEdges) counts.set(e.kind, (counts.get(e.kind) ?? 0) + 1);
    return counts;
  });

  // Kind distribution for label chips.
  const nodeKindCounts = $derived.by(() => {
    const counts = new Map<string, number>();
    for (const n of graphNodes) counts.set(n.kind, (counts.get(n.kind) ?? 0) + 1);
    return counts;
  });
</script>

<svelte:head>
  <title>{data.communityLabel} — Code — CLEO Studio</title>
</svelte:head>

<section class="community-view" aria-labelledby="community-title">
  <header class="page-head">
    <Breadcrumb
      items={[
        { label: 'Studio', href: '/' },
        { label: 'Code', href: '/code' },
        { label: data.communityLabel },
      ]}
    />
    <div class="title-row">
      <div>
        <span class="eyebrow">NEXUS · Community</span>
        <h1 id="community-title">{data.communityLabel}</h1>
        <p class="subtitle">
          <span>{data.summary.memberCount} members</span>
          <span class="sep" aria-hidden="true">·</span>
          <span>{data.summary.internalEdgeCount} internal edges</span>
          <span class="sep" aria-hidden="true">·</span>
          <span>top kind: <span class="kind-badge">{data.summary.topKind}</span></span>
        </p>
      </div>
    </div>
  </header>

  <div class="workbench">
    <div class="stage">
      <div class="stage-scanlines" aria-hidden="true"></div>
      <CosmosRenderer
        nodes={graphNodes}
        edges={graphEdges}
        clusters={graphClusters}
        visibleEdgeKinds={visibleEdgeKinds}
        visibleNodeKinds={visibleNodeKinds}
        highlightNodeId={highlightedNodeId}
        showClusterLabels={false}
        onNodeClick={onNodeClick}
        height="calc(100vh - 220px)"
        baseAlpha={0.92}
      />

      <footer class="legend-dock" aria-label="Edge legend">
        <span class="legend-eyebrow">EDGES ({data.summary.internalEdgeCount})</span>
        <ul>
          {#each COMMUNITY_EDGE_KINDS as kind (kind)}
            {@const style = EDGE_STYLE[kind]}
            {@const active = visibleEdgeKinds.has(kind)}
            {@const count = edgeKindCounts.get(kind) ?? 0}
            <li>
              <button
                type="button"
                class="legend-item"
                class:active
                class:disabled={count === 0}
                disabled={count === 0}
                aria-pressed={active}
                onclick={() => toggleEdge(kind)}
                title={describeEdgeKind(kind)}
              >
                <span
                  class="swatch"
                  style:background={style.color}
                  class:dashed={Boolean(style.dash)}
                  aria-hidden="true"
                ></span>
                <span class="legend-label">{kind}</span>
                <span class="legend-count">{count}</span>
              </button>
            </li>
          {/each}
        </ul>
      </footer>
    </div>

    <aside class="side-panel" aria-label="Community controls">
      <Card elevation={1} padding="cozy">
        {#snippet children()}
          <div class="panel-stack">
            <div class="panel-section">
              <h2 class="panel-head">Member kinds</h2>
              <ChipGroup>
                {#snippet children()}
                  {#each MEMBER_KINDS as kind (kind)}
                    {@const count = nodeKindCounts.get(kind) ?? 0}
                    <Chip
                      active={visibleNodeKinds.has(kind)}
                      disabled={count === 0}
                      count={count}
                      onclick={() => toggleLabel(kind)}
                    >
                      {#snippet children()}{kind}{/snippet}
                    </Chip>
                  {/each}
                {/snippet}
              </ChipGroup>
            </div>

            <div class="panel-section">
              <h2 class="panel-head">Top by callers</h2>
              <ol class="member-list">
                {#each topMembers as m (m.id)}
                  <li>
                    <a
                      class="member-row"
                      href="/code/symbol/{encodeURIComponent(m.label)}"
                      onmouseenter={() => { highlightedNodeId = m.id; }}
                      onmouseleave={() => { highlightedNodeId = null; }}
                      onfocus={() => { highlightedNodeId = m.id; }}
                      onblur={() => { highlightedNodeId = null; }}
                    >
                      <span class="member-label">{m.label}</span>
                      <span class="member-meta">
                        <span class="member-kind">{m.kind}</span>
                        {#if m.filePath}
                          <span class="member-path">{shortPath(m.filePath)}</span>
                        {/if}
                        <span class="member-count">{m.callerCount}×</span>
                      </span>
                    </a>
                  </li>
                {/each}
              </ol>
            </div>

            {#if selectedNode}
              <div class="panel-section">
                <h2 class="panel-head">Selected</h2>
                <div class="selected-card">
                  <span class="selected-label">{selectedNode.label}</span>
                  <span class="selected-kind">{selectedNode.kind}</span>
                  {#if typeof selectedNode.meta?.filePath === 'string'}
                    <span class="selected-meta">
                      {shortPath(selectedNode.meta.filePath as string)}
                    </span>
                  {/if}
                </div>
              </div>
            {/if}
          </div>
        {/snippet}
      </Card>
    </aside>
  </div>
</section>

<style>
  .community-view {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    padding-bottom: var(--space-8);
  }

  .page-head {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .title-row {
    display: flex;
    justify-content: space-between;
    gap: var(--space-5);
    flex-wrap: wrap;
  }

  .eyebrow {
    display: inline-block;
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--accent);
    padding: 2px var(--space-2);
    border-radius: var(--radius-xs);
    background: var(--accent-halo);
  }

  h1 {
    font-family: var(--font-sans);
    font-size: var(--text-2xl);
    font-weight: 700;
    letter-spacing: -0.02em;
    color: var(--text);
    margin: var(--space-2) 0;
  }

  .subtitle {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--text-dim);
  }

  .subtitle .sep {
    color: var(--text-faint);
  }

  .kind-badge {
    color: var(--accent);
    font-weight: 600;
  }

  .workbench {
    display: grid;
    grid-template-columns: minmax(0, 72fr) minmax(0, 28fr);
    gap: var(--space-4);
    align-items: stretch;
  }

  @media (max-width: 960px) {
    .workbench {
      grid-template-columns: 1fr;
    }
  }

  .stage {
    position: relative;
    overflow: hidden;
    border-radius: var(--radius-lg);
  }

  .stage-scanlines {
    position: absolute;
    inset: 0;
    pointer-events: none;
    background-image: repeating-linear-gradient(
      180deg,
      transparent 0,
      transparent 2px,
      color-mix(in srgb, var(--border) 25%, transparent) 2px,
      color-mix(in srgb, var(--border) 25%, transparent) 3px
    );
    mix-blend-mode: overlay;
    opacity: 0.3;
    z-index: 2;
  }

  /* Legend dock */
  .legend-dock {
    position: absolute;
    left: var(--space-3);
    right: var(--space-3);
    bottom: var(--space-3);
    display: flex;
    align-items: center;
    gap: var(--space-4);
    padding: var(--space-2) var(--space-3);
    background: color-mix(in srgb, var(--bg-elev-2) 88%, transparent);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-md);
    backdrop-filter: blur(10px);
    z-index: 3;
    overflow-x: auto;
  }

  .legend-eyebrow {
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    text-transform: uppercase;
    letter-spacing: 0.12em;
    color: var(--text-dim);
    white-space: nowrap;
  }

  .legend-dock ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: inline-flex;
    gap: var(--space-1);
    flex-wrap: nowrap;
  }

  .legend-item {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px var(--space-2);
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    color: var(--text-dim);
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    cursor: pointer;
    white-space: nowrap;
  }

  .legend-item:hover:not(:disabled) {
    color: var(--text);
    background: color-mix(in srgb, var(--bg-elev-2) 75%, transparent);
  }

  .legend-item:focus-visible {
    outline: none;
    box-shadow: var(--shadow-focus);
  }

  .legend-item.active {
    color: var(--text);
    border-color: var(--border);
    background: color-mix(in srgb, var(--bg) 70%, transparent);
  }

  .legend-item:not(.active) .swatch {
    opacity: 0.3;
  }

  .legend-item.disabled {
    opacity: 0.35;
    cursor: not-allowed;
  }

  .swatch {
    width: 18px;
    height: 2px;
    display: inline-block;
    border-radius: 1px;
  }

  .swatch.dashed {
    background-image: repeating-linear-gradient(
      90deg,
      currentColor 0,
      currentColor 3px,
      transparent 3px,
      transparent 6px
    );
  }

  .legend-count {
    font-size: 0.625rem;
    color: var(--text-faint);
    font-variant-numeric: tabular-nums;
  }

  /* Side panel */
  .side-panel {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    min-width: 0;
  }

  .panel-stack {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  .panel-section {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .panel-head {
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    font-weight: 700;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--text-dim);
    margin: 0;
  }

  .member-list {
    list-style: none;
    margin: 0;
    padding: 0;
    max-height: 420px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .member-row {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: var(--space-2) var(--space-3);
    border: 1px solid transparent;
    border-left: 2px solid var(--border);
    border-radius: var(--radius-xs);
    text-decoration: none;
    color: var(--text);
    transition: background var(--ease), border-color var(--ease), transform var(--ease);
  }

  .member-row:hover,
  .member-row:focus-visible {
    background: var(--bg-elev-2);
    border-color: var(--border);
    border-left-color: var(--accent);
    transform: translateX(2px);
    outline: none;
  }

  .member-label {
    font-family: var(--font-mono);
    font-size: var(--text-sm);
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .member-meta {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    font-size: var(--text-2xs);
    color: var(--text-dim);
  }

  .member-kind {
    color: var(--accent);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-weight: 600;
  }

  .member-path {
    color: var(--text-faint);
    font-family: var(--font-mono);
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .member-count {
    margin-left: auto;
    font-family: var(--font-mono);
    font-variant-numeric: tabular-nums;
    color: var(--text-dim);
  }

  .selected-card {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: var(--space-2) var(--space-3);
    border-left: 2px solid var(--accent);
    background: var(--accent-halo);
    border-radius: var(--radius-sm);
  }

  .selected-label {
    font-family: var(--font-mono);
    font-size: var(--text-sm);
    color: var(--text);
  }

  .selected-kind {
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    text-transform: uppercase;
    color: var(--accent);
    letter-spacing: 0.08em;
  }

  .selected-meta {
    font-size: var(--text-2xs);
    color: var(--text-dim);
  }
</style>
