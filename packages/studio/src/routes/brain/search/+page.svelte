<!--
  /brain/search — cross-table memory search.

  @task T990
  @wave 1D
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { Badge, Button, Card, EmptyState, Input, Spinner } from '$lib/ui';
  import { QualityBar, TierBadge } from '$lib/components/memory';
  import type {
    MemoryFindResponse,
    MemorySearchHit,
  } from '$lib/../routes/api/memory/find/+server.js';
  import type { SearchPageData } from './+page.server.js';

  interface Props {
    data: SearchPageData;
  }

  let { data }: Props = $props();

  const RECENT_KEY = 'cleo:brain:recent-searches';
  const MAX_RECENT = 6;

  const initialQuery: string = data.initialQuery;
  let query = $state(initialQuery);
  let hits = $state<MemorySearchHit[]>([]);
  let loading = $state(false);
  let error = $state<string | null>(null);
  let recentSearches = $state<string[]>([]);
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let abortController: AbortController | null = null;

  const GROUPS: Array<MemorySearchHit['table']> = [
    'observations',
    'decisions',
    'patterns',
    'learnings',
  ];

  const GROUP_LABELS: Record<MemorySearchHit['table'], string> = {
    observations: 'Observations',
    decisions: 'Decisions',
    patterns: 'Patterns',
    learnings: 'Learnings',
  };

  const TABLE_TONE: Record<MemorySearchHit['table'], 'info' | 'success' | 'accent' | 'warning'> = {
    observations: 'info',
    decisions: 'success',
    patterns: 'accent',
    learnings: 'warning',
  };

  function loadRecent(): void {
    try {
      const raw = localStorage.getItem(RECENT_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        recentSearches = parsed.filter((s): s is string => typeof s === 'string').slice(0, MAX_RECENT);
      }
    } catch {
      recentSearches = [];
    }
  }

  function saveRecent(q: string): void {
    try {
      const filtered = recentSearches.filter((r) => r !== q);
      recentSearches = [q, ...filtered].slice(0, MAX_RECENT);
      localStorage.setItem(RECENT_KEY, JSON.stringify(recentSearches));
    } catch {
      // localStorage disabled — silent no-op.
    }
  }

  function clearRecent(): void {
    recentSearches = [];
    try {
      localStorage.removeItem(RECENT_KEY);
    } catch {
      // ignore
    }
  }

  async function runSearch(q: string): Promise<void> {
    if (!q.trim()) {
      hits = [];
      error = null;
      loading = false;
      return;
    }
    abortController?.abort();
    abortController = new AbortController();

    loading = true;
    error = null;

    try {
      const res = await fetch(`/api/memory/find?q=${encodeURIComponent(q)}`, {
        signal: abortController.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as MemoryFindResponse;
      hits = body.hits;
      saveRecent(q);
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return;
      error = e instanceof Error ? e.message : 'Search failed';
    } finally {
      loading = false;
    }
  }

  function onInput(e: Event): void {
    const v = (e.target as HTMLInputElement).value;
    query = v;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      void runSearch(v);
      // Update URL for deep-linking / refresh stability.
      try {
        const url = new URL(window.location.href);
        if (v.trim()) url.searchParams.set('q', v);
        else url.searchParams.delete('q');
        window.history.replaceState({}, '', url);
      } catch {
        // SSR / missing window
      }
    }, 250);
  }

  function applyRecent(q: string): void {
    query = q;
    void runSearch(q);
  }

  const grouped = $derived.by(() => {
    const g: Record<MemorySearchHit['table'], MemorySearchHit[]> = {
      observations: [],
      decisions: [],
      patterns: [],
      learnings: [],
    };
    for (const h of hits) g[h.table].push(h);
    return g;
  });

  function hitRoute(h: MemorySearchHit): string {
    const base = `/brain/${h.table}`;
    return `${base}#${encodeURIComponent(h.id)}`;
  }

  onMount(() => {
    loadRecent();
    if (initialQuery) {
      void runSearch(initialQuery);
    }
  });
</script>

<svelte:head>
  <title>BRAIN Search — CLEO Studio</title>
</svelte:head>

<section class="page">
  <header class="page-head">
    <div class="head-left">
      <a class="back" href="/brain/overview">← Overview</a>
      <h1 class="title">Search</h1>
      <span class="subtitle">Cross-table memory retrieval — observations, decisions, patterns, learnings</span>
    </div>
  </header>

  <div class="search-shell">
    <Input
      type="search"
      value={query}
      label="Memory search"
      placeholder="Search across observations, decisions, patterns, learnings…"
      oninput={onInput}
    />
    {#if loading}
      <span class="live-indicator">
        <Spinner size="sm" label="" />
        <span>searching…</span>
      </span>
    {/if}
  </div>

  {#if !query.trim()}
    <Card>
      {#snippet header()}
        <div class="panel-head">
          <h2 class="panel-title">Recent searches</h2>
          {#if recentSearches.length > 0}
            <button type="button" class="clear-btn" onclick={clearRecent}>clear</button>
          {/if}
        </div>
      {/snippet}

      {#if recentSearches.length === 0}
        <EmptyState
          title="Nothing yet"
          subtitle="Type above to search memory. Your recent queries will appear here."
        />
      {:else}
        <ul class="recent-list">
          {#each recentSearches as r (r)}
            <li>
              <button type="button" class="recent-item" onclick={() => applyRecent(r)}>
                <span class="recent-arrow" aria-hidden="true">↗</span>
                <span>{r}</span>
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    </Card>
  {:else if error}
    <EmptyState
      title="Search failed"
      subtitle={error}
      variant="warning"
    >
      {#snippet action()}
        <Button
          variant="secondary"
          size="sm"
          onclick={() => {
            void runSearch(query);
          }}
        >
          Retry
        </Button>
      {/snippet}
    </EmptyState>
  {:else if loading && hits.length === 0}
    <div class="state">
      <Spinner size="md" />
      <span>Searching memory…</span>
    </div>
  {:else if hits.length === 0}
    <EmptyState
      title="No matches"
      subtitle={`Nothing matched "${query}". Try a broader term or a synonym.`}
    />
  {:else}
    <div class="groups">
      {#each GROUPS as g (g)}
        {@const items = grouped[g]}
        {#if items.length > 0}
          <section class="group">
            <div class="group-head">
              <h3 class="group-title">{GROUP_LABELS[g]}</h3>
              <Badge tone={TABLE_TONE[g]} size="sm" pill>{items.length}</Badge>
            </div>
            <ul class="group-list">
              {#each items as h (h.id)}
                <li>
                  <a class="hit" href={hitRoute(h)}>
                    <div class="hit-head">
                      <code class="hit-id">{h.id}</code>
                      <TierBadge tier={h.tier} />
                      {#if h.verified === 1}<Badge tone="success" size="sm">verified</Badge>{/if}
                      {#if h.citations > 0}<span class="hit-cites">{h.citations} citations</span>{/if}
                      <span class="hit-date">{h.createdAt.slice(0, 10)}</span>
                    </div>
                    <p class="hit-title">{h.title}</p>
                    {#if h.preview}<p class="hit-preview">{h.preview}</p>{/if}
                    <div class="hit-foot">
                      <QualityBar score={h.quality} width={80} />
                    </div>
                  </a>
                </li>
              {/each}
            </ul>
          </section>
        {/if}
      {/each}
    </div>
  {/if}
</section>

<style>
  .page {
    max-width: 1000px;
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    gap: var(--space-5);
    font-family: var(--font-sans);
  }

  .page-head {
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

  .search-shell {
    position: relative;
    display: flex;
    align-items: center;
    gap: var(--space-3);
  }

  .search-shell :global(.field) {
    flex: 1;
  }

  .live-indicator {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    font-size: var(--text-2xs);
    color: var(--accent);
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }

  .panel-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .panel-title {
    margin: 0;
    font-size: var(--text-md);
    font-weight: 600;
    color: var(--text);
  }

  .clear-btn {
    background: none;
    border: none;
    color: var(--text-faint);
    font-size: var(--text-2xs);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    cursor: pointer;
    font-family: inherit;
  }

  .clear-btn:hover {
    color: var(--accent);
  }

  .recent-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  .recent-item {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    width: 100%;
    padding: var(--space-2) var(--space-3);
    background: none;
    border: none;
    color: var(--text-dim);
    font-size: var(--text-sm);
    font-family: inherit;
    text-align: left;
    cursor: pointer;
    border-radius: var(--radius-sm);
    transition: background var(--ease), color var(--ease);
  }

  .recent-item:hover {
    background: var(--bg-elev-2);
    color: var(--text);
  }

  .recent-item:focus-visible {
    outline: none;
    box-shadow: var(--shadow-focus);
  }

  .recent-arrow {
    color: var(--text-faint);
    font-family: var(--font-mono);
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

  .groups {
    display: flex;
    flex-direction: column;
    gap: var(--space-5);
  }

  .group-head {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin-bottom: var(--space-2);
    padding-bottom: var(--space-2);
    border-bottom: 1px solid var(--border);
  }

  .group-title {
    margin: 0;
    font-size: var(--text-xs);
    font-weight: 700;
    color: var(--text-faint);
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }

  .group-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .hit {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-3) var(--space-4);
    background: var(--bg-elev-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    text-decoration: none;
    color: inherit;
    transition: border-color var(--ease), box-shadow var(--ease), transform var(--ease);
  }

  .hit:hover {
    border-color: var(--border-strong);
    box-shadow: var(--shadow-hover);
    transform: translateY(-1px);
  }

  .hit:focus-visible {
    outline: none;
    box-shadow: var(--shadow-focus);
  }

  .hit-head {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
  }

  .hit-id {
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    color: var(--text-faint);
    background: var(--bg);
    padding: 1px var(--space-2);
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
  }

  .hit-cites {
    color: var(--accent);
    font-size: var(--text-2xs);
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }

  .hit-date {
    margin-left: auto;
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    color: var(--text-faint);
  }

  .hit-title {
    margin: 0;
    font-size: var(--text-sm);
    font-weight: 600;
    color: var(--text);
    line-height: var(--leading-normal);
  }

  .hit-preview {
    margin: 0;
    font-size: var(--text-xs);
    color: var(--text-dim);
    line-height: var(--leading-normal);
  }

  .hit-foot {
    display: flex;
    align-items: center;
    justify-content: flex-end;
  }
</style>
