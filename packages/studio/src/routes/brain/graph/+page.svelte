<script lang="ts">
  import { onMount } from 'svelte';
  import BrainGraph from '$lib/components/BrainGraph.svelte';

  interface BrainNode {
    id: string;
    node_type: string;
    label: string;
    quality_score: number;
    metadata_json: string | null;
    created_at: string;
  }

  interface BrainEdge {
    from_id: string;
    to_id: string;
    edge_type: string;
    weight: number;
    created_at: string;
  }

  let nodes: BrainNode[] = $state([]);
  let edges: BrainEdge[] = $state([]);
  let totalNodes = $state(0);
  let totalEdges = $state(0);
  let loading = $state(true);
  let error: string | null = $state(null);

  // Time slider
  let allDates: string[] = $state([]);
  let sliderIndex = $state(0);
  let filterDate: string | null = $state(null);
  let useTimeSlider = $state(false);

  const NODE_COLORS: Record<string, string> = {
    observation: '#3b82f6',
    decision: '#22c55e',
    pattern: '#a855f7',
    learning: '#f97316',
    task: '#6b7280',
    session: '#64748b',
    epic: '#f59e0b',
    sticky: '#ec4899',
  };

  const EDGE_COLORS: Record<string, string> = {
    supersedes: '#ef4444',
    applies_to: '#3b82f6',
    derived_from: '#22c55e',
    part_of: '#a855f7',
    produced_by: '#f97316',
    references: '#94a3b8',
  };

  function nodeColor(type: string): string {
    return NODE_COLORS[type] ?? '#94a3b8';
  }

  function edgeColor(type: string): string {
    return EDGE_COLORS[type] ?? '#475569';
  }

  async function loadGraph(): Promise<void> {
    loading = true;
    error = null;
    try {
      const res = await fetch('/api/memory/graph');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as {
        nodes: BrainNode[];
        edges: BrainEdge[];
        total_nodes: number;
        total_edges: number;
      };
      nodes = data.nodes;
      edges = data.edges;
      totalNodes = data.total_nodes;
      totalEdges = data.total_edges;

      // Build sorted date list for time slider
      const dates = [...new Set(nodes.map((n) => n.created_at.slice(0, 10)))].sort();
      allDates = dates;
      sliderIndex = dates.length - 1;
      filterDate = null;
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load graph data';
    } finally {
      loading = false;
    }
  }

  function onSliderChange(e: Event): void {
    const target = e.target as HTMLInputElement;
    sliderIndex = parseInt(target.value, 10);
    filterDate = useTimeSlider ? (allDates[sliderIndex] ?? null) : null;
  }

  function toggleSlider(): void {
    useTimeSlider = !useTimeSlider;
    filterDate = useTimeSlider ? (allDates[sliderIndex] ?? null) : null;
  }

  // Node type counts for legend
  let nodeTypeCounts = $derived(
    Object.entries(
      nodes.reduce<Record<string, number>>((acc, n) => {
        acc[n.node_type] = (acc[n.node_type] ?? 0) + 1;
        return acc;
      }, {}),
    ).sort((a, b) => b[1] - a[1]),
  );

  // Edge type counts
  let edgeTypeCounts = $derived(
    Object.entries(
      edges.reduce<Record<string, number>>((acc, e) => {
        acc[e.edge_type] = (acc[e.edge_type] ?? 0) + 1;
        return acc;
      }, {}),
    ).sort((a, b) => b[1] - a[1]),
  );

  onMount(() => {
    loadGraph();
  });
</script>

<svelte:head>
  <title>BRAIN Graph — CLEO Studio</title>
</svelte:head>

<div class="graph-page">
  <div class="graph-header">
    <div class="header-left">
      <a href="/brain/overview" class="back-link">← Overview</a>
      <h1 class="page-title">Knowledge Graph</h1>
      {#if !loading && !error}
        <span class="node-count">{totalNodes} nodes · {totalEdges} edges</span>
      {/if}
    </div>
    <div class="header-controls">
      <button class="toggle-btn" class:active={useTimeSlider} onclick={toggleSlider}>
        Time Slider {useTimeSlider ? 'On' : 'Off'}
      </button>
      {#if useTimeSlider && allDates.length > 0}
        <div class="slider-wrap">
          <input
            type="range"
            min={0}
            max={allDates.length - 1}
            value={sliderIndex}
            oninput={onSliderChange}
            class="time-slider"
          />
          <span class="slider-date">{allDates[sliderIndex] ?? ''}</span>
        </div>
      {/if}
    </div>
  </div>

  {#if loading}
    <div class="loading">Loading graph data…</div>
  {:else if error}
    <div class="error">{error}</div>
  {:else}
    <div class="graph-canvas">
      <BrainGraph {nodes} {edges} {filterDate} />
    </div>

    <div class="legend-bar">
      <div class="legend-section">
        <span class="legend-label">Nodes</span>
        {#each nodeTypeCounts as [type, count]}
          <div class="legend-item">
            <span class="legend-dot" style="background:{nodeColor(type)}"></span>
            <span>{type}</span>
            <span class="legend-count">{count}</span>
          </div>
        {/each}
      </div>
      <div class="legend-section">
        <span class="legend-label">Edges</span>
        {#each edgeTypeCounts as [type, count]}
          <div class="legend-item">
            <span class="legend-line" style="background:{edgeColor(type)}"></span>
            <span>{type}</span>
            <span class="legend-count">{count}</span>
          </div>
        {/each}
      </div>
      <div class="legend-section">
        <span class="legend-label">Tiers</span>
        <div class="legend-item">
          <span class="tier-ring thin solid"></span>
          <span>short</span>
        </div>
        <div class="legend-item">
          <span class="tier-ring medium dashed"></span>
          <span>medium</span>
        </div>
        <div class="legend-item">
          <span class="tier-ring thick solid"></span>
          <span>long</span>
        </div>
      </div>
    </div>
  {/if}
</div>

<style>
  .graph-page {
    display: flex;
    flex-direction: column;
    height: calc(100vh - 3rem - 4rem);
    gap: 0.75rem;
  }

  .graph-header {
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
  }

  .back-link {
    font-size: 0.8125rem;
    color: #64748b;
    text-decoration: none;
    transition: color 0.15s;
  }

  .back-link:hover {
    color: #22c55e;
  }

  .page-title {
    font-size: 1.125rem;
    font-weight: 700;
    color: #f1f5f9;
  }

  .node-count {
    font-size: 0.75rem;
    color: #64748b;
  }

  .header-controls {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    flex-wrap: wrap;
  }

  .toggle-btn {
    padding: 0.25rem 0.75rem;
    border-radius: 999px;
    font-size: 0.75rem;
    font-weight: 500;
    background: none;
    border: 1px solid #2d3748;
    color: #94a3b8;
    cursor: pointer;
    transition: color 0.15s, border-color 0.15s;
  }

  .toggle-btn:hover,
  .toggle-btn.active {
    color: #22c55e;
    border-color: #22c55e;
  }

  .slider-wrap {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .time-slider {
    width: 160px;
    accent-color: #22c55e;
  }

  .slider-date {
    font-size: 0.75rem;
    color: #94a3b8;
    font-variant-numeric: tabular-nums;
    min-width: 80px;
  }

  .loading,
  .error {
    display: flex;
    align-items: center;
    justify-content: center;
    flex: 1;
    font-size: 0.875rem;
    color: #64748b;
  }

  .error {
    color: #ef4444;
  }

  .graph-canvas {
    flex: 1;
    min-height: 0;
    border-radius: 8px;
    overflow: hidden;
  }

  .legend-bar {
    display: flex;
    gap: 1.5rem;
    padding: 0.625rem 0.875rem;
    background: #1a1f2e;
    border: 1px solid #2d3748;
    border-radius: 6px;
    flex-wrap: wrap;
  }

  .legend-section {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    flex-wrap: wrap;
  }

  .legend-label {
    font-size: 0.6875rem;
    font-weight: 600;
    color: #64748b;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin-right: 0.25rem;
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
  }

  .tier-ring {
    display: inline-block;
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: none;
    flex-shrink: 0;
  }

  .tier-ring.thin {
    border: 1px solid #94a3b8;
  }

  .tier-ring.medium {
    border: 1.5px dashed #94a3b8;
  }

  .tier-ring.thick {
    border: 2.5px solid #94a3b8;
  }
</style>
