<script lang="ts">
  import type { PageData } from './$types';

  interface Props {
    data: PageData;
  }
  let { data }: Props = $props();

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

  const TIER_COLORS: Record<string, string> = {
    short: '#64748b',
    medium: '#3b82f6',
    long: '#22c55e',
    unknown: '#475569',
  };

  function nodeColor(type: string): string {
    return NODE_COLORS[type] ?? '#94a3b8';
  }

  function tierColor(tier: string): string {
    return TIER_COLORS[tier] ?? '#475569';
  }
</script>

<svelte:head>
  <title>BRAIN — CLEO Studio</title>
</svelte:head>

<div class="brain-overview">
  <div class="view-header">
    <div class="view-icon brain-icon">B</div>
    <div>
      <h1 class="view-title">BRAIN View</h1>
      <p class="view-subtitle">Knowledge Graph &amp; Memory Tiers</p>
    </div>
    <div class="header-nav">
      <a href="/brain/graph" class="nav-pill">Graph</a>
      <a href="/brain/decisions" class="nav-pill">Decisions</a>
      <a href="/brain/observations" class="nav-pill">Observations</a>
      <a href="/brain/quality" class="nav-pill">Quality</a>
    </div>
  </div>

  {#if !data.stats}
    <div class="no-data">
      <p>brain.db not found. Start a CLEO session to populate memory.</p>
    </div>
  {:else}
    <div class="stats-grid">
      {#each data.stats as stat}
        <div class="stat-card">
          <span class="stat-value">{stat.value}</span>
          <span class="stat-label">{stat.label}</span>
        </div>
      {/each}
    </div>

    <div class="panels">
      {#if data.nodeTypeCounts.length > 0}
        <div class="panel">
          <h2 class="panel-title">Node Types</h2>
          <div class="type-list">
            {#each data.nodeTypeCounts as item}
              <div class="type-row">
                <span class="type-dot" style="background:{nodeColor(item.node_type)}"></span>
                <span class="type-name">{item.node_type}</span>
                <span class="type-count">{item.count}</span>
              </div>
            {/each}
          </div>
        </div>
      {/if}

      {#if data.tierCounts.length > 0}
        <div class="panel">
          <h2 class="panel-title">Memory Tiers</h2>
          <div class="tier-list">
            {#each data.tierCounts as item}
              <div class="tier-row">
                <span class="tier-dot" style="background:{tierColor(item.tier)}"></span>
                <span class="tier-name">{item.tier}</span>
                <span class="tier-count">{item.count}</span>
              </div>
            {/each}
          </div>
        </div>
      {/if}

      {#if data.recentNodes.length > 0}
        <div class="panel panel-wide">
          <h2 class="panel-title">Recent Activity</h2>
          <div class="recent-list">
            {#each data.recentNodes as node}
              <div class="recent-row">
                <span class="recent-dot" style="background:{nodeColor(node.node_type)}"></span>
                <span class="recent-label">{node.label}</span>
                <span class="recent-type">{node.node_type}</span>
                <span class="recent-quality">{(node.quality_score ?? 0).toFixed(2)}</span>
                <span class="recent-date">{node.created_at.slice(0, 10)}</span>
              </div>
            {/each}
          </div>
        </div>
      {/if}
    </div>

    <div class="action-cards">
      <a href="/brain/graph" class="action-card">
        <div class="action-icon" style="background:rgba(59,130,246,0.15);color:#3b82f6">G</div>
        <div>
          <div class="action-title">Knowledge Graph</div>
          <div class="action-desc">Force-directed neural network with {data.stats[0].value} nodes</div>
        </div>
      </a>
      <a href="/brain/decisions" class="action-card">
        <div class="action-icon" style="background:rgba(34,197,94,0.15);color:#22c55e">D</div>
        <div>
          <div class="action-title">Decisions Timeline</div>
          <div class="action-desc">Chronological decision history with rationale</div>
        </div>
      </a>
      <a href="/brain/observations" class="action-card">
        <div class="action-icon" style="background:rgba(168,85,247,0.15);color:#a855f7">O</div>
        <div>
          <div class="action-title">Observations</div>
          <div class="action-desc">Filter by tier, type, and quality score</div>
        </div>
      </a>
      <a href="/brain/quality" class="action-card">
        <div class="action-icon" style="background:rgba(249,115,22,0.15);color:#f97316">Q</div>
        <div>
          <div class="action-title">Quality Distribution</div>
          <div class="action-desc">Score histograms and tier breakdowns</div>
        </div>
      </a>
    </div>
  {/if}
</div>

<style>
  .brain-overview {
    max-width: 1000px;
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    gap: 2rem;
  }

  .view-header {
    display: flex;
    align-items: center;
    gap: 1rem;
    flex-wrap: wrap;
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

  .header-nav {
    display: flex;
    gap: 0.5rem;
    margin-left: auto;
    flex-wrap: wrap;
  }

  .nav-pill {
    padding: 0.25rem 0.875rem;
    border-radius: 999px;
    font-size: 0.8125rem;
    font-weight: 500;
    color: #94a3b8;
    text-decoration: none;
    border: 1px solid #2d3748;
    transition:
      color 0.15s,
      border-color 0.15s;
  }

  .nav-pill:hover {
    color: #22c55e;
    border-color: #22c55e;
  }

  .no-data {
    padding: 2rem;
    background: #1a1f2e;
    border: 1px dashed #2d3748;
    border-radius: 8px;
    text-align: center;
    color: #64748b;
    font-size: 0.875rem;
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
    min-width: 110px;
  }

  .stat-value {
    font-size: 1.375rem;
    font-weight: 700;
    color: #f1f5f9;
    font-variant-numeric: tabular-nums;
  }

  .stat-label {
    font-size: 0.6875rem;
    color: #64748b;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .panels {
    display: flex;
    gap: 1rem;
    flex-wrap: wrap;
  }

  .panel {
    background: #1a1f2e;
    border: 1px solid #2d3748;
    border-radius: 8px;
    padding: 1rem;
    flex: 1;
    min-width: 200px;
  }

  .panel-wide {
    flex: 2;
    min-width: 320px;
  }

  .panel-title {
    font-size: 0.75rem;
    font-weight: 600;
    color: #94a3b8;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-bottom: 0.75rem;
  }

  .type-list,
  .tier-list {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
  }

  .type-row,
  .tier-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.8125rem;
  }

  .type-dot,
  .tier-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .type-name,
  .tier-name {
    flex: 1;
    color: #e2e8f0;
  }

  .type-count,
  .tier-count {
    color: #64748b;
    font-variant-numeric: tabular-nums;
  }

  .recent-list {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
  }

  .recent-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.75rem;
    padding: 0.25rem 0;
    border-bottom: 1px solid #1e2535;
  }

  .recent-row:last-child {
    border-bottom: none;
  }

  .recent-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .recent-label {
    flex: 1;
    color: #e2e8f0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 220px;
  }

  .recent-type {
    color: #64748b;
    font-size: 0.6875rem;
    min-width: 70px;
  }

  .recent-quality {
    color: #94a3b8;
    font-variant-numeric: tabular-nums;
    min-width: 35px;
    text-align: right;
  }

  .recent-date {
    color: #475569;
    white-space: nowrap;
  }

  .action-cards {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
    gap: 0.75rem;
  }

  .action-card {
    display: flex;
    align-items: center;
    gap: 0.875rem;
    padding: 1rem;
    background: #1a1f2e;
    border: 1px solid #2d3748;
    border-radius: 8px;
    text-decoration: none;
    transition:
      border-color 0.15s,
      background 0.15s;
  }

  .action-card:hover {
    border-color: #22c55e;
    background: #1c2130;
  }

  .action-icon {
    width: 2.5rem;
    height: 2.5rem;
    border-radius: 6px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-weight: 700;
    font-size: 1rem;
    flex-shrink: 0;
  }

  .action-title {
    font-size: 0.875rem;
    font-weight: 600;
    color: #e2e8f0;
    margin-bottom: 0.25rem;
  }

  .action-desc {
    font-size: 0.75rem;
    color: #64748b;
  }
</style>
