<script lang="ts">
  import LivingBrainGraph from '$lib/components/LivingBrainGraph.svelte';
  import type { LBGraph, LBNode, LBSubstrate } from '$lib/server/living-brain/types.js';

  // ---------------------------------------------------------------------------
  // Server-loaded data
  // ---------------------------------------------------------------------------

  interface PageData {
    graph: LBGraph;
  }

  let { data }: { data: PageData } = $props();

  // ---------------------------------------------------------------------------
  // Runtime state
  // ---------------------------------------------------------------------------

  let graph = $state<LBGraph>(data.graph);
  let loading = $state(false);
  let error = $state<string | null>(null);

  /** Active substrate filter set (all enabled by default). */
  let enabledSubstrates = $state<Set<LBSubstrate>>(
    new Set(['brain', 'nexus', 'tasks', 'conduit', 'signaldock'] as LBSubstrate[]),
  );

  /** Minimum weight threshold [0,1]. */
  let minWeight = $state(0);

  /** Side panel node detail. */
  let selectedNode = $state<LBNode | null>(null);
  let sideLoading = $state(false);
  let sideError = $state<string | null>(null);

  // ---------------------------------------------------------------------------
  // Visual encoding constants (must mirror LivingBrainGraph.svelte)
  // ---------------------------------------------------------------------------

  const ALL_SUBSTRATES: LBSubstrate[] = ['brain', 'nexus', 'tasks', 'conduit', 'signaldock'];

  const SUBSTRATE_COLOR: Record<LBSubstrate, string> = {
    brain: '#3b82f6',
    nexus: '#22c55e',
    tasks: '#f97316',
    conduit: '#a855f7',
    signaldock: '#ef4444',
  };

  const EDGE_TYPES = [
    { type: 'supersedes', color: '#ef4444' },
    { type: 'affects', color: '#3b82f6' },
    { type: 'applies_to', color: '#22c55e' },
    { type: 'calls', color: '#94a3b8' },
    { type: 'co_retrieved', color: '#a855f7' },
    { type: 'mentions', color: '#eab308' },
  ];

  // ---------------------------------------------------------------------------
  // Derived filtered graph
  // ---------------------------------------------------------------------------

  let filteredGraph = $derived<LBGraph>({
    nodes: graph.nodes.filter(
      (n) => enabledSubstrates.has(n.substrate) && (n.weight ?? 1) >= minWeight,
    ),
    edges: graph.edges.filter((e) => {
      const srcOk =
        e.substrate === 'cross' ||
        enabledSubstrates.has(e.substrate as LBSubstrate);
      return srcOk;
    }),
    counts: graph.counts,
    truncated: graph.truncated,
  });

  // ---------------------------------------------------------------------------
  // Substrate toggle
  // ---------------------------------------------------------------------------

  function toggleSubstrate(s: LBSubstrate): void {
    const next = new Set(enabledSubstrates);
    if (next.has(s)) {
      next.delete(s);
    } else {
      next.add(s);
    }
    enabledSubstrates = next;
  }

  // ---------------------------------------------------------------------------
  // Full graph fetch
  // ---------------------------------------------------------------------------

  async function fetchFullGraph(): Promise<void> {
    loading = true;
    error = null;
    try {
      const res = await fetch('/api/living-brain?limit=5000');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      graph = (await res.json()) as LBGraph;
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load graph';
    } finally {
      loading = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Node click → side panel
  // ---------------------------------------------------------------------------

  async function handleNodeClick(id: string): Promise<void> {
    sideLoading = true;
    sideError = null;
    selectedNode = null;
    try {
      const res = await fetch(`/api/living-brain/node/${encodeURIComponent(id)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { node: LBNode };
      selectedNode = body.node;
    } catch (e) {
      sideError = e instanceof Error ? e.message : 'Failed to load node';
    } finally {
      sideLoading = false;
    }
  }

  function closePanel(): void {
    selectedNode = null;
    sideError = null;
  }

  // ---------------------------------------------------------------------------
  // Derived stats
  // ---------------------------------------------------------------------------

  let totalNodes = $derived(filteredGraph.nodes.length);
  let totalEdges = $derived(filteredGraph.edges.length);
  let isFullGraph = $derived(graph.nodes.length > 500);
</script>

<svelte:head>
  <title>Living Brain — CLEO Studio</title>
</svelte:head>

<div class="lb-page">
  <!-- ====================================================================== -->
  <!-- Header -->
  <!-- ====================================================================== -->
  <div class="lb-header">
    <div class="header-left">
      <h1 class="page-title">Living Brain</h1>
      <span class="node-count">
        {totalNodes} nodes · {totalEdges} edges
        {#if graph.truncated}
          <span class="truncated-badge">truncated</span>
        {/if}
      </span>
    </div>

    <div class="header-controls">
      <!-- Substrate toggles -->
      <div class="substrate-filters">
        {#each ALL_SUBSTRATES as s}
          <button
            class="substrate-btn"
            class:active={enabledSubstrates.has(s)}
            style="--s-color: {SUBSTRATE_COLOR[s]}"
            onclick={() => toggleSubstrate(s)}
            title="Toggle {s} substrate"
          >
            {s}
          </button>
        {/each}
      </div>

      <!-- Weight threshold -->
      <div class="weight-wrap">
        <label class="weight-label" for="weight-slider">
          min weight: <span class="weight-val">{minWeight.toFixed(2)}</span>
        </label>
        <input
          id="weight-slider"
          type="range"
          min="0"
          max="1"
          step="0.05"
          bind:value={minWeight}
          class="weight-slider"
        />
      </div>

      <!-- Full graph button -->
      {#if !isFullGraph}
        <button class="full-graph-btn" onclick={fetchFullGraph} disabled={loading}>
          {loading ? 'Loading…' : 'Full graph'}
        </button>
      {:else}
        <span class="full-graph-label">Full graph loaded</span>
      {/if}
    </div>
  </div>

  <!-- Error banner -->
  {#if error}
    <div class="error-banner">{error}</div>
  {/if}

  <!-- ====================================================================== -->
  <!-- Main canvas + optional side panel -->
  <!-- ====================================================================== -->
  <div class="lb-body" class:has-panel={selectedNode !== null || sideLoading || sideError !== null}>
    <div class="lb-canvas">
      <LivingBrainGraph
        nodes={filteredGraph.nodes}
        edges={filteredGraph.edges}
        onNodeClick={handleNodeClick}
        height="100%"
      />
    </div>

    <!-- Side panel -->
    {#if selectedNode !== null || sideLoading || sideError !== null}
      <div class="lb-panel">
        <div class="panel-header">
          <span class="panel-title">Node Detail</span>
          <button class="panel-close" onclick={closePanel} aria-label="Close panel">×</button>
        </div>

        {#if sideLoading}
          <div class="panel-loading">Loading…</div>
        {:else if sideError}
          <div class="panel-error">{sideError}</div>
        {:else if selectedNode}
          <div class="panel-body">
            <div
              class="panel-kind-badge"
              style="background: {SUBSTRATE_COLOR[selectedNode.substrate]}22; color: {SUBSTRATE_COLOR[selectedNode.substrate]}; border-color: {SUBSTRATE_COLOR[selectedNode.substrate]}44"
            >
              {selectedNode.substrate} / {selectedNode.kind}
            </div>

            <p class="panel-label">{selectedNode.label}</p>

            <div class="panel-id">
              <span class="field-key">id</span>
              <span class="field-val mono">{selectedNode.id}</span>
            </div>

            {#if selectedNode.weight !== undefined}
              <div class="panel-field">
                <span class="field-key">weight</span>
                <span class="field-val">{selectedNode.weight.toFixed(3)}</span>
              </div>
            {/if}

            {#if Object.keys(selectedNode.meta).length > 0}
              <details class="panel-meta">
                <summary class="meta-summary">Metadata</summary>
                <pre class="meta-pre">{JSON.stringify(selectedNode.meta, null, 2)}</pre>
              </details>
            {/if}
          </div>
        {/if}
      </div>
    {/if}
  </div>

  <!-- ====================================================================== -->
  <!-- Legend bar -->
  <!-- ====================================================================== -->
  <div class="lb-legend">
    <div class="legend-section">
      <span class="legend-label">Substrates</span>
      {#each ALL_SUBSTRATES as s}
        {#if enabledSubstrates.has(s)}
          <div class="legend-item">
            <span class="legend-dot" style="background: {SUBSTRATE_COLOR[s]}"></span>
            <span>
              {s}
              <span class="legend-count">{graph.counts.nodes[s] ?? 0}</span>
            </span>
          </div>
        {/if}
      {/each}
    </div>

    <div class="legend-section">
      <span class="legend-label">Edges</span>
      {#each EDGE_TYPES as et}
        <div class="legend-item">
          <span class="legend-line" style="background: {et.color}"></span>
          <span>{et.type}</span>
        </div>
      {/each}
    </div>

    <!-- TODO: Time slider — future feature. Nodes carry no timestamp in LBNode yet.
         When LBNode.createdAt is added, filter by date range here. -->
    <div class="legend-section legend-todo">
      <span class="legend-label">Time slider</span>
      <span class="todo-note">TODO — requires LBNode.createdAt</span>
    </div>
  </div>
</div>

<style>
  .lb-page {
    display: flex;
    flex-direction: column;
    height: calc(100vh - 3rem - 4rem);
    gap: 0.625rem;
  }

  /* ---- Header ------------------------------------------------------------ */
  .lb-header {
    display: flex;
    align-items: center;
    gap: 1rem;
    flex-wrap: wrap;
  }

  .header-left {
    display: flex;
    align-items: center;
    gap: 0.875rem;
    flex: 1;
    min-width: 0;
  }

  .page-title {
    font-size: 1.125rem;
    font-weight: 700;
    color: #f1f5f9;
    white-space: nowrap;
  }

  .node-count {
    font-size: 0.75rem;
    color: #64748b;
    display: flex;
    align-items: center;
    gap: 0.375rem;
  }

  .truncated-badge {
    padding: 0.1rem 0.4rem;
    border-radius: 4px;
    background: rgba(245, 158, 11, 0.15);
    color: #f59e0b;
    font-size: 0.6875rem;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .header-controls {
    display: flex;
    align-items: center;
    gap: 0.875rem;
    flex-wrap: wrap;
  }

  /* Substrate filter buttons */
  .substrate-filters {
    display: flex;
    gap: 0.25rem;
  }

  .substrate-btn {
    padding: 0.2rem 0.55rem;
    border-radius: 999px;
    font-size: 0.6875rem;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    background: none;
    border: 1px solid #2d3748;
    color: #64748b;
    cursor: pointer;
    transition: color 0.15s, border-color 0.15s, background 0.15s;
  }

  .substrate-btn.active {
    color: var(--s-color);
    border-color: var(--s-color);
    background: color-mix(in srgb, var(--s-color) 12%, transparent);
  }

  .substrate-btn:hover {
    border-color: var(--s-color);
    color: var(--s-color);
  }

  /* Weight slider */
  .weight-wrap {
    display: flex;
    align-items: center;
    gap: 0.375rem;
  }

  .weight-label {
    font-size: 0.75rem;
    color: #64748b;
    white-space: nowrap;
  }

  .weight-val {
    color: #94a3b8;
    font-variant-numeric: tabular-nums;
  }

  .weight-slider {
    width: 100px;
    accent-color: #3b82f6;
  }

  /* Full graph button */
  .full-graph-btn {
    padding: 0.25rem 0.75rem;
    border-radius: 4px;
    font-size: 0.75rem;
    font-weight: 500;
    background: rgba(59, 130, 246, 0.12);
    border: 1px solid rgba(59, 130, 246, 0.4);
    color: #3b82f6;
    cursor: pointer;
    transition: background 0.15s;
    white-space: nowrap;
  }

  .full-graph-btn:hover:not(:disabled) {
    background: rgba(59, 130, 246, 0.22);
  }

  .full-graph-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .full-graph-label {
    font-size: 0.6875rem;
    color: #22c55e;
  }

  /* Error banner */
  .error-banner {
    padding: 0.375rem 0.75rem;
    background: rgba(239, 68, 68, 0.1);
    border: 1px solid rgba(239, 68, 68, 0.35);
    border-radius: 6px;
    font-size: 0.8125rem;
    color: #ef4444;
  }

  /* ---- Body (canvas + side panel) --------------------------------------- */
  .lb-body {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: 1fr;
    gap: 0.625rem;
    overflow: hidden;
  }

  .lb-body.has-panel {
    grid-template-columns: 1fr 280px;
  }

  .lb-canvas {
    min-width: 0;
    border-radius: 8px;
    overflow: hidden;
  }

  /* Side panel */
  .lb-panel {
    background: #1a1f2e;
    border: 1px solid #2d3748;
    border-radius: 8px;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.5rem 0.875rem;
    border-bottom: 1px solid #2d3748;
  }

  .panel-title {
    font-size: 0.75rem;
    font-weight: 600;
    color: #64748b;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }

  .panel-close {
    background: none;
    border: none;
    color: #64748b;
    cursor: pointer;
    font-size: 1.125rem;
    line-height: 1;
    padding: 0 0.25rem;
    transition: color 0.15s;
  }

  .panel-close:hover {
    color: #f1f5f9;
  }

  .panel-loading,
  .panel-error {
    padding: 1rem;
    font-size: 0.8125rem;
    color: #64748b;
  }

  .panel-error {
    color: #ef4444;
  }

  .panel-body {
    padding: 0.875rem;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 0.625rem;
    flex: 1;
  }

  .panel-kind-badge {
    display: inline-block;
    padding: 0.2rem 0.5rem;
    border-radius: 4px;
    font-size: 0.6875rem;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    border: 1px solid;
    align-self: flex-start;
  }

  .panel-label {
    font-size: 0.875rem;
    font-weight: 600;
    color: #f1f5f9;
    word-break: break-word;
  }

  .panel-id,
  .panel-field {
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
  }

  .field-key {
    font-size: 0.6875rem;
    color: #475569;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .field-val {
    font-size: 0.8125rem;
    color: #94a3b8;
    word-break: break-all;
  }

  .field-val.mono {
    font-family: monospace;
    font-size: 0.75rem;
  }

  .panel-meta {
    margin-top: 0.25rem;
  }

  .meta-summary {
    font-size: 0.75rem;
    color: #64748b;
    cursor: pointer;
    user-select: none;
  }

  .meta-pre {
    margin-top: 0.375rem;
    padding: 0.5rem;
    background: #0f1117;
    border-radius: 4px;
    font-size: 0.6875rem;
    color: #94a3b8;
    overflow-x: auto;
    white-space: pre-wrap;
    word-break: break-all;
    line-height: 1.5;
    max-height: 260px;
  }

  /* ---- Legend bar ------------------------------------------------------- */
  .lb-legend {
    display: flex;
    gap: 1.5rem;
    padding: 0.5rem 0.875rem;
    background: #1a1f2e;
    border: 1px solid #2d3748;
    border-radius: 6px;
    flex-wrap: wrap;
    align-items: center;
  }

  .legend-section {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .legend-label {
    font-size: 0.6875rem;
    font-weight: 600;
    color: #475569;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin-right: 0.125rem;
  }

  .legend-item {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    font-size: 0.75rem;
    color: #94a3b8;
  }

  .legend-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .legend-line {
    width: 14px;
    height: 2px;
    flex-shrink: 0;
  }

  .legend-count {
    color: #475569;
    font-variant-numeric: tabular-nums;
    margin-left: 0.15rem;
  }

  .legend-todo {
    opacity: 0.55;
  }

  .todo-note {
    font-size: 0.6875rem;
    color: #475569;
    font-style: italic;
  }
</style>
