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

  /** Callers: hop-1 nodes where the edge comes *into* the center. */
  const callerNodes = $derived(
    data.egoNodes.filter((n) => {
      if (n.hop !== 1) return false;
      return data.egoEdges.some((e) => e.target === centerNode?.id && e.source === n.id);
    }),
  );

  /** Callees: hop-1 nodes where the edge goes *out from* the center. */
  const calleeNodes = $derived(
    data.egoNodes.filter((n) => {
      if (n.hop !== 1) return false;
      return data.egoEdges.some((e) => e.source === centerNode?.id && e.target === n.id);
    }),
  );

  /** Nodes that are connected to center but direction is ambiguous (both or neither). */
  const otherHop1 = $derived(
    data.egoNodes.filter((n) => {
      if (n.hop !== 1) return false;
      const isCaller = data.egoEdges.some((e) => e.target === centerNode?.id && e.source === n.id);
      const isCallee = data.egoEdges.some((e) => e.source === centerNode?.id && e.target === n.id);
      return !isCaller && !isCallee;
    }),
  );

  /** Human-readable community label for the breadcrumb. */
  const communityBreadcrumb = $derived((): string => {
    const commId = centerNode?.communityId;
    if (!commId) return '';
    const clusterNum = commId.replace('comm_', '');
    return `Cluster ${clusterNum}`;
  });
</script>

<svelte:head>
  <title>{data.symbolName} — Code — CLEO Studio</title>
</svelte:head>

<div class="symbol-view">
  <div class="breadcrumb">
    <a href="/code" class="breadcrumb-link">Code</a>
    <span class="breadcrumb-sep">/</span>
    {#if centerNode?.communityId}
      <a
        href="/code/community/{encodeURIComponent(centerNode.communityId)}"
        class="breadcrumb-link"
      >
        {communityBreadcrumb}
      </a>
      <span class="breadcrumb-sep">/</span>
    {/if}
    <span class="breadcrumb-current">{data.symbolName}</span>
  </div>

  <!-- Context strip: callers / callees summary with back link -->
  <div class="context-strip">
    <div class="context-card">
      <span class="context-card-label">Callers</span>
      <span class="context-card-value callers-value">{callerNodes.length}</span>
    </div>
    <div class="context-card">
      <span class="context-card-label">Callees</span>
      <span class="context-card-value callees-value">{calleeNodes.length}</span>
    </div>
    <div class="context-card">
      <span class="context-card-label">Hop-2 nodes</span>
      <span class="context-card-value">{data.egoNodes.filter((n) => n.hop === 2).length}</span>
    </div>
    <div class="context-card">
      <span class="context-card-label">Edges visible</span>
      <span class="context-card-value">{data.egoEdges.length}</span>
    </div>
    <a
      href="/brain?scope=nexus"
      class="canvas-pill"
    >
      Open in Canvas &rarr;
    </a>
    {#if centerNode?.communityId}
      <a
        href="/code/community/{encodeURIComponent(centerNode.communityId)}"
        class="context-back-link"
      >
        <span class="back-arrow">&#8592;</span> Back to {communityBreadcrumb}
      </a>
    {:else}
      <a href="/code" class="context-back-link">
        <span class="back-arrow">&#8592;</span> Back to Code
      </a>
    {/if}
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
    <span class="legend-item legend-edge-hint">
      <span class="legend-edge-sample"></span>
      Arrow = calls direction
    </span>
  </div>

  <div class="graph-container">
    <NexusGraph
      nodes={graphNodes}
      edges={graphEdges}
      drillDownBase="/code/symbol/:id"
      height="calc(100vh - 360px)"
    />
  </div>

  {#if callerNodes.length > 0}
    <div class="context-section">
      <h2 class="section-title">Callers ({callerNodes.length})</h2>
      <div class="node-chips">
        {#each callerNodes as node}
          <a href="/code/symbol/{encodeURIComponent(node.label)}" class="node-chip chip-caller">
            <span class="chip-label">{node.label}</span>
            <span class="chip-kind">{node.kind}</span>
          </a>
        {/each}
      </div>
    </div>
  {/if}

  {#if calleeNodes.length > 0}
    <div class="context-section">
      <h2 class="section-title">Callees ({calleeNodes.length})</h2>
      <div class="node-chips">
        {#each calleeNodes as node}
          <a href="/code/symbol/{encodeURIComponent(node.label)}" class="node-chip chip-callee">
            <span class="chip-label">{node.label}</span>
            <span class="chip-kind">{node.kind}</span>
          </a>
        {/each}
      </div>
    </div>
  {/if}

  {#if otherHop1.length > 0}
    <div class="context-section">
      <h2 class="section-title">Direct Connections ({otherHop1.length})</h2>
      <div class="node-chips">
        {#each otherHop1 as node}
          <a href="/code/symbol/{encodeURIComponent(node.label)}" class="node-chip">
            <span class="chip-label">{node.label}</span>
            <span class="chip-kind">{node.kind}</span>
          </a>
        {/each}
      </div>
    </div>
  {/if}
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

  /* Context strip */
  .context-strip {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.75rem 1rem;
    background: #141820;
    border: 1px solid #2d3748;
    border-radius: 8px;
    flex-wrap: wrap;
  }

  .context-card {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    padding: 0.375rem 0.75rem;
    background: #1a1f2e;
    border: 1px solid #2d3748;
    border-radius: 6px;
    min-width: 72px;
  }

  .context-card-label {
    font-size: 0.625rem;
    color: #475569;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }

  .context-card-value {
    font-size: 0.875rem;
    font-weight: 600;
    color: #e2e8f0;
    font-variant-numeric: tabular-nums;
  }

  .callers-value {
    color: #f59e0b;
  }

  .callees-value {
    color: #3b82f6;
  }

  .canvas-pill {
    padding: 0.25rem 0.875rem;
    border-radius: 999px;
    font-size: 0.8125rem;
    font-weight: 500;
    color: #3b82f6;
    text-decoration: none;
    border: 1px solid rgba(59, 130, 246, 0.4);
    background: rgba(59, 130, 246, 0.08);
    transition:
      background 0.15s,
      border-color 0.15s;
    white-space: nowrap;
  }

  .canvas-pill:hover {
    background: rgba(59, 130, 246, 0.18);
    border-color: #3b82f6;
  }

  .context-back-link {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    margin-left: auto;
    font-size: 0.8125rem;
    color: #3b82f6;
    text-decoration: none;
    padding: 0.375rem 0.625rem;
    border: 1px solid #2d3748;
    border-radius: 6px;
    background: #1a1f2e;
    transition: background 0.15s;
  }

  .context-back-link:hover {
    background: #222736;
    border-color: #3b82f6;
  }

  .back-arrow {
    font-size: 0.875rem;
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
    flex-wrap: wrap;
    align-items: center;
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

  .legend-edge-hint {
    color: #475569;
    font-size: 0.75rem;
  }

  .legend-edge-sample {
    display: inline-block;
    width: 1.25rem;
    height: 1px;
    background: rgba(148, 163, 184, 0.5);
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

  .context-section {
    display: flex;
    flex-direction: column;
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

  .chip-caller {
    border-left: 2px solid #f59e0b;
  }

  .chip-callee {
    border-left: 2px solid #3b82f6;
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
