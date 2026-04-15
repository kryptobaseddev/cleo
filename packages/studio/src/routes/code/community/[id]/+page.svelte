<script lang="ts">
  import type { PageData } from './$types';
  import NexusGraph from '$lib/components/NexusGraph.svelte';

  interface Props {
    data: PageData;
  }
  let { data }: Props = $props();

  const KIND_COLORS: Record<string, string> = {
    function: '#3b82f6',
    method: '#06b6d4',
    class: '#8b5cf6',
    interface: '#10b981',
    type_alias: '#f59e0b',
    enum: '#ef4444',
    property: '#94a3b8',
    file: '#64748b',
    folder: '#475569',
    process: '#f97316',
  };

  function kindColor(kind: string): string {
    return KIND_COLORS[kind] ?? '#64748b';
  }

  const graphNodes = $derived(
    data.communityNodes.map((n) => ({
      id: n.id,
      label: n.label,
      kind: n.kind,
      color: kindColor(n.kind),
      callerCount: n.callerCount,
      filePath: n.filePath,
    })),
  );

  const graphEdges = $derived(
    data.communityEdges.map((e) => ({
      source: e.source,
      target: e.target,
      type: e.type,
    })),
  );

  const topNodes = $derived(data.communityNodes.slice(0, 20));

  function shortPath(filePath: string): string {
    const parts = filePath.split('/');
    return parts.slice(-2).join('/');
  }

  /** Display label for the page title and breadcrumb. */
  const displayLabel = $derived(data.communityLabel);

  /** Edge count from the loaded community edges. */
  const edgeCount = $derived(data.communityEdges.length);
</script>

<svelte:head>
  <title>{displayLabel} — Code — CLEO Studio</title>
</svelte:head>

<div class="community-view">
  <div class="breadcrumb">
    <a href="/code" class="breadcrumb-link">Code</a>
    <span class="breadcrumb-sep">/</span>
    <span class="breadcrumb-current">{displayLabel}</span>
  </div>

  <!-- Context strip: community summary cards giving navigation context -->
  <div class="context-strip">
    <div class="context-card">
      <span class="context-card-label">Community</span>
      <span class="context-card-value">{displayLabel}</span>
    </div>
    <div class="context-card">
      <span class="context-card-label">Symbols</span>
      <span class="context-card-value">{data.summary.memberCount}</span>
    </div>
    <div class="context-card">
      <span class="context-card-label">Internal edges</span>
      <span class="context-card-value">{edgeCount}</span>
    </div>
    <div class="context-card">
      <span class="context-card-label">Top kind</span>
      <span class="context-card-value" style="color: {kindColor(data.summary.topKind)};">
        {data.summary.topKind}
      </span>
    </div>
    <a
      href="/brain?scope=nexus&community={encodeURIComponent(data.communityId)}"
      class="canvas-pill"
    >
      Open in Canvas &rarr;
    </a>
    <a href="/code" class="context-back-link">
      <span class="back-arrow">&#8592;</span> All communities
    </a>
  </div>

  <div class="page-header">
    <div>
      <h1 class="view-title">{displayLabel}</h1>
      <p class="view-subtitle">
        {data.communityNodes.length} symbols &mdash; {edgeCount} connections &mdash; click a node
        to explore its ego network
      </p>
    </div>
  </div>

  <div class="graph-container">
    <NexusGraph
      nodes={graphNodes}
      edges={graphEdges}
      drillDownBase="/code/symbol/:id"
      height="calc(100vh - 320px)"
    />
  </div>

  <div class="member-table-section">
    <h2 class="section-title">Top Members by Caller Count</h2>
    <table class="member-table">
      <thead>
        <tr>
          <th>Symbol</th>
          <th>Kind</th>
          <th>File</th>
          <th class="col-count">Callers</th>
        </tr>
      </thead>
      <tbody>
        {#each topNodes as node}
          <tr>
            <td>
              <a href="/code/symbol/{encodeURIComponent(node.label)}" class="symbol-link">
                {node.label}
              </a>
            </td>
            <td>
              <span class="kind-badge" style="color: {kindColor(node.kind)};">{node.kind}</span>
            </td>
            <td class="file-cell">{shortPath(node.filePath)}</td>
            <td class="col-count">{node.callerCount}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
</div>

<style>
  .community-view {
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
  }

  /* Context strip — sticky summary row above the graph */
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
    min-width: 80px;
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

  .view-subtitle {
    font-size: 0.875rem;
    color: #64748b;
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

  .member-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.8125rem;
  }

  .member-table th {
    text-align: left;
    padding: 0.5rem 0.75rem;
    background: #1a1f2e;
    border-bottom: 1px solid #2d3748;
    color: #64748b;
    font-weight: 500;
    text-transform: uppercase;
    font-size: 0.6875rem;
    letter-spacing: 0.05em;
  }

  .member-table td {
    padding: 0.5rem 0.75rem;
    border-bottom: 1px solid #1a1f2e;
    color: #e2e8f0;
    vertical-align: middle;
  }

  .member-table tr:hover td {
    background: #1a1f2e;
  }

  .symbol-link {
    color: #3b82f6;
    text-decoration: none;
    font-family: monospace;
    font-size: 0.8125rem;
  }

  .symbol-link:hover {
    text-decoration: underline;
  }

  .kind-badge {
    font-size: 0.6875rem;
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .file-cell {
    color: #64748b;
    font-family: monospace;
    font-size: 0.75rem;
  }

  .col-count {
    text-align: right;
    color: #94a3b8;
    font-variant-numeric: tabular-nums;
  }
</style>
