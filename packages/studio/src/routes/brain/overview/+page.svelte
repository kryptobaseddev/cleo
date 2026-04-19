<!--
  /brain/overview — landing page for the memory surface.

  Wave 1D: tokenized, navigable action cards, pulled all data through the
  /api/memory/* layer (kills direct-SQL drift), added promotion-countdown
  + latest-N observations/decisions panels, and wired the VerifyQueuePanel.

  @task T990
  @wave 1D
-->
<script lang="ts">
  import { Badge, Card, EmptyState } from '$lib/ui';
  import {
    PromotionCountdown,
    QualityBar,
    TierBadge,
    VerifyQueuePanel,
  } from '$lib/components/memory';
  import type { PageData } from './$types';

  interface Props {
    data: PageData;
  }

  let { data }: Props = $props();

  function tableShort(t: string): string {
    return t.replace('brain_', '');
  }

  function barMax(dist: typeof data.tierDistribution): number {
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
</script>

<svelte:head>
  <title>BRAIN — CLEO Studio</title>
</svelte:head>

<section class="overview">
  <header class="view-head">
    <div class="view-ident">
      <div class="view-icon" aria-hidden="true">B</div>
      <div>
        <h1 class="view-title">BRAIN</h1>
        <p class="view-sub">Cognitive memory · observations · decisions · patterns · learnings</p>
      </div>
    </div>
    <nav class="view-nav" aria-label="Brain navigation">
      <a href="/brain" class="nav-pill nav-pill--canvas">Open in Canvas →</a>
      <a href="/brain/search" class="nav-pill">Search</a>
      <a href="/brain/causal" class="nav-pill">Causal</a>
      <a href="/brain/tier-stats" class="nav-pill">Tier stats</a>
      <a href="/brain/quality" class="nav-pill">Quality</a>
      <a href="/brain/graph" class="nav-pill">Graph</a>
    </nav>
  </header>

  {#if !data.stats}
    <EmptyState
      title="brain.db not found"
      subtitle="Start a CLEO session to populate memory; this view will light up as entries are recorded."
    />
  {:else}
    <!-- Stats -->
    <div class="stats-grid">
      {#each data.stats as stat (stat.label)}
        <article class="stat">
          <span class="stat-value">{stat.value}</span>
          <span class="stat-label">{stat.label}</span>
        </article>
      {/each}
    </div>

    <!-- Tier distribution -->
    {#if data.tierDistribution.length > 0}
      {@const maxCount = barMax(data.tierDistribution)}
      <Card>
        {#snippet header()}
          <div class="panel-head">
            <h2 class="panel-title">Tier distribution by table</h2>
            <div class="legend">
              <TierBadge tier="short" />
              <TierBadge tier="medium" />
              <TierBadge tier="long" />
            </div>
          </div>
        {/snippet}
        <div class="chart-rows">
          {#each data.tierDistribution as dist (dist.table)}
            <a class="chart-row" href={`/brain/${tableShort(dist.table)}`}>
              <span class="chart-label">{tableShort(dist.table)}</span>
              <div class="chart-bars" aria-hidden="true">
                {#if dist.short > 0}
                  <span class="seg seg-short" style="width:{pct(dist.short, maxCount)}%">
                    {#if pct(dist.short, maxCount) > 12}<span class="seg-n">{dist.short}</span>{/if}
                  </span>
                {/if}
                {#if dist.medium > 0}
                  <span class="seg seg-medium" style="width:{pct(dist.medium, maxCount)}%">
                    {#if pct(dist.medium, maxCount) > 12}<span class="seg-n">{dist.medium}</span>{/if}
                  </span>
                {/if}
                {#if dist.long > 0}
                  <span class="seg seg-long" style="width:{pct(dist.long, maxCount)}%">
                    {#if pct(dist.long, maxCount) > 12}<span class="seg-n">{dist.long}</span>{/if}
                  </span>
                {/if}
                {#if dist.short === 0 && dist.medium === 0 && dist.long === 0}
                  <span class="seg-empty">empty</span>
                {/if}
              </div>
              <span class="chart-total">{dist.short + dist.medium + dist.long}</span>
            </a>
          {/each}
        </div>
      </Card>
    {/if}

    <!-- Dual column: promotions + verify queue -->
    <div class="dual">
      <Card>
        {#snippet header()}
          <div>
            <h2 class="panel-title">Upcoming long-tier promotions</h2>
            <span class="panel-sub">Medium entries eligible after the 7-day citation gate</span>
          </div>
        {/snippet}
        {#if data.upcomingPromotions.length === 0}
          <EmptyState
            title="Nothing queued"
            subtitle="Entries need ≥ 7 days age plus citation ≥ 5 (or owner-verified) to promote."
          />
        {:else}
          <ul class="promo-list">
            {#each data.upcomingPromotions as promo (promo.id)}
              <li class="promo-row">
                <code class="promo-id">{promo.id}</code>
                <span class="promo-table">{tableShort(promo.table)}</span>
                <Badge tone="accent" size="sm" subtle>{promo.track}</Badge>
                <div class="promo-end">
                  <PromotionCountdown daysUntil={promo.daysUntil} />
                </div>
              </li>
            {/each}
          </ul>
        {/if}
      </Card>

      <VerifyQueuePanel limit={6} />
    </div>

    <!-- Recent observations & decisions -->
    <div class="dual">
      <Card>
        {#snippet header()}
          <div class="panel-head">
            <h2 class="panel-title">Recent observations</h2>
            <a class="panel-link" href="/brain/observations">See all →</a>
          </div>
        {/snippet}
        {#if data.recentObservations.length === 0}
          <EmptyState title="No observations yet" />
        {:else}
          <ul class="recent-list">
            {#each data.recentObservations as o (o.id)}
              <li class="recent-row">
                <span class="recent-head">
                  <code class="recent-id">{o.id}</code>
                  <TierBadge tier={o.memory_tier} />
                  <Badge tone="info" size="sm" subtle>{o.type}</Badge>
                  <span class="recent-date">{o.created_at.slice(0, 10)}</span>
                </span>
                <span class="recent-body">
                  <span class="recent-title">{o.title}</span>
                  <QualityBar score={o.quality_score} width={60} showLabel={false} />
                </span>
              </li>
            {/each}
          </ul>
        {/if}
      </Card>

      <Card>
        {#snippet header()}
          <div class="panel-head">
            <h2 class="panel-title">Recent decisions</h2>
            <a class="panel-link" href="/brain/decisions">See all →</a>
          </div>
        {/snippet}
        {#if data.recentDecisions.length === 0}
          <EmptyState title="No decisions yet" />
        {:else}
          <ul class="recent-list">
            {#each data.recentDecisions as d (d.id)}
              <li class="recent-row">
                <span class="recent-head">
                  <code class="recent-id">{d.id}</code>
                  <TierBadge tier={d.memory_tier} />
                  <Badge tone={d.confidence === 'high' ? 'success' : d.confidence === 'low' ? 'danger' : 'warning'} size="sm">{d.confidence ?? 'unknown'}</Badge>
                  <span class="recent-date">{d.created_at.slice(0, 10)}</span>
                </span>
                <span class="recent-body">
                  <span class="recent-title">{d.decision}</span>
                </span>
              </li>
            {/each}
          </ul>
        {/if}
      </Card>
    </div>

    <!-- Action cards -->
    <div class="actions">
      <a href="/brain/graph" class="action">
        <span class="action-icon">G</span>
        <span class="action-body">
          <span class="action-title">Knowledge graph</span>
          <span class="action-desc">Force-directed view of the full substrate</span>
        </span>
      </a>
      <a href="/brain/decisions" class="action">
        <span class="action-icon">D</span>
        <span class="action-body">
          <span class="action-title">Decisions</span>
          <span class="action-desc">Timeline with rationale + outcomes</span>
        </span>
      </a>
      <a href="/brain/observations" class="action">
        <span class="action-icon">O</span>
        <span class="action-body">
          <span class="action-title">Observations</span>
          <span class="action-desc">Filter by tier, type, and quality</span>
        </span>
      </a>
      <a href="/brain/patterns" class="action">
        <span class="action-icon">P</span>
        <span class="action-body">
          <span class="action-title">Patterns</span>
          <span class="action-desc">Recurring workflow signals</span>
        </span>
      </a>
      <a href="/brain/learnings" class="action">
        <span class="action-icon">L</span>
        <span class="action-body">
          <span class="action-title">Learnings</span>
          <span class="action-desc">Actionable insights with confidence</span>
        </span>
      </a>
      <a href="/brain/search" class="action">
        <span class="action-icon">S</span>
        <span class="action-body">
          <span class="action-title">Search</span>
          <span class="action-desc">Cross-table FTS retrieval</span>
        </span>
      </a>
      <a href="/brain/causal" class="action">
        <span class="action-icon">C</span>
        <span class="action-body">
          <span class="action-title">Causal reasoning</span>
          <span class="action-desc">Trace blocker chains to the root</span>
        </span>
      </a>
      <a href="/brain/tier-stats" class="action">
        <span class="action-icon">T</span>
        <span class="action-body">
          <span class="action-title">Tier stats</span>
          <span class="action-desc">Retention split + verify queue</span>
        </span>
      </a>
    </div>
  {/if}
</section>

<style>
  .overview {
    max-width: 1150px;
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    gap: var(--space-6);
    font-family: var(--font-sans);
  }

  .view-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: var(--space-4);
  }

  .view-ident {
    display: flex;
    align-items: center;
    gap: var(--space-3);
  }

  .view-icon {
    width: 48px;
    height: 48px;
    border-radius: var(--radius-lg);
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: var(--font-mono);
    font-size: var(--text-xl);
    font-weight: 700;
    color: var(--accent);
    background: var(--accent-halo);
    border: 1px solid var(--accent);
  }

  .view-title {
    margin: 0;
    font-size: var(--text-2xl);
    font-weight: 700;
    color: var(--text);
    letter-spacing: -0.01em;
  }

  .view-sub {
    margin: 0;
    font-size: var(--text-xs);
    color: var(--text-dim);
  }

  .view-nav {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
  }

  .nav-pill {
    display: inline-flex;
    align-items: center;
    padding: 6px var(--space-3);
    border-radius: var(--radius-pill);
    font-size: var(--text-xs);
    font-weight: 500;
    color: var(--text-dim);
    text-decoration: none;
    border: 1px solid var(--border);
    transition: color var(--ease), border-color var(--ease), background var(--ease);
  }

  .nav-pill:hover {
    color: var(--accent);
    border-color: var(--accent);
  }

  .nav-pill:focus-visible {
    outline: none;
    box-shadow: var(--shadow-focus);
  }

  .nav-pill--canvas {
    color: var(--info);
    border-color: color-mix(in srgb, var(--info) 40%, transparent);
    background: var(--info-soft);
  }

  .nav-pill--canvas:hover {
    color: var(--info);
    border-color: var(--info);
    background: color-mix(in srgb, var(--info) 25%, transparent);
  }

  .stats-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
    gap: var(--space-3);
  }

  .stat {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    padding: var(--space-3) var(--space-4);
    background: var(--bg-elev-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
  }

  .stat-value {
    font-size: var(--text-xl);
    font-weight: 700;
    color: var(--text);
    font-variant-numeric: tabular-nums;
  }

  .stat-label {
    font-size: var(--text-2xs);
    color: var(--text-faint);
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }

  .panel-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
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

  .panel-link {
    font-size: var(--text-2xs);
    color: var(--accent);
    text-decoration: none;
    letter-spacing: 0.04em;
  }

  .panel-link:hover {
    text-decoration: underline;
  }

  .legend {
    display: inline-flex;
    gap: var(--space-1);
  }

  .chart-rows {
    display: flex;
    flex-direction: column;
  }

  .chart-row {
    display: grid;
    grid-template-columns: 100px 1fr 42px;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-2) 0;
    border-top: 1px solid var(--border);
    text-decoration: none;
    color: inherit;
  }

  .chart-row:first-child {
    border-top: none;
  }

  .chart-row:hover .chart-label {
    color: var(--accent);
  }

  .chart-label {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--text-dim);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    transition: color var(--ease);
  }

  .chart-bars {
    display: flex;
    gap: 2px;
    height: 20px;
    align-items: stretch;
    min-width: 0;
  }

  .seg {
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: var(--radius-xs);
    min-width: 4px;
    transition: width var(--ease-slow);
    overflow: hidden;
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

  .seg-n {
    font-size: 0.625rem;
    font-weight: 700;
    color: var(--bg);
  }

  .seg-empty {
    color: var(--text-faint);
    font-size: var(--text-2xs);
    align-self: center;
    font-style: italic;
  }

  .chart-total {
    text-align: right;
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--text-faint);
    font-variant-numeric: tabular-nums;
  }

  .dual {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--space-4);
  }

  @media (max-width: 800px) {
    .dual {
      grid-template-columns: 1fr;
    }
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

  .recent-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
  }

  .recent-row {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    padding: var(--space-2) 0;
    border-top: 1px solid var(--border);
  }

  .recent-row:first-child {
    border-top: none;
  }

  .recent-head {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
  }

  .recent-id {
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    color: var(--text-faint);
    background: var(--bg);
    padding: 1px var(--space-2);
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
  }

  .recent-date {
    margin-left: auto;
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    color: var(--text-faint);
  }

  .recent-body {
    display: flex;
    align-items: center;
    gap: var(--space-3);
  }

  .recent-title {
    flex: 1;
    font-size: var(--text-sm);
    color: var(--text);
    line-height: var(--leading-normal);
  }

  .actions {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
    gap: var(--space-3);
  }

  .action {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-4);
    background: var(--bg-elev-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    text-decoration: none;
    transition: border-color var(--ease), box-shadow var(--ease), transform var(--ease);
  }

  .action:hover {
    border-color: var(--accent);
    box-shadow: var(--shadow-hover);
    transform: translateY(-1px);
  }

  .action:focus-visible {
    outline: none;
    box-shadow: var(--shadow-focus);
  }

  .action-icon {
    width: 36px;
    height: 36px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: var(--radius-md);
    font-family: var(--font-mono);
    font-size: var(--text-md);
    font-weight: 700;
    color: var(--accent);
    background: var(--accent-halo);
    border: 1px solid var(--accent);
    flex-shrink: 0;
  }

  .action-body {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }

  .action-title {
    font-size: var(--text-sm);
    font-weight: 600;
    color: var(--text);
  }

  .action-desc {
    font-size: var(--text-2xs);
    color: var(--text-dim);
    letter-spacing: 0.02em;
  }
</style>
