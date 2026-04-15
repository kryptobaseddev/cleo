<script lang="ts">
  import type { PageData } from './$types';
  import NexusGraph from '$lib/components/NexusGraph.svelte';

  interface Props {
    data: PageData;
  }
  let { data }: Props = $props();

  function formatCount(n: number): string {
    if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
    return String(n);
  }

  const graphNodes = $derived(
    data.macroNodes.map((n) => ({
      id: n.id,
      label: n.label,
      kind: n.topKind,
      size: n.size,
      color: n.color,
      callerCount: n.memberCount,
    })),
  );

  const graphEdges = $derived(
    data.macroEdges.map((e) => ({
      source: e.source,
      target: e.target,
      type: 'cross-community',
    })),
  );
</script>

<svelte:head>
  <title>NEXUS — CLEO Studio</title>
</svelte:head>

<div class="nexus-macro">
  <div class="page-header">
    <div class="header-left">
      <div class="view-icon nexus-icon">N</div>
      <div>
        <h1 class="view-title">NEXUS — Code Intelligence</h1>
        <p class="view-subtitle">
          {formatCount(data.totalNodes)} symbols across {data.macroNodes.length} communities
        </p>
      </div>
    </div>
    <div class="header-stats">
      <div class="stat">
        <span class="stat-value">{formatCount(data.totalNodes)}</span>
        <span class="stat-label">Symbols</span>
      </div>
      <div class="stat">
        <span class="stat-value">{formatCount(data.totalRelations)}</span>
        <span class="stat-label">Relations</span>
      </div>
      <div class="stat">
        <span class="stat-value">{data.macroNodes.length}</span>
        <span class="stat-label">Communities</span>
      </div>
    </div>
  </div>

  <div class="graph-hint">
    Click any community node to drill into its members.
  </div>

  <div class="graph-container">
    {#if data.macroNodes.length > 0}
      <NexusGraph
        nodes={graphNodes}
        edges={graphEdges}
        drillDownBase="/nexus/community/:id"
        isMacroView={true}
        height="calc(100vh - 200px)"
      />
    {:else}
      <div class="no-data">
        <p>nexus.db unavailable or empty.</p>
        <p class="no-data-hint">Run <code>cleo nexus analyze</code> to index the codebase.</p>
      </div>
    {/if}
  </div>

  {#if data.macroNodes.length > 0}
    <div class="community-list">
      <h2 class="section-title">Communities</h2>
      <div class="community-grid">
        {#each data.macroNodes.slice(0, 24) as community}
          <a
            href="/nexus/community/{encodeURIComponent(community.id)}"
            class="community-card"
            style="border-left-color: {community.color};"
          >
            <span class="community-name">{community.label}</span>
            <span class="community-meta">{community.memberCount} symbols</span>
            <span class="community-kind">{community.topKind}</span>
          </a>
        {/each}
      </div>
    </div>
  {/if}
</div>

<style>
  .nexus-macro {
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
    max-width: 1400px;
    margin: 0 auto;
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
    gap: 1rem;
  }

  .view-icon {
    width: 3rem;
    height: 3rem;
    border-radius: 8px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-weight: 700;
    font-size: 1.25rem;
    flex-shrink: 0;
    background: rgba(59, 130, 246, 0.15);
    color: #3b82f6;
  }

  .nexus-icon {
    background: rgba(59, 130, 246, 0.15);
    color: #3b82f6;
  }

  .view-title {
    font-size: 1.5rem;
    font-weight: 700;
    color: #f1f5f9;
  }

  .view-subtitle {
    font-size: 0.875rem;
    color: #64748b;
  }

  .header-stats {
    display: flex;
    gap: 1.5rem;
  }

  .stat {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 0.125rem;
  }

  .stat-value {
    font-size: 1.25rem;
    font-weight: 600;
    color: #f1f5f9;
    font-variant-numeric: tabular-nums;
  }

  .stat-label {
    font-size: 0.6875rem;
    color: #64748b;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .graph-hint {
    font-size: 0.8125rem;
    color: #475569;
    padding: 0.375rem 0;
  }

  .graph-container {
    width: 100%;
    min-height: 400px;
  }

  .no-data {
    padding: 3rem;
    text-align: center;
    background: #1a1f2e;
    border: 1px dashed #2d3748;
    border-radius: 8px;
    color: #64748b;
  }

  .no-data-hint {
    margin-top: 0.5rem;
    font-size: 0.875rem;
  }

  .no-data code {
    font-family: monospace;
    color: #3b82f6;
  }

  .section-title {
    font-size: 0.875rem;
    font-weight: 600;
    color: #94a3b8;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-bottom: 0.75rem;
  }

  .community-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
    gap: 0.5rem;
  }

  .community-card {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    padding: 0.625rem 0.75rem 0.625rem 1rem;
    background: #1a1f2e;
    border: 1px solid #2d3748;
    border-left-width: 3px;
    border-radius: 6px;
    text-decoration: none;
    transition: background 0.15s;
  }

  .community-card:hover {
    background: #222736;
  }

  .community-name {
    font-size: 0.8125rem;
    font-weight: 600;
    color: #f1f5f9;
  }

  .community-meta {
    font-size: 0.75rem;
    color: #64748b;
  }

  .community-kind {
    font-size: 0.6875rem;
    color: #475569;
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }
</style>
