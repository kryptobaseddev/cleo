<!--
  /tasks — command surface for the CLEO Task Explorer.

  Wave 1C relayout of the T956 hybrid dashboard. Operator feedback
  (captured in `.cleo/agent-outputs/T990-design-research/tasks-page-audit.md`):

    - Kanban + Graph were buried below the fold on a 900-1100px viewport
    - Explorer body capped at `min-height: 400px` so the d3 graph never
      had room to breathe
    - Dashboard cards dominated the visual hierarchy

  This file now renders a **two-column command surface**:

    ┌──────────────────────────────────────────────┬──────────────┐
    │  Header (title + nav + live indicator)        │              │
    │  Search                                       │              │
    │  ── Task Explorer (hero, fills viewport) ──   │  Right rail  │
    │  [1 Hierarchy] [2 Graph] [3 Kanban]           │  • Stats     │
    │  <tab body: flex:1 min-height:0>              │  • Priority  │
    │                                               │  • Epic prog │
    │                                               │  • Recent    │
    └──────────────────────────────────────────────┴──────────────┘

  Below 1100px the right rail collapses to a single column under the
  Explorer (still scrollable, still full viewport — just stacked).

  Every existing behaviour is preserved:

    - `?q=`, `?status=`, `?priority=`, `?labels=`, `?cancelled=`,
      `?selected=`, `?view=` round-trip through the URL.
    - SSE live indicator pings `/api/tasks/events` every 2s.
    - `/tasks#hierarchy` / `#graph` / `#kanban` deep links work (T957).
    - `1` / `2` / `3` switch tabs globally.
    - `/` focuses the Explorer search.
    - `Esc` closes the DetailDrawer.
    - The dashboard filter toggles (`cancelled`, `archived`) still flip
      via anchored navigation.

  @task T956
  @epic T949
  @reviewed T990 (Wave 1C)
-->
<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/stores';
  import type { Task, TaskPriority, TaskStatus } from '@cleocode/contracts';
  import { onMount, untrack } from 'svelte';

  import {
    DetailDrawer,
    EpicProgressCard,
    FilterChipGroup,
    type FilterChipOption,
    GraphTab,
    HierarchyTab,
    KanbanTab,
    LabelsFilter,
    RecentActivityFeed,
    TaskSearchBox,
  } from '$lib/components/tasks';
  import {
    createTaskFilters,
    type TaskFilters,
    type TaskView,
  } from '$lib/stores/task-filters.svelte.js';
  import { normalizeSearch } from '$lib/tasks/search.js';

  import type { SearchTaskRow } from '../api/tasks/search/+server.js';
  import type {
    DashboardFilters,
    DashboardStats,
    EpicProgress,
    RecentTask,
  } from './+page.server.js';
  import type { PageData } from './$types';

  interface Props {
    data: PageData;
  }
  let { data }: Props = $props();

  // ---------------------------------------------------------------------------
  // Dashboard data (preserved verbatim from the pre-T956 page)
  // ---------------------------------------------------------------------------

  const stats = $derived<DashboardStats | null>(data.stats);
  const recentTasks = $derived<RecentTask[]>(data.recentTasks ?? []);
  const epicProgress = $derived<EpicProgress[]>(data.epicProgress ?? []);
  const dashboardFilters = $derived<DashboardFilters>(
    data.filters ?? { showCancelled: false, showArchived: false },
  );

  /**
   * Build a toggle URL that flips one dashboard filter flag while preserving
   * the other.
   */
  function toggleUrl(flag: 'cancelled' | 'archived'): string {
    const next = new URL($page.url);
    const current = next.searchParams.get(flag) === '1';
    if (current) {
      next.searchParams.delete(flag);
    } else {
      next.searchParams.set(flag, '1');
    }
    if (flag === 'cancelled') next.searchParams.delete('deferred');
    return next.pathname + (next.search ? next.search : '');
  }

  // ---------------------------------------------------------------------------
  // Filter store (shared with the Task Explorer)
  // ---------------------------------------------------------------------------

  let filters = $state<TaskFilters>(createTaskFilters(new URL($page.url)));

  $effect(() => {
    const url = new URL($page.url);
    const { next, old } = untrack(() => {
      const created = createTaskFilters(url);
      const previous = filters;
      filters = created;
      return { next: created, old: previous };
    });
    return () => {
      next.dispose();
      old?.dispose();
    };
  });

  function parseHashView(hash: string): TaskView | null {
    const cleaned = hash.replace(/^#/, '').toLowerCase();
    if (cleaned === 'hierarchy' || cleaned === 'graph' || cleaned === 'kanban') {
      return cleaned;
    }
    return null;
  }

  onMount(() => {
    function readHash(): void {
      if (!filters) return;
      const hashView = parseHashView(window.location.hash);
      if (hashView && hashView !== filters.state.view) {
        filters.setView(hashView);
      }
    }
    readHash();
    window.addEventListener('hashchange', readHash);
    return () => window.removeEventListener('hashchange', readHash);
  });

  function switchView(v: TaskView): void {
    if (!filters) return;
    filters.setView(v);
    if (typeof window !== 'undefined' && window.location.hash !== `#${v}`) {
      const next = `${window.location.pathname}${window.location.search}#${v}`;
      window.history.replaceState(window.history.state, '', next);
    }
  }

  // ---------------------------------------------------------------------------
  // Explorer projections
  // ---------------------------------------------------------------------------

  const explorerTasks = $derived<Task[]>(data.explorer?.tasks ?? []);
  const explorerDeps = $derived(data.explorer?.deps ?? []);
  const explorerLabels = $derived<string[]>(data.explorer?.labels ?? []);
  const explorerEpicProgressMap = $derived(data.explorer?.epicProgress ?? {});

  const selectedTask = $derived<Task | null>(
    (() => {
      if (!filters) return null;
      const id = filters.state.selected;
      if (!id) return null;
      return explorerTasks.find((t) => t.id === id) ?? null;
    })(),
  );

  // ---------------------------------------------------------------------------
  // Filter chips for the Explorer toolbar
  // ---------------------------------------------------------------------------

  const statusOptions: FilterChipOption[] = [
    { value: 'pending', label: 'Pending', tint: 'var(--status-pending)' },
    { value: 'active', label: 'Active', tint: 'var(--status-active)' },
    { value: 'blocked', label: 'Blocked', tint: 'var(--status-blocked)' },
    { value: 'done', label: 'Done', tint: 'var(--status-done)' },
    { value: 'cancelled', label: 'Cancelled', tint: 'var(--status-cancelled)' },
  ];

  const priorityOptions: FilterChipOption[] = [
    { value: 'critical', label: 'Critical', tint: 'var(--priority-critical)' },
    { value: 'high', label: 'High', tint: 'var(--priority-high)' },
    { value: 'medium', label: 'Medium', tint: 'var(--priority-medium)' },
    { value: 'low', label: 'Low', tint: 'var(--priority-low)' },
  ];

  const labelOptions = $derived<FilterChipOption[]>(
    explorerLabels.map((label) => ({ value: label, label })),
  );

  function diffAndToggle<T extends string>(
    before: readonly T[],
    after: readonly string[],
    toggle: (value: T) => void,
  ): void {
    const beforeSet = new Set<string>(before);
    const afterSet = new Set<string>(after);
    for (const v of beforeSet) {
      if (!afterSet.has(v)) toggle(v as T);
    }
    for (const v of afterSet) {
      if (!beforeSet.has(v)) toggle(v as T);
    }
  }

  // ---------------------------------------------------------------------------
  // Legacy search bar (exact-id navigate + title fuzzy)
  // ---------------------------------------------------------------------------

  let searchRaw = $state('');
  let searchLoading = $state(false);
  let searchError = $state<string | null>(null);
  let titleResults = $state<SearchTaskRow[]>([]);
  let idNotFound = $state(false);
  let resolvedId = $state<string | null>(null);
  let noTitleResults = $state(false);
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

    const controller = new AbortController();
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
            goto(`/tasks/${body.task.id}`);
          } else {
            idNotFound = true;
            const parsed = normalizeSearch(raw);
            resolvedId = parsed.kind === 'id' ? parsed.id : null;
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
  // Display helpers
  // ---------------------------------------------------------------------------

  function priorityClassLocal(p: string): string {
    if (p === 'critical') return 'priority-critical';
    if (p === 'high') return 'priority-high';
    if (p === 'medium') return 'priority-medium';
    return 'priority-low';
  }

  function statusIconLocal(s: string): string {
    if (s === 'done') return '✓';
    if (s === 'active') return '●';
    if (s === 'blocked') return '✗';
    return '○';
  }

  function statusClassLocal(s: string): string {
    if (s === 'done') return 'status-done';
    if (s === 'active') return 'status-active';
    if (s === 'blocked') return 'status-blocked';
    return 'status-pending';
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

  // ---------------------------------------------------------------------------
  // Live SSE indicator
  // ---------------------------------------------------------------------------

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

  // ---------------------------------------------------------------------------
  // Page-level keyboard shortcuts
  // ---------------------------------------------------------------------------

  function onPageKey(e: KeyboardEvent): void {
    if (!filters) return;
    const target = e.target;
    if (target instanceof HTMLElement) {
      const tag = target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable) return;
    }
    if (e.key === '1') {
      e.preventDefault();
      switchView('hierarchy');
    } else if (e.key === '2') {
      e.preventDefault();
      switchView('graph');
    } else if (e.key === '3') {
      e.preventDefault();
      switchView('kanban');
    }
  }
</script>

<svelte:head>
  <title>Tasks — CLEO Studio</title>
</svelte:head>

<svelte:window onkeydown={onPageKey} />

<div class="tasks-page">
  <div class="page-header">
    <div class="header-left">
      <h1 class="page-title">Tasks</h1>
      <nav class="tasks-nav">
        <a href="/tasks" class="nav-tab active">Dashboard</a>
        <a href="/tasks/pipeline" class="nav-tab">Pipeline</a>
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

  <!-- Search bar (full-width) -->
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
          <span class="results-count"
            >{titleResults.length} result{titleResults.length === 1 ? '' : 's'}</span
          >
          <button class="results-close" onclick={clearSearch} aria-label="Close results">✕</button>
        </div>
        <div class="search-results-list">
          {#each titleResults as t (t.id)}
            <a href="/tasks/{t.id}" class="search-result-row" onclick={clearSearch}>
              <span class="result-status-icon {statusClassLocal(t.status)}"
                >{statusIconLocal(t.status)}</span
              >
              <div class="result-info">
                <span class="result-id">{t.id}</span>
                {#if t.type !== 'task'}
                  <span class="result-type">{t.type}</span>
                {/if}
                <span class="result-title">{t.title}</span>
              </div>
              <div class="result-meta">
                <span class="result-priority {priorityClassLocal(t.priority)}">{t.priority}</span>
                <span class="result-time">{formatTime(t.updated_at)}</span>
              </div>
            </a>
          {/each}
        </div>
      {/if}
    </div>
  {/if}

  <!-- COMMAND SURFACE — Explorer hero + Right rail -->
  {#if filters}
    <div class="command-surface">
      <!-- Task Explorer (hero) -->
      <section class="task-explorer" aria-label="Task Explorer">
        <header class="explorer-header">
          <div class="tabs" role="tablist" aria-label="Task Explorer views">
            <button
              type="button"
              class="tab"
              class:active={filters.state.view === 'hierarchy'}
              role="tab"
              aria-selected={filters.state.view === 'hierarchy'}
              onclick={() => switchView('hierarchy')}
            >
              <span class="tab-key" aria-hidden="true">1</span>
              Hierarchy
            </button>
            <button
              type="button"
              class="tab"
              class:active={filters.state.view === 'graph'}
              role="tab"
              aria-selected={filters.state.view === 'graph'}
              onclick={() => switchView('graph')}
            >
              <span class="tab-key" aria-hidden="true">2</span>
              Graph
            </button>
            <button
              type="button"
              class="tab"
              class:active={filters.state.view === 'kanban'}
              role="tab"
              aria-selected={filters.state.view === 'kanban'}
              onclick={() => switchView('kanban')}
            >
              <span class="tab-key" aria-hidden="true">3</span>
              Kanban
            </button>
          </div>

          <div class="toolbar">
            <TaskSearchBox
              value={filters.state.query}
              onChange={(q) => filters?.setQuery(q)}
              placeholder="Filter explorer by id or title..."
              registerSlashShortcut={true}
            />
            <FilterChipGroup
              label="Status"
              options={statusOptions}
              selected={filters.state.status}
              onChange={(next) => {
                if (!filters) return;
                diffAndToggle<TaskStatus>(
                  filters.state.status,
                  next,
                  (v) => filters?.toggleStatus(v),
                );
              }}
            />
            <FilterChipGroup
              label="Priority"
              options={priorityOptions}
              selected={filters.state.priority}
              onChange={(next) => {
                if (!filters) return;
                diffAndToggle<TaskPriority>(
                  filters.state.priority,
                  next,
                  (v) => filters?.togglePriority(v),
                );
              }}
            />
            {#if labelOptions.length > 0}
              <LabelsFilter
                options={labelOptions}
                selected={filters.state.labels}
                onChange={(next) => {
                  if (!filters) return;
                  diffAndToggle<string>(
                    filters.state.labels,
                    next,
                    (v) => filters?.toggleLabel(v),
                  );
                }}
              />
            {/if}
          </div>
        </header>

        <div class="explorer-body">
          {#if filters.state.view === 'hierarchy'}
            <HierarchyTab
              tasks={explorerTasks}
              deps={explorerDeps}
              epicProgress={explorerEpicProgressMap}
              {filters}
            />
          {:else if filters.state.view === 'graph'}
            <GraphTab tasks={explorerTasks} deps={explorerDeps} {filters} labels={explorerLabels} />
          {:else}
            <KanbanTab tasks={explorerTasks} deps={explorerDeps} {filters} />
          {/if}
        </div>
      </section>

      <!-- Right rail — dashboard summary -->
      <aside class="side-rail" aria-label="Dashboard summary">
        {#if stats}
          <section class="rail-card" aria-label="Task counts">
            <header class="rail-head">
              <span class="rail-eyebrow">Overview</span>
              <span class="rail-total">{stats.total} <span class="rail-total-lbl">tasks</span></span>
            </header>
            <div class="stat-grid">
              <span class="stat-card status-active-card">
                <span class="stat-num">{stats.active}</span>
                <span class="stat-lbl">Active</span>
              </span>
              <span class="stat-card">
                <span class="stat-num">{stats.pending}</span>
                <span class="stat-lbl">Pending</span>
              </span>
              <span class="stat-card status-done-card">
                <span class="stat-num">{stats.done}</span>
                <span class="stat-lbl">Done</span>
              </span>
              <span class="stat-card status-cancelled-card">
                <span class="stat-num">{stats.cancelled}</span>
                <span class="stat-lbl">Cancelled</span>
              </span>
              <span class="stat-card muted">
                <span class="stat-num">{stats.archived}</span>
                <span class="stat-lbl">Archived</span>
              </span>
            </div>

            <div class="priority-block">
              <div class="section-label">Priority</div>
              <div class="priority-bars">
                {#each [['critical', stats.critical], ['high', stats.high], ['medium', stats.medium], ['low', stats.low]] as [label, count] (label)}
                  {@const total = stats.critical + stats.high + stats.medium + stats.low}
                  {@const pct = total > 0 ? Math.round((Number(count) / total) * 100) : 0}
                  <div class="priority-row">
                    <span class="priority-label {priorityClassLocal(String(label))}">{label}</span>
                    <div class="priority-bar-track">
                      <div
                        class="priority-bar-fill {priorityClassLocal(String(label))}"
                        style="width:{pct}%"
                      ></div>
                    </div>
                    <span class="priority-count">{count}</span>
                  </div>
                {/each}
              </div>
            </div>

            <div class="type-block">
              <div class="section-label">Type</div>
              <div class="type-chips">
                <span class="type-chip">Epics <strong>{stats.epics}</strong></span>
                <span class="type-chip">Tasks <strong>{stats.tasks}</strong></span>
                <span class="type-chip">Subtasks <strong>{stats.subtasks}</strong></span>
              </div>
            </div>

            <div class="filter-bar" aria-label="Dashboard filters">
              <a
                href={toggleUrl('cancelled')}
                class="filter-chip"
                class:active={dashboardFilters.showCancelled}
                data-sveltekit-noscroll
                title="Include cancelled epics in the Epic Progress panel"
              >
                <span class="chip-check">{dashboardFilters.showCancelled ? '✓' : ' '}</span>
                Cancelled epics
              </a>
              <a
                href={toggleUrl('archived')}
                class="filter-chip"
                class:active={dashboardFilters.showArchived}
                data-sveltekit-noscroll
                title="Include archived tasks in Recent Activity"
              >
                <span class="chip-check">{dashboardFilters.showArchived ? '✓' : ' '}</span>
                Archived
              </a>
            </div>
          </section>
        {:else}
          <div class="no-db">tasks.db not found — start CLEO in the project directory</div>
        {/if}

        {#if epicProgress.length > 0}
          <EpicProgressCard
            epics={epicProgress}
            includingDeferred={dashboardFilters.showCancelled}
          />
        {/if}

        {#if recentTasks.length > 0}
          <RecentActivityFeed tasks={recentTasks} />
        {/if}
      </aside>
    </div>

    <DetailDrawer task={selectedTask} onClose={() => filters?.setSelected(null)} />
  {/if}
</div>

<style>
  .tasks-page {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    /* Bounded viewport so the Explorer + Side-Rail scroll internally rather
       than pushing the whole page into scroll. */
    height: calc(100vh - 3.5rem);
    min-height: 0;
    padding-inline: var(--space-6);
    padding-block: var(--space-4);
    max-width: none;
    overflow: hidden;
  }

  /* Below the mobile breakpoint the two-column grid collapses to a single
     column; let the whole page scroll naturally. */
  @media (max-width: 1100px) {
    .tasks-page {
      height: auto;
      min-height: calc(100vh - 3.5rem);
      overflow: visible;
    }
  }

  .page-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: var(--space-3);
  }

  .header-left {
    display: flex;
    align-items: center;
    gap: var(--space-5);
  }

  .page-title {
    font-size: var(--text-2xl);
    font-weight: 700;
    color: var(--text);
    letter-spacing: -0.01em;
    margin: 0;
  }

  .tasks-nav {
    display: flex;
    gap: var(--space-1);
  }

  .nav-tab {
    padding: 4px var(--space-3);
    border-radius: var(--radius-sm);
    text-decoration: none;
    font-size: var(--text-sm);
    font-weight: 500;
    color: var(--text-dim);
    transition: color var(--ease), background var(--ease);
  }

  .nav-tab:hover {
    color: var(--text);
    background: var(--bg-elev-2);
  }

  .nav-tab.active {
    color: var(--accent);
    background: var(--accent-soft);
  }

  .live-indicator {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-size: var(--text-xs);
    color: var(--text-faint);
  }

  .live-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--text-faint);
  }

  .live-indicator.connected .live-dot {
    background: var(--success);
    box-shadow: 0 0 6px var(--success);
  }

  .live-indicator.connected .live-label {
    color: var(--success);
  }

  .live-ts {
    color: var(--text-faint);
  }

  /* Search bar */

  .search-section {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .search-box {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    background: var(--bg-elev-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    padding: var(--space-2) var(--space-3);
    transition: border-color var(--ease), box-shadow var(--ease);
  }

  .search-box:focus-within {
    border-color: var(--accent);
    box-shadow: var(--shadow-focus);
  }

  .search-box.loading {
    border-color: color-mix(in srgb, var(--accent) 55%, transparent);
  }

  .search-icon {
    color: var(--text-faint);
    font-size: var(--text-md);
    line-height: 1;
    user-select: none;
  }

  .search-input {
    flex: 1;
    background: transparent;
    border: none;
    outline: none;
    color: var(--text);
    font-size: var(--text-base);
    min-width: 0;
    font-family: inherit;
  }

  .search-input::placeholder {
    color: var(--text-faint);
  }

  .search-clear {
    background: none;
    border: none;
    color: var(--text-faint);
    cursor: pointer;
    font-size: var(--text-xs);
    padding: 2px 4px;
    border-radius: var(--radius-xs);
    transition: color var(--ease);
  }

  .search-clear:hover {
    color: var(--text-dim);
  }

  .search-error {
    font-size: var(--text-xs);
    color: var(--danger);
    padding: 0 var(--space-1);
  }

  .search-results-panel {
    background: var(--bg-elev-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    overflow: hidden;
  }

  .search-empty {
    padding: var(--space-4);
    font-size: var(--text-base);
    color: var(--text-dim);
    text-align: center;
  }

  .search-results-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--space-2) var(--space-4);
    border-bottom: 1px solid var(--border);
  }

  .results-count {
    font-size: var(--text-xs);
    color: var(--text-dim);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    font-weight: 600;
  }

  .results-close {
    background: none;
    border: none;
    color: var(--text-faint);
    cursor: pointer;
    font-size: var(--text-xs);
    padding: 2px 6px;
    border-radius: var(--radius-xs);
    transition: color var(--ease);
  }

  .results-close:hover {
    color: var(--text-dim);
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
    gap: var(--space-2);
    padding: var(--space-2) var(--space-4);
    border-bottom: 1px solid var(--bg-elev-2);
    text-decoration: none;
    color: inherit;
    transition: background var(--ease);
  }

  .search-result-row:hover {
    background: var(--bg-elev-2);
  }

  .search-result-row:last-child {
    border-bottom: none;
  }

  .result-status-icon {
    font-size: var(--text-xs);
    width: 1rem;
    text-align: center;
    flex-shrink: 0;
  }

  .result-info {
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
    flex: 1;
    min-width: 0;
  }

  .result-id {
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    color: var(--accent);
    font-weight: 600;
    flex-shrink: 0;
  }

  .result-type {
    font-size: 0.625rem;
    color: var(--text-dim);
    background: var(--bg-elev-2);
    padding: 2px 6px;
    border-radius: var(--radius-xs);
    flex-shrink: 0;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .result-title {
    font-size: var(--text-sm);
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .result-meta {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-shrink: 0;
  }

  .result-priority {
    font-size: 0.625rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .result-time {
    font-size: 0.625rem;
    color: var(--text-faint);
    font-variant-numeric: tabular-nums;
  }

  /* =========================================================================
     Command surface — Explorer hero + right-rail summary
     ========================================================================= */

  .command-surface {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 320px;
    gap: var(--space-4);
    flex: 1;
    min-height: 0;
  }

  @media (max-width: 1100px) {
    .command-surface {
      grid-template-columns: minmax(0, 1fr);
    }
    .side-rail {
      max-height: none;
    }
  }

  /* ---------------- Task Explorer (hero) ---------------- */

  .task-explorer {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    background: var(--bg-elev-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    padding: var(--space-4);
    min-height: 0;
    min-width: 0;
  }

  .explorer-header {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    flex-shrink: 0;
  }

  .tabs {
    display: inline-flex;
    gap: 4px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    padding: 4px;
    align-self: flex-start;
  }

  .tab {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px var(--space-3);
    border-radius: var(--radius-md);
    border: none;
    background: transparent;
    color: var(--text-dim);
    font-size: var(--text-sm);
    font-weight: 500;
    font-family: inherit;
    cursor: pointer;
    transition: background var(--ease), color var(--ease);
  }

  .tab:hover {
    color: var(--text);
    background: var(--accent-halo);
  }

  .tab:focus-visible {
    outline: none;
    box-shadow: var(--shadow-focus);
  }

  .tab.active {
    color: var(--accent);
    background: var(--accent-soft);
  }

  .tab-key {
    font-size: 0.625rem;
    font-family: var(--font-mono);
    padding: 1px 6px;
    border-radius: var(--radius-xs);
    background: color-mix(in srgb, var(--text) 6%, transparent);
    color: var(--text-dim);
    line-height: 1.2;
  }

  .tab.active .tab-key {
    color: var(--accent);
    background: color-mix(in srgb, var(--accent) 14%, transparent);
  }

  .toolbar {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    align-items: center;
  }

  .explorer-body {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }

  /* ---------------- Side rail (dashboard summary) ---------------- */

  .side-rail {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    min-height: 0;
    /* Rail fills its grid cell and scrolls independently from the Explorer. */
    height: 100%;
    overflow-y: auto;
    padding-right: 4px;
  }

  .side-rail::-webkit-scrollbar {
    width: 6px;
  }
  .side-rail::-webkit-scrollbar-thumb {
    background: var(--bg-elev-2);
    border-radius: var(--radius-pill);
  }

  .rail-card {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    padding: var(--space-4);
    background: var(--bg-elev-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
  }

  .rail-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-2);
  }

  .rail-eyebrow {
    font-size: var(--text-2xs);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-faint);
    font-weight: 600;
  }

  .rail-total {
    font-family: var(--font-mono);
    font-size: var(--text-xl);
    font-weight: 700;
    color: var(--text);
    font-variant-numeric: tabular-nums;
  }

  .rail-total-lbl {
    font-size: var(--text-xs);
    color: var(--text-faint);
    font-weight: 500;
    margin-left: 2px;
    text-transform: lowercase;
  }

  .stat-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--space-2);
  }

  .stat-card {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: var(--space-2) var(--space-3);
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
  }

  .stat-card.status-active-card {
    border-color: color-mix(in srgb, var(--status-active) 40%, transparent);
  }
  .stat-card.status-done-card {
    border-color: color-mix(in srgb, var(--status-done) 40%, transparent);
  }
  .stat-card.status-cancelled-card {
    border-color: color-mix(in srgb, var(--status-cancelled) 40%, transparent);
  }
  .stat-card.muted {
    opacity: 0.6;
  }

  .stat-num {
    font-family: var(--font-mono);
    font-size: var(--text-lg);
    font-weight: 700;
    color: var(--text);
    font-variant-numeric: tabular-nums;
  }

  .stat-lbl {
    font-size: 0.625rem;
    color: var(--text-faint);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .priority-block,
  .type-block {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .section-label {
    font-size: var(--text-2xs);
    color: var(--text-faint);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    font-weight: 600;
  }

  .priority-bars {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .priority-row {
    display: grid;
    grid-template-columns: 64px 1fr auto;
    align-items: center;
    gap: var(--space-2);
  }

  .priority-label {
    font-size: var(--text-2xs);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .priority-bar-track {
    height: 6px;
    background: var(--bg);
    border-radius: var(--radius-pill);
    overflow: hidden;
  }

  .priority-bar-fill {
    height: 100%;
    border-radius: var(--radius-pill);
    transition: width var(--ease-slow);
  }

  .priority-count {
    font-size: var(--text-xs);
    color: var(--text-dim);
    text-align: right;
    font-variant-numeric: tabular-nums;
    min-width: 2ch;
  }

  :global(.priority-critical) {
    color: var(--priority-critical);
  }
  :global(.priority-high) {
    color: var(--priority-high);
  }
  :global(.priority-medium) {
    color: var(--priority-medium);
  }
  :global(.priority-low) {
    color: var(--priority-low);
  }

  .priority-bar-fill.priority-critical {
    background: var(--priority-critical);
  }
  .priority-bar-fill.priority-high {
    background: var(--priority-high);
  }
  .priority-bar-fill.priority-medium {
    background: var(--priority-medium);
  }
  .priority-bar-fill.priority-low {
    background: var(--priority-low);
  }

  .type-chips {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
  }

  .type-chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: var(--text-xs);
    color: var(--text-dim);
    background: var(--bg);
    border: 1px solid var(--border);
    padding: 2px 8px;
    border-radius: var(--radius-pill);
  }

  .type-chip strong {
    color: var(--text);
    font-family: var(--font-mono);
    font-variant-numeric: tabular-nums;
  }

  .filter-bar {
    display: flex;
    gap: var(--space-2);
    flex-wrap: wrap;
  }

  .filter-chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px var(--space-2);
    border-radius: var(--radius-sm);
    font-size: var(--text-2xs);
    font-weight: 500;
    color: var(--text-dim);
    background: var(--bg);
    border: 1px solid var(--border);
    text-decoration: none;
    transition: color var(--ease), border-color var(--ease), background var(--ease);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .filter-chip:hover {
    color: var(--text);
    border-color: var(--border-strong);
  }

  .filter-chip.active {
    color: var(--accent);
    border-color: color-mix(in srgb, var(--accent) 50%, transparent);
    background: var(--accent-soft);
  }

  .chip-check {
    display: inline-block;
    width: 0.75rem;
    text-align: center;
    font-size: 0.625rem;
    opacity: 0.9;
  }

  .no-db {
    padding: var(--space-4);
    background: var(--bg-elev-1);
    border: 1px dashed var(--danger);
    border-radius: var(--radius-md);
    color: var(--danger);
    font-size: var(--text-sm);
    text-align: center;
  }

  /* Status colour tokens reused by the search-result rows */
  :global(.status-done) {
    color: var(--status-done);
  }
  :global(.status-active) {
    color: var(--status-active);
  }
  :global(.status-blocked) {
    color: var(--status-blocked);
  }
  :global(.status-pending) {
    color: var(--status-pending);
  }
</style>
