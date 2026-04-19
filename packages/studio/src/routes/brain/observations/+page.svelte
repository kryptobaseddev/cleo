<script lang="ts">
  import { onMount } from 'svelte';

  interface BrainObservation {
    id: string;
    type: string;
    title: string;
    subtitle: string | null;
    narrative: string | null;
    project: string | null;
    quality_score: number | null;
    memory_tier: string | null;
    memory_type: string | null;
    verified: number;
    valid_at: string | null;
    invalid_at: string | null;
    source_confidence: string | null;
    citation_count: number;
    prune_candidate: number;
    created_at: string;
  }

  let observations: BrainObservation[] = $state([]);
  let total = $state(0);
  let filtered = $state(0);
  let loading = $state(true);
  let error: string | null = $state(null);

  // Filters
  let tierFilter = $state('');
  let typeFilter = $state('');
  let minQuality = $state('');
  let searchText = $state('');
  let expandedId: string | null = $state(null);

  const TIER_OPTIONS = ['', 'short', 'medium', 'long'];
  const TYPE_OPTIONS = ['', 'episodic', 'semantic', 'procedural'];

  const NODE_COLORS: Record<string, string> = {
    observation: '#3b82f6',
    decision: '#22c55e',
    pattern: '#a855f7',
    learning: '#f97316',
  };

  const TIER_COLORS: Record<string, string> = {
    short: '#64748b',
    medium: '#3b82f6',
    long: '#22c55e',
  };

  function tierColor(t: string | null): string {
    return TIER_COLORS[t ?? 'short'] ?? '#64748b';
  }

  async function loadObservations(): Promise<void> {
    loading = true;
    error = null;
    try {
      const params = new URLSearchParams();
      if (tierFilter) params.set('tier', tierFilter);
      if (typeFilter) params.set('type', typeFilter);
      if (minQuality) params.set('min_quality', minQuality);

      const res = await fetch(`/api/memory/observations?${params.toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as {
        observations: BrainObservation[];
        total: number;
        filtered: number;
      };
      observations = data.observations;
      total = data.total;
      filtered = data.filtered;
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load observations';
    } finally {
      loading = false;
    }
  }

  let displayedObservations = $derived(
    searchText
      ? observations.filter(
          (o) =>
            o.title.toLowerCase().includes(searchText.toLowerCase()) ||
            (o.narrative ?? '').toLowerCase().includes(searchText.toLowerCase()),
        )
      : observations,
  );

  function toggle(id: string): void {
    expandedId = expandedId === id ? null : id;
  }

  function qualityBar(score: number | null): number {
    return Math.round((score ?? 0.5) * 100);
  }

  function qualityColor(score: number | null): string {
    const q = score ?? 0.5;
    if (q >= 0.7) return '#22c55e';
    if (q >= 0.4) return '#f59e0b';
    return '#ef4444';
  }

  onMount(() => {
    loadObservations();
  });
</script>

<svelte:head>
  <title>BRAIN Observations — CLEO Studio</title>
</svelte:head>

<div class="obs-page">
  <div class="page-header">
    <a href="/brain/overview" class="back-link">← Overview</a>
    <h1 class="page-title">Observations</h1>
    {#if !loading && !error}
      <span class="count-badge">{filtered} shown / {total} total</span>
    {/if}
    <a href="/brain?scope=brain&type=observation" class="canvas-pill">Open in Canvas &rarr;</a>
  </div>

  <div class="filters">
    <input
      class="search-input"
      type="text"
      placeholder="Search title or narrative…"
      bind:value={searchText}
    />
    <select class="filter-select" bind:value={tierFilter} onchange={loadObservations}>
      {#each TIER_OPTIONS as opt}
        <option value={opt}>{opt || 'All tiers'}</option>
      {/each}
    </select>
    <select class="filter-select" bind:value={typeFilter} onchange={loadObservations}>
      {#each TYPE_OPTIONS as opt}
        <option value={opt}>{opt || 'All types'}</option>
      {/each}
    </select>
    <input
      class="quality-input"
      type="number"
      min="0"
      max="1"
      step="0.1"
      placeholder="Min quality"
      bind:value={minQuality}
      onchange={loadObservations}
    />
    <button class="apply-btn" onclick={loadObservations}>Apply</button>
  </div>

  {#if loading}
    <div class="loading">Loading observations…</div>
  {:else if error}
    <div class="error">{error}</div>
  {:else if displayedObservations.length === 0}
    <div class="empty">No observations match the current filters.</div>
  {:else}
    <div class="obs-list">
      {#each displayedObservations as obs}
        <div
          class="obs-card"
          class:invalidated={!!obs.invalid_at}
          class:prune={!!obs.prune_candidate}
        >
          <button class="obs-header" onclick={() => toggle(obs.id)}>
            <div class="obs-meta">
              <span class="obs-date">{obs.created_at.slice(0, 10)}</span>
              <span class="obs-type" style="color:{NODE_COLORS[obs.type] ?? '#94a3b8'}">{obs.type}</span>
              {#if obs.memory_tier}
                <span class="tier-pill" style="border-color:{tierColor(obs.memory_tier)};color:{tierColor(obs.memory_tier)}"
                  >{obs.memory_tier}</span
                >
              {/if}
              {#if obs.memory_type}
                <span class="type-pill">{obs.memory_type}</span>
              {/if}
              {#if obs.verified}
                <span class="status-badge verified">verified</span>
              {/if}
              {#if obs.prune_candidate}
                <span class="status-badge prune">prune</span>
              {/if}
              {#if obs.invalid_at}
                <span class="status-badge invalid">invalidated</span>
              {/if}
              {#if obs.citation_count > 0}
                <span class="citation-count">{obs.citation_count} citations</span>
              {/if}
            </div>
            <div class="obs-title-row">
              <span class="obs-title">{obs.title}</span>
              <div class="quality-pill">
                <div
                  class="quality-fill"
                  style="width:{qualityBar(obs.quality_score)}%;background:{qualityColor(obs.quality_score)}"
                ></div>
                <span class="quality-label">{(obs.quality_score ?? 0.5).toFixed(2)}</span>
              </div>
            </div>
          </button>

          {#if expandedId === obs.id}
            <div class="obs-detail">
              {#if obs.subtitle}
                <p class="obs-subtitle">{obs.subtitle}</p>
              {/if}
              {#if obs.narrative}
                <div class="detail-section">
                  <span class="detail-label">Narrative</span>
                  <p class="detail-text">{obs.narrative}</p>
                </div>
              {/if}
              <div class="detail-footer">
                <span class="detail-id">{obs.id}</span>
                {#if obs.project}
                  <span class="detail-ctx">Project: {obs.project}</span>
                {/if}
                {#if obs.source_confidence}
                  <span class="detail-ctx">Source confidence: {obs.source_confidence}</span>
                {/if}
              </div>
            </div>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .obs-page {
    max-width: 900px;
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
  }

  .page-header {
    display: flex;
    align-items: center;
    gap: 1rem;
  }

  .back-link {
    font-size: 0.8125rem;
    color: #64748b;
    text-decoration: none;
  }

  .back-link:hover {
    color: #22c55e;
  }

  .canvas-pill {
    margin-left: auto;
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

  .page-title {
    font-size: 1.25rem;
    font-weight: 700;
    color: #f1f5f9;
  }

  .count-badge {
    font-size: 0.75rem;
    color: #64748b;
    padding: 0.125rem 0.5rem;
    background: #1a1f2e;
    border: 1px solid #2d3748;
    border-radius: 999px;
  }

  .filters {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
    align-items: center;
  }

  .search-input {
    flex: 1;
    min-width: 200px;
    padding: 0.375rem 0.625rem;
    background: #1a1f2e;
    border: 1px solid #2d3748;
    border-radius: 6px;
    color: #e2e8f0;
    font-size: 0.8125rem;
    outline: none;
  }

  .search-input::placeholder {
    color: #475569;
  }

  .search-input:focus {
    border-color: #22c55e;
  }

  .filter-select,
  .quality-input {
    padding: 0.375rem 0.625rem;
    background: #1a1f2e;
    border: 1px solid #2d3748;
    border-radius: 6px;
    color: #e2e8f0;
    font-size: 0.8125rem;
    outline: none;
    cursor: pointer;
  }

  .quality-input {
    width: 110px;
  }

  .apply-btn {
    padding: 0.375rem 0.875rem;
    background: rgba(34, 197, 94, 0.1);
    border: 1px solid #22c55e;
    border-radius: 6px;
    color: #22c55e;
    font-size: 0.8125rem;
    font-weight: 500;
    cursor: pointer;
    transition: background 0.15s;
  }

  .apply-btn:hover {
    background: rgba(34, 197, 94, 0.2);
  }

  .loading,
  .error,
  .empty {
    text-align: center;
    padding: 3rem;
    font-size: 0.875rem;
    color: #64748b;
  }

  .error {
    color: #ef4444;
  }

  .obs-list {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .obs-card {
    background: #1a1f2e;
    border: 1px solid #2d3748;
    border-radius: 8px;
    overflow: hidden;
    transition: border-color 0.15s;
  }

  .obs-card:hover {
    border-color: #3d4e6b;
  }

  .obs-card.invalidated {
    opacity: 0.45;
  }

  .obs-card.prune {
    border-left: 2px solid #f59e0b;
  }

  .obs-header {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    padding: 0.75rem 1rem;
    background: none;
    border: none;
    cursor: pointer;
    text-align: left;
    width: 100%;
  }

  .obs-meta {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .obs-date {
    font-size: 0.6875rem;
    color: #475569;
    font-variant-numeric: tabular-nums;
  }

  .obs-type {
    font-size: 0.6875rem;
    font-weight: 600;
  }

  .tier-pill,
  .type-pill {
    font-size: 0.6875rem;
    padding: 0.1rem 0.3rem;
    border-radius: 3px;
    border: 1px solid;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .type-pill {
    border-color: #2d3748;
    color: #64748b;
  }

  .status-badge {
    font-size: 0.6875rem;
    padding: 0.1rem 0.375rem;
    border-radius: 3px;
  }

  .status-badge.verified {
    background: rgba(34, 197, 94, 0.15);
    color: #22c55e;
  }

  .status-badge.prune {
    background: rgba(245, 158, 11, 0.15);
    color: #f59e0b;
  }

  .status-badge.invalid {
    background: rgba(239, 68, 68, 0.15);
    color: #ef4444;
  }

  .citation-count {
    font-size: 0.6875rem;
    color: #475569;
  }

  .obs-title-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
  }

  .obs-title {
    font-size: 0.875rem;
    color: #e2e8f0;
    font-weight: 500;
    flex: 1;
  }

  .quality-pill {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    flex-shrink: 0;
  }

  .quality-fill {
    height: 4px;
    width: 60px;
    border-radius: 2px;
    min-width: 4px;
  }

  .quality-label {
    font-size: 0.6875rem;
    color: #64748b;
    font-variant-numeric: tabular-nums;
    min-width: 28px;
  }

  .obs-detail {
    padding: 0.625rem 1rem 0.875rem;
    border-top: 1px solid #2d3748;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .obs-subtitle {
    font-size: 0.8125rem;
    color: #94a3b8;
    font-style: italic;
  }

  .detail-section {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .detail-label {
    font-size: 0.6875rem;
    font-weight: 600;
    color: #64748b;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .detail-text {
    font-size: 0.8125rem;
    color: #94a3b8;
    line-height: 1.5;
  }

  .detail-footer {
    display: flex;
    gap: 0.75rem;
    flex-wrap: wrap;
    padding-top: 0.375rem;
    border-top: 1px solid #2d3748;
  }

  .detail-id {
    font-size: 0.6875rem;
    color: #475569;
    font-family: monospace;
  }

  .detail-ctx {
    font-size: 0.6875rem;
    color: #64748b;
  }
</style>
