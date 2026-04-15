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

  // T748: Tier distribution bar chart helpers
  function tableShortName(tbl: string): string {
    return tbl.replace('brain_', '');
  }

  function barMaxCount(dist: typeof data.tierDistribution): number {
    let max = 1;
    for (const d of dist) {
      const total = d.short + d.medium + d.long;
      if (total > max) max = total;
    }
    return max;
  }

  function pct(value: number, max: number): number {
    if (max === 0) return 0;
    return Math.round((value / max) * 100);
  }

  function formatDays(days: number): string {
    if (days < 0.1) return 'eligible now';
    if (days < 1) return `${Math.round(days * 24)}h`;
    return `${days.toFixed(1)}d`;
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
      <a href="/brain" class="nav-pill nav-pill--canvas">Open in Canvas &rarr;</a>
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

    <!-- T748: Per-table tier distribution bar chart -->
    {#if data.tierDistribution && data.tierDistribution.length > 0}
      {@const maxCount = barMaxCount(data.tierDistribution)}
      <div class="tier-chart-panel">
        <h2 class="panel-title">Tier Distribution by Table</h2>
        <div class="tier-chart-legend">
          <span class="legend-item"><span class="legend-swatch" style="background:#64748b"></span>Short</span>
          <span class="legend-item"><span class="legend-swatch" style="background:#3b82f6"></span>Medium</span>
          <span class="legend-item"><span class="legend-swatch" style="background:#22c55e"></span>Long</span>
        </div>
        <div class="tier-chart-rows">
          {#each data.tierDistribution as dist}
            <div class="chart-row">
              <span class="chart-label">{tableShortName(dist.table)}</span>
              <div class="chart-bars">
                {#if dist.short > 0}
                  <div
                    class="chart-bar chart-bar--short"
                    style="width:{pct(dist.short, maxCount)}%"
                    title="short: {dist.short}"
                  >
                    {#if pct(dist.short, maxCount) > 12}<span class="bar-label">{dist.short}</span>{/if}
                  </div>
                {/if}
                {#if dist.medium > 0}
                  <div
                    class="chart-bar chart-bar--medium"
                    style="width:{pct(dist.medium, maxCount)}%"
                    title="medium: {dist.medium}"
                  >
                    {#if pct(dist.medium, maxCount) > 12}<span class="bar-label">{dist.medium}</span>{/if}
                  </div>
                {/if}
                {#if dist.long > 0}
                  <div
                    class="chart-bar chart-bar--long"
                    style="width:{pct(dist.long, maxCount)}%"
                    title="long: {dist.long}"
                  >
                    {#if pct(dist.long, maxCount) > 12}<span class="bar-label">{dist.long}</span>{/if}
                  </div>
                {/if}
                {#if dist.short === 0 && dist.medium === 0 && dist.long === 0}
                  <span class="chart-empty">empty</span>
                {/if}
              </div>
              <span class="chart-total">{dist.short + dist.medium + dist.long}</span>
            </div>
          {/each}
        </div>
      </div>
    {/if}

    <!-- T748: Long-tier promotion countdown -->
    {#if data.upcomingPromotions && data.upcomingPromotions.length > 0}
      <div class="promo-panel">
        <h2 class="panel-title">Upcoming Long-Tier Promotions</h2>
        <p class="promo-subtitle">Medium entries eligible for long-tier after 7-day gate</p>
        <div class="promo-list">
          {#each data.upcomingPromotions as promo}
            <div class="promo-row">
              <span class="promo-table">{tableShortName(promo.table)}</span>
              <span class="promo-id">{promo.id}</span>
              <span class="promo-track">{promo.track}</span>
              <span class="promo-countdown" class:promo-ready={promo.daysUntil < 0.1}>
                {formatDays(promo.daysUntil)}
              </span>
            </div>
          {/each}
        </div>
      </div>
    {:else if data.stats}
      <div class="promo-panel promo-panel--empty">
        <h2 class="panel-title">Long-Tier Promotions</h2>
        <p class="promo-empty-msg">No entries currently qualify for long-tier promotion. Entries need 7 days age + citation&nbsp;&ge;&nbsp;5 or owner-verified.</p>
      </div>
    {/if}

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

  .nav-pill--canvas {
    color: #3b82f6;
    border-color: rgba(59, 130, 246, 0.4);
    background: rgba(59, 130, 246, 0.08);
  }

  .nav-pill--canvas:hover {
    color: #3b82f6;
    border-color: #3b82f6;
    background: rgba(59, 130, 246, 0.18);
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

  /* T748: Tier distribution bar chart */
  .tier-chart-panel {
    background: #1a1f2e;
    border: 1px solid #2d3748;
    border-radius: 8px;
    padding: 1rem;
  }

  .tier-chart-legend {
    display: flex;
    gap: 1rem;
    margin-bottom: 0.75rem;
  }

  .legend-item {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    font-size: 0.75rem;
    color: #94a3b8;
  }

  .legend-swatch {
    width: 10px;
    height: 10px;
    border-radius: 2px;
    flex-shrink: 0;
  }

  .tier-chart-rows {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .chart-row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    font-size: 0.8125rem;
  }

  .chart-label {
    width: 90px;
    flex-shrink: 0;
    color: #94a3b8;
    font-size: 0.75rem;
  }

  .chart-bars {
    flex: 1;
    display: flex;
    gap: 2px;
    height: 22px;
    align-items: stretch;
    min-width: 0;
  }

  .chart-bar {
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 3px;
    min-width: 4px;
    transition: width 0.2s;
    overflow: hidden;
  }

  .chart-bar--short {
    background: #64748b;
  }

  .chart-bar--medium {
    background: #3b82f6;
  }

  .chart-bar--long {
    background: #22c55e;
  }

  .bar-label {
    font-size: 0.6875rem;
    font-weight: 600;
    color: rgba(255, 255, 255, 0.85);
    padding: 0 4px;
    white-space: nowrap;
  }

  .chart-empty {
    color: #475569;
    font-size: 0.75rem;
    align-self: center;
  }

  .chart-total {
    width: 40px;
    text-align: right;
    color: #475569;
    font-size: 0.75rem;
    font-variant-numeric: tabular-nums;
    flex-shrink: 0;
  }

  /* T748: Promotion countdown */
  .promo-panel {
    background: #1a1f2e;
    border: 1px solid #2d3748;
    border-radius: 8px;
    padding: 1rem;
  }

  .promo-panel--empty {
    border-style: dashed;
  }

  .promo-subtitle {
    font-size: 0.75rem;
    color: #475569;
    margin-bottom: 0.75rem;
  }

  .promo-empty-msg {
    font-size: 0.8125rem;
    color: #475569;
  }

  .promo-list {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
  }

  .promo-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.8125rem;
    padding: 0.25rem 0;
    border-bottom: 1px solid #1e2535;
  }

  .promo-row:last-child {
    border-bottom: none;
  }

  .promo-table {
    width: 80px;
    flex-shrink: 0;
    font-size: 0.6875rem;
    color: #64748b;
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }

  .promo-id {
    flex: 1;
    color: #94a3b8;
    font-family: monospace;
    font-size: 0.75rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
  }

  .promo-track {
    color: #64748b;
    font-size: 0.6875rem;
    white-space: nowrap;
    flex-shrink: 0;
  }

  .promo-countdown {
    font-size: 0.8125rem;
    font-weight: 600;
    color: #3b82f6;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    flex-shrink: 0;
    min-width: 60px;
    text-align: right;
  }

  .promo-countdown.promo-ready {
    color: #22c55e;
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
