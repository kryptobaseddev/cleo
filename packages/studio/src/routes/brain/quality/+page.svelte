<script lang="ts">
  import { onMount } from 'svelte';

  interface QualityBucket {
    range: string;
    min: number;
    max: number;
    count: number;
  }

  interface TierCount {
    tier: string;
    count: number;
  }

  interface TypeCount {
    memory_type: string;
    count: number;
  }

  interface QualityData {
    observations: {
      buckets: QualityBucket[];
      tiers: TierCount[];
      types: TypeCount[];
      verified_count: number;
      prune_count: number;
      invalidated_count: number;
    };
    decisions: {
      buckets: QualityBucket[];
      verified_count: number;
      prune_count: number;
    };
    patterns: {
      buckets: QualityBucket[];
      verified_count: number;
    };
    learnings: {
      buckets: QualityBucket[];
      verified_count: number;
    };
  }

  let data: QualityData | null = $state(null);
  let loading = $state(true);
  let error: string | null = $state(null);

  const TIER_COLORS: Record<string, string> = {
    short: '#64748b',
    medium: '#3b82f6',
    long: '#22c55e',
    unknown: '#475569',
  };

  const TYPE_COLORS: Record<string, string> = {
    episodic: '#3b82f6',
    semantic: '#a855f7',
    procedural: '#f97316',
    unknown: '#475569',
  };

  const BUCKET_COLORS = ['#ef4444', '#f97316', '#f59e0b', '#84cc16', '#22c55e'];

  function maxBucket(buckets: QualityBucket[]): number {
    return Math.max(...buckets.map((b) => b.count), 1);
  }

  function barWidth(count: number, max: number): number {
    return Math.round((count / max) * 100);
  }

  function tierColor(t: string): string {
    return TIER_COLORS[t] ?? '#475569';
  }

  function typeColor(t: string): string {
    return TYPE_COLORS[t] ?? '#475569';
  }

  async function loadQuality(): Promise<void> {
    loading = true;
    error = null;
    try {
      const res = await fetch('/api/brain/quality');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      data = (await res.json()) as QualityData;
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load quality data';
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    loadQuality();
  });
</script>

<svelte:head>
  <title>BRAIN Quality — CLEO Studio</title>
</svelte:head>

<div class="quality-page">
  <div class="page-header">
    <a href="/brain/overview" class="back-link">← Overview</a>
    <h1 class="page-title">Quality Distribution</h1>
    <a href="/brain" class="canvas-pill">Open in Canvas &rarr;</a>
  </div>

  {#if loading}
    <div class="loading">Loading quality data…</div>
  {:else if error}
    <div class="error">{error}</div>
  {:else if data}
    <div class="panels">
      <!-- Observations quality -->
      <div class="panel">
        <h2 class="panel-title">Observations Quality</h2>
        <div class="summary-row">
          <div class="summary-chip verified">{data.observations.verified_count} verified</div>
          <div class="summary-chip prune">{data.observations.prune_count} prune</div>
          <div class="summary-chip invalid">{data.observations.invalidated_count} invalidated</div>
        </div>
        <div class="chart">
          {#each data.observations.buckets as bucket, i}
            <div class="bar-row">
              <span class="bar-label">{bucket.range}</span>
              <div class="bar-track">
                <div
                  class="bar-fill"
                  style="width:{barWidth(bucket.count, maxBucket(data.observations.buckets))}%;background:{BUCKET_COLORS[i]}"
                ></div>
              </div>
              <span class="bar-count">{bucket.count}</span>
            </div>
          {/each}
        </div>
      </div>

      <!-- Tier distribution -->
      <div class="panel">
        <h2 class="panel-title">Memory Tiers (Observations)</h2>
        <div class="donut-chart">
          {#each data.observations.tiers as tier}
            {@const tierTotal = data.observations.tiers.reduce((s, t) => s + t.count, 0)}
            <div class="donut-row">
              <div class="donut-bar-wrap">
                <div
                  class="donut-bar"
                  style="width:{Math.round((tier.count / Math.max(tierTotal, 1)) * 100)}%;background:{tierColor(tier.tier)}"
                ></div>
              </div>
              <span class="donut-label" style="color:{tierColor(tier.tier)}">{tier.tier}</span>
              <span class="donut-count">{tier.count}</span>
              <span class="donut-pct">{Math.round((tier.count / Math.max(tierTotal, 1)) * 100)}%</span>
            </div>
          {/each}
        </div>
      </div>

      <!-- Memory type distribution -->
      <div class="panel">
        <h2 class="panel-title">Memory Types (Observations)</h2>
        <div class="donut-chart">
          {#each data.observations.types as mt}
            {@const typeTotal = data.observations.types.reduce((s, t) => s + t.count, 0)}
            <div class="donut-row">
              <div class="donut-bar-wrap">
                <div
                  class="donut-bar"
                  style="width:{Math.round((mt.count / Math.max(typeTotal, 1)) * 100)}%;background:{typeColor(mt.memory_type)}"
                ></div>
              </div>
              <span class="donut-label" style="color:{typeColor(mt.memory_type)}">{mt.memory_type}</span>
              <span class="donut-count">{mt.count}</span>
              <span class="donut-pct">{Math.round((mt.count / Math.max(typeTotal, 1)) * 100)}%</span>
            </div>
          {/each}
        </div>
      </div>

      <!-- Decisions quality -->
      <div class="panel">
        <h2 class="panel-title">Decisions Quality</h2>
        <div class="summary-row">
          <div class="summary-chip verified">{data.decisions.verified_count} verified</div>
          <div class="summary-chip prune">{data.decisions.prune_count} prune</div>
        </div>
        <div class="chart">
          {#each data.decisions.buckets as bucket, i}
            <div class="bar-row">
              <span class="bar-label">{bucket.range}</span>
              <div class="bar-track">
                <div
                  class="bar-fill"
                  style="width:{barWidth(bucket.count, maxBucket(data.decisions.buckets))}%;background:{BUCKET_COLORS[i]}"
                ></div>
              </div>
              <span class="bar-count">{bucket.count}</span>
            </div>
          {/each}
        </div>
      </div>

      <!-- Patterns quality -->
      <div class="panel">
        <h2 class="panel-title">Patterns Quality</h2>
        <div class="summary-row">
          <div class="summary-chip verified">{data.patterns.verified_count} verified</div>
        </div>
        <div class="chart">
          {#each data.patterns.buckets as bucket, i}
            <div class="bar-row">
              <span class="bar-label">{bucket.range}</span>
              <div class="bar-track">
                <div
                  class="bar-fill"
                  style="width:{barWidth(bucket.count, maxBucket(data.patterns.buckets))}%;background:{BUCKET_COLORS[i]}"
                ></div>
              </div>
              <span class="bar-count">{bucket.count}</span>
            </div>
          {/each}
        </div>
      </div>

      <!-- Learnings quality -->
      <div class="panel">
        <h2 class="panel-title">Learnings Quality</h2>
        <div class="summary-row">
          <div class="summary-chip verified">{data.learnings.verified_count} verified</div>
        </div>
        <div class="chart">
          {#each data.learnings.buckets as bucket, i}
            <div class="bar-row">
              <span class="bar-label">{bucket.range}</span>
              <div class="bar-track">
                <div
                  class="bar-fill"
                  style="width:{barWidth(bucket.count, maxBucket(data.learnings.buckets))}%;background:{BUCKET_COLORS[i]}"
                ></div>
              </div>
              <span class="bar-count">{bucket.count}</span>
            </div>
          {/each}
        </div>
      </div>
    </div>
  {/if}
</div>

<style>
  .quality-page {
    max-width: 1000px;
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
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

  .loading,
  .error {
    text-align: center;
    padding: 3rem;
    font-size: 0.875rem;
    color: #64748b;
  }

  .error {
    color: #ef4444;
  }

  .panels {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
    gap: 1rem;
  }

  .panel {
    background: #1a1f2e;
    border: 1px solid #2d3748;
    border-radius: 8px;
    padding: 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.875rem;
  }

  .panel-title {
    font-size: 0.75rem;
    font-weight: 600;
    color: #94a3b8;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .summary-row {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .summary-chip {
    font-size: 0.6875rem;
    padding: 0.15rem 0.5rem;
    border-radius: 999px;
    font-weight: 500;
  }

  .summary-chip.verified {
    background: rgba(34, 197, 94, 0.15);
    color: #22c55e;
  }

  .summary-chip.prune {
    background: rgba(245, 158, 11, 0.15);
    color: #f59e0b;
  }

  .summary-chip.invalid {
    background: rgba(239, 68, 68, 0.15);
    color: #ef4444;
  }

  .chart {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .bar-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .bar-label {
    font-size: 0.6875rem;
    color: #64748b;
    width: 60px;
    flex-shrink: 0;
    font-variant-numeric: tabular-nums;
  }

  .bar-track {
    flex: 1;
    height: 8px;
    background: #0f1117;
    border-radius: 4px;
    overflow: hidden;
  }

  .bar-fill {
    height: 100%;
    border-radius: 4px;
    transition: width 0.3s ease;
    min-width: 2px;
  }

  .bar-count {
    font-size: 0.6875rem;
    color: #64748b;
    min-width: 28px;
    text-align: right;
    font-variant-numeric: tabular-nums;
  }

  .donut-chart {
    display: flex;
    flex-direction: column;
    gap: 0.625rem;
  }

  .donut-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .donut-bar-wrap {
    flex: 1;
    height: 6px;
    background: #0f1117;
    border-radius: 3px;
    overflow: hidden;
  }

  .donut-bar {
    height: 100%;
    border-radius: 3px;
    transition: width 0.3s ease;
    min-width: 2px;
  }

  .donut-label {
    font-size: 0.6875rem;
    font-weight: 600;
    min-width: 60px;
  }

  .donut-count {
    font-size: 0.6875rem;
    color: #64748b;
    min-width: 28px;
    text-align: right;
    font-variant-numeric: tabular-nums;
  }

  .donut-pct {
    font-size: 0.6875rem;
    color: #475569;
    min-width: 32px;
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
</style>
