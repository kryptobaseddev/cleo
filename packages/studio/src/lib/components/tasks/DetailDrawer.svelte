<!--
  DetailDrawer — right-side slide-out panel for task inspection.

  Ported from the standalone viz drawer at
  `/tmp/task-viz/index.html:330-459` into a reusable Svelte 5 rune
  component. Matches the spec anatomy in
  `docs/specs/CLEO-TASK-DASHBOARD-SPEC.md` §5.5:

    ┌──────────────────────────────────────────────┐
    │ [T123]  [× close]                            │
    │ Title here (wraps)                           │
    │ ┌────────────────────────────────────────┐   │
    │ │ Status    │ Priority                   │   │
    │ │ Type      │ Size                       │   │
    │ │ Parent    │ Labels                     │   │
    │ │ Pipeline  │ Updated                    │   │
    │ └────────────────────────────────────────┘   │
    │ Acceptance criteria (bullets)                │
    │ ─────────────────────────────────            │
    │ Depends on (↑N)                              │
    │   T12 · T45 · …                              │
    │ Depended on by (↓N)                          │
    │   T98 · T120 · …                             │
    │ Parent chain                                 │
    │   Epic T-X → Task T-Y → this                 │
    │ ─────────────────────────────────            │
    │ [Open full page →]   [Start working]         │
    └──────────────────────────────────────────────┘

  Behaviour:
    - Opens on node click (graph), row click (hierarchy), card click (kanban).
    - `Esc` closes (handler registered only while open).
    - This component is presentational: deps + epic-chain + actions are
      passed in by the parent. Dep navigation REPINS the drawer via the
      `onSelectDep` callback; the parent decides whether that also
      updates the URL (`?selected=T###`).
    - `Open full page →` navigates to `/tasks/{id}` for the existing
      full detail page — preserves legacy behaviour as opt-in.

  No API calls inside the component — data loading is T952's job.

  @task T950
  @epic T949
-->
<script lang="ts">
  import type { Task } from '@cleocode/contracts';
  import { onMount } from 'svelte';
  import PriorityBadge from './PriorityBadge.svelte';
  import StatusBadge from './StatusBadge.svelte';
  import { formatTime } from './format.js';

  /**
   * Minimal shape of a dependency link rendered in the drawer.
   *
   * The parent resolves the upstream / downstream arrays from
   * `/api/tasks/[id]/deps` and passes them in.
   */
  export interface DependencyLink {
    /** Linked task ID. */
    id: string;
    /** Linked task title. */
    title: string;
    /** Linked task status (drives the leading colour dot). */
    status: string;
    /** Linked task priority. @defaultValue undefined */
    priority?: string;
  }

  /**
   * Single breadcrumb entry in the parent chain.
   */
  export interface ParentChainEntry {
    /** Ancestor task ID. */
    id: string;
    /** Ancestor task title. */
    title: string;
    /** Ancestor type — epic/task/subtask. @defaultValue undefined */
    type?: string;
  }

  /**
   * Props for {@link DetailDrawer}.
   */
  interface Props {
    /**
     * The task currently pinned in the drawer, or `null` when closed.
     * The component hides itself when `task` is null.
     */
    task: Task | null;
    /** Called when the user closes the drawer (Esc, × button, backdrop click). */
    onClose: () => void;
    /**
     * Upstream (blockers) — tasks that this one depends on.
     * @defaultValue []
     */
    upstream?: DependencyLink[];
    /**
     * Downstream (dependents) — tasks that depend on this one.
     * @defaultValue []
     */
    downstream?: DependencyLink[];
    /**
     * Parent chain from root to current (exclusive of current).
     * Rendered as breadcrumbs. @defaultValue []
     */
    parentChain?: ParentChainEntry[];
    /**
     * Called when the user clicks a dependency row. The parent should
     * REPIN the drawer with the new task instead of navigating the page.
     * When omitted, clicks render as plain `/tasks/<id>` anchors.
     */
    onSelectDep?: (id: string) => void;
    /**
     * When true, show a loading indicator inside the deps panels.
     * @defaultValue false
     */
    loading?: boolean;
    /**
     * Error message rendered in the deps panels when non-empty.
     * @defaultValue undefined
     */
    error?: string | null;
  }

  let {
    task,
    onClose,
    upstream = [],
    downstream = [],
    parentChain = [],
    onSelectDep,
    loading = false,
    error,
  }: Props = $props();

  const acceptanceStrings: string[] = $derived.by(() => {
    if (!task || !Array.isArray(task.acceptance)) return [];
    return task.acceptance.map((item) =>
      typeof item === 'string' ? item : (item.description ?? ''),
    );
  });

  function statusDotColor(s: string): string {
    if (s === 'done') return '#22c55e';
    if (s === 'active') return '#3b82f6';
    if (s === 'blocked') return '#ef4444';
    if (s === 'cancelled') return '#94a3b8';
    if (s === 'archived') return '#64748b';
    if (s === 'proposed') return '#a855f7';
    return '#f59e0b';
  }

  function handleDepClick(e: Event, id: string): void {
    if (!onSelectDep) return;
    e.preventDefault();
    onSelectDep(id);
  }

  onMount(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && task !== null) {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  });
</script>

{#if task}
  <aside
    class="detail-drawer"
    aria-label={`Task ${task.id} details`}
  >
    <header class="drawer-header">
      <span class="d-id">{task.id}</span>
      <button
        type="button"
        class="close-btn"
        onclick={onClose}
        aria-label="Close detail drawer"
      >
        ×
      </button>
    </header>

    <h3 class="d-title">{task.title}</h3>

    {#if parentChain.length > 0}
      <nav class="parent-chain" aria-label="Parent chain">
        {#each parentChain as entry, idx (entry.id)}
          {#if onSelectDep}
            <button
              type="button"
              class="crumb"
              onclick={() => onSelectDep?.(entry.id)}
              aria-label={`Open ${entry.id}`}
            >
              {#if entry.type}
                <span class="crumb-type">{entry.type}</span>
              {/if}
              <span class="crumb-id">{entry.id}</span>
            </button>
          {:else}
            <a href={`/tasks/${entry.id}`} class="crumb">
              {#if entry.type}
                <span class="crumb-type">{entry.type}</span>
              {/if}
              <span class="crumb-id">{entry.id}</span>
            </a>
          {/if}
          {#if idx < parentChain.length - 1}
            <span class="crumb-sep" aria-hidden="true">›</span>
          {:else}
            <span class="crumb-sep" aria-hidden="true">›</span>
            <span class="crumb-current">{task.id}</span>
          {/if}
        {/each}
      </nav>
    {/if}

    <dl class="d-meta">
      <dt>Status</dt>
      <dd><StatusBadge status={task.status} /></dd>

      <dt>Priority</dt>
      <dd><PriorityBadge priority={task.priority ?? 'medium'} /></dd>

      {#if task.type}
        <dt>Type</dt>
        <dd>{task.type}</dd>
      {/if}

      {#if task.size}
        <dt>Size</dt>
        <dd>{task.size}</dd>
      {/if}

      {#if task.parentId}
        <dt>Parent</dt>
        <dd>
          {#if onSelectDep}
            <button
              type="button"
              class="inline-link"
              onclick={() => onSelectDep?.(task.parentId ?? '')}
            >
              {task.parentId}
            </button>
          {:else}
            <a href={`/tasks/${task.parentId}`} class="inline-link">{task.parentId}</a>
          {/if}
        </dd>
      {/if}

      {#if task.pipelineStage}
        <dt>Pipeline</dt>
        <dd>{task.pipelineStage}</dd>
      {/if}

      {#if task.updatedAt}
        <dt>Updated</dt>
        <dd>{formatTime(task.updatedAt)}</dd>
      {/if}
    </dl>

    {#if Array.isArray(task.labels) && task.labels.length > 0}
      <section class="d-section">
        <h4 class="section-h">Labels</h4>
        <div class="labels-row">
          {#each task.labels as lbl}
            <span class="label-pill">{lbl}</span>
          {/each}
        </div>
      </section>
    {/if}

    {#if acceptanceStrings.length > 0}
      <section class="d-section">
        <h4 class="section-h">Acceptance Criteria</h4>
        <ul class="criteria-list">
          {#each acceptanceStrings as crit}
            <li>{crit}</li>
          {/each}
        </ul>
      </section>
    {/if}

    <section class="d-section">
      <h4 class="section-h">
        Depends on
        {#if upstream.length > 0}
          <span class="count-badge">↑{upstream.length}</span>
        {/if}
      </h4>
      {#if loading}
        <div class="d-empty-small">Loading…</div>
      {:else if error}
        <div class="d-empty-small error">{error}</div>
      {:else if upstream.length === 0}
        <div class="d-empty-small">None.</div>
      {:else}
        <ul class="d-list">
          {#each upstream as dep (dep.id)}
            {#if onSelectDep}
              <li>
                <button
                  type="button"
                  class="dep-btn"
                  onclick={(e) => handleDepClick(e, dep.id)}
                >
                  <span
                    class="dep-dot"
                    style="background:{statusDotColor(dep.status)}"
                    aria-hidden="true"
                  ></span>
                  <span class="iid">{dep.id}</span>
                  <span class="ititle">{dep.title}</span>
                </button>
              </li>
            {:else}
              <li>
                <a href={`/tasks/${dep.id}`} class="dep-btn dep-link">
                  <span
                    class="dep-dot"
                    style="background:{statusDotColor(dep.status)}"
                    aria-hidden="true"
                  ></span>
                  <span class="iid">{dep.id}</span>
                  <span class="ititle">{dep.title}</span>
                </a>
              </li>
            {/if}
          {/each}
        </ul>
      {/if}
    </section>

    <section class="d-section">
      <h4 class="section-h">
        Depended on by
        {#if downstream.length > 0}
          <span class="count-badge">↓{downstream.length}</span>
        {/if}
      </h4>
      {#if loading}
        <div class="d-empty-small">Loading…</div>
      {:else if downstream.length === 0}
        <div class="d-empty-small">None.</div>
      {:else}
        <ul class="d-list">
          {#each downstream as dep (dep.id)}
            {#if onSelectDep}
              <li>
                <button
                  type="button"
                  class="dep-btn"
                  onclick={(e) => handleDepClick(e, dep.id)}
                >
                  <span
                    class="dep-dot"
                    style="background:{statusDotColor(dep.status)}"
                    aria-hidden="true"
                  ></span>
                  <span class="iid">{dep.id}</span>
                  <span class="ititle">{dep.title}</span>
                </button>
              </li>
            {:else}
              <li>
                <a href={`/tasks/${dep.id}`} class="dep-btn dep-link">
                  <span
                    class="dep-dot"
                    style="background:{statusDotColor(dep.status)}"
                    aria-hidden="true"
                  ></span>
                  <span class="iid">{dep.id}</span>
                  <span class="ititle">{dep.title}</span>
                </a>
              </li>
            {/if}
          {/each}
        </ul>
      {/if}
    </section>

    <footer class="drawer-actions">
      <a href={`/tasks/${task.id}`} class="btn btn-secondary">Open full page →</a>
      <!--
        Future: wire to CRUD API via task-explorer store (T952).
        Keeping as a disabled hint so the action bar shape is preserved.
      -->
      <button type="button" class="btn btn-primary" disabled title="Wire in T952">
        Start working
      </button>
    </footer>
  </aside>
{/if}

<style>
  .detail-drawer {
    width: 360px;
    min-width: 320px;
    max-width: 360px;
    background: #151822;
    border-left: 1px solid #2a2e3d;
    overflow-y: auto;
    padding: 1rem 1rem 2.5rem;
    font-size: 0.875rem;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .drawer-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    position: sticky;
    top: 0;
    background: #151822;
    padding-bottom: 0.375rem;
    border-bottom: 1px solid #2a2e3d;
    margin: -1rem -1rem 0;
    padding: 0.75rem 1rem 0.5rem;
    z-index: 2;
  }

  .d-id {
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    color: #a78bfa;
    font-size: 0.8125rem;
    background: rgba(167, 139, 250, 0.15);
    padding: 2px 8px;
    border-radius: 4px;
  }

  .close-btn {
    background: transparent;
    border: 1px solid #2a2e3d;
    color: #9aa3b2;
    cursor: pointer;
    width: 28px;
    height: 28px;
    border-radius: 4px;
    font-size: 1.125rem;
    line-height: 1;
    padding: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    transition: color 0.15s, border-color 0.15s;
    font-family: inherit;
  }

  .close-btn:hover {
    color: #e7eaf3;
    border-color: #3a4055;
  }

  .close-btn:focus-visible {
    outline: 2px solid rgba(168, 85, 247, 0.5);
    outline-offset: 1px;
  }

  .d-title {
    font-size: 1rem;
    line-height: 1.35;
    margin: 0;
    color: #e7eaf3;
    font-weight: 600;
  }

  .parent-chain {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.25rem;
    font-size: 0.7rem;
  }

  .crumb {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.1rem 0.375rem;
    border-radius: 3px;
    background: #1b1f2c;
    border: 1px solid #2a2e3d;
    color: #9aa3b2;
    text-decoration: none;
    font: inherit;
    font-size: 0.7rem;
    cursor: pointer;
    transition: color 0.15s, border-color 0.15s;
  }

  .crumb:hover {
    color: #e7eaf3;
    border-color: #3a4055;
  }

  .crumb-type {
    font-size: 0.6rem;
    color: #6b7280;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .crumb-id {
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    color: #a78bfa;
  }

  .crumb-sep {
    color: #6b7280;
  }

  .crumb-current {
    color: #e7eaf3;
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    font-size: 0.7rem;
  }

  .d-meta {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 0.375rem 1rem;
    font-size: 0.75rem;
    margin: 0;
    padding: 0.75rem;
    background: #1b1f2c;
    border-radius: 4px;
    border: 1px solid #2a2e3d;
  }

  .d-meta dt {
    color: #6b7280;
    text-transform: uppercase;
    font-size: 0.625rem;
    letter-spacing: 0.06em;
    padding-top: 2px;
    font-weight: 600;
  }

  .d-meta dd {
    margin: 0;
    color: #e7eaf3;
    font-size: 0.75rem;
  }

  .d-section {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
  }

  .section-h {
    font-size: 0.6875rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: #6b7280;
    margin: 0;
    font-weight: 600;
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
  }

  .count-badge {
    font-size: 0.625rem;
    color: #94a3b8;
    background: #1b1f2c;
    border: 1px solid #2a2e3d;
    padding: 0.05rem 0.375rem;
    border-radius: 999px;
    font-variant-numeric: tabular-nums;
    letter-spacing: 0;
    text-transform: none;
  }

  .criteria-list {
    list-style: disc outside;
    padding-left: 1.125rem;
    margin: 0;
    color: #e7eaf3;
    font-size: 0.8125rem;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .d-list {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .dep-btn {
    background: #1b1f2c;
    border: 1px solid #2a2e3d;
    border-radius: 4px;
    padding: 0.375rem 0.625rem;
    font-size: 0.75rem;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    transition: background 0.15s, border-color 0.15s;
    cursor: pointer;
    width: 100%;
    text-align: left;
    color: inherit;
    text-decoration: none;
    font-family: inherit;
  }

  .dep-btn:hover {
    border-color: #3a4055;
    background: #212534;
  }

  .dep-btn:focus-visible {
    outline: 2px solid rgba(168, 85, 247, 0.5);
    outline-offset: 1px;
  }

  .dep-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .iid {
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    color: #a78bfa;
    font-size: 0.6875rem;
    flex-shrink: 0;
  }

  .ititle {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: #9aa3b2;
  }

  .d-empty-small {
    font-size: 0.75rem;
    color: #6b7280;
    padding: 0.25rem 0.125rem;
  }

  .d-empty-small.error {
    color: #ef4444;
  }

  .labels-row {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }

  .label-pill {
    font-size: 0.625rem;
    background: #1b1f2c;
    border: 1px solid #2a2e3d;
    color: #9aa3b2;
    padding: 2px 7px;
    border-radius: 999px;
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  }

  .inline-link {
    background: transparent;
    border: none;
    padding: 0;
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    color: #a78bfa;
    cursor: pointer;
    text-decoration: none;
    font-size: 0.75rem;
  }

  .inline-link:hover {
    text-decoration: underline;
  }

  .drawer-actions {
    display: flex;
    gap: 0.5rem;
    padding-top: 0.75rem;
    border-top: 1px solid #2a2e3d;
    margin-top: 0.5rem;
  }

  .btn {
    flex: 1;
    padding: 0.5rem 0.75rem;
    border-radius: 4px;
    font-size: 0.8125rem;
    font-weight: 500;
    text-align: center;
    cursor: pointer;
    border: 1px solid transparent;
    font-family: inherit;
    transition: background 0.15s, border-color 0.15s, color 0.15s;
    text-decoration: none;
  }

  .btn-primary {
    background: rgba(168, 85, 247, 0.15);
    color: #a78bfa;
    border-color: rgba(168, 85, 247, 0.4);
  }

  .btn-primary:hover:not(:disabled) {
    background: rgba(168, 85, 247, 0.25);
    border-color: rgba(168, 85, 247, 0.7);
  }

  .btn-primary:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .btn-secondary {
    background: #1b1f2c;
    color: #e7eaf3;
    border-color: #2a2e3d;
  }

  .btn-secondary:hover {
    background: #212534;
    border-color: #3a4055;
  }

  .btn-secondary:focus-visible,
  .btn-primary:focus-visible {
    outline: 2px solid rgba(168, 85, 247, 0.6);
    outline-offset: 1px;
  }
</style>
