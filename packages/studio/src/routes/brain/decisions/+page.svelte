<!--
  /brain/decisions — decision timeline with filter bar, sort, pagination,
  and inline decision-store modal.

  @task T990
  @wave 1D
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { Badge, Button, EmptyState, Spinner } from '$lib/ui';
  import {
    ConfidenceBadge,
    DecisionModal,
    FilterBar,
    Pagination,
    QualityBar,
    SortControl,
    TierBadge,
    type FilterValue,
    type MemorySortKey,
  } from '$lib/components/memory';

  interface BrainDecision {
    id: string;
    type: string;
    decision: string;
    rationale: string;
    confidence: string;
    outcome: string | null;
    context_epic_id: string | null;
    context_task_id: string | null;
    context_phase: string | null;
    quality_score: number | null;
    memory_tier: string | null;
    verified: number;
    valid_at: string | null;
    invalid_at: string | null;
    prune_candidate: number;
    created_at: string;
  }

  const LIMIT = 50;

  let decisions = $state<BrainDecision[]>([]);
  let total = $state(0);
  let loading = $state(true);
  let error = $state<string | null>(null);

  let filter = $state<FilterValue>({ tier: null, confidence: null, minQuality: undefined });
  let sortBy = $state<MemorySortKey>('created_desc');
  let offset = $state(0);
  let searchText = $state('');

  let expandedId = $state<string | null>(null);
  let modalOpen = $state(false);
  let toastMessage = $state<string | null>(null);

  async function load(): Promise<void> {
    loading = true;
    error = null;
    try {
      const res = await fetch('/api/memory/decisions');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { decisions: BrainDecision[]; total: number };
      decisions = body.decisions;
      total = body.total;
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load decisions';
    } finally {
      loading = false;
    }
  }

  // Client-side filter + sort — API only supports a flat chronological fetch today.
  const displayed = $derived.by(() => {
    let list = decisions.slice();
    if (filter.tier) list = list.filter((d) => d.memory_tier === filter.tier);
    if (filter.confidence) {
      list = list.filter((d) => d.confidence?.toLowerCase() === filter.confidence);
    }
    if (filter.minQuality !== undefined) {
      const m = filter.minQuality;
      list = list.filter((d) => d.quality_score === null || d.quality_score >= m);
    }
    if (searchText) {
      const q = searchText.toLowerCase();
      list = list.filter(
        (d) =>
          d.decision.toLowerCase().includes(q) ||
          d.rationale.toLowerCase().includes(q),
      );
    }

    if (sortBy === 'quality_desc') {
      list.sort((a, b) => (b.quality_score ?? -1) - (a.quality_score ?? -1));
    } else if (sortBy === 'citation_desc') {
      // Fall back to created_desc since decisions don't surface citation_count today.
      list.sort((a, b) => b.created_at.localeCompare(a.created_at));
    } else {
      // created_desc
      list.sort((a, b) => b.created_at.localeCompare(a.created_at));
    }
    return list;
  });

  const paged = $derived(displayed.slice(offset, offset + LIMIT));

  function onFilterChange(next: FilterValue): void {
    filter = next;
    offset = 0;
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
    toastMessage = `Stored decision ${id}`;
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
  <title>BRAIN Decisions — CLEO Studio</title>
</svelte:head>

<section class="page">
  <header class="page-head">
    <div class="head-left">
      <a class="back" href="/brain/overview">← Overview</a>
      <h1 class="title">Decisions</h1>
      <span class="count">
        <span class="count-n">{displayed.length}</span>
        <span class="count-div">/</span>
        <span class="count-total">{total}</span>
        <span class="count-label">shown</span>
      </span>
    </div>
    <div class="head-right">
      <a class="canvas-pill" href="/brain?scope=brain&type=decision">Open in Canvas →</a>
      <Button variant="primary" size="sm" onclick={() => (modalOpen = true)}>
        + Store decision
      </Button>
    </div>
  </header>

  <div class="controls">
    <FilterBar
      value={{ ...filter, q: searchText }}
      tiers={['short', 'medium', 'long']}
      confidences={['high', 'medium', 'low']}
      showQuality={true}
      showSearch={true}
      searchPlaceholder="Search decisions…"
      onChange={(next) => {
        searchText = next.q ?? '';
        const { q, ...rest } = next;
        onFilterChange(rest);
      }}
    />
    <SortControl value={sortBy} onChange={onSortChange} allowCitation={false} />
  </div>

  {#if loading}
    <div class="state">
      <Spinner size="md" />
      <span>Loading decisions…</span>
    </div>
  {:else if error}
    <EmptyState
      title="Couldn't load decisions"
      subtitle={error}
      variant="warning"
    >
      {#snippet action()}
        <Button variant="secondary" size="sm" onclick={() => { void load(); }}>Retry</Button>
      {/snippet}
    </EmptyState>
  {:else if paged.length === 0}
    <EmptyState
      title="No decisions match these filters"
      subtitle="Loosen the filter or capture the first decision of the project."
    >
      {#snippet action()}
        <Button variant="primary" size="sm" onclick={() => (modalOpen = true)}>
          New decision
        </Button>
      {/snippet}
    </EmptyState>
  {:else}
    <ol class="timeline">
      {#each paged as dec (dec.id)}
        <li
          class="tl-item"
          class:expanded={expandedId === dec.id}
          class:invalid={!!dec.invalid_at}
        >
          <span class="tl-connector" aria-hidden="true">
            <span class="tl-dot" data-tier={dec.memory_tier ?? 'short'}></span>
            <span class="tl-line"></span>
          </span>

          <div class="tl-content">
            <button
              class="tl-head"
              aria-expanded={expandedId === dec.id}
              onclick={() => toggle(dec.id)}
            >
              <span class="tl-meta">
                <code class="tl-id">{dec.id}</code>
                <Badge tone="neutral" size="sm" subtle>{dec.type}</Badge>
                <ConfidenceBadge confidence={dec.confidence} />
                <TierBadge tier={dec.memory_tier} />
                {#if dec.verified === 1}<Badge tone="success" size="sm">verified</Badge>{/if}
                {#if dec.prune_candidate === 1}<Badge tone="warning" size="sm">prune</Badge>{/if}
                {#if dec.invalid_at}<Badge tone="danger" size="sm">invalidated</Badge>{/if}
                <span class="tl-date">{dec.created_at.slice(0, 10)}</span>
              </span>
              <p class="tl-statement">{dec.decision}</p>
              <div class="tl-body-end">
                <QualityBar score={dec.quality_score} width={80} />
              </div>
            </button>

            {#if expandedId === dec.id}
              <div class="tl-detail">
                <div class="detail-section">
                  <span class="detail-label">Rationale</span>
                  <p class="detail-text">{dec.rationale}</p>
                </div>
                {#if dec.outcome}
                  <div class="detail-section">
                    <span class="detail-label">Outcome</span>
                    <p class="detail-text">{dec.outcome}</p>
                  </div>
                {/if}
                <div class="detail-footer">
                  {#if dec.context_task_id}
                    <a class="ctx-chip" href={`/tasks#${dec.context_task_id}`}>
                      Task · <code>{dec.context_task_id}</code>
                    </a>
                  {/if}
                  {#if dec.context_epic_id}
                    <a class="ctx-chip" href={`/tasks#${dec.context_epic_id}`}>
                      Epic · <code>{dec.context_epic_id}</code>
                    </a>
                  {/if}
                  {#if dec.context_phase}
                    <span class="detail-meta">Phase · {dec.context_phase}</span>
                  {/if}
                </div>
              </div>
            {/if}
          </div>
        </li>
      {/each}
    </ol>

    <Pagination {offset} limit={LIMIT} total={displayed.length} onChange={onPageChange} />
  {/if}
</section>

<DecisionModal bind:open={modalOpen} onSuccess={onModalSuccess} onError={onModalError} />

{#if toastMessage}
  <div class="toast" role="status" aria-live="polite">{toastMessage}</div>
{/if}

<style>
  .page {
    max-width: 900px;
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

  .timeline {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
  }

  .tl-item {
    display: grid;
    grid-template-columns: 24px 1fr;
    gap: var(--space-3);
  }

  .tl-item.invalid {
    opacity: 0.5;
  }

  .tl-connector {
    display: flex;
    flex-direction: column;
    align-items: center;
    position: relative;
  }

  .tl-dot {
    width: 10px;
    height: 10px;
    border-radius: var(--radius-pill);
    flex-shrink: 0;
    margin-top: 18px;
    background: var(--text-faint);
    box-shadow: 0 0 0 3px var(--bg);
  }

  .tl-dot[data-tier='medium'] {
    background: var(--info);
  }

  .tl-dot[data-tier='long'] {
    background: var(--success);
  }

  .tl-line {
    flex: 1;
    width: 1px;
    background: var(--border);
    margin: 4px 0;
    min-height: 20px;
  }

  .tl-item:last-child .tl-line {
    display: none;
  }

  .tl-content {
    padding: var(--space-3) 0 var(--space-4);
    min-width: 0;
  }

  .tl-head {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    width: 100%;
    background: none;
    border: none;
    text-align: left;
    cursor: pointer;
    color: inherit;
    font-family: inherit;
    padding: 0;
  }

  .tl-head:focus-visible {
    outline: none;
    box-shadow: 0 0 0 2px var(--accent);
    border-radius: var(--radius-sm);
  }

  .tl-meta {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
  }

  .tl-id {
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    color: var(--text-faint);
    background: var(--bg-elev-2);
    padding: 1px var(--space-2);
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
  }

  .tl-date {
    margin-left: auto;
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    color: var(--text-faint);
  }

  .tl-statement {
    margin: 0;
    font-size: var(--text-sm);
    font-weight: 500;
    color: var(--text);
    line-height: var(--leading-normal);
  }

  .tl-body-end {
    display: flex;
    justify-content: flex-end;
  }

  .tl-detail {
    margin-top: var(--space-3);
    padding: var(--space-3) var(--space-4);
    background: var(--bg-elev-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
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
    gap: var(--space-2);
    flex-wrap: wrap;
    padding-top: var(--space-2);
    border-top: 1px solid var(--border);
  }

  .ctx-chip {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    padding: 2px var(--space-2);
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    font-size: var(--text-2xs);
    color: var(--text-dim);
    text-decoration: none;
    transition: color var(--ease), border-color var(--ease);
  }

  .ctx-chip code {
    font-family: var(--font-mono);
    color: var(--text);
  }

  .ctx-chip:hover {
    color: var(--accent);
    border-color: var(--accent);
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
