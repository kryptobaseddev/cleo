<!--
  HierarchyTab — global tree + epic-scoped drill-down for the 3-tab Task
  Explorer (W1A of T949 / T953).

  Consumes the Wave-0 primitives:
    - @lib/components/tasks barrel (T950) — StatusBadge, PriorityBadge,
      TaskSearchBox, etc.
    - @lib/stores/task-filters (T951) — URL-round-tripped filter state.
    - @lib/server/tasks/explorer-loader (T952) — typed `tasks`, `deps`,
      `epicProgress` bundle.

  Modes:
    - `filters.state.epic === null` → global tree, grouped by parentId.
      Orphans (parent missing from payload) surface under a synthetic
      "Unparented" pseudo-root.
    - `filters.state.epic !== null` → epic-scoped subtree (+ breadcrumb).

  Virtualization: simple windowing over the flattened tree. No new deps.

  Keyboard: Up/Down navigates rows, Enter opens selection, Space/Enter
  toggles expand on epic rows, Esc clears selection.

  @task T953
  @epic T949
-->
<script lang="ts">
  import type { Task } from '@cleocode/contracts';
  import type { EpicProgressBucket, TaskDependencyEdge } from '../../server/tasks/explorer-loader.js';
  import type { TaskFilters } from '../../stores/task-filters.svelte.js';
  import {
    buildEpicSubtree,
    buildGlobalTree,
    collectAllIds,
    computeDepCounts,
    type FlatRow,
    flattenTree,
    type HierarchyNode,
    pruneTree,
    UNPARENTED_BUCKET_ID,
    windowRows,
  } from './hierarchy-tree.js';
  import PriorityBadge from './PriorityBadge.svelte';
  import StatusBadge from './StatusBadge.svelte';
  import { progressPct } from './format.js';

  /**
   * Props for {@link HierarchyTab}.
   */
  interface Props {
    /**
     * All tasks for the current project context, typically from
     * {@link import('../../server/tasks/explorer-loader.js').ExplorerBundle.tasks}.
     */
    tasks: Task[];
    /**
     * All dependency edges (task_dependencies) for the loaded task set.
     */
    deps: TaskDependencyEdge[];
    /**
     * Per-epic progress rollup for the loaded task set (direct-children
     * basis per T874).
     */
    epicProgress?: Record<string, EpicProgressBucket>;
    /**
     * The shared Task Explorer filter store (T951). The tab reads filter
     * state from `filters.state` and writes selection / epic drill-down
     * mutations back through the setter methods.
     */
    filters: TaskFilters;
    /**
     * Fixed row height in px for the virtualization math. Default `32`.
     */
    rowHeight?: number;
    /**
     * Threshold above which virtualization kicks in. Below this count, every
     * row renders without spacers. Default `200`.
     */
    virtualizationThreshold?: number;
  }

  let {
    tasks,
    deps,
    epicProgress = {},
    filters,
    rowHeight = 32,
    virtualizationThreshold = 200,
  }: Props = $props();

  // ---------------------------------------------------------------------------
  // Derived tree + flat rows
  // ---------------------------------------------------------------------------

  const depCounts = $derived(computeDepCounts(deps));
  const roots: HierarchyNode[] = $derived.by(() => {
    if (filters.state.epic === null) {
      return buildGlobalTree(tasks, depCounts);
    }
    return buildEpicSubtree(tasks, depCounts, filters.state.epic);
  });

  const prunedRoots: HierarchyNode[] = $derived(pruneTree(roots, filters.state));

  let expandedIds = $state<Set<string>>(new Set());

  // When entering epic-scoped mode, auto-expand the epic root so children show.
  $effect(() => {
    if (filters.state.epic !== null && prunedRoots.length > 0) {
      const id = prunedRoots[0].id;
      if (!expandedIds.has(id)) {
        const next = new Set(expandedIds);
        next.add(id);
        expandedIds = next;
      }
    }
  });

  // When a filter is actively narrowing, expand every surviving node so matches
  // are visible without manual disclosure. The heuristic: if ANY filter is on,
  // expand everything. Otherwise honour the user's manual expand state.
  const filteringActive = $derived(
    filters.state.query.length > 0 ||
      filters.state.status.length > 0 ||
      filters.state.priority.length > 0 ||
      filters.state.labels.length > 0,
  );

  const effectiveExpandedIds = $derived<ReadonlySet<string>>(
    filteringActive ? collectAllIds(prunedRoots) : expandedIds,
  );

  const flatRows: FlatRow[] = $derived(flattenTree(prunedRoots, effectiveExpandedIds));

  // ---------------------------------------------------------------------------
  // Virtualization
  // ---------------------------------------------------------------------------

  let scrollTop = $state(0);
  let viewportHeight = $state(600);
  let viewportEl: HTMLDivElement | undefined = $state();

  const virtualize = $derived(flatRows.length >= virtualizationThreshold);
  const windowed = $derived(
    virtualize
      ? windowRows(flatRows, { scrollTop, viewportHeight, rowHeight, buffer: 50 })
      : { startIndex: 0, visible: flatRows, totalRows: flatRows.length },
  );

  const topSpacer = $derived(virtualize ? windowed.startIndex * rowHeight : 0);
  const totalHeight = $derived(flatRows.length * rowHeight);
  const bottomSpacer = $derived(
    virtualize ? Math.max(0, totalHeight - topSpacer - windowed.visible.length * rowHeight) : 0,
  );

  function onScroll(): void {
    if (viewportEl) {
      scrollTop = viewportEl.scrollTop;
    }
  }

  $effect(() => {
    if (!viewportEl || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        viewportHeight = e.contentRect.height;
      }
    });
    ro.observe(viewportEl);
    return () => ro.disconnect();
  });

  // ---------------------------------------------------------------------------
  // Selection + keyboard nav
  // ---------------------------------------------------------------------------

  const focusedIndex = $derived.by(() => {
    const sel = filters.state.selected;
    if (!sel) return -1;
    return windowed.visible.findIndex((r) => r.id === sel);
  });

  function selectTask(id: string): void {
    if (id === UNPARENTED_BUCKET_ID) return;
    filters.setSelected(id);
  }

  function handleEpicClick(epicId: string): void {
    filters.setEpic(epicId);
  }

  function handleRowClick(row: FlatRow, event: MouseEvent): void {
    // Toggle expand when the user clicks the caret region (left edge).
    const target = event.currentTarget as HTMLElement;
    const caret = target.querySelector('.row-caret');
    if (caret && caret.contains(event.target as Node) && row.hasChildren) {
      toggleExpand(row.id);
      event.stopPropagation();
      return;
    }

    if (!row.task) return;
    selectTask(row.id);
  }

  function toggleExpand(id: string): void {
    const next = new Set(expandedIds);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    expandedIds = next;
  }

  function handleKeydown(e: KeyboardEvent): void {
    if (flatRows.length === 0) return;

    // Derive current index from the selected id, searching the FULL list so
    // arrow-nav works across the window boundary.
    const currentFullIndex = (() => {
      const sel = filters.state.selected;
      if (!sel) return -1;
      return flatRows.findIndex((r) => r.id === sel);
    })();

    switch (e.key) {
      case 'ArrowDown': {
        e.preventDefault();
        const next = currentFullIndex < 0 ? 0 : Math.min(flatRows.length - 1, currentFullIndex + 1);
        const row = flatRows[next];
        if (row?.task) selectTask(row.id);
        scrollRowIntoView(next);
        break;
      }
      case 'ArrowUp': {
        e.preventDefault();
        const next = currentFullIndex <= 0 ? 0 : currentFullIndex - 1;
        const row = flatRows[next];
        if (row?.task) selectTask(row.id);
        scrollRowIntoView(next);
        break;
      }
      case 'Enter': {
        e.preventDefault();
        if (currentFullIndex < 0) return;
        const row = flatRows[currentFullIndex];
        if (!row) return;
        if (row.isEpic && row.hasChildren && !e.shiftKey) {
          // Drill into epic on plain Enter; Shift+Enter just selects.
          handleEpicClick(row.id);
        } else if (row.task) {
          selectTask(row.id);
        }
        break;
      }
      case ' ': {
        if (currentFullIndex < 0) return;
        e.preventDefault();
        const row = flatRows[currentFullIndex];
        if (row?.hasChildren) toggleExpand(row.id);
        break;
      }
      case 'Escape': {
        e.preventDefault();
        filters.setSelected(null);
        break;
      }
      default:
        break;
    }
  }

  function scrollRowIntoView(index: number): void {
    if (!viewportEl) return;
    const top = index * rowHeight;
    const bottom = top + rowHeight;
    if (top < viewportEl.scrollTop) {
      viewportEl.scrollTop = top;
    } else if (bottom > viewportEl.scrollTop + viewportEl.clientHeight) {
      viewportEl.scrollTop = bottom - viewportEl.clientHeight;
    }
  }

  // ---------------------------------------------------------------------------
  // Dep badge filter actions
  // ---------------------------------------------------------------------------

  /** Highlight tasks this row depends ON (outbound). */
  function showDepsOf(taskId: string): void {
    // Opens the drawer on this task — the drawer itself renders the two
    // dep panels, so we just ensure the task is the selected one.
    filters.setSelected(taskId);
  }

  /** Highlight tasks this row blocks (inbound). */
  function showTasksBlocking(taskId: string): void {
    filters.setSelected(taskId);
  }

  // ---------------------------------------------------------------------------
  // Breadcrumb + toolbar actions
  // ---------------------------------------------------------------------------

  const scopedEpic = $derived.by(() => {
    const id = filters.state.epic;
    if (!id) return null;
    return tasks.find((t) => t.id === id) ?? null;
  });

  function clearEpic(): void {
    filters.setEpic(null);
  }

  function expandAll(): void {
    expandedIds = collectAllIds(prunedRoots);
  }

  function collapseAll(): void {
    expandedIds = new Set();
  }

  // ---------------------------------------------------------------------------
  // Empty-state detection
  // ---------------------------------------------------------------------------

  const isEmpty = $derived(flatRows.length === 0);

  function rowLabel(row: FlatRow): string {
    if (!row.task) return 'Unparented tasks';
    return `${row.task.id}: ${row.task.title}`;
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_to_interactive_role -->
<section
  class="hierarchy-tab"
  role="tree"
  aria-label="Task hierarchy"
  tabindex="0"
  onkeydown={handleKeydown}
>
  <header class="ht-toolbar">
    {#if scopedEpic}
      <nav class="breadcrumb" aria-label="Epic scope breadcrumb">
        <button type="button" class="crumb-btn" onclick={clearEpic}>All epics</button>
        <span class="crumb-sep" aria-hidden="true">›</span>
        <span class="crumb-current">
          <span class="crumb-id">{scopedEpic.id}</span>
          <span class="crumb-title">{scopedEpic.title}</span>
        </span>
      </nav>
    {:else}
      <span class="scope-label">Global hierarchy</span>
    {/if}

    <div class="toolbar-spacer"></div>

    <div class="toolbar-actions">
      <span class="count-chip" title="Rows visible / total tasks">
        {flatRows.length} of {tasks.length}
      </span>
      <button
        type="button"
        class="tb-btn"
        onclick={expandAll}
        title="Expand all"
        disabled={filteringActive}
      >
        ⊞ Expand
      </button>
      <button
        type="button"
        class="tb-btn"
        onclick={collapseAll}
        title="Collapse all"
        disabled={filteringActive}
      >
        ⊟ Collapse
      </button>
    </div>
  </header>

  {#if scopedEpic}
    <aside class="epic-summary" aria-label="Scoped epic summary">
      <h3 class="epic-summary-title">{scopedEpic.title}</h3>
      {#if epicProgress[scopedEpic.id]}
        {@const bucket = epicProgress[scopedEpic.id]}
        {@const pct = progressPct(bucket.done, bucket.total)}
        <div class="epic-summary-progress">
          <span class="es-counts">{bucket.done}/{bucket.total}</span>
          <div class="es-bar">
            <div class="es-bar-fill" style="width:{pct}%"></div>
          </div>
          <span class="es-pct">{pct}%</span>
        </div>
      {/if}
      {#if Array.isArray(scopedEpic.acceptance) && scopedEpic.acceptance.length > 0}
        <details class="epic-acceptance">
          <summary>Acceptance criteria ({scopedEpic.acceptance.length})</summary>
          <ul>
            {#each scopedEpic.acceptance as crit}
              <li>
                {typeof crit === 'string' ? crit : (crit.description ?? '')}
              </li>
            {/each}
          </ul>
        </details>
      {/if}
    </aside>
  {/if}

  <div
    class="ht-viewport"
    bind:this={viewportEl}
    onscroll={onScroll}
    data-testid="ht-viewport"
  >
    {#if isEmpty}
      <div class="ht-empty">
        {#if filteringActive}
          No tasks match the current filters.
        {:else}
          No tasks to display.
        {/if}
      </div>
    {:else}
      {#if topSpacer > 0}
        <div class="ht-spacer" style="height:{topSpacer}px" aria-hidden="true"></div>
      {/if}
      <ul class="ht-list" role="group" aria-label="Task rows">
        {#each windowed.visible as row (row.id)}
          {@const epicBucket = row.isEpic && row.task ? (epicProgress[row.task.id] ?? null) : null}
          {@const pct = epicBucket ? progressPct(epicBucket.done, epicBucket.total) : 0}
          <li
            class="ht-row"
            class:focused={focusedIndex !== -1 && windowed.visible[focusedIndex]?.id === row.id}
            class:is-epic={row.isEpic}
            class:is-bucket={row.task === null}
            style="padding-left:{row.depth * 16 + 8}px; height:{rowHeight}px"
            role="treeitem"
            aria-level={row.depth + 1}
            aria-expanded={row.hasChildren ? row.expanded : undefined}
            aria-selected={filters.state.selected === row.id}
            aria-label={rowLabel(row)}
            data-id={row.id}
          >
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div
              class="ht-row-inner"
              onclick={(e) => handleRowClick(row, e)}
            >
              <span class="row-caret" aria-hidden="true">
                {#if row.hasChildren}
                  {row.expanded ? '▾' : '▸'}
                {:else}
                  &nbsp;
                {/if}
              </span>
              {#if row.task === null}
                <span class="bucket-label">Unparented</span>
                <span class="row-descendants">({row.descendantCount})</span>
              {:else}
                <span class="row-id">{row.task.id}</span>
                <span class="row-title">{row.task.title}</span>
                <StatusBadge status={row.task.status} compact />
                <PriorityBadge priority={row.task.priority ?? 'medium'} compact />
                {#if row.task.size}
                  <span class="size-chip">{row.task.size}</span>
                {/if}
                {#if row.isEpic && epicBucket}
                  <span class="epic-mini-progress" title="{epicBucket.done}/{epicBucket.total}">
                    <span class="emp-bar">
                      <span class="emp-fill" style="width:{pct}%"></span>
                    </span>
                    <span class="emp-label">{epicBucket.done}/{epicBucket.total}</span>
                  </span>
                {/if}
                {#if row.depsIn > 0}
                  <button
                    type="button"
                    class="dep-badge dep-in"
                    title="{row.depsIn} tasks depend on this"
                    onclick={(e) => {
                      e.stopPropagation();
                      if (row.task) showTasksBlocking(row.task.id);
                    }}
                  >← {row.depsIn}</button>
                {/if}
                {#if row.depsOut > 0}
                  <button
                    type="button"
                    class="dep-badge dep-out"
                    title="This task depends on {row.depsOut} tasks"
                    onclick={(e) => {
                      e.stopPropagation();
                      if (row.task) showDepsOf(row.task.id);
                    }}
                  >→ {row.depsOut}</button>
                {/if}
                {#if Array.isArray(row.task.labels) && row.task.labels.length > 0}
                  <span class="row-labels">
                    {#each row.task.labels.slice(0, 3) as lbl}
                      <span class="label-pill">{lbl}</span>
                    {/each}
                    {#if row.task.labels.length > 3}
                      <span class="label-pill more">+{row.task.labels.length - 3}</span>
                    {/if}
                  </span>
                {/if}
                {#if row.isEpic && row.hasChildren}
                  <button
                    type="button"
                    class="drill-btn"
                    title="Drill into this epic"
                    onclick={(e) => {
                      e.stopPropagation();
                      if (row.task) handleEpicClick(row.task.id);
                    }}
                  >drill →</button>
                {/if}
              {/if}
            </div>
          </li>
        {/each}
      </ul>
      {#if bottomSpacer > 0}
        <div class="ht-spacer" style="height:{bottomSpacer}px" aria-hidden="true"></div>
      {/if}
    {/if}
  </div>
</section>

<style>
  .hierarchy-tab {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    background: var(--bg);
    border: 1px solid var(--bg-elev-2);
    border-radius: var(--radius-md);
    overflow: hidden;
    outline: none;
  }

  .hierarchy-tab:focus-visible {
    outline: none;
    box-shadow: var(--shadow-focus);
  }

  .ht-toolbar {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 0.75rem;
    border-bottom: 1px solid var(--bg-elev-2);
    background: var(--bg-elev-1);
    flex-shrink: 0;
  }

  .scope-label {
    font-size: 0.75rem;
    color: var(--text-dim);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-weight: 600;
  }

  .breadcrumb {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    font-size: 0.75rem;
  }

  .crumb-btn {
    background: transparent;
    border: 1px solid var(--border);
    color: var(--text-dim);
    padding: 0.2rem 0.5rem;
    border-radius: 3px;
    font-size: 0.7rem;
    cursor: pointer;
    font-family: inherit;
    transition: color 0.15s, border-color 0.15s;
  }

  .crumb-btn:hover {
    color: var(--text);
    border-color: var(--border-strong);
  }

  .crumb-sep {
    color: var(--text-faint);
  }

  .crumb-current {
    display: inline-flex;
    gap: 0.375rem;
    align-items: baseline;
  }

  .crumb-id {
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    color: var(--accent);
    font-weight: 600;
  }

  .crumb-title {
    color: var(--text);
  }

  .toolbar-spacer {
    flex: 1;
  }

  .toolbar-actions {
    display: flex;
    align-items: center;
    gap: 0.375rem;
  }

  .count-chip {
    font-size: 0.6875rem;
    color: var(--text-dim);
    background: var(--bg-elev-2);
    padding: 0.125rem 0.5rem;
    border-radius: 3px;
    font-variant-numeric: tabular-nums;
  }

  .tb-btn {
    background: transparent;
    border: 1px solid var(--border);
    color: var(--text-dim);
    padding: 0.2rem 0.5rem;
    border-radius: 3px;
    font-size: 0.7rem;
    cursor: pointer;
    font-family: inherit;
    transition: color 0.15s, border-color 0.15s;
  }

  .tb-btn:hover:not(:disabled) {
    color: var(--text);
    border-color: var(--border-strong);
  }

  .tb-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .epic-summary {
    padding: 0.625rem 0.75rem;
    background: var(--bg-elev-1);
    border-bottom: 1px solid var(--bg-elev-2);
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    flex-shrink: 0;
  }

  .epic-summary-title {
    margin: 0;
    font-size: 0.875rem;
    color: var(--text);
    font-weight: 600;
  }

  .epic-summary-progress {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.75rem;
  }

  .es-counts {
    color: var(--success);
    font-variant-numeric: tabular-nums;
  }

  .es-bar {
    flex: 1;
    height: 4px;
    background: var(--border);
    border-radius: 2px;
    overflow: hidden;
    max-width: 240px;
  }

  .es-bar-fill {
    height: 100%;
    background: var(--success);
    transition: width 0.3s ease;
  }

  .es-pct {
    color: var(--text-dim);
    font-variant-numeric: tabular-nums;
  }

  .epic-acceptance {
    font-size: 0.75rem;
    color: var(--text-dim);
  }

  .epic-acceptance summary {
    cursor: pointer;
    color: var(--text);
  }

  .epic-acceptance ul {
    margin: 0.375rem 0 0;
    padding-left: 1.125rem;
    color: var(--text);
  }

  .ht-viewport {
    flex: 1;
    overflow-y: auto;
    position: relative;
  }

  .ht-empty {
    padding: 2rem;
    text-align: center;
    color: var(--text-faint);
    font-size: 0.875rem;
  }

  .ht-list {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .ht-spacer {
    width: 100%;
    flex-shrink: 0;
  }

  .ht-row {
    display: flex;
    align-items: center;
    width: 100%;
    border-bottom: 1px solid var(--border);
    box-sizing: border-box;
  }

  .ht-row.focused {
    background: var(--accent-halo);
    border-left: 2px solid var(--accent);
  }

  .ht-row.is-bucket {
    background: color-mix(in srgb, var(--text-faint) 10%, transparent);
    font-style: italic;
  }

  .ht-row.is-epic .ht-row-inner .row-title {
    color: var(--text);
    font-weight: 600;
  }

  .ht-row-inner {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    width: 100%;
    height: 100%;
    padding: 0 0.5rem;
    background: transparent;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
    transition: background 0.15s;
    box-sizing: border-box;
  }

  .ht-row-inner:hover {
    background: color-mix(in srgb, var(--border-strong) 20%, transparent);
  }

  .row-caret {
    width: 14px;
    flex-shrink: 0;
    color: var(--text-faint);
    font-size: 0.75rem;
    text-align: center;
  }

  .row-id {
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    font-size: 0.675rem;
    color: var(--accent);
    font-weight: 600;
    flex-shrink: 0;
  }

  .row-title {
    color: var(--text);
    font-size: 0.8125rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
    flex: 1;
  }

  .bucket-label {
    color: var(--text-dim);
    font-size: 0.8125rem;
    flex: 1;
  }

  .row-descendants {
    color: var(--text-faint);
    font-size: 0.6875rem;
    flex-shrink: 0;
  }

  .size-chip {
    font-size: 0.625rem;
    color: var(--text-faint);
    background: var(--bg-elev-2);
    padding: 0.1rem 0.3rem;
    border-radius: 2px;
    text-transform: lowercase;
    flex-shrink: 0;
  }

  .epic-mini-progress {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    flex-shrink: 0;
  }

  .emp-bar {
    display: inline-block;
    width: 50px;
    height: 4px;
    background: var(--border);
    border-radius: 2px;
    overflow: hidden;
  }

  .emp-fill {
    display: block;
    height: 100%;
    background: var(--success);
  }

  .emp-label {
    font-size: 0.625rem;
    color: var(--success);
    font-variant-numeric: tabular-nums;
  }

  .dep-badge {
    font-size: 0.625rem;
    padding: 0.1rem 0.375rem;
    border-radius: 3px;
    font-variant-numeric: tabular-nums;
    font-weight: 600;
    border: 1px solid transparent;
    cursor: pointer;
    font-family: inherit;
    flex-shrink: 0;
    transition: opacity 0.15s;
  }

  .dep-badge:hover {
    opacity: 0.8;
  }

  .dep-badge.dep-in {
    background: var(--danger-soft);
    color: var(--danger);
    border-color: var(--danger-soft);
  }

  .dep-badge.dep-out {
    background: var(--warning-soft);
    color: var(--warning);
    border-color: var(--warning-soft);
  }

  .row-labels {
    display: inline-flex;
    gap: 3px;
    flex-shrink: 0;
  }

  .label-pill {
    font-size: 0.575rem;
    background: var(--bg-elev-2);
    border: 1px solid var(--border);
    color: var(--text-dim);
    padding: 1px 5px;
    border-radius: 999px;
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  }

  .label-pill.more {
    color: var(--text-faint);
  }

  .drill-btn {
    font-size: 0.625rem;
    padding: 0.1rem 0.4rem;
    border-radius: 3px;
    background: var(--accent-halo);
    color: var(--accent);
    border: 1px solid var(--accent-soft);
    cursor: pointer;
    font-family: inherit;
    flex-shrink: 0;
    transition: background 0.15s;
  }

  .drill-btn:hover {
    background: var(--accent-soft);
  }
</style>
