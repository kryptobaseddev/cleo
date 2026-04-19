<!--
  /brain/tier-stats — per-table tier distribution + upcoming long-tier promotions.

  Layout:
    - Header: title + last-refreshed + refresh button
    - Grid of 4 cards (one per brain table) with stacked tier bars
    - Upcoming promotions list with countdowns
    - VerifyQueuePanel for ground-truth promotion

  @task T990
  @wave 1D
-->
<script lang="ts">
  import { Badge, Button, Card, EmptyState, Spinner } from '$lib/ui';
  import {
    PromotionCountdown,
    TierBadge,
    VerifyQueuePanel,
  } from '$lib/components/memory';
  import type { TierStatsResponse } from '$lib/../routes/api/memory/tier-stats/+server.js';
  import type { TierStatsPageData } from './+page.server.js';

  interface Props {
    data: TierStatsPageData;
  }

  let { data }: Props = $props();

  // SSR bootstrap: snapshot the props once so updates from refresh() replace the state
  // cleanly without re-reading the prop.
  const initialStats = data.stats;
  const initialLoadedAt = data.loadedAt;
  let stats = $state<TierStatsResponse | null>(initialStats);
  let loadedAt = $state<string>(initialLoadedAt);
  let loading = $state(false);
  let error = $state<string | null>(null);

  function tableDisplayName(t: string): string {
    return t.replace('brain_', '').replace(/_/g, ' ');
  }

  function tableTotal(row: TierStatsResponse['tables'][number]): number {
    return row.short + row.medium + row.long;
  }

  /** Stack bar percentages (three-segment). */
  function stackPct(row: TierStatsResponse['tables'][number]): {
    short: number;
    medium: number;
    long: number;
  } {
    const total = tableTotal(row);
    if (total === 0) return { short: 0, medium: 0, long: 0 };
    return {
      short: (row.short / total) * 100,
      medium: (row.medium / total) * 100,
      long: (row.long / total) * 100,
    };
  }

  async function refresh(): Promise<void> {
    loading = true;
    error = null;
    try {
      const res = await fetch('/api/memory/tier-stats');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      stats = (await res.json()) as TierStatsResponse;
      loadedAt = new Date().toISOString();
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to refresh tier stats';
    } finally {
      loading = false;
    }
  }

  function formatTime(iso: string): string {
    try {
      return new Date(iso).toLocaleTimeString('en-US', { hour12: false });
    } catch {
      return iso.slice(11, 19);
    }
  }

  function tableRoute(tbl: string): string {
    switch (tbl) {
      case 'brain_observations':
        return '/brain/observations';
      case 'brain_decisions':
        return '/brain/decisions';
      case 'brain_patterns':
        return '/brain/patterns';
      case 'brain_learnings':
        return '/brain/learnings';
      default:
        return '/brain';
    }
  }
</script>

<svelte:head>
  <title>BRAIN Tier Stats — CLEO Studio</title>
</svelte:head>

<section class="tier-page">
  <header class="page-head">
    <div class="head-left">
      <a class="back" href="/brain/overview">← Overview</a>
      <h1 class="title">Tier Stats</h1>
      <span class="subtitle">Short · Medium · Long retention split across memory tables</span>
    </div>
    <div class="head-right">
      <span class="updated">Updated {formatTime(loadedAt)}</span>
      <Button variant="secondary" size="sm" loading={loading} onclick={() => { void refresh(); }}>
        Refresh
      </Button>
    </div>
  </header>

  {#if error}
    <EmptyState
      title="Couldn't load tier stats"
      subtitle={error}
      variant="warning"
    >
      {#snippet action()}
        <Button variant="secondary" size="sm" onclick={() => { void refresh(); }}>Retry</Button>
      {/snippet}
    </EmptyState>
  {:else if !stats}
    <EmptyState
      title="brain.db not available"
      subtitle="Start a CLEO session to populate memory — then come back for the split."
    />
  {:else}
    <!-- Legend -->
    <div class="legend">
      <span class="legend-title">Tiers</span>
      <TierBadge tier="short" />
      <TierBadge tier="medium" />
      <TierBadge tier="long" />
    </div>

    <!-- Per-table cards -->
    <div class="grid">
      {#each stats.tables as row (row.table)}
        {@const total = tableTotal(row)}
        {@const pct = stackPct(row)}
        <Card>
          {#snippet header()}
            <a class="card-head" href={tableRoute(row.table)}>
              <span class="card-table">{tableDisplayName(row.table)}</span>
              <span class="card-total">
                <span class="total-number">{total}</span>
                <span class="total-label">entries</span>
              </span>
            </a>
          {/snippet}

          {#if total === 0}
            <p class="empty-table">No entries in this table yet.</p>
          {:else}
            <div class="stack" role="img" aria-label={`${tableDisplayName(row.table)} tier split`}>
              {#if pct.short > 0}
                <div class="seg seg-short" style="width:{pct.short}%" title={`short: ${row.short}`}>
                  {#if pct.short >= 12}<span class="seg-label">{row.short}</span>{/if}
                </div>
              {/if}
              {#if pct.medium > 0}
                <div class="seg seg-medium" style="width:{pct.medium}%" title={`medium: ${row.medium}`}>
                  {#if pct.medium >= 12}<span class="seg-label">{row.medium}</span>{/if}
                </div>
              {/if}
              {#if pct.long > 0}
                <div class="seg seg-long" style="width:{pct.long}%" title={`long: ${row.long}`}>
                  {#if pct.long >= 12}<span class="seg-label">{row.long}</span>{/if}
                </div>
              {/if}
            </div>

            <dl class="kv">
              <div>
                <dt><TierBadge tier="short" /></dt>
                <dd>{row.short}</dd>
              </div>
              <div>
                <dt><TierBadge tier="medium" /></dt>
                <dd>{row.medium}</dd>
              </div>
              <div>
                <dt><TierBadge tier="long" /></dt>
                <dd>{row.long}</dd>
              </div>
            </dl>
          {/if}
        </Card>
      {/each}
    </div>

    <!-- Upcoming promotions -->
    <Card>
      {#snippet header()}
        <div class="promo-head">
          <h2 class="promo-title">Upcoming long-tier promotions</h2>
          <span class="promo-sub">Medium entries closest to the 7-day citation gate</span>
        </div>
      {/snippet}

      {#if stats.upcomingLongPromotions.length === 0}
        <EmptyState
          title="Nothing queued"
          subtitle="Entries need ≥ 7 days age and citation ≥ 5 (or owner-verified) to promote."
        />
      {:else}
        <ul class="promo-list">
          {#each stats.upcomingLongPromotions as promo (promo.id)}
            <li class="promo-row">
              <a class="promo-id" href={tableRoute(promo.table)}>
                <code>{promo.id}</code>
              </a>
              <span class="promo-table-cell">{tableDisplayName(promo.table)}</span>
              <Badge tone="accent" size="sm" subtle>{promo.track}</Badge>
              <div class="promo-end">
                <PromotionCountdown daysUntil={promo.daysUntil} />
              </div>
            </li>
          {/each}
        </ul>
      {/if}
    </Card>

    <!-- Verify queue -->
    <VerifyQueuePanel limit={8} />
  {/if}
</section>

<style>
  .tier-page {
    max-width: 1100px;
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    gap: var(--space-6);
    font-family: var(--font-sans);
  }

  .page-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--space-4);
    flex-wrap: wrap;
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

  .subtitle {
    font-size: var(--text-sm);
    color: var(--text-dim);
  }

  .head-right {
    display: flex;
    align-items: center;
    gap: var(--space-3);
  }

  .updated {
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    color: var(--text-faint);
    letter-spacing: 0.04em;
  }

  .legend {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-3);
    background: var(--bg-elev-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    width: fit-content;
  }

  .legend-title {
    font-size: var(--text-2xs);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-faint);
    font-weight: 700;
    margin-right: var(--space-2);
  }

  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
    gap: var(--space-4);
  }

  .card-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    text-decoration: none;
    gap: var(--space-3);
  }

  .card-table {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--text-dim);
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }

  .card-total {
    display: inline-flex;
    align-items: baseline;
    gap: var(--space-1);
  }

  .total-number {
    font-size: var(--text-xl);
    font-weight: 700;
    color: var(--text);
    font-variant-numeric: tabular-nums;
  }

  .total-label {
    font-size: var(--text-2xs);
    color: var(--text-faint);
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }

  .empty-table {
    margin: 0;
    font-size: var(--text-xs);
    color: var(--text-faint);
    font-style: italic;
  }

  .stack {
    display: flex;
    align-items: stretch;
    height: 12px;
    border-radius: var(--radius-pill);
    overflow: hidden;
    background: var(--bg);
    border: 1px solid var(--border);
  }

  .seg {
    display: flex;
    align-items: center;
    justify-content: center;
    min-width: 2px;
    transition: width var(--ease-slow);
  }

  .seg-short {
    background: var(--text-faint);
  }

  .seg-medium {
    background: var(--info);
  }

  .seg-long {
    background: var(--success);
  }

  .seg-label {
    font-size: 0.625rem;
    font-weight: 700;
    color: var(--bg);
    letter-spacing: 0.04em;
  }

  .kv {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: var(--space-2);
    margin: var(--space-3) 0 0;
    padding: 0;
  }

  .kv > div {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--space-1);
  }

  .kv dt {
    margin: 0;
  }

  .kv dd {
    margin: 0;
    font-size: var(--text-md);
    font-weight: 600;
    color: var(--text);
    font-variant-numeric: tabular-nums;
  }

  .promo-head {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  .promo-title {
    margin: 0;
    font-size: var(--text-md);
    font-weight: 600;
    color: var(--text);
  }

  .promo-sub {
    font-size: var(--text-xs);
    color: var(--text-dim);
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
    padding: var(--space-3) 0;
    border-top: 1px solid var(--border);
  }

  .promo-row:first-child {
    border-top: none;
  }

  .promo-id {
    text-decoration: none;
  }

  .promo-id code {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--text);
    background: var(--bg-elev-2);
    padding: 2px var(--space-2);
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
  }

  .promo-id:hover code {
    border-color: var(--accent);
    color: var(--accent);
  }

  .promo-table-cell {
    font-size: var(--text-xs);
    color: var(--text-dim);
    font-family: var(--font-mono);
    letter-spacing: 0.04em;
  }

  .promo-end {
    text-align: right;
  }
</style>
