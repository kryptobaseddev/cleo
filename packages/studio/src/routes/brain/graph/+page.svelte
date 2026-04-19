<!--
  /brain/graph — retrospective force-directed view of the memory graph.

  Wave 1D pass: token-only styles + EmptyState / Spinner primitives.
  The underlying BrainGraph canvas is preserved (a future wave wires
  CosmosRenderer from $lib/graph/renderers).

  @task T990
  @wave 1D
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import BrainGraph from '$lib/components/BrainGraph.svelte';
  import { Button, EmptyState, Spinner } from '$lib/ui';

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

  let nodes = $state<BrainNode[]>([]);
  let edges = $state<BrainEdge[]>([]);
  let totalNodes = $state(0);
  let totalEdges = $state(0);
  let loading = $state(true);
  let error = $state<string | null>(null);

  let allDates = $state<string[]>([]);
  let sliderIndex = $state(0);
  let filterDate = $state<string | null>(null);
  let useTimeSlider = $state(false);

  const NODE_TINT: Record<string, string> = {
    observation: 'var(--info)',
    decision: 'var(--success)',
    pattern: 'var(--accent)',
    learning: 'var(--warning)',
    task: 'var(--text-faint)',
    session: 'var(--text-faint)',
    epic: 'var(--warning)',
    sticky: 'var(--danger)',
  };

  const EDGE_TINT: Record<string, string> = {
    supersedes: 'var(--danger)',
    applies_to: 'var(--info)',
    derived_from: 'var(--success)',
    part_of: 'var(--accent)',
    produced_by: 'var(--warning)',
    references: 'var(--text-dim)',
  };

  function nodeColor(type: string): string {
    return NODE_TINT[type] ?? 'var(--text-dim)';
  }

  function edgeColor(type: string): string {
    return EDGE_TINT[type] ?? 'var(--text-faint)';
  }

  async function load(): Promise<void> {
    loading = true;
    error = null;
    try {
      const res = await fetch('/api/memory/graph');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as {
        nodes: BrainNode[];
        edges: BrainEdge[];
        total_nodes: number;
        total_edges: number;
      };
      nodes = body.nodes;
      edges = body.edges;
      totalNodes = body.total_nodes;
      totalEdges = body.total_edges;

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
    sliderIndex = Number.parseInt(target.value, 10);
    filterDate = useTimeSlider ? (allDates[sliderIndex] ?? null) : null;
  }

  function toggleSlider(): void {
    useTimeSlider = !useTimeSlider;
    filterDate = useTimeSlider ? (allDates[sliderIndex] ?? null) : null;
  }

  const nodeTypeCounts = $derived(
    Object.entries(
      nodes.reduce<Record<string, number>>((acc, n) => {
        acc[n.node_type] = (acc[n.node_type] ?? 0) + 1;
        return acc;
      }, {}),
    ).sort((a, b) => b[1] - a[1]),
  );

  const edgeTypeCounts = $derived(
    Object.entries(
      edges.reduce<Record<string, number>>((acc, e) => {
        acc[e.edge_type] = (acc[e.edge_type] ?? 0) + 1;
        return acc;
      }, {}),
    ).sort((a, b) => b[1] - a[1]),
  );

  onMount(() => {
    void load();
  });
</script>

<svelte:head>
  <title>BRAIN Graph — CLEO Studio</title>
</svelte:head>

<section class="page">
  <header class="page-head">
    <div class="head-left">
      <a class="back" href="/brain/overview">← Overview</a>
      <h1 class="title">Knowledge graph</h1>
      {#if !loading && !error}
        <span class="count">
          <span class="count-n">{totalNodes}</span>
          <span class="count-div">·</span>
          <span class="count-n">{totalEdges}</span>
          <span class="count-label">nodes · edges</span>
        </span>
      {/if}
    </div>
    <div class="head-right">
      <button
        type="button"
        class="toggle-btn"
        class:on={useTimeSlider}
        aria-pressed={useTimeSlider}
        onclick={toggleSlider}
      >
        Time slider {useTimeSlider ? 'on' : 'off'}
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
            aria-label="Graph date filter"
          />
          <span class="slider-date">{allDates[sliderIndex] ?? ''}</span>
        </div>
      {/if}
    </div>
  </header>

  {#if loading}
    <div class="state">
      <Spinner size="md" />
      <span>Loading graph data…</span>
    </div>
  {:else if error}
    <EmptyState
      title="Couldn't load graph"
      subtitle={error}
      variant="warning"
    >
      {#snippet action()}
        <Button variant="secondary" size="sm" onclick={() => { void load(); }}>Retry</Button>
      {/snippet}
    </EmptyState>
  {:else if nodes.length === 0}
    <EmptyState
      title="No graph data"
      subtitle="brain.db exists but the PageIndex graph is empty. Run a session to populate it."
    />
  {:else}
    <div class="graph-canvas">
      <BrainGraph {nodes} {edges} {filterDate} />
    </div>

    <div class="legend-bar">
      <div class="legend-section">
        <span class="legend-label">Nodes</span>
        {#each nodeTypeCounts as [type, count] (type)}
          <span class="legend-item">
            <span class="legend-dot" style="background:{nodeColor(type)}"></span>
            <span class="legend-text">{type}</span>
            <span class="legend-count">{count}</span>
          </span>
        {/each}
      </div>
      <div class="legend-section">
        <span class="legend-label">Edges</span>
        {#each edgeTypeCounts as [type, count] (type)}
          <span class="legend-item">
            <span class="legend-line" style="background:{edgeColor(type)}"></span>
            <span class="legend-text">{type}</span>
            <span class="legend-count">{count}</span>
          </span>
        {/each}
      </div>
      <div class="legend-section">
        <span class="legend-label">Tiers</span>
        <span class="legend-item">
          <span class="tier-ring thin solid"></span>
          <span class="legend-text">short</span>
        </span>
        <span class="legend-item">
          <span class="tier-ring medium dashed"></span>
          <span class="legend-text">medium</span>
        </span>
        <span class="legend-item">
          <span class="tier-ring thick solid"></span>
          <span class="legend-text">long</span>
        </span>
      </div>
    </div>
  {/if}
</section>

<style>
  .page {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    height: calc(100vh - 3rem - 4rem);
    font-family: var(--font-sans);
  }

  .page-head {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: var(--space-3);
  }

  .head-left {
    display: flex;
    align-items: baseline;
    gap: var(--space-3);
  }

  .back {
    font-size: var(--text-xs);
    color: var(--text-faint);
    text-decoration: none;
    font-family: var(--font-mono);
    letter-spacing: 0.04em;
  }

  .back:hover {
    color: var(--accent);
  }

  .title {
    font-size: var(--text-lg);
    font-weight: 700;
    color: var(--text);
    margin: 0;
  }

  .count {
    display: inline-flex;
    align-items: baseline;
    gap: var(--space-1);
    font-family: var(--font-mono);
    font-variant-numeric: tabular-nums;
  }

  .count-n {
    font-size: var(--text-sm);
    color: var(--text);
    font-weight: 600;
  }

  .count-div {
    color: var(--text-faint);
  }

  .count-label {
    margin-left: var(--space-1);
    font-size: var(--text-2xs);
    color: var(--text-faint);
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }

  .head-right {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    flex-wrap: wrap;
  }

  .toggle-btn {
    background: none;
    border: 1px solid var(--border);
    color: var(--text-dim);
    font-family: var(--font-sans);
    font-size: var(--text-xs);
    font-weight: 500;
    padding: var(--space-1) var(--space-3);
    border-radius: var(--radius-pill);
    cursor: pointer;
    transition: color var(--ease), border-color var(--ease), background var(--ease);
  }

  .toggle-btn.on {
    color: var(--accent);
    border-color: var(--accent);
    background: var(--accent-halo);
  }

  .toggle-btn:hover {
    color: var(--text);
    border-color: var(--border-strong);
  }

  .toggle-btn:focus-visible {
    outline: none;
    box-shadow: var(--shadow-focus);
  }

  .slider-wrap {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  .time-slider {
    width: 180px;
    accent-color: var(--accent);
  }

  .slider-date {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--text-dim);
    font-variant-numeric: tabular-nums;
    min-width: 80px;
  }

  .state {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: var(--space-3);
    flex: 1;
    color: var(--text-dim);
    font-size: var(--text-sm);
  }

  .graph-canvas {
    flex: 1;
    min-height: 0;
    border-radius: var(--radius-lg);
    overflow: hidden;
    border: 1px solid var(--border);
  }

  .legend-bar {
    display: flex;
    gap: var(--space-5);
    padding: var(--space-2) var(--space-3);
    background: var(--bg-elev-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    flex-wrap: wrap;
  }

  .legend-section {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
  }

  .legend-label {
    font-size: var(--text-2xs);
    font-weight: 700;
    color: var(--text-faint);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    margin-right: var(--space-1);
  }

  .legend-item {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: var(--text-2xs);
    color: var(--text-dim);
  }

  .legend-dot {
    width: 8px;
    height: 8px;
    border-radius: var(--radius-pill);
    flex-shrink: 0;
  }

  .legend-line {
    width: 14px;
    height: 2px;
    flex-shrink: 0;
  }

  .legend-count {
    color: var(--text-faint);
    font-variant-numeric: tabular-nums;
  }

  .tier-ring {
    display: inline-block;
    width: 10px;
    height: 10px;
    border-radius: var(--radius-pill);
    background: none;
    flex-shrink: 0;
  }

  .tier-ring.thin {
    border: 1px solid var(--text-dim);
  }

  .tier-ring.medium {
    border: 1.5px dashed var(--text-dim);
  }

  .tier-ring.thick {
    border: 2.5px solid var(--text-dim);
  }
</style>
