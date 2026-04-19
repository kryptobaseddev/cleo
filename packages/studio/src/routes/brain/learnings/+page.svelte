<!--
  /brain/learnings — learning list with confidence filter + store modal.

  @task T990
  @wave 1D
-->
<script lang="ts">
  import { Badge, Button, EmptyState, Spinner } from '$lib/ui';
  import {
    ConfidenceBadge,
    FilterBar,
    LearningModal,
    Pagination,
    QualityBar,
    SortControl,
    TierBadge,
    type FilterValue,
    type MemorySortKey,
  } from '$lib/components/memory';
  import type {
    BrainLearningRow,
    BrainLearningsResponse,
  } from '$lib/../routes/api/memory/learnings/+server.js';
  import type { LearningsPageData } from './+page.server.js';

  interface Props {
    data: LearningsPageData;
  }

  let { data }: Props = $props();

  const LIMIT = 50;

  const initial = data.initial;
  let learnings = $state<BrainLearningRow[]>(initial?.learnings ?? []);
  let total = $state(initial?.total ?? 0);
  let filteredCount = $state(initial?.filtered ?? 0);
  let loading = $state(false);
  let error = $state<string | null>(null);

  let filter = $state<FilterValue>({ tier: null, confidence: null, minQuality: undefined });
  let sortBy = $state<MemorySortKey>('created_desc');
  let offset = $state(0);
  let actionableOnly = $state(false);

  let expanded = $state<string | null>(null);
  let modalOpen = $state(false);
  let toastMessage = $state<string | null>(null);

  function buildParams(): URLSearchParams {
    const p = new URLSearchParams();
    p.set('offset', String(offset));
    p.set('limit', String(LIMIT));
    p.set('sort', sortBy);
    if (filter.minQuality !== undefined) p.set('min_quality', String(filter.minQuality));
    if (actionableOnly) p.set('actionable', '1');
    // confidence filter becomes min_confidence via discrete thresholds
    if (filter.confidence === 'high') p.set('min_confidence', '0.7');
    else if (filter.confidence === 'medium') p.set('min_confidence', '0.4');
    else if (filter.confidence === 'low') p.set('min_confidence', '0');
    return p;
  }

  async function load(): Promise<void> {
    loading = true;
    error = null;
    try {
      const res = await fetch(`/api/memory/learnings?${buildParams().toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as BrainLearningsResponse;
      learnings = body.learnings;
      total = body.total;
      filteredCount = body.filtered;
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load learnings';
    } finally {
      loading = false;
    }
  }

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
    toastMessage = `Stored learning ${id}`;
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

  function toggleActionable(): void {
    actionableOnly = !actionableOnly;
    offset = 0;
    void load();
  }

  function parseTags(raw: string | null): string[] {
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.filter((x): x is string => typeof x === 'string');
      }
    } catch {
      // fall through
    }
    return [];
  }
</script>

<svelte:head>
  <title>BRAIN Learnings — CLEO Studio</title>
</svelte:head>

<section class="page">
  <header class="page-head">
    <div class="head-left">
      <a class="back" href="/brain/overview">← Overview</a>
      <h1 class="title">Learnings</h1>
      <span class="count">
        <span class="count-n">{filteredCount}</span>
        <span class="count-div">/</span>
        <span class="count-total">{total}</span>
        <span class="count-label">shown</span>
      </span>
    </div>
    <div class="head-right">
      <button
        type="button"
        class="toggle-btn"
        class:on={actionableOnly}
        aria-pressed={actionableOnly}
        onclick={toggleActionable}
      >
        {actionableOnly ? '✓ Actionable only' : 'All learnings'}
      </button>
      <Button variant="primary" size="sm" onclick={() => (modalOpen = true)}>
        + Store learning
      </Button>
    </div>
  </header>

  <div class="controls">
    <FilterBar
      value={filter}
      tiers={['short', 'medium', 'long']}
      confidences={['high', 'medium', 'low']}
      showQuality={true}
      onChange={onFilterChange}
    />
    <SortControl value={sortBy} onChange={onSortChange} />
  </div>

  {#if loading}
    <div class="state">
      <Spinner size="md" />
      <span>Loading learnings…</span>
    </div>
  {:else if error}
    <EmptyState
      title="Couldn't load learnings"
      subtitle={error}
      variant="warning"
    >
      {#snippet action()}
        <Button variant="secondary" size="sm" onclick={() => { void load(); }}>Retry</Button>
      {/snippet}
    </EmptyState>
  {:else if learnings.length === 0}
    <EmptyState
      title="No learnings captured"
      subtitle="Capture an insight — a future session will recall it automatically."
    >
      {#snippet action()}
        <Button variant="primary" size="sm" onclick={() => (modalOpen = true)}>
          Store a learning
        </Button>
      {/snippet}
    </EmptyState>
  {:else}
    <ul class="list">
      {#each learnings as l (l.id)}
        {@const tags = parseTags(l.applicable_types)}
        <li
          class="row"
          class:invalid={!!l.invalid_at}
          class:prune={l.prune_candidate === 1}
        >
          <button
            class="row-head"
            aria-expanded={expanded === l.id}
            onclick={() => toggle(l.id)}
          >
            <span class="row-meta">
              <code class="row-id">{l.id}</code>
              <ConfidenceBadge
                confidence={l.confidence !== null && l.confidence >= 0.7 ? 'high' : l.confidence !== null && l.confidence >= 0.4 ? 'medium' : l.confidence !== null ? 'low' : 'unknown'}
                value={l.confidence}
              />
              <TierBadge tier={l.memory_tier} />
              {#if l.actionable === 1}<Badge tone="accent" size="sm">actionable</Badge>{/if}
              {#if l.verified === 1}<Badge tone="success" size="sm">verified</Badge>{/if}
              {#if l.prune_candidate === 1}<Badge tone="warning" size="sm">prune</Badge>{/if}
              {#if l.invalid_at}<Badge tone="danger" size="sm">invalidated</Badge>{/if}
              {#if l.citation_count > 0}
                <span class="cites">{l.citation_count} citations</span>
              {/if}
            </span>

            <span class="row-body">
              <span class="row-text">{l.insight}</span>
              <QualityBar score={l.quality_score} width={80} />
            </span>
          </button>

          {#if expanded === l.id}
            <div class="row-detail">
              {#if l.source}
                <div class="detail-section">
                  <span class="detail-label">Source</span>
                  <p class="detail-text">{l.source}</p>
                </div>
              {/if}
              {#if l.application}
                <div class="detail-section">
                  <span class="detail-label">Application</span>
                  <p class="detail-text">{l.application}</p>
                </div>
              {/if}
              {#if tags.length > 0}
                <div class="detail-section">
                  <span class="detail-label">Applicable to</span>
                  <div class="tag-row">
                    {#each tags as t (t)}
                      <Badge tone="neutral" size="sm" subtle>{t}</Badge>
                    {/each}
                  </div>
                </div>
              {/if}
              <div class="detail-footer">
                <span class="detail-ts">Stored {l.created_at.slice(0, 10)}</span>
              </div>
            </div>
          {/if}
        </li>
      {/each}
    </ul>

    <Pagination {offset} limit={LIMIT} {total} onChange={onPageChange} />
  {/if}
</section>

<LearningModal bind:open={modalOpen} onSuccess={onModalSuccess} onError={onModalError} />

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

  .toggle-btn {
    background: none;
    border: 1px solid var(--border);
    color: var(--text-dim);
    font-family: var(--font-sans);
    font-size: var(--text-xs);
    font-weight: 500;
    padding: var(--space-1) var(--space-3);
    border-radius: var(--radius-pill);
    cursor: pointer;
    transition: color var(--ease), border-color var(--ease), background var(--ease);
  }

  .toggle-btn.on {
    color: var(--accent);
    border-color: var(--accent);
    background: var(--accent-halo);
  }

  .toggle-btn:hover {
    color: var(--text);
    border-color: var(--border-strong);
  }

  .toggle-btn:focus-visible {
    outline: none;
    box-shadow: var(--shadow-focus);
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

  .tag-row {
    display: flex;
    gap: var(--space-1);
    flex-wrap: wrap;
  }

  .detail-footer {
    display: flex;
    gap: var(--space-3);
    flex-wrap: wrap;
    padding-top: var(--space-2);
    border-top: 1px solid var(--border);
  }

  .detail-ts {
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
