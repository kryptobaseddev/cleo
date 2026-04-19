<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/stores';
  import type { PageData } from './$types';
  import type { DashboardFilters, EpicProgress, RecentTask } from './+page.server.js';
  import type { SearchTaskRow } from '../api/tasks/search/+server.js';
  import { normalizeSearch } from '$lib/tasks/search.js';

  interface Props {
    data: PageData;
  }
  let { data }: Props = $props();

  const stats = data.stats;
  const recentTasks: RecentTask[] = data.recentTasks ?? [];
  const epicProgress: EpicProgress[] = data.epicProgress ?? [];
  // T878 / T958: display filter state (?cancelled=1 / ?archived=1) driven
  // from the URL. `?deferred=1` is the legacy alias honoured for one release.
  const filters: DashboardFilters = data.filters ?? { showCancelled: false, showArchived: false };

  /**
   * Build a toggle URL that flips one filter flag while preserving the other.
   * We round-trip through the URL so the dashboard stays SSR-correct and the
   * toggle state is bookmarkable / shareable.
   *
   * T958: `cancelled` is the canonical param name. When activating the filter
   * we also strip any legacy `?deferred=1` alias the URL might still carry so
   * the resulting link canonicalises on the new name.
   */
  function toggleUrl(flag: 'cancelled' | 'archived'): string {
    const next = new URL($page.url);
    // Always scrub the legacy alias so toggling the filter leaves the URL in
    // the post-T958 canonical shape.
    next.searchParams.delete('deferred');
    const current = next.searchParams.get(flag) === '1';
    if (current) {
      next.searchParams.delete(flag);
    } else {
      next.searchParams.set(flag, '1');
    }
    return next.pathname + (next.search ? next.search : '');
  }

  // ---------------------------------------------------------------------------
  // Search state
  // ---------------------------------------------------------------------------

  let searchRaw = $state('');
  let searchLoading = $state(false);
  let searchError = $state<string | null>(null);

  /** Results for a fuzzy title search. */
  let titleResults = $state<SearchTaskRow[]>([]);
  /** Whether the current search resolved to an exact ID that was not found. */
  let idNotFound = $state(false);
  /** The resolved ID that was looked up (for not-found message). */
  let resolvedId = $state<string | null>(null);

  /** True when a title search returned zero results. */
  let noTitleResults = $state(false);

  /** True when a title search is active (results panel visible). */
  let showResults = $state(false);

  $effect(() => {
    const raw = searchRaw;
    const normalized = normalizeSearch(raw);

    if (normalized.kind === 'empty') {
      titleResults = [];
      idNotFound = false;
      resolvedId = null;
      noTitleResults = false;
      showResults = false;
      return;
    }

    let controller = new AbortController();

    // Debounce: wait 250ms before firing the request
    const timer = setTimeout(async () => {
      searchLoading = true;
      searchError = null;
      idNotFound = false;
      noTitleResults = false;
      resolvedId = null;

      try {
        const res = await fetch(`/api/tasks/search?q=${encodeURIComponent(raw)}`, {
          signal: controller.signal,
        });

        if (!res.ok) {
          searchError = `Search failed (${res.status})`;
          searchLoading = false;
          return;
        }

        const body = (await res.json()) as
          | { kind: 'empty' }
          | { kind: 'id'; task: SearchTaskRow | null }
          | { kind: 'title'; tasks: SearchTaskRow[]; total: number }
          | { error: string };

        if ('error' in body) {
          searchError = body.error;
          searchLoading = false;
          return;
        }

        if (body.kind === 'id') {
          if (body.task) {
            // Exact match — navigate directly to task detail
            goto(`/tasks/${body.task.id}`);
          } else {
            idNotFound = true;
            resolvedId = normalizeSearch(raw).kind === 'id' ? (normalizeSearch(raw) as { kind: 'id'; id: string }).id : null;
            showResults = true;
          }
        } else if (body.kind === 'title') {
          titleResults = body.tasks;
          noTitleResults = body.total === 0;
          showResults = true;
        } else {
          showResults = false;
        }
      } catch (err) {
        if ((err as Error).name !== 'AbortError') {
          searchError = String(err);
        }
      } finally {
        searchLoading = false;
      }
    }, 250);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  });

  function clearSearch(): void {
    searchRaw = '';
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  function priorityClass(p: string): string {
    if (p === 'critical') return 'priority-critical';
    if (p === 'high') return 'priority-high';
    if (p === 'medium') return 'priority-medium';
    return 'priority-low';
  }

  function statusIcon(s: string): string {
    if (s === 'done') return '✓';
    if (s === 'active') return '●';
    if (s === 'blocked') return '✗';
    return '○';
  }

  function statusClass(s: string): string {
    if (s === 'done') return 'status-done';
    if (s === 'active') return 'status-active';
    if (s === 'blocked') return 'status-blocked';
    return 'status-pending';
  }

  function progressPct(ep: EpicProgress): number {
    if (ep.total === 0) return 0;
    return Math.round((ep.done / ep.total) * 100);
  }

  function formatTime(iso: string): string {
    try {
      const d = new Date(iso);
      const now = Date.now();
      const diff = now - d.getTime();
      const mins = Math.floor(diff / 60000);
      if (mins < 60) return `${mins}m ago`;
      const hrs = Math.floor(mins / 60);
      if (hrs < 24) return `${hrs}h ago`;
      return `${Math.floor(hrs / 24)}d ago`;
    } catch {
      return iso;
    }
  }

  let liveConnected = $state(false);
  let liveTs = $state('');

  $effect(() => {
    const src = new EventSource('/api/tasks/events');
    src.addEventListener('connected', () => {
      liveConnected = true;
    });
    src.addEventListener('task-updated', (e) => {
      const d = JSON.parse(e.data) as { ts: string };
      liveTs = d.ts;
    });
    src.addEventListener('heartbeat', () => {
      liveConnected = true;
    });
    src.onerror = () => {
      liveConnected = false;
    };
    return () => src.close();
  });
</script>

<svelte:head>
  <title>Tasks — CLEO Studio</title>
</svelte:head>

<div class="tasks-dashboard">
  <div class="page-header">
    <div class="header-left">
      <h1 class="page-title">Tasks</h1>
      <nav class="tasks-nav">
        <a href="/tasks" class="nav-tab active">Dashboard</a>
        <a href="/tasks/pipeline" class="nav-tab">Pipeline</a>
        <a href="/tasks/graph" class="nav-tab">Graph</a>
        <a href="/tasks/sessions" class="nav-tab">Sessions</a>
      </nav>
    </div>
    <div class="live-indicator" class:connected={liveConnected}>
      <span class="live-dot"></span>
      <span class="live-label">{liveConnected ? 'Live' : 'Connecting...'}</span>
      {#if liveTs}
        <span class="live-ts">updated {formatTime(liveTs)}</span>
      {/if}
    </div>
  </div>

  <!-- Search bar -->
  <div class="search-section">
    <div class="search-box" class:loading={searchLoading}>
      <span class="search-icon" aria-hidden="true">⌕</span>
      <input
        class="search-input"
        type="text"
        placeholder="Search by ID (T663, t663, 663) or title..."
        bind:value={searchRaw}
        autocomplete="off"
        spellcheck="false"
      />
      {#if searchRaw.length > 0}
        <button class="search-clear" onclick={clearSearch} aria-label="Clear search">✕</button>
      {/if}
    </div>
    {#if searchError}
      <div class="search-error">{searchError}</div>
    {/if}
  </div>

  <!-- Search results panel -->
  {#if showResults}
    <div class="search-results-panel">
      {#if idNotFound}
        <div class="search-empty">Task {resolvedId ?? searchRaw} not found.</div>
      {:else if noTitleResults}
        <div class="search-empty">No tasks match "{searchRaw}".</div>
      {:else}
        <div class="search-results-header">
          <span class="results-count">{titleResults.length} result{titleResults.length === 1 ? '' : 's'}</span>
          <button class="results-close" onclick={clearSearch} aria-label="Close results">✕</button>
        </div>
        <div class="search-results-list">
          {#each titleResults as t}
            <a href="/tasks/{t.id}" class="search-result-row" onclick={clearSearch}>
              <span class="result-status-icon {statusClass(t.status)}">{statusIcon(t.status)}</span>
              <div class="result-info">
                <span class="result-id">{t.id}</span>
                {#if t.type !== 'task'}
                  <span class="result-type">{t.type}</span>
                {/if}
                <span class="result-title">{t.title}</span>
              </div>
              <div class="result-meta">
                <span class="result-priority {priorityClass(t.priority)}">{t.priority}</span>
                <span class="result-time">{formatTime(t.updated_at)}</span>
              </div>
            </a>
          {/each}
        </div>
      {/if}
    </div>
  {/if}

  {#if stats}
    <div class="stats-section">
      <div class="stat-group">
        <div class="stat-card primary">
          <span class="stat-num">{stats.total}</span>
          <span class="stat-lbl">Total</span>
        </div>
        <div class="stat-card status-active-card">
          <span class="stat-num">{stats.active}</span>
          <span class="stat-lbl">Active</span>
        </div>
        <div class="stat-card">
          <span class="stat-num">{stats.pending}</span>
          <span class="stat-lbl">Pending</span>
        </div>
        <div class="stat-card status-done-card">
          <span class="stat-num">{stats.done}</span>
          <span class="stat-lbl">Done</span>
        </div>
        <div class="stat-card status-cancelled-card">
          <span class="stat-num">{stats.cancelled}</span>
          <span class="stat-lbl">Cancelled</span>
        </div>
        <div class="stat-card muted">
          <span class="stat-num">{stats.archived}</span>
          <span class="stat-lbl">Archived</span>
        </div>
      </div>

      <div class="priority-breakdown">
        <div class="section-label">Priority</div>
        <div class="priority-bars">
          {#each [['critical', stats.critical], ['high', stats.high], ['medium', stats.medium], ['low', stats.low]] as [label, count]}
            {@const total = stats.critical + stats.high + stats.medium + stats.low}
            {@const pct = total > 0 ? Math.round((Number(count) / total) * 100) : 0}
            <div class="priority-row">
              <span class="priority-label {priorityClass(String(label))}">{label}</span>
              <div class="priority-bar-track">
                <div
                  class="priority-bar-fill {priorityClass(String(label))}"
                  style="width:{pct}%"
                ></div>
              </div>
              <span class="priority-count">{count}</span>
            </div>
          {/each}
        </div>
      </div>

      <div class="type-breakdown">
        <div class="section-label">Type</div>
        <div class="type-chips">
          <span class="type-chip">Epics: <strong>{stats.epics}</strong></span>
          <span class="type-chip">Tasks: <strong>{stats.tasks}</strong></span>
          <span class="type-chip">Subtasks: <strong>{stats.subtasks}</strong></span>
        </div>
      </div>
    </div>
  {:else}
    <div class="no-db">tasks.db not found — start CLEO in the project directory</div>
  {/if}

  <!-- T878 / T958: dashboard filter toggles ("Deferred" → "Cancelled epics" rename). -->
  <div class="filter-bar" aria-label="Dashboard filters">
    <a
      href={toggleUrl('cancelled')}
      class="filter-chip"
      class:active={filters.showCancelled}
      data-sveltekit-noscroll
      title="Include epics with status='cancelled' in the Epic Progress rollups (previously labelled 'Deferred'). URL: ?cancelled=1"
    >
      <span class="chip-check">{filters.showCancelled ? '✓' : ' '}</span>
      Show cancelled epics
    </a>
    <a
      href={toggleUrl('archived')}
      class="filter-chip"
      class:active={filters.showArchived}
      data-sveltekit-noscroll
      title="Include archived tasks in Recent Activity"
    >
      <span class="chip-check">{filters.showArchived ? '✓' : ' '}</span>
      Show archived
    </a>
  </div>

  <div class="lower-grid">
    {#if epicProgress.length > 0}
      <section class="panel">
        <h2 class="panel-title">
          Epic Progress
          {#if filters.showCancelled}
            <span class="panel-sub">(including cancelled)</span>
          {/if}
        </h2>
        <div class="epic-list">
          {#each epicProgress as ep}
            <a
              href="/tasks/tree/{ep.id}"
              class="epic-row"
              class:epic-cancelled={ep.status === 'cancelled'}
            >
              <div class="epic-header-row">
                <span class="epic-id">{ep.id}</span>
                <span class="epic-title">{ep.title}</span>
                {#if ep.status === 'cancelled'}
                  <!-- T958: row badge renamed from 'deferred' to 'cancelled' -->
                  <span class="epic-status-badge badge-cancelled">cancelled</span>
                {/if}
                <span class="epic-counts">{ep.done}/{ep.total}</span>
                <span class="epic-pct">{progressPct(ep)}%</span>
              </div>
              <div class="epic-progress-bar">
                <div class="epic-done-bar" style="width:{progressPct(ep)}%"></div>
              </div>
              <div class="epic-sub-counts">
                <span class="sub-done">{ep.done} done</span>
                <span class="sub-active">{ep.active} active</span>
                <span class="sub-pending">{ep.pending} pending</span>
                {#if ep.cancelled > 0}
                  <span class="sub-cancelled">{ep.cancelled} cancelled</span>
                {/if}
              </div>
            </a>
          {/each}
        </div>
      </section>
    {/if}

    {#if recentTasks.length > 0}
      <section class="panel">
        <h2 class="panel-title">Recent Activity</h2>
        <div class="task-list">
          {#each recentTasks as t}
            <a href="/tasks/{t.id}" class="task-row">
              <span class="task-status-icon {statusClass(t.status)}">{statusIcon(t.status)}</span>
              <div class="task-info">
                <span class="task-id">{t.id}</span>
                <span class="task-title">{t.title}</span>
              </div>
              <div class="task-meta">
                <span class="task-priority {priorityClass(t.priority)}">{t.priority}</span>
                {#if t.pipeline_stage}
                  <span class="task-stage">{t.pipeline_stage}</span>
                {/if}
                <span class="task-time">{formatTime(t.updated_at)}</span>
              </div>
            </a>
          {/each}
        </div>
      </section>
    {/if}
  </div>
</div>

<style>
  .tasks-dashboard {
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
    max-width: 1200px;
    margin: 0 auto;
  }

  .page-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 1rem;
  }

  .header-left {
    display: flex;
    align-items: center;
    gap: 1.5rem;
  }

  .page-title {
    font-size: 1.5rem;
    font-weight: 700;
    color: #f1f5f9;
  }

  .tasks-nav {
    display: flex;
    gap: 0.25rem;
  }

  .nav-tab {
    padding: 0.25rem 0.75rem;
    border-radius: 4px;
    text-decoration: none;
    font-size: 0.8125rem;
    font-weight: 500;
    color: #64748b;
    transition: color 0.15s, background 0.15s;
  }

  .nav-tab:hover {
    color: #e2e8f0;
    background: #2d3748;
  }

  .nav-tab.active {
    color: #a855f7;
    background: rgba(168, 85, 247, 0.1);
  }

  .live-indicator {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.75rem;
    color: #475569;
  }

  .live-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #475569;
  }

  .live-indicator.connected .live-dot {
    background: #22c55e;
    box-shadow: 0 0 4px #22c55e;
  }

  .live-indicator.connected .live-label {
    color: #22c55e;
  }

  .live-ts {
    color: #475569;
  }

  /* Search */

  .search-section {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .search-box {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    background: #1a1f2e;
    border: 1px solid #2d3748;
    border-radius: 8px;
    padding: 0.5rem 0.875rem;
    transition: border-color 0.15s;
  }

  .search-box:focus-within {
    border-color: rgba(168, 85, 247, 0.5);
  }

  .search-box.loading {
    border-color: rgba(168, 85, 247, 0.3);
  }

  .search-icon {
    color: #475569;
    font-size: 1.125rem;
    line-height: 1;
    flex-shrink: 0;
    user-select: none;
  }

  .search-input {
    flex: 1;
    background: transparent;
    border: none;
    outline: none;
    color: #f1f5f9;
    font-size: 0.875rem;
    min-width: 0;
  }

  .search-input::placeholder {
    color: #475569;
  }

  .search-clear {
    background: none;
    border: none;
    color: #475569;
    cursor: pointer;
    font-size: 0.75rem;
    padding: 0.125rem 0.25rem;
    border-radius: 3px;
    transition: color 0.15s;
    flex-shrink: 0;
  }

  .search-clear:hover {
    color: #94a3b8;
  }

  .search-error {
    font-size: 0.75rem;
    color: #ef4444;
    padding: 0 0.25rem;
  }

  /* Search results panel */

  .search-results-panel {
    background: #1a1f2e;
    border: 1px solid #2d3748;
    border-radius: 8px;
    overflow: hidden;
  }

  .search-empty {
    padding: 1rem;
    font-size: 0.875rem;
    color: #64748b;
    text-align: center;
  }

  .search-results-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.5rem 1rem;
    border-bottom: 1px solid #2d3748;
  }

  .results-count {
    font-size: 0.75rem;
    color: #64748b;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    font-weight: 600;
  }

  .results-close {
    background: none;
    border: none;
    color: #475569;
    cursor: pointer;
    font-size: 0.75rem;
    padding: 0.125rem 0.375rem;
    border-radius: 3px;
    transition: color 0.15s;
  }

  .results-close:hover {
    color: #94a3b8;
  }

  .search-results-list {
    display: flex;
    flex-direction: column;
    max-height: 360px;
    overflow-y: auto;
  }

  .search-result-row {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    padding: 0.625rem 1rem;
    border-bottom: 1px solid #1e2435;
    text-decoration: none;
    color: inherit;
    transition: background 0.15s;
  }

  .search-result-row:hover {
    background: #21273a;
  }

  .search-result-row:last-child {
    border-bottom: none;
  }

  .result-status-icon {
    font-size: 0.75rem;
    width: 1rem;
    text-align: center;
    flex-shrink: 0;
  }

  .result-info {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    flex: 1;
    min-width: 0;
  }

  .result-id {
    font-size: 0.7rem;
    color: #a855f7;
    font-weight: 600;
    flex-shrink: 0;
  }

  .result-type {
    font-size: 0.675rem;
    color: #64748b;
    background: #1e2435;
    padding: 0.1rem 0.375rem;
    border-radius: 3px;
    flex-shrink: 0;
  }

  .result-title {
    font-size: 0.8125rem;
    color: #e2e8f0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .result-meta {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-shrink: 0;
  }

  .result-priority {
    font-size: 0.675rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .result-time {
    font-size: 0.675rem;
    color: #475569;
    font-variant-numeric: tabular-nums;
  }

  /* Stats section */

  .stats-section {
    display: flex;
    flex-wrap: wrap;
    gap: 1.5rem;
    align-items: flex-start;
  }

  .stat-group {
    display: flex;
    gap: 0.75rem;
    flex-wrap: wrap;
  }

  .stat-card {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.25rem;
    padding: 0.875rem 1.25rem;
    background: #1a1f2e;
    border: 1px solid #2d3748;
    border-radius: 8px;
    min-width: 90px;
  }

  .stat-card.primary { border-color: #a855f7; }
  .stat-card.status-active-card { border-color: rgba(59, 130, 246, 0.4); }
  .stat-card.status-done-card { border-color: rgba(34, 197, 94, 0.4); }
  .stat-card.status-cancelled-card { border-color: rgba(239, 68, 68, 0.4); }
  .stat-card.muted { opacity: 0.6; }

  /* T878: filter bar */
  .filter-bar {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  .filter-chip {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.375rem 0.75rem;
    border-radius: 6px;
    font-size: 0.75rem;
    font-weight: 500;
    color: #94a3b8;
    background: #1a1f2e;
    border: 1px solid #2d3748;
    text-decoration: none;
    transition: all 0.15s;
  }
  .filter-chip:hover {
    color: #e2e8f0;
    background: #21273a;
  }
  .filter-chip.active {
    color: #a855f7;
    border-color: rgba(168, 85, 247, 0.5);
    background: rgba(168, 85, 247, 0.08);
  }
  .chip-check {
    display: inline-block;
    width: 0.875rem;
    text-align: center;
    font-size: 0.75rem;
    opacity: 0.9;
  }

  .panel-sub {
    font-size: 0.7rem;
    color: #64748b;
    font-weight: 400;
    margin-left: 0.5rem;
    text-transform: none;
    letter-spacing: 0;
  }

  /* T878 / T958: cancelled epic styling (was .epic-deferred). */
  .epic-row.epic-cancelled {
    opacity: 0.7;
  }
  .epic-row.epic-cancelled .epic-title {
    color: #94a3b8;
  }
  .epic-status-badge {
    font-size: 0.65rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    padding: 0.1rem 0.375rem;
    border-radius: 3px;
    flex-shrink: 0;
  }
  .badge-cancelled {
    background: rgba(239, 68, 68, 0.15);
    color: #ef4444;
  }
  .sub-cancelled {
    color: #ef4444;
  }

  .stat-num {
    font-size: 1.75rem;
    font-weight: 700;
    color: #f1f5f9;
    font-variant-numeric: tabular-nums;
  }

  .stat-lbl {
    font-size: 0.7rem;
    color: #64748b;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .priority-breakdown {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    min-width: 200px;
  }

  .section-label {
    font-size: 0.75rem;
    color: #64748b;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    font-weight: 600;
  }

  .priority-bars {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
  }

  .priority-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .priority-label {
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    width: 60px;
  }

  .priority-bar-track {
    flex: 1;
    height: 6px;
    background: #1a1f2e;
    border-radius: 3px;
    overflow: hidden;
    max-width: 120px;
  }

  .priority-bar-fill {
    height: 100%;
    border-radius: 3px;
    transition: width 0.3s ease;
  }

  .priority-count {
    font-size: 0.75rem;
    color: #94a3b8;
    min-width: 2rem;
    text-align: right;
    font-variant-numeric: tabular-nums;
  }

  :global(.priority-critical) { color: #ef4444; }
  :global(.priority-high) { color: #f97316; }
  :global(.priority-medium) { color: #eab308; }
  :global(.priority-low) { color: #64748b; }

  .priority-bar-fill.priority-critical { background: #ef4444; }
  .priority-bar-fill.priority-high { background: #f97316; }
  .priority-bar-fill.priority-medium { background: #eab308; }
  .priority-bar-fill.priority-low { background: #64748b; }

  .type-breakdown {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .type-chips {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
  }

  .type-chip {
    font-size: 0.8125rem;
    color: #94a3b8;
  }

  .type-chip strong {
    color: #f1f5f9;
    font-variant-numeric: tabular-nums;
  }

  .no-db {
    padding: 1.5rem;
    background: #1a1f2e;
    border: 1px dashed #ef4444;
    border-radius: 8px;
    color: #ef4444;
    font-size: 0.875rem;
    text-align: center;
  }

  .lower-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1.5rem;
  }

  @media (max-width: 800px) {
    .lower-grid { grid-template-columns: 1fr; }
  }

  .panel {
    background: #1a1f2e;
    border: 1px solid #2d3748;
    border-radius: 8px;
    overflow: hidden;
  }

  .panel-title {
    padding: 0.75rem 1rem;
    font-size: 0.8125rem;
    font-weight: 600;
    color: #94a3b8;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    border-bottom: 1px solid #2d3748;
  }

  .epic-list { display: flex; flex-direction: column; }

  .epic-row {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    padding: 0.75rem 1rem;
    border-bottom: 1px solid #1e2435;
    text-decoration: none;
    color: inherit;
    transition: background 0.15s;
  }

  .epic-row:hover { background: #21273a; }
  .epic-row:last-child { border-bottom: none; }

  .epic-header-row {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
  }

  .epic-id { font-size: 0.7rem; color: #a855f7; font-weight: 600; flex-shrink: 0; }
  .epic-title { font-size: 0.8125rem; color: #e2e8f0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .epic-counts { font-size: 0.75rem; color: #22c55e; font-variant-numeric: tabular-nums; flex-shrink: 0; }
  .epic-pct { font-size: 0.75rem; color: #94a3b8; font-variant-numeric: tabular-nums; flex-shrink: 0; }

  .epic-progress-bar {
    height: 4px;
    background: #2d3748;
    border-radius: 2px;
    overflow: hidden;
  }

  .epic-done-bar {
    height: 100%;
    background: #22c55e;
    border-radius: 2px;
    transition: width 0.3s ease;
  }

  .epic-sub-counts { display: flex; gap: 0.75rem; font-size: 0.7rem; }
  .sub-done { color: #22c55e; }
  .sub-active { color: #3b82f6; }
  .sub-pending { color: #64748b; }

  .task-list { display: flex; flex-direction: column; }

  .task-row {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    padding: 0.625rem 1rem;
    border-bottom: 1px solid #1e2435;
    text-decoration: none;
    color: inherit;
    transition: background 0.15s;
  }

  .task-row:hover { background: #21273a; }
  .task-row:last-child { border-bottom: none; }

  .task-status-icon { font-size: 0.75rem; width: 1rem; text-align: center; flex-shrink: 0; }

  :global(.status-done) { color: #22c55e; }
  :global(.status-active) { color: #3b82f6; }
  :global(.status-blocked) { color: #ef4444; }
  :global(.status-pending) { color: #475569; }

  .task-info { display: flex; align-items: baseline; gap: 0.5rem; flex: 1; min-width: 0; }
  .task-id { font-size: 0.7rem; color: #a855f7; font-weight: 600; flex-shrink: 0; }
  .task-title { font-size: 0.8125rem; color: #e2e8f0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  .task-meta { display: flex; align-items: center; gap: 0.5rem; flex-shrink: 0; }

  .task-priority { font-size: 0.675rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; }
  .task-stage { font-size: 0.675rem; color: #475569; background: #1e2435; padding: 0.1rem 0.375rem; border-radius: 3px; }
  .task-time { font-size: 0.675rem; color: #475569; font-variant-numeric: tabular-nums; }
</style>
