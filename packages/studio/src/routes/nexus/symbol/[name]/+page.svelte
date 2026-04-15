<script lang="ts">
  import type { PageData } from './$types';
  import NexusGraph from '$lib/components/NexusGraph.svelte';

  interface Props {
    data: PageData;
  }
  let { data }: Props = $props();

  const HOP_COLORS: Record<number, string> = {
    0: '#f59e0b', // center — amber
    1: '#3b82f6', // hop 1 — blue
    2: '#475569', // hop 2 — muted
  };

  const graphNodes = $derived(
    data.egoNodes.map((n) => ({
      id: n.id,
      label: n.label,
      kind: n.kind,
      color: HOP_COLORS[n.hop] ?? '#475569',
      callerCount: n.callerCount,
      filePath: n.filePath,
      hop: n.hop,
    })),
  );

  const graphEdges = $derived(
    data.egoEdges.map((e) => ({
      source: e.source,
      target: e.target,
      type: e.type,
    })),
  );

  const centerNode = $derived(data.egoNodes.find((n) => n.hop === 0));
</script>

<svelte:head>
  <title>{data.symbolName} — NEXUS — CLEO Studio</title>
</svelte:head>

<div class="symbol-view">
  <div class="breadcrumb">
    <a href="/nexus" class="breadcrumb-link">NEXUS</a>
    <span class="breadcrumb-sep">/</span>
    {#if centerNode?.communityId}
      <a
        href="/nexus/community/{encodeURIComponent(centerNode.communityId)}"
        class="breadcrumb-link"
      >
        {centerNode.communityId.replace('comm_', 'Cluster ')}
      </a>
      <span class="breadcrumb-sep">/</span>
    {/if}
    <span class="breadcrumb-current">{data.symbolName}</span>
  </div>

  <div class="page-header">
    <div>
      <h1 class="view-title symbol-title">{data.symbolName}</h1>
      <p class="view-subtitle">
        {data.egoNodes.length} nodes in ego network &mdash;
        {centerNode?.kind ?? ''} &mdash;
        {centerNode?.filePath ?? ''}
      </p>
    </div>
  </div>

  <div class="legend">
    <span class="legend-item">
      <span class="legend-dot" style="background: #f59e0b;"></span>
      Center
    </span>
    <span class="legend-item">
      <span class="legend-dot" style="background: #3b82f6;"></span>
      Hop 1 (direct)
    </span>
    <span class="legend-item">
      <span class="legend-dot" style="background: #475569;"></span>
      Hop 2
    </span>
  </div>

  <div class="graph-container">
    <NexusGraph
      nodes={graphNodes}
      edges={graphEdges}
      drillDownBase="/nexus/symbol/:id"
      height="calc(100vh - 280px)"
    />
  </div>

  <div class="context-section">
    <h2 class="section-title">
      Direct Connections ({data.egoNodes.filter((n) => n.hop === 1).length})
    </h2>
    <div class="node-chips">
      {#each data.egoNodes.filter((n) => n.hop === 1) as node}
        <a href="/nexus/symbol/{encodeURIComponent(node.label)}" class="node-chip">
          <span class="chip-label">{node.label}</span>
          <span class="chip-kind">{node.kind}</span>
        </a>
      {/each}
    </div>
  </div>
</div>

<style>
  .symbol-view {
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
    max-width: 1400px;
    margin: 0 auto;
  }

  .breadcrumb {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.8125rem;
    color: #64748b;
  }

  .breadcrumb-link {
    color: #3b82f6;
    text-decoration: none;
  }

  .breadcrumb-link:hover {
    text-decoration: underline;
  }

  .breadcrumb-sep {
    color: #475569;
  }

  .breadcrumb-current {
    color: #94a3b8;
    font-family: monospace;
  }

  .page-header {
    display: flex;
    align-items: center;
    gap: 1rem;
  }

  .view-title {
    font-size: 1.5rem;
    font-weight: 700;
    color: #f1f5f9;
  }

  .symbol-title {
    font-family: monospace;
  }

  .view-subtitle {
    font-size: 0.875rem;
    color: #64748b;
    font-family: monospace;
    word-break: break-all;
  }

  .legend {
    display: flex;
    gap: 1.25rem;
    font-size: 0.8125rem;
    color: #64748b;
  }

  .legend-item {
    display: flex;
    align-items: center;
    gap: 0.375rem;
  }

  .legend-dot {
    width: 0.625rem;
    height: 0.625rem;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .graph-container {
    width: 100%;
    min-height: 400px;
  }

  .section-title {
    font-size: 0.875rem;
    font-weight: 600;
    color: #94a3b8;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-bottom: 0.75rem;
  }

  .node-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }

  .node-chip {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.25rem 0.625rem;
    background: #1a1f2e;
    border: 1px solid #2d3748;
    border-radius: 4px;
    text-decoration: none;
    transition: background 0.15s;
  }

  .node-chip:hover {
    background: #222736;
    border-color: #3b4a63;
  }

  .chip-label {
    font-family: monospace;
    font-size: 0.8125rem;
    color: #3b82f6;
  }

  .chip-kind {
    font-size: 0.625rem;
    color: #475569;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
</style>
