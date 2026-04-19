<!--
  /brain/patterns — filter / sort / paginate brain patterns + open PatternModal.

  @task T990
  @wave 1D
-->
<script lang="ts">
  import { Badge, Button, Card, EmptyState, Spinner } from '$lib/ui';
  import {
    FilterBar,
    Pagination,
    PatternModal,
    QualityBar,
    SortControl,
    TierBadge,
    type FilterValue,
    type MemorySortKey,
  } from '$lib/components/memory';
  import type {
    BrainPatternRow,
    BrainPatternsResponse,
  } from '$lib/../routes/api/memory/patterns/+server.js';
  import type { PatternsPageData } from './+page.server.js';

  interface Props {
    data: PatternsPageData;
  }

  let { data }: Props = $props();

  const LIMIT = 50;

  // SSR provided the first page; we take a one-shot snapshot via structuredClone
  // so subsequent loads can overwrite the state without re-reading the prop.
  const initial = data.initial;
  let patterns = $state<BrainPatternRow[]>(initial?.patterns ?? []);
  let total = $state(initial?.total ?? 0);
  let filteredCount = $state(initial?.filtered ?? 0);
  let loading = $state(false);
  let error = $state<string | null>(null);

  let filter = $state<FilterValue>({ tier: null, type: null, status: null, minQuality: undefined });
  let sortBy = $state<MemorySortKey>('created_desc');
  let offset = $state(0);

  let expanded = $state<string | null>(null);
  let modalOpen = $state(false);
  let toastMessage = $state<string | null>(null);

  function buildParams(): URLSearchParams {
    const p = new URLSearchParams();
    p.set('offset', String(offset));
    p.set('limit', String(LIMIT));
    p.set('sort', sortBy);
    if (filter.type) p.set('type', filter.type);
    // "tier" filter is recorded on patterns via memory_tier; reuse it here
    if (filter.minQuality !== undefined) p.set('min_quality', String(filter.minQuality));
    return p;
  }

  async function load(): Promise<void> {
    loading = true;
    error = null;
    try {
      const res = await fetch(`/api/memory/patterns?${buildParams().toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as BrainPatternsResponse;
      patterns = body.patterns;
      total = body.total;
      filteredCount = body.filtered;
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load patterns';
    } finally {
      loading = false;
    }
  }

  // Filter reactively — reset offset when any filter changes.
  function onFilterChange(next: FilterValue): void {
    filter = next;
    offset = 0;
    void load();
  }

  function onSortChange(next: MemorySortKey): void {
    sortBy = next;
    offset = 0;
    void load();
  }

  function onPageChange(next: number): void {
    offset = next;
    void load();
  }

  function toggle(id: string): void {
    expanded = expanded === id ? null : id;
  }

  function onModalSuccess(id: string): void {
    toastMessage = `Stored pattern ${id}`;
    offset = 0;
    void load();
    setTimeout(() => {
      toastMessage = null;
    }, 3_000);
  }

  function onModalError(msg: string): void {
    toastMessage = `Save failed: ${msg}`;
    setTimeout(() => {
      toastMessage = null;
    }, 4_000);
  }

  const IMPACT_TONE: Record<string, 'danger' | 'warning' | 'neutral'> = {
    high: 'danger',
    medium: 'warning',
    low: 'neutral',
  };

  const TYPE_TONE: Record<string, 'success' | 'danger' | 'accent' | 'info' | 'neutral'> = {
    success: 'success',
    failure: 'danger',
    optimization: 'accent',
    workflow: 'info',
    blocker: 'danger',
  };
</script>

<svelte:head>
  <title>BRAIN Patterns — CLEO Studio</title>
</svelte:head>

<section class="page">
  <header class="page-head">
    <div class="head-left">
      <a class="back" href="/brain/overview">← Overview</a>
      <h1 class="title">Patterns</h1>
      <span class="count">
        <span class="count-n">{filteredCount}</span>
        <span class="count-div">/</span>
        <span class="count-total">{total}</span>
        <span class="count-label">shown</span>
      </span>
    </div>
    <div class="head-right">
      <Button variant="primary" size="sm" onclick={() => (modalOpen = true)}>
        + Store pattern
      </Button>
    </div>
  </header>

  <div class="controls">
    <FilterBar
      value={filter}
      tiers={['short', 'medium', 'long']}
      types={['workflow', 'blocker', 'success', 'failure', 'optimization']}
      showQuality={true}
      onChange={onFilterChange}
    />
    <SortControl value={sortBy} onChange={onSortChange} />
  </div>

  {#if loading}
    <div class="state">
      <Spinner size="md" />
      <span>Loading patterns…</span>
    </div>
  {:else if error}
    <EmptyState
      title="Couldn't load patterns"
      subtitle={error}
      variant="warning"
    >
      {#snippet action()}
        <Button variant="secondary" size="sm" onclick={() => { void load(); }}>Retry</Button>
      {/snippet}
    </EmptyState>
  {:else if patterns.length === 0}
    <EmptyState
      title="No patterns match these filters"
      subtitle="Loosen filters, or store the first pattern in this project."
    >
      {#snippet action()}
        <Button variant="primary" size="sm" onclick={() => (modalOpen = true)}>
          Store a pattern
        </Button>
      {/snippet}
    </EmptyState>
  {:else}
    <ul class="list">
      {#each patterns as p (p.id)}
        <li
          class="row"
          class:invalid={!!p.invalid_at}
          class:prune={p.prune_candidate === 1}
        >
          <button
            class="row-head"
            aria-expanded={expanded === p.id}
            onclick={() => toggle(p.id)}
          >
            <span class="row-meta">
              <code class="row-id">{p.id}</code>
              <Badge tone={TYPE_TONE[p.type] ?? 'neutral'} size="sm" subtle>
                {p.type}
              </Badge>
              {#if p.impact}
                <Badge tone={IMPACT_TONE[p.impact] ?? 'neutral'} size="sm">
                  {p.impact} impact
                </Badge>
              {/if}
              <TierBadge tier={p.memory_tier} />
              {#if p.verified === 1}<Badge tone="success" size="sm">verified</Badge>{/if}
              {#if p.prune_candidate === 1}<Badge tone="warning" size="sm">prune</Badge>{/if}
              {#if p.invalid_at}<Badge tone="danger" size="sm">invalidated</Badge>{/if}
              <span class="freq">{p.frequency}× seen</span>
              {#if p.citation_count > 0}
                <span class="cites">{p.citation_count} citations</span>
              {/if}
            </span>
            <span class="row-body">
              <span class="row-text">{p.pattern}</span>
              <QualityBar score={p.quality_score} width={80} />
            </span>
          </button>

          {#if expanded === p.id}
            <div class="row-detail">
              {#if p.context}
                <div class="detail-section">
                  <span class="detail-label">Context</span>
                  <p class="detail-text">{p.context}</p>
                </div>
              {/if}
              {#if p.anti_pattern}
                <div class="detail-section">
                  <span class="detail-label">Anti-pattern</span>
                  <p class="detail-text">{p.anti_pattern}</p>
                </div>
              {/if}
              {#if p.mitigation}
                <div class="detail-section">
                  <span class="detail-label">Mitigation</span>
                  <p class="detail-text">{p.mitigation}</p>
                </div>
              {/if}
              <div class="detail-footer">
                <span class="detail-ts">Extracted {p.extracted_at.slice(0, 10)}</span>
                {#if typeof p.success_rate === 'number'}
                  <span class="detail-meta">Success rate {(p.success_rate * 100).toFixed(0)}%</span>
                {/if}
              </div>
            </div>
          {/if}
        </li>
      {/each}
    </ul>

    <Pagination {offset} limit={LIMIT} {total} onChange={onPageChange} />
  {/if}
</section>

<PatternModal bind:open={modalOpen} onSuccess={onModalSuccess} onError={onModalError} />

{#if toastMessage}
  <div class="toast" role="status" aria-live="polite">{toastMessage}</div>
{/if}

<style>
  .page {
    max-width: 1100px;
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    gap: var(--space-5);
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

  .count {
    display: inline-flex;
    align-items: baseline;
    gap: var(--space-1);
    font-family: var(--font-mono);
  }

  .count-n {
    font-size: var(--text-sm);
    color: var(--text);
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }

  .count-div {
    color: var(--text-faint);
  }

  .count-total {
    font-size: var(--text-xs);
    color: var(--text-dim);
    font-variant-numeric: tabular-nums;
  }

  .count-label {
    margin-left: var(--space-1);
    font-size: var(--text-2xs);
    color: var(--text-faint);
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }

  .controls {
    display: flex;
    align-items: center;
    gap: var(--space-4);
    flex-wrap: wrap;
  }

  .controls :global(.filter-bar) {
    flex: 1;
    min-width: 300px;
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

  .list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .row {
    background: var(--bg-elev-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    overflow: hidden;
    transition: border-color var(--ease);
  }

  .row:hover {
    border-color: var(--border-strong);
  }

  .row.invalid {
    opacity: 0.5;
  }

  .row.prune {
    border-left: 3px solid var(--warning);
  }

  .row-head {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    width: 100%;
    padding: var(--space-3) var(--space-4);
    background: none;
    border: none;
    text-align: left;
    cursor: pointer;
    color: inherit;
    font-family: inherit;
  }

  .row-head:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 2px var(--accent);
  }

  .row-meta {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
  }

  .row-id {
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    color: var(--text-faint);
    background: var(--bg);
    padding: 1px var(--space-2);
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
  }

  .freq,
  .cites {
    font-size: var(--text-2xs);
    color: var(--text-faint);
    font-variant-numeric: tabular-nums;
    letter-spacing: 0.04em;
  }

  .row-body {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
  }

  .row-text {
    flex: 1;
    font-size: var(--text-sm);
    color: var(--text);
    font-weight: 500;
    line-height: var(--leading-normal);
  }

  .row-detail {
    padding: var(--space-3) var(--space-4) var(--space-4);
    border-top: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .detail-section {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  .detail-label {
    font-size: var(--text-2xs);
    font-weight: 700;
    color: var(--text-faint);
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }

  .detail-text {
    margin: 0;
    font-size: var(--text-sm);
    color: var(--text-dim);
    line-height: var(--leading-normal);
  }

  .detail-footer {
    display: flex;
    gap: var(--space-3);
    flex-wrap: wrap;
    padding-top: var(--space-2);
    border-top: 1px solid var(--border);
  }

  .detail-ts,
  .detail-meta {
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    color: var(--text-faint);
    letter-spacing: 0.04em;
  }

  .toast {
    position: fixed;
    bottom: var(--space-6);
    right: var(--space-6);
    padding: var(--space-3) var(--space-4);
    background: var(--bg-elev-2);
    color: var(--text);
    border: 1px solid var(--accent);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-md);
    font-size: var(--text-sm);
    z-index: 100;
  }
</style>
