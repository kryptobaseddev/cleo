<!--
  /brain/quality — quality distribution histograms + tier / type donuts.

  Wave 1D pass: tokenized styles, Spinner + EmptyState primitives, and
  upcoming-promotions panel pulled from `/api/memory/tier-stats` so the
  two surfaces stay in sync.

  @task T990
  @wave 1D
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { Badge, Button, Card, EmptyState, Spinner } from '$lib/ui';
  import { PromotionCountdown, VerifyQueuePanel } from '$lib/components/memory';
  import type { TierStatsResponse } from '$lib/../routes/api/memory/tier-stats/+server.js';

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

  let data = $state<QualityData | null>(null);
  let tierStats = $state<TierStatsResponse | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);

  /** Tier → token colour. */
  const TIER_TINT: Record<string, string> = {
    short: 'var(--text-faint)',
    medium: 'var(--info)',
    long: 'var(--success)',
    unknown: 'var(--border-strong)',
  };

  const TYPE_TINT: Record<string, string> = {
    episodic: 'var(--info)',
    semantic: 'var(--accent)',
    procedural: 'var(--warning)',
    unknown: 'var(--border-strong)',
  };

  /** Bucket-index → token colour (low→high). */
  const BUCKET_TINT = [
    'var(--danger)',
    'var(--warning)',
    'color-mix(in srgb, var(--warning) 60%, var(--success) 40%)',
    'color-mix(in srgb, var(--warning) 20%, var(--success) 80%)',
    'var(--success)',
  ];

  function maxBucket(buckets: QualityBucket[]): number {
    return Math.max(...buckets.map((b) => b.count), 1);
  }

  function barWidth(count: number, max: number): number {
    return Math.round((count / max) * 100);
  }

  async function load(): Promise<void> {
    loading = true;
    error = null;
    try {
      const [qRes, tsRes] = await Promise.all([
        fetch('/api/memory/quality'),
        fetch('/api/memory/tier-stats'),
      ]);
      if (!qRes.ok) throw new Error(`HTTP ${qRes.status}`);
      data = (await qRes.json()) as QualityData;
      if (tsRes.ok) {
        tierStats = (await tsRes.json()) as TierStatsResponse;
      }
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load quality data';
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    void load();
  });
</script>

<svelte:head>
  <title>BRAIN Quality — CLEO Studio</title>
</svelte:head>

<section class="page">
  <header class="page-head">
    <div class="head-left">
      <a class="back" href="/brain/overview">← Overview</a>
      <h1 class="title">Quality Distribution</h1>
    </div>
    <a class="canvas-pill" href="/brain">Open in Canvas →</a>
  </header>

  {#if loading}
    <div class="state">
      <Spinner size="md" />
      <span>Loading quality data…</span>
    </div>
  {:else if error}
    <EmptyState
      title="Couldn't load quality data"
      subtitle={error}
      variant="warning"
    >
      {#snippet action()}
        <Button variant="secondary" size="sm" onclick={() => { void load(); }}>Retry</Button>
      {/snippet}
    </EmptyState>
  {:else if !data}
    <EmptyState
      title="brain.db not available"
      subtitle="Start a CLEO session to populate memory, then return for the distribution."
    />
  {:else}
    {@const d = data}
    <div class="panels">
      <!-- Observations quality -->
      <Card>
        {#snippet header()}
          <div class="panel-head">
            <h2 class="panel-title">Observations quality</h2>
            <div class="summary-row">
              <Badge tone="success" size="sm">{d.observations.verified_count} verified</Badge>
              <Badge tone="warning" size="sm">{d.observations.prune_count} prune</Badge>
              <Badge tone="danger" size="sm">{d.observations.invalidated_count} invalid</Badge>
            </div>
          </div>
        {/snippet}
        <div class="chart">
          {#each d.observations.buckets as bucket, i (bucket.range)}
            <div class="bar-row">
              <span class="bar-label">{bucket.range}</span>
              <div class="bar-track">
                <div
                  class="bar-fill"
                  style="width:{barWidth(bucket.count, maxBucket(d.observations.buckets))}%;background:{BUCKET_TINT[i] ?? 'var(--text-faint)'}"
                ></div>
              </div>
              <span class="bar-count">{bucket.count}</span>
            </div>
          {/each}
        </div>
      </Card>

      <!-- Tier distribution -->
      <Card>
        {#snippet header()}
          <h2 class="panel-title">Memory tiers (observations)</h2>
        {/snippet}
        <div class="donut-chart">
          {#each d.observations.tiers as tier (tier.tier)}
            {@const tierTotal = d.observations.tiers.reduce((s, t) => s + t.count, 0)}
            {@const tint = TIER_TINT[tier.tier] ?? TIER_TINT.unknown}
            <div class="donut-row">
              <div class="donut-bar-wrap">
                <div
                  class="donut-bar"
                  style="width:{Math.round((tier.count / Math.max(tierTotal, 1)) * 100)}%;background:{tint}"
                ></div>
              </div>
              <span class="donut-label" style="color:{tint}">{tier.tier}</span>
              <span class="donut-count">{tier.count}</span>
              <span class="donut-pct">{Math.round((tier.count / Math.max(tierTotal, 1)) * 100)}%</span>
            </div>
          {/each}
        </div>
      </Card>

      <!-- Type distribution -->
      <Card>
        {#snippet header()}
          <h2 class="panel-title">Memory types (observations)</h2>
        {/snippet}
        <div class="donut-chart">
          {#each d.observations.types as mt (mt.memory_type)}
            {@const typeTotal = d.observations.types.reduce((s, t) => s + t.count, 0)}
            {@const tint = TYPE_TINT[mt.memory_type] ?? TYPE_TINT.unknown}
            <div class="donut-row">
              <div class="donut-bar-wrap">
                <div
                  class="donut-bar"
                  style="width:{Math.round((mt.count / Math.max(typeTotal, 1)) * 100)}%;background:{tint}"
                ></div>
              </div>
              <span class="donut-label" style="color:{tint}">{mt.memory_type}</span>
              <span class="donut-count">{mt.count}</span>
              <span class="donut-pct">{Math.round((mt.count / Math.max(typeTotal, 1)) * 100)}%</span>
            </div>
          {/each}
        </div>
      </Card>

      <!-- Decisions quality -->
      <Card>
        {#snippet header()}
          <div class="panel-head">
            <h2 class="panel-title">Decisions quality</h2>
            <div class="summary-row">
              <Badge tone="success" size="sm">{d.decisions.verified_count} verified</Badge>
              <Badge tone="warning" size="sm">{d.decisions.prune_count} prune</Badge>
            </div>
          </div>
        {/snippet}
        <div class="chart">
          {#each d.decisions.buckets as bucket, i (bucket.range)}
            <div class="bar-row">
              <span class="bar-label">{bucket.range}</span>
              <div class="bar-track">
                <div
                  class="bar-fill"
                  style="width:{barWidth(bucket.count, maxBucket(d.decisions.buckets))}%;background:{BUCKET_TINT[i] ?? 'var(--text-faint)'}"
                ></div>
              </div>
              <span class="bar-count">{bucket.count}</span>
            </div>
          {/each}
        </div>
      </Card>

      <!-- Patterns quality -->
      <Card>
        {#snippet header()}
          <div class="panel-head">
            <h2 class="panel-title">Patterns quality</h2>
            <div class="summary-row">
              <Badge tone="success" size="sm">{d.patterns.verified_count} verified</Badge>
            </div>
          </div>
        {/snippet}
        <div class="chart">
          {#each d.patterns.buckets as bucket, i (bucket.range)}
            <div class="bar-row">
              <span class="bar-label">{bucket.range}</span>
              <div class="bar-track">
                <div
                  class="bar-fill"
                  style="width:{barWidth(bucket.count, maxBucket(d.patterns.buckets))}%;background:{BUCKET_TINT[i] ?? 'var(--text-faint)'}"
                ></div>
              </div>
              <span class="bar-count">{bucket.count}</span>
            </div>
          {/each}
        </div>
      </Card>

      <!-- Learnings quality -->
      <Card>
        {#snippet header()}
          <div class="panel-head">
            <h2 class="panel-title">Learnings quality</h2>
            <div class="summary-row">
              <Badge tone="success" size="sm">{d.learnings.verified_count} verified</Badge>
            </div>
          </div>
        {/snippet}
        <div class="chart">
          {#each d.learnings.buckets as bucket, i (bucket.range)}
            <div class="bar-row">
              <span class="bar-label">{bucket.range}</span>
              <div class="bar-track">
                <div
                  class="bar-fill"
                  style="width:{barWidth(bucket.count, maxBucket(d.learnings.buckets))}%;background:{BUCKET_TINT[i] ?? 'var(--text-faint)'}"
                ></div>
              </div>
              <span class="bar-count">{bucket.count}</span>
            </div>
          {/each}
        </div>
      </Card>
    </div>

    <!-- Upcoming promotions (from tier-stats) -->
    {#if tierStats && tierStats.upcomingLongPromotions.length > 0}
      <Card>
        {#snippet header()}
          <div>
            <h2 class="panel-title">Upcoming long-tier promotions</h2>
            <span class="panel-sub">Ready-to-promote medium entries (top 5)</span>
          </div>
        {/snippet}
        <ul class="promo-list">
          {#each tierStats.upcomingLongPromotions as promo (promo.id)}
            <li class="promo-row">
              <code class="promo-id">{promo.id}</code>
              <span class="promo-table">{promo.table.replace('brain_', '')}</span>
              <Badge tone="accent" size="sm" subtle>{promo.track}</Badge>
              <div class="promo-end">
                <PromotionCountdown daysUntil={promo.daysUntil} />
              </div>
            </li>
          {/each}
        </ul>
      </Card>
    {/if}

    <VerifyQueuePanel limit={6} />
  {/if}
</section>

<style>
  .page {
    max-width: 1100px;
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    gap: var(--space-6);
    font-family: var(--font-sans);
  }

  .page-head {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: var(--space-4);
  }

  .head-left {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
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
    font-size: var(--text-2xl);
    font-weight: 700;
    color: var(--text);
    margin: 0;
    letter-spacing: -0.01em;
  }

  .canvas-pill {
    display: inline-flex;
    align-items: center;
    padding: 6px var(--space-3);
    border-radius: var(--radius-pill);
    font-size: var(--text-xs);
    font-weight: 500;
    color: var(--info);
    text-decoration: none;
    border: 1px solid color-mix(in srgb, var(--info) 40%, transparent);
    background: var(--info-soft);
    transition: background var(--ease), border-color var(--ease);
    white-space: nowrap;
  }

  .canvas-pill:hover {
    background: color-mix(in srgb, var(--info) 25%, transparent);
    border-color: var(--info);
  }

  .state {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: var(--space-3);
    padding: var(--space-8);
    color: var(--text-dim);
    font-size: var(--text-sm);
  }

  .panels {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
    gap: var(--space-4);
  }

  .panel-head {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .panel-title {
    margin: 0;
    font-size: var(--text-xs);
    font-weight: 700;
    color: var(--text-faint);
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }

  .panel-sub {
    font-size: var(--text-2xs);
    color: var(--text-faint);
    letter-spacing: 0.04em;
  }

  .summary-row {
    display: flex;
    gap: var(--space-1);
    flex-wrap: wrap;
  }

  .chart {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .bar-row {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  .bar-label {
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    color: var(--text-faint);
    width: 68px;
    flex-shrink: 0;
    font-variant-numeric: tabular-nums;
  }

  .bar-track {
    flex: 1;
    height: 8px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--radius-pill);
    overflow: hidden;
  }

  .bar-fill {
    height: 100%;
    border-radius: var(--radius-pill);
    transition: width var(--ease-slow);
    min-width: 2px;
  }

  .bar-count {
    font-size: var(--text-xs);
    color: var(--text-dim);
    min-width: 28px;
    text-align: right;
    font-variant-numeric: tabular-nums;
  }

  .donut-chart {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .donut-row {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  .donut-bar-wrap {
    flex: 1;
    height: 6px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--radius-pill);
    overflow: hidden;
  }

  .donut-bar {
    height: 100%;
    border-radius: var(--radius-pill);
    transition: width var(--ease-slow);
    min-width: 2px;
  }

  .donut-label {
    font-size: var(--text-2xs);
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    min-width: 60px;
  }

  .donut-count {
    font-size: var(--text-xs);
    color: var(--text-dim);
    min-width: 28px;
    text-align: right;
    font-variant-numeric: tabular-nums;
  }

  .donut-pct {
    font-size: var(--text-2xs);
    color: var(--text-faint);
    min-width: 32px;
    text-align: right;
    font-variant-numeric: tabular-nums;
  }

  .promo-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
  }

  .promo-row {
    display: grid;
    grid-template-columns: auto 1fr auto auto;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-2) 0;
    border-top: 1px solid var(--border);
  }

  .promo-row:first-child {
    border-top: none;
  }

  .promo-id {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--text);
    background: var(--bg-elev-2);
    padding: 2px var(--space-2);
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
  }

  .promo-table {
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    color: var(--text-dim);
    letter-spacing: 0.04em;
  }

  .promo-end {
    text-align: right;
  }
</style>
