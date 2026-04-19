<!--
  /brain/observations — observation list with filter bar, sort, pagination,
  and inline observe modal.

  @task T990
  @wave 1D
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { Badge, Button, EmptyState, Spinner } from '$lib/ui';
  import {
    FilterBar,
    ObserveModal,
    Pagination,
    QualityBar,
    SortControl,
    TierBadge,
    type FilterValue,
    type MemorySortKey,
  } from '$lib/components/memory';

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

  const LIMIT = 50;

  let observations = $state<BrainObservation[]>([]);
  let total = $state(0);
  let filteredCount = $state(0);
  let loading = $state(true);
  let error = $state<string | null>(null);

  let filter = $state<FilterValue>({ tier: null, type: null, minQuality: undefined });
  let sortBy = $state<MemorySortKey>('created_desc');
  let offset = $state(0);
  let searchText = $state('');

  let expandedId = $state<string | null>(null);
  let modalOpen = $state(false);
  let toastMessage = $state<string | null>(null);

  function buildParams(): URLSearchParams {
    const p = new URLSearchParams();
    if (filter.tier) p.set('tier', filter.tier);
    if (filter.type) p.set('type', filter.type);
    if (filter.minQuality !== undefined) p.set('min_quality', String(filter.minQuality));
    return p;
  }

  async function load(): Promise<void> {
    loading = true;
    error = null;
    try {
      const res = await fetch(`/api/memory/observations?${buildParams().toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as {
        observations: BrainObservation[];
        total: number;
        filtered: number;
      };
      observations = body.observations;
      total = body.total;
      filteredCount = body.filtered;
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load observations';
    } finally {
      loading = false;
    }
  }

  // Derived: client-side text filter + sort (API sort support is limited to created_desc today).
  const displayed = $derived.by(() => {
    let list = observations;
    if (searchText) {
      const q = searchText.toLowerCase();
      list = list.filter(
        (o) =>
          o.title.toLowerCase().includes(q) ||
          (o.narrative ?? '').toLowerCase().includes(q),
      );
    }
    // Client-side sort (for citation/quality) so we don't add SQL churn.
    if (sortBy === 'quality_desc') {
      list = [...list].sort(
        (a, b) => (b.quality_score ?? -1) - (a.quality_score ?? -1),
      );
    } else if (sortBy === 'citation_desc') {
      list = [...list].sort((a, b) => b.citation_count - a.citation_count);
    }
    return list;
  });

  // Paginated window.
  const paged = $derived(displayed.slice(offset, offset + LIMIT));

  function onFilterChange(next: FilterValue): void {
    filter = next;
    offset = 0;
    void load();
  }

  function onSortChange(next: MemorySortKey): void {
    sortBy = next;
    offset = 0;
  }

  function onPageChange(next: number): void {
    offset = next;
  }

  function toggle(id: string): void {
    expandedId = expandedId === id ? null : id;
  }

  function onModalSuccess(id: string): void {
    toastMessage = `Stored observation ${id}`;
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

  onMount(() => {
    void load();
  });
</script>

<svelte:head>
  <title>BRAIN Observations — CLEO Studio</title>
</svelte:head>

<section class="page">
  <header class="page-head">
    <div class="head-left">
      <a class="back" href="/brain/overview">← Overview</a>
      <h1 class="title">Observations</h1>
      <span class="count">
        <span class="count-n">{displayed.length}</span>
        <span class="count-div">/</span>
        <span class="count-total">{total}</span>
        <span class="count-label">shown</span>
      </span>
    </div>
    <div class="head-right">
      <a class="canvas-pill" href="/brain?scope=brain&type=observation">Open in Canvas →</a>
      <Button variant="primary" size="sm" onclick={() => (modalOpen = true)}>
        + Observe
      </Button>
    </div>
  </header>

  <div class="controls">
    <FilterBar
      value={{ ...filter, q: searchText }}
      tiers={['short', 'medium', 'long']}
      types={['episodic', 'semantic', 'procedural']}
      showQuality={true}
      showSearch={true}
      searchPlaceholder="Search title or narrative…"
      onChange={(next) => {
        searchText = next.q ?? '';
        const { q, ...rest } = next;
        onFilterChange(rest);
      }}
    />
    <SortControl value={sortBy} onChange={onSortChange} />
  </div>

  {#if loading}
    <div class="state">
      <Spinner size="md" />
      <span>Loading observations…</span>
    </div>
  {:else if error}
    <EmptyState
      title="Couldn't load observations"
      subtitle={error}
      variant="warning"
    >
      {#snippet action()}
        <Button variant="secondary" size="sm" onclick={() => { void load(); }}>Retry</Button>
      {/snippet}
    </EmptyState>
  {:else if paged.length === 0}
    <EmptyState
      title="No observations match these filters"
      subtitle="Loosen filters, or record a fresh observation — the brain learns from every one."
    >
      {#snippet action()}
        <Button variant="primary" size="sm" onclick={() => (modalOpen = true)}>
          New observation
        </Button>
      {/snippet}
    </EmptyState>
  {:else}
    <ul class="list">
      {#each paged as obs (obs.id)}
        <li
          class="row"
          class:invalid={!!obs.invalid_at}
          class:prune={obs.prune_candidate === 1}
        >
          <button
            class="row-head"
            aria-expanded={expandedId === obs.id}
            onclick={() => toggle(obs.id)}
          >
            <span class="row-meta">
              <code class="row-id">{obs.id}</code>
              <Badge tone="info" size="sm" subtle>{obs.type}</Badge>
              <TierBadge tier={obs.memory_tier} />
              {#if obs.memory_type}
                <Badge tone="neutral" size="sm" subtle>{obs.memory_type}</Badge>
              {/if}
              {#if obs.verified === 1}<Badge tone="success" size="sm">verified</Badge>{/if}
              {#if obs.prune_candidate === 1}<Badge tone="warning" size="sm">prune</Badge>{/if}
              {#if obs.invalid_at}<Badge tone="danger" size="sm">invalidated</Badge>{/if}
              {#if obs.citation_count > 0}
                <span class="cites">{obs.citation_count} citations</span>
              {/if}
              <span class="row-date">{obs.created_at.slice(0, 10)}</span>
            </span>

            <span class="row-body">
              <span class="row-text">{obs.title}</span>
              <QualityBar score={obs.quality_score} width={80} />
            </span>
          </button>

          {#if expandedId === obs.id}
            <div class="row-detail">
              {#if obs.subtitle}
                <p class="subtitle">{obs.subtitle}</p>
              {/if}
              {#if obs.narrative}
                <div class="detail-section">
                  <span class="detail-label">Narrative</span>
                  <p class="detail-text">{obs.narrative}</p>
                </div>
              {/if}
              <div class="detail-footer">
                <code class="detail-id">{obs.id}</code>
                {#if obs.project}
                  <span class="detail-meta">Project · {obs.project}</span>
                {/if}
                {#if obs.source_confidence}
                  <span class="detail-meta">Confidence · {obs.source_confidence}</span>
                {/if}
              </div>
            </div>
          {/if}
        </li>
      {/each}
    </ul>

    <Pagination {offset} limit={LIMIT} total={displayed.length} onChange={onPageChange} />
  {/if}
</section>

<ObserveModal bind:open={modalOpen} onSuccess={onModalSuccess} onError={onModalError} />

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

  .head-right {
    display: flex;
    align-items: center;
    gap: var(--space-2);
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

  .cites {
    font-size: var(--text-2xs);
    color: var(--text-faint);
    font-variant-numeric: tabular-nums;
    letter-spacing: 0.04em;
  }

  .row-date {
    margin-left: auto;
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    color: var(--text-faint);
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

  .subtitle {
    margin: 0;
    font-size: var(--text-sm);
    color: var(--text-dim);
    font-style: italic;
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

  .detail-id {
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    color: var(--text-faint);
    background: var(--bg);
    padding: 1px var(--space-2);
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
  }

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
