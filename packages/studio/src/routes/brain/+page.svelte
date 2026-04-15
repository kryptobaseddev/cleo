<script lang="ts">
  import type { PageData } from './$types';

  interface Props {
    data: PageData;
  }
  let { data }: Props = $props();
</script>

<svelte:head>
  <title>BRAIN — CLEO Studio</title>
</svelte:head>

<div class="placeholder-view">
  <div class="view-header">
    <div class="view-icon brain-icon">B</div>
    <div>
      <h1 class="view-title">BRAIN View</h1>
      <p class="view-subtitle">Memory Visualization</p>
    </div>
  </div>

  <div class="coming-soon">
    <p class="coming-soon-text">BRAIN View coming soon</p>
    <p class="coming-soon-detail">
      Force-directed memory graph, decision timeline, quality scores, and tier distribution — delivered
      by T579 workers.
    </p>
  </div>

  {#if data.stats}
    <div class="stats-preview">
      <h2 class="stats-title">Live Data Ready</h2>
      <div class="stats-grid">
        {#each data.stats as stat}
          <div class="stat-card">
            <span class="stat-value">{stat.value}</span>
            <span class="stat-label">{stat.label}</span>
          </div>
        {/each}
      </div>
    </div>
  {/if}
</div>

<style>
  .placeholder-view {
    max-width: 700px;
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    gap: 2rem;
  }

  .view-header {
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
  }

  .brain-icon {
    background: rgba(34, 197, 94, 0.15);
    color: #22c55e;
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

  .coming-soon {
    padding: 2rem;
    background: #1a1f2e;
    border: 1px dashed #2d3748;
    border-radius: 8px;
    text-align: center;
  }

  .coming-soon-text {
    font-size: 1.125rem;
    font-weight: 600;
    color: #22c55e;
    margin-bottom: 0.75rem;
  }

  .coming-soon-detail {
    font-size: 0.875rem;
    color: #64748b;
    line-height: 1.6;
    max-width: 420px;
    margin: 0 auto;
  }

  .stats-preview {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .stats-title {
    font-size: 0.875rem;
    font-weight: 600;
    color: #94a3b8;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .stats-grid {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
  }

  .stat-card {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    padding: 0.75rem 1rem;
    background: #1a1f2e;
    border: 1px solid #2d3748;
    border-radius: 6px;
    min-width: 120px;
  }

  .stat-value {
    font-size: 1.25rem;
    font-weight: 600;
    color: #f1f5f9;
    font-variant-numeric: tabular-nums;
  }

  .stat-label {
    font-size: 0.75rem;
    color: #64748b;
  }
</style>
