<!--
  T956 — /tasks hybrid (dashboard panel + embedded 3-tab Task Explorer).

  W2A of T949 ("Option C hybrid" per operator decision 2026-04-17). The
  top of the page preserves the dashboard VERBATIM (stats / priority bars
  / type chips / filter chips / Epic Progress / Recent Activity / live
  SSE indicator). Below it, the 3-tab Task Explorer (Hierarchy / Graph /
  Kanban) renders against the same `ExplorerBundle` loaded server-side.

  Switching tabs does NOT re-query the server — it projects from the
  already-loaded bundle. Tab state is URL-synced (`?view=` + hash so
  `/tasks#graph`-style links from the T957 redirects land correctly).
  Search, status/priority/label/cancelled filters, and selection all live
  in the shared `createTaskFilters(url)` store (T951) and round-trip
  through the URL. The `DetailDrawer` is rendered once globally, driven by
  `filters.state.selected`.

  Preservation checklist (per docs/specs/CLEO-TASK-DASHBOARD-SPEC.md §9):
    - Epic Progress (direct-children per T874) — via `EpicProgressCard`
    - Recent Activity (last 20 by updated_at) — via `RecentActivityFeed`
    - Live SSE indicator (2-second EventSource)
    - `?archived=1` / `?cancelled=1` toggle chips
    - Search by ID (exact match navigates) or title (fuzzy via /api/tasks/search)
    - All existing stats rows + priority bars + type chips

  Keyboard:
    - `/` focuses the Explorer search box (registered by TaskSearchBox)
    - `1` / `2` / `3` switch Hierarchy / Graph / Kanban tabs
    - `Esc` closes the DetailDrawer
    - Tab-specific navigation lives in each tab component

  @task T956
  @epic T949
-->
<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/stores';
  import type { Task, TaskPriority, TaskStatus } from '@cleocode/contracts';
  import { onMount } from 'svelte';

  import {
    DetailDrawer,
    EpicProgressCard,
    FilterChipGroup,
    type FilterChipOption,
    GraphTab,
    HierarchyTab,
    KanbanTab,
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
  // T878 / T958: display filter state (?cancelled=1 / ?archived=1) driven
  // from the URL. `?deferred=1` is the legacy alias honoured for one release.
  const dashboardFilters = $derived<DashboardFilters>(
    data.filters ?? { showCancelled: false, showArchived: false },
  );

  /**
   * Build a toggle URL that flips one dashboard filter flag while preserving
   * the other. Round-trips through the URL so state stays SSR-correct and
   * bookmarkable.
   *
   * T958: `cancelled` is the canonical param; `deferred=1` is a legacy
   * alias the server still accepts.
   */
  function toggleUrl(flag: 'cancelled' | 'archived'): string {
    const next = new URL($page.url);
    const current = next.searchParams.get(flag) === '1';
    if (current) {
      next.searchParams.delete(flag);
    } else {
      next.searchParams.set(flag, '1');
    }
    // Strip the legacy alias when toggling the canonical param so they don't coexist.
    if (flag === 'cancelled') next.searchParams.delete('deferred');
    return next.pathname + (next.search ? next.search : '');
  }

  // ---------------------------------------------------------------------------
  // Explorer filter store (T951) — one source of truth for ?q / status / priority
  // / labels / epic / selected / cancelled / view.
  // ---------------------------------------------------------------------------

  /**
   * The shared Task Explorer filter store. Created in an `$effect` so it is
   * rebuilt when the URL changes cross-navigation (e.g. a user clicks a
   * deep-link from another page). `dispose()` cleans up popstate listeners +
   * pending debounced writes on teardown.
   */
  let filters = $state<TaskFilters | null>(null);

  $effect(() => {
    const next = createTaskFilters(new URL($page.url));
    filters = next;
    return () => next.dispose();
  });

  /**
   * Parse a URL hash into a valid {@link TaskView}, or `null` if the hash
   * does not name one of the three tabs.
   *
   * @param hash - Raw `window.location.hash` (e.g. `"#graph"`).
   */
  function parseHashView(hash: string): TaskView | null {
    const cleaned = hash.replace(/^#/, '').toLowerCase();
    if (cleaned === 'hierarchy' || cleaned === 'graph' || cleaned === 'kanban') {
      return cleaned;
    }
    return null;
  }

  /**
   * Sync the active view between `filters.state.view` and the URL hash.
   *
   * On mount (and whenever the hash changes via back/forward nav), we read the
   * hash and prefer it over whatever was seeded from `?view=`. When the user
   * clicks a tab, {@link switchView} writes back to both the filter store AND
   * the hash for shareable deep-links.
   */
  onMount(() => {
    function readHash(): void {
      if (!filters) return;
      const hashView = parseHashView(window.location.hash);
      if (hashView && hashView !== filters.state.view) {
        filters.setView(hashView);
      }
    }
    // Apply on mount (hash wins over ?view= if both are present).
    readHash();
    window.addEventListener('hashchange', readHash);
    return () => window.removeEventListener('hashchange', readHash);
  });

  /**
   * Switch the active Explorer tab. Updates both the filter store (which
   * writes `?view=` to the URL) and the location hash (`#hierarchy` /
   * `#graph` / `#kanban`) so hash-driven deep-links keep working.
   *
   * @param v - The tab to activate.
   */
  function switchView(v: TaskView): void {
    if (!filters) return;
    filters.setView(v);
    if (typeof window !== 'undefined' && window.location.hash !== `#${v}`) {
      // `replaceState` avoids a back-button trap on every tab toggle.
      const next = `${window.location.pathname}${window.location.search}#${v}`;
      window.history.replaceState(window.history.state, '', next);
    }
  }

  // ---------------------------------------------------------------------------
  // Derived — Explorer bundle projections + selected task for the DetailDrawer
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
  // Filter chip options (wired against the shared FilterChipGroup)
  // ---------------------------------------------------------------------------

  /** Canonical status chip options for the Explorer toolbar. */
  const statusOptions: FilterChipOption[] = [
    { value: 'pending', label: 'Pending', tint: '#f59e0b' },
    { value: 'active', label: 'Active', tint: '#3b82f6' },
    { value: 'blocked', label: 'Blocked', tint: '#ef4444' },
    { value: 'done', label: 'Done', tint: '#22c55e' },
    { value: 'cancelled', label: 'Cancelled', tint: '#6b7280' },
  ];

  /** Canonical priority chip options for the Explorer toolbar. */
  const priorityOptions: FilterChipOption[] = [
    { value: 'critical', label: 'Critical', tint: '#ef4444' },
    { value: 'high', label: 'High', tint: '#f97316' },
    { value: 'medium', label: 'Medium', tint: '#eab308' },
    { value: 'low', label: 'Low', tint: '#64748b' },
  ];

  /** Labels discovered from the loaded bundle — empty when the project has none. */
  const labelOptions = $derived<FilterChipOption[]>(
    explorerLabels.map((label) => ({ value: label, label })),
  );

  /**
   * Diff `before` vs `after` and drive the matching toggle on `filters`. The
   * store only exposes a per-value toggle API — the chip group gives us the
   * full next-array, so we reconcile here. Generic over the enum being
   * toggled so the caller stays type-safe.
   *
   * @param before - Currently-selected values from the store.
   * @param after  - Next-selected values from the chip group.
   * @param toggle - The store method that toggles one value on/off.
   */
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
  // Legacy search bar — preserved (exact-id navigate + title fuzzy)
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
  // Display helpers (preserved verbatim from the pre-T956 page)
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
  // Live SSE indicator (preserved)
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
  // Page-level keyboard shortcuts: 1/2/3 tab switching (bypassed when typing)
  // ---------------------------------------------------------------------------

  /**
   * Global `keydown` handler wiring `1` / `2` / `3` to the three Explorer
   * tabs. The handler is inert while focus is inside an editable field so we
   * never hijack typing. Exported via `<svelte:window onkeydown>`.
   *
   * @param e - Keyboard event.
   */
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

<div class="tasks-dashboard">
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

  <!-- T878/T958: dashboard filter toggles (canonical `cancelled` + `archived`) -->
  <div class="filter-bar" aria-label="Dashboard filters">
    <a
      href={toggleUrl('cancelled')}
      class="filter-chip"
      class:active={dashboardFilters.showCancelled}
      data-sveltekit-noscroll
      title="Include cancelled epics in the Epic Progress panel"
    >
      <span class="chip-check">{dashboardFilters.showCancelled ? '✓' : ' '}</span>
      Show cancelled epics
    </a>
    <a
      href={toggleUrl('archived')}
      class="filter-chip"
      class:active={dashboardFilters.showArchived}
      data-sveltekit-noscroll
      title="Include archived tasks in Recent Activity"
    >
      <span class="chip-check">{dashboardFilters.showArchived ? '✓' : ' '}</span>
      Show archived
    </a>
  </div>

  <!-- TOP PANEL: dashboard (Epic Progress + Recent Activity) — preserved -->
  <section class="dashboard-panel" aria-label="Dashboard summary">
    <div class="lower-grid">
      {#if epicProgress.length > 0}
        <EpicProgressCard
          epics={epicProgress}
          includingDeferred={dashboardFilters.showCancelled}
        />
      {/if}

      {#if recentTasks.length > 0}
        <RecentActivityFeed tasks={recentTasks} />
      {/if}
    </div>
  </section>

  <!-- BOTTOM PANEL: 3-tab Task Explorer (T953 / T954 / T955) -->
  {#if filters}
    <section class="task-explorer" aria-label="Task Explorer">
      <header class="explorer-header">
        <nav class="tabs" role="tablist" aria-label="Task Explorer views">
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
        </nav>

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
            <FilterChipGroup
              label="Labels"
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

    <DetailDrawer task={selectedTask} onClose={() => filters?.setSelected(null)} />
  {/if}
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

  .stat-card.primary {
    border-color: #a855f7;
  }
  .stat-card.status-active-card {
    border-color: rgba(59, 130, 246, 0.4);
  }
  .stat-card.status-done-card {
    border-color: rgba(34, 197, 94, 0.4);
  }
  .stat-card.status-cancelled-card {
    border-color: rgba(239, 68, 68, 0.4);
  }
  .stat-card.muted {
    opacity: 0.6;
  }

  /* T878 / T958: filter bar */
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

  :global(.priority-critical) {
    color: #ef4444;
  }
  :global(.priority-high) {
    color: #f97316;
  }
  :global(.priority-medium) {
    color: #eab308;
  }
  :global(.priority-low) {
    color: #64748b;
  }

  .priority-bar-fill.priority-critical {
    background: #ef4444;
  }
  .priority-bar-fill.priority-high {
    background: #f97316;
  }
  .priority-bar-fill.priority-medium {
    background: #eab308;
  }
  .priority-bar-fill.priority-low {
    background: #64748b;
  }

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
    .lower-grid {
      grid-template-columns: 1fr;
    }
  }

  /* Status colour tokens reused by the search-result rows */
  :global(.status-done) {
    color: #22c55e;
  }
  :global(.status-active) {
    color: #3b82f6;
  }
  :global(.status-blocked) {
    color: #ef4444;
  }
  :global(.status-pending) {
    color: #475569;
  }

  /* -------------------------------------------------------------------------
     Task Explorer (bottom panel)
     ------------------------------------------------------------------------- */

  .task-explorer {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    background: #151a24;
    border: 1px solid #2d3748;
    border-radius: 10px;
    padding: 1rem;
  }

  .explorer-header {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .tabs {
    display: inline-flex;
    gap: 0.25rem;
    background: #1a1f2e;
    border: 1px solid #2d3748;
    border-radius: 8px;
    padding: 0.25rem;
    align-self: flex-start;
  }

  .tab {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.375rem 0.875rem;
    border-radius: 6px;
    border: none;
    background: transparent;
    color: #94a3b8;
    font-size: 0.8125rem;
    font-weight: 500;
    font-family: inherit;
    cursor: pointer;
    transition: background 0.15s, color 0.15s;
  }

  .tab:hover {
    color: #e2e8f0;
    background: rgba(168, 85, 247, 0.08);
  }

  .tab:focus-visible {
    outline: 2px solid rgba(168, 85, 247, 0.5);
    outline-offset: 1px;
  }

  .tab.active {
    color: #a855f7;
    background: rgba(168, 85, 247, 0.15);
  }

  .tab-key {
    font-size: 0.65rem;
    font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
    padding: 0.05rem 0.35rem;
    border-radius: 3px;
    background: rgba(255, 255, 255, 0.05);
    color: #64748b;
    line-height: 1.2;
  }

  .tab.active .tab-key {
    color: #a855f7;
    background: rgba(168, 85, 247, 0.12);
  }

  .toolbar {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    align-items: center;
  }

  .explorer-body {
    min-height: 400px;
  }
</style>
