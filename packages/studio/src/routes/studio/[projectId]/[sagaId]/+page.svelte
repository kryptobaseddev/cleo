<!--
  /studio/[projectId]/[sagaId] — the SAGA OPERATOR-CONSOLE SHELL
  (T11797 / T11798 · E6-RESKIN-SHELL).

  A mission-control shell for ONE saga with a sibling **workgraph | kanban**
  toggle over the SHARED data layer:

    - workgraph → {@link WorkGraphView}, the saga-scoped graph (containment +
      depends edges) over `$lib/graph` — SSR-rendered from the server bundle.
    - kanban    → {@link SagaKanbanPane}, the live dispatcher board scoped to
      the saga, mounted CLIENT-ONLY (`{#if browser}`) so the `EventSource`
      SSE pane never runs during SSR (the opencode `/s/[id]` pattern).

  Both panes project the SAME server bundle (`data.explorer`) — one round
  trip, two views. The toggle round-trips through the URL (`?view=`) so a
  deep link is shareable.

  Operator-console aesthetic: a compact mono command bar (project ▸ saga
  breadcrumb · live indicator · theme switcher) over a full-bleed canvas.
  This is a RESKIN — it reuses every existing token + component, forks no
  design system, and stays Svelte-5 runes throughout.

  `noindex` (opencode `/s/[id]` pattern): a per-saga operator view is not a
  public document — keep it out of search indexes.

  @task T11797
  @task T11798
  @epic T11561 — E6-RESKIN-SHELL
  @saga T11555
-->
<script lang="ts">
  import { browser } from '$app/environment';
  import { page } from '$app/stores';
  import { goto } from '$app/navigation';
  import { Badge } from '$lib/ui';
  import WorkGraphView from '$lib/components/WorkGraphView.svelte';
  import ThemeSwitcher from '$lib/components/shell/ThemeSwitcher.svelte';
  import { createThemeStore } from '$lib/stores/theme.svelte.js';
  import SagaKanbanPane from './SagaKanbanPane.svelte';
  import type { PageData } from './$types';

  interface Props {
    data: PageData;
  }

  let { data }: Props = $props();

  // ---- Theme rune (client-only hydrate) ----
  const theme = createThemeStore();
  $effect(() => {
    theme.hydrate();
  });

  // ---- View toggle (workgraph | kanban), URL-round-tripped ----
  type ShellView = 'workgraph' | 'kanban';

  const view = $derived<ShellView>(
    $page.url.searchParams.get('view') === 'kanban' ? 'kanban' : 'workgraph',
  );

  function setView(next: ShellView): void {
    const url = new URL($page.url);
    url.searchParams.set('view', next);
    void goto(url.pathname + url.search, { replaceState: true, noScroll: true, keepFocus: true });
  }

  // ---- Saga-subtree id set (for the kanban pane scope) ----
  /**
   * The id set of the saga + every descendant, derived from the bundle's
   * parent pointers. Used to scope the live board to this saga without a
   * second store or query. Iterates to a fixed point: a child joins the set
   * once its parent is already in it.
   */
  const subtreeIds = $derived.by<ReadonlySet<string>>(() => {
    const out = new Set<string>([data.sagaId]);
    const tasks = data.explorer?.tasks ?? [];
    let grew = true;
    while (grew) {
      grew = false;
      for (const t of tasks) {
        if (out.has(t.id)) continue;
        if (t.parentId && out.has(t.parentId)) {
          out.add(t.id);
          grew = true;
        }
      }
    }
    return out;
  });

  const sagaTitle = $derived(data.saga?.title ?? data.sagaId);
  const nodeCount = $derived(data.explorer?.tasks.length ?? 0);
</script>

<svelte:head>
  <title>{data.sagaId} · {data.projectName} — CLEO Studio</title>
  <meta name="robots" content="noindex" />
</svelte:head>

<section class="saga-shell" data-view={view}>
  <!-- Operator command bar -->
  <header class="command-bar">
    <nav class="crumbs" aria-label="Breadcrumb">
      <a class="crumb" href="/projects">{data.projectName}</a>
      <span class="sep" aria-hidden="true">▸</span>
      <span class="crumb current" title={sagaTitle}>
        <code>{data.sagaId}</code>
        {#if data.saga}<span class="crumb-title">{data.saga.title}</span>{/if}
      </span>
      {#if data.saga}
        <Badge tone="info" size="sm">{data.saga.type}</Badge>
      {/if}
    </nav>

    <div class="toggle" role="tablist" aria-label="Saga view">
      <button
        type="button"
        class="toggle-btn"
        class:active={view === 'workgraph'}
        role="tab"
        aria-selected={view === 'workgraph'}
        onclick={() => setView('workgraph')}
      >
        Workgraph
      </button>
      <button
        type="button"
        class="toggle-btn"
        class:active={view === 'kanban'}
        role="tab"
        aria-selected={view === 'kanban'}
        onclick={() => setView('kanban')}
      >
        Kanban
      </button>
    </div>

    <div class="bar-right">
      <ThemeSwitcher {theme} />
    </div>
  </header>

  <!-- Canvas -->
  <div class="canvas">
    {#if data.error}
      <div class="shell-error" role="alert">
        <p>{data.error}</p>
      </div>
    {:else if !data.explorer}
      <div class="shell-error" role="alert">
        <p>No workgraph bundle available for this saga.</p>
      </div>
    {:else if view === 'workgraph'}
      <WorkGraphView
        tasks={data.explorer.tasks}
        deps={data.explorer.deps}
        sagaId={data.sagaId}
      />
    {:else}
      <!-- Kanban pane is the LIVE SSE board — client-only mount. -->
      {#if browser}
        <SagaKanbanPane sagaId={data.sagaId} {subtreeIds} />
      {:else}
        <div class="ssr-placeholder">
          <p>Loading the live board…</p>
        </div>
      {/if}
    {/if}
  </div>

  <footer class="shell-foot">
    <span class="hint">
      {nodeCount} tasks in bundle · containment + depends · operator console
    </span>
  </footer>
</section>

<style>
  .saga-shell {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    /* Fill the layout main; subtract the global header + main padding. */
    height: calc(100vh - 7rem);
    min-height: 0;
  }

  .command-bar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-2) var(--space-3);
    background: var(--bg-elev-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
  }

  .crumbs {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    min-width: 0;
  }

  .crumb {
    color: var(--text-dim);
    text-decoration: none;
    font-size: var(--text-sm);
    font-weight: 500;
  }

  .crumb:hover {
    color: var(--text);
  }

  .crumb.current {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    color: var(--text);
    min-width: 0;
  }

  .crumb code {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--accent);
  }

  .crumb-title {
    font-size: var(--text-sm);
    color: var(--text-dim);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 28ch;
  }

  .sep {
    color: var(--text-faint);
    font-size: var(--text-xs);
  }

  .toggle {
    display: inline-flex;
    gap: 2px;
    padding: 2px;
    margin-left: auto;
    background: var(--bg-elev-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-pill);
  }

  .toggle-btn {
    padding: var(--space-1) var(--space-4);
    border: none;
    background: transparent;
    color: var(--text-dim);
    font-size: var(--text-xs);
    font-weight: 600;
    letter-spacing: 0.02em;
    border-radius: var(--radius-pill);
    cursor: pointer;
    transition: color var(--ease), background var(--ease);
  }

  .toggle-btn:hover {
    color: var(--text);
  }

  .toggle-btn.active {
    color: var(--bg);
    background: var(--accent);
  }

  .toggle-btn:focus-visible {
    outline: none;
    box-shadow: var(--shadow-focus);
  }

  .bar-right {
    display: inline-flex;
    align-items: center;
  }

  .canvas {
    flex: 1;
    min-height: 0;
    position: relative;
  }

  .shell-error {
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--danger);
    background: var(--danger-soft);
    border: 1px solid color-mix(in srgb, var(--danger) 40%, transparent);
    border-radius: var(--radius-md);
    padding: var(--space-6);
    text-align: center;
  }

  .ssr-placeholder {
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--text-faint);
    font-size: var(--text-sm);
  }

  .shell-foot {
    display: flex;
    justify-content: center;
    padding-top: var(--space-1);
    border-top: 1px solid var(--border);
    flex-shrink: 0;
  }

  .hint {
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    color: var(--text-faint);
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
</style>
