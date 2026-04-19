<!--
  KanbanTab — status-axis Kanban board with epic sub-grouping.

  Post-T990 Wave 1C, the board gains:

    - Sticky column headers when the Explorer scrolls inside a
      constrained viewport
    - Full keyboard navigation (Tab/ArrowLeft/ArrowRight/ArrowUp/
      ArrowDown/Enter)
    - Swim-lane mode — rows = top-level-ancestor epics, columns = 5
      canonical statuses.  Toggled via the control above the board.
    - Drop-placeholder styling (dashed outline under the column that
      would receive a card in a future drag-and-drop wave). Drag-and-
      drop itself is still explicitly out of scope (operator decision
      captured in `docs/specs/CLEO-TASK-DASHBOARD-SPEC.md` §5.4).

  Preserved:
    - Five canonical status columns in order
    - `TaskCard` (compact) renders each card, clicking repins the drawer
    - Status filter from the shared store hides non-selected columns
    - Horizontal scroll at ≤ 1200px, stacked at ≤ 640px

  @task T955
  @epic T949
  @reviewed T990 (Wave 1C)
-->
<script lang="ts">
  import type { Task } from '@cleocode/contracts';

  import type { TaskDependencyEdge } from '../../server/tasks/explorer-loader.js';
  import type { TaskFilters } from '../../stores/task-filters.svelte.js';
  import {
    applyKanbanFilters,
    bucketKanbanTasks,
    columnIsVisible,
    indexTasksById,
    type KanbanColumn,
    type KanbanFilterPredicate,
    NO_EPIC_GROUP_ID,
    NO_EPIC_GROUP_TITLE,
  } from './kanban-bucketing.js';
  import { statusIcon } from './format.js';
  import TaskCard from './TaskCard.svelte';

  interface Props {
    /** Full task set for the active project, already archive-filtered. */
    tasks: Task[];
    /** Dependency edges (unused here — passed through for parity). */
    deps: TaskDependencyEdge[];
    /** Shared Task Explorer filter store. */
    filters: TaskFilters;
  }

  let { tasks, deps: _deps, filters }: Props = $props();

  // ---------------------------------------------------------------------------
  // Reactive derivations
  // ---------------------------------------------------------------------------

  const predicate = $derived<KanbanFilterPredicate>({
    query: filters.state.query,
    priority: filters.state.priority,
    labels: filters.state.labels,
    cancelled: filters.state.cancelled,
    status: filters.state.status,
  });

  const byId = $derived(indexTasksById(tasks));
  const filteredTasks = $derived(applyKanbanFilters(tasks, predicate));
  const buckets = $derived(bucketKanbanTasks(filteredTasks, byId));
  const totalTasks = $derived(tasks.length);
  const selectedId = $derived(filters.state.selected);

  // View mode — status-first (default) or epic-first (swim lanes).
  let viewMode: 'status' | 'epic' = $state('status');

  // Collapse state keyed by `${status}::${epicId}` (status-first mode).
  let collapsed = $state(new Set<string>());

  // Swim-lane collapse state keyed by epic id.
  let collapsedLanes = $state(new Set<string>());

  // ---------------------------------------------------------------------------
  // Event handlers
  // ---------------------------------------------------------------------------

  function openTask(task: Task): void {
    filters.setSelected(task.id);
  }

  function toggleGroup(status: string, epicId: string): void {
    const key = `${status}::${epicId}`;
    const next = new Set(collapsed);
    if (next.has(key)) {
      next.delete(key);
    } else {
      next.add(key);
    }
    collapsed = next;
  }

  function toggleLane(epicId: string): void {
    const next = new Set(collapsedLanes);
    if (next.has(epicId)) {
      next.delete(epicId);
    } else {
      next.add(epicId);
    }
    collapsedLanes = next;
  }

  function groupKey(status: string, epicId: string): string {
    return `${status}::${epicId}`;
  }

  function isColumnVisible(col: KanbanColumn): boolean {
    return columnIsVisible(col.status, predicate);
  }

  function statusLabel(s: string): string {
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  // ---------------------------------------------------------------------------
  // Keyboard navigation — arrows move focus between cards, Enter opens
  // ---------------------------------------------------------------------------

  /**
   * Handle arrow keys on a card: Left/Right cycle columns at the same
   * row index; Up/Down cycle cards within the same column.
   */
  function onCardKeydown(
    e: KeyboardEvent,
    ctx: { status: string; groupIdx: number; cardIdx: number },
  ): void {
    const target = e.currentTarget;
    if (!(target instanceof HTMLElement)) return;

    if (e.key === 'Enter' || e.key === ' ') {
      // Delegate to the TaskCard's own click handler.
      e.preventDefault();
      target.click();
      return;
    }

    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
    e.preventDefault();

    const column = target.closest<HTMLElement>('[data-column]');
    const board = target.closest<HTMLElement>('[data-board]');
    if (!column || !board) return;

    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      const columnCards = Array.from(column.querySelectorAll<HTMLElement>('[data-card]'));
      const idx = columnCards.indexOf(target);
      const nextIdx = e.key === 'ArrowDown'
        ? Math.min(columnCards.length - 1, idx + 1)
        : Math.max(0, idx - 1);
      columnCards[nextIdx]?.focus();
      return;
    }

    // Left/Right: move between columns at the same card index.
    const columns = Array.from(board.querySelectorAll<HTMLElement>('[data-column]'));
    const curColIdx = columns.indexOf(column);
    const dir = e.key === 'ArrowRight' ? 1 : -1;
    for (let step = 1; step <= columns.length; step += 1) {
      const next = columns[(curColIdx + dir * step + columns.length) % columns.length];
      if (!next) continue;
      const cards = next.querySelectorAll<HTMLElement>('[data-card]');
      if (cards.length === 0) continue;
      const clampedIdx = Math.min(cards.length - 1, ctx.cardIdx);
      cards[clampedIdx]?.focus();
      return;
    }
  }

  // ---------------------------------------------------------------------------
  // Swim-lane projection — rows = root epics, cols = 5 statuses
  // ---------------------------------------------------------------------------

  interface SwimLane {
    epicId: string;
    epicTitle: string;
    /** Tasks keyed by status. */
    cells: Record<string, Task[]>;
    /** Cached total across cells, used in the left-edge gutter. */
    total: number;
  }

  const swimLanes = $derived.by<SwimLane[]>(() => {
    const lanes = new Map<string, SwimLane>();
    for (const column of buckets.columns) {
      for (const group of column.groups) {
        let lane = lanes.get(group.epicId);
        if (!lane) {
          lane = {
            epicId: group.epicId,
            epicTitle: group.epicTitle,
            cells: {
              pending: [],
              active: [],
              blocked: [],
              done: [],
              cancelled: [],
            },
            total: 0,
          };
          lanes.set(group.epicId, lane);
        }
        lane.cells[column.status] = [...(lane.cells[column.status] ?? []), ...group.tasks];
        lane.total += group.tasks.length;
      }
    }
    return Array.from(lanes.values()).sort((a, b) => {
      if (a.epicId === NO_EPIC_GROUP_ID) return 1;
      if (b.epicId === NO_EPIC_GROUP_ID) return -1;
      return a.epicId.localeCompare(b.epicId);
    });
  });
</script>

<section class="kanban-tab" aria-label="Kanban by status">
  <header class="kanban-header">
    <div class="header-left">
      <h2 class="kanban-title">Kanban <span class="axis">· by {viewMode === 'status' ? 'status' : 'epic'}</span></h2>
      <p class="kanban-total" aria-live="polite">
        {buckets.filteredTotal} of {totalTasks}
      </p>
    </div>
    <div class="mode-toggle" role="group" aria-label="Kanban view mode">
      <button
        type="button"
        class="mode-btn"
        class:active={viewMode === 'status'}
        onclick={() => (viewMode = 'status')}
        aria-pressed={viewMode === 'status'}
      >
        <span>Columns</span>
      </button>
      <button
        type="button"
        class="mode-btn"
        class:active={viewMode === 'epic'}
        onclick={() => (viewMode = 'epic')}
        aria-pressed={viewMode === 'epic'}
      >
        <span>Swim lanes</span>
      </button>
    </div>
  </header>

  {#if viewMode === 'status'}
    <div class="kanban-board" data-board role="list" aria-label="Status columns">
      {#each buckets.columns as column (column.status)}
        {#if isColumnVisible(column)}
          <article
            class="kanban-column status-{column.status}"
            role="listitem"
            data-column={column.status}
            aria-label={`${statusLabel(column.status)} column: ${column.taskCount} tasks`}
          >
            <header class="column-header">
              <span class="col-glyph" aria-hidden="true">{statusIcon(column.status)}</span>
              <h3 class="col-name">{statusLabel(column.status)}</h3>
              <span class="col-count" aria-label={`${column.taskCount} tasks`}>{column.taskCount}</span>
            </header>

            {#if column.groups.length === 0}
              <div class="drop-slot" aria-hidden="true">No tasks</div>
            {:else}
              <div class="column-body">
                {#each column.groups as group, groupIdx (group.epicId)}
                  {@const isOpen = !collapsed.has(groupKey(column.status, group.epicId))}
                  <div class="epic-group" class:open={isOpen}>
                    <button
                      type="button"
                      class="group-header"
                      aria-expanded={isOpen}
                      aria-controls={groupKey(column.status, group.epicId)}
                      onclick={() => toggleGroup(column.status, group.epicId)}
                    >
                      <span class="chevron" aria-hidden="true">{isOpen ? '▾' : '▸'}</span>
                      <span class="group-label">
                        {#if group.epicId === NO_EPIC_GROUP_ID}
                          <span class="group-title">{NO_EPIC_GROUP_TITLE}</span>
                        {:else}
                          <span class="group-id">{group.epicId}</span>
                          <span class="group-title">{group.epicTitle}</span>
                        {/if}
                      </span>
                      <span class="group-count">{group.tasks.length}</span>
                    </button>
                    {#if isOpen}
                      <ul
                        class="group-body"
                        id={groupKey(column.status, group.epicId)}
                      >
                        {#each group.tasks as task, cardIdx (task.id)}
                          <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
                          <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
                          <li
                            class="card-wrapper"
                            data-card
                            tabindex="-1"
                            onkeydown={(e) =>
                              onCardKeydown(e, {
                                status: column.status,
                                groupIdx,
                                cardIdx,
                              })}
                          >
                            <TaskCard
                              task={task}
                              onClick={openTask}
                              compact
                              focused={selectedId === task.id}
                            />
                          </li>
                        {/each}
                      </ul>
                    {/if}
                  </div>
                {/each}
              </div>
            {/if}
          </article>
        {/if}
      {/each}
    </div>
  {:else}
    <div class="swim-board" role="table" aria-label="Swim lanes by epic">
      <div class="swim-head" role="row">
        <div class="swim-head-gutter" role="columnheader">Epic</div>
        {#each buckets.columns as column (column.status)}
          {#if isColumnVisible(column)}
            <div class="swim-head-cell status-{column.status}" role="columnheader">
              <span class="col-glyph" aria-hidden="true">{statusIcon(column.status)}</span>
              <span class="col-name">{statusLabel(column.status)}</span>
            </div>
          {/if}
        {/each}
      </div>
      {#each swimLanes as lane (lane.epicId)}
        {@const laneOpen = !collapsedLanes.has(lane.epicId)}
        <div class="swim-row" class:collapsed={!laneOpen} role="row">
          <button
            type="button"
            class="swim-gutter"
            aria-expanded={laneOpen}
            onclick={() => toggleLane(lane.epicId)}
          >
            <span class="chevron" aria-hidden="true">{laneOpen ? '▾' : '▸'}</span>
            {#if lane.epicId === NO_EPIC_GROUP_ID}
              <span class="lane-title">{NO_EPIC_GROUP_TITLE}</span>
            {:else}
              <span class="lane-id">{lane.epicId}</span>
              <span class="lane-title">{lane.epicTitle}</span>
            {/if}
            <span class="lane-count">{lane.total}</span>
          </button>
          {#each buckets.columns as column (column.status)}
            {#if isColumnVisible(column)}
              {@const cell = lane.cells[column.status] ?? []}
              <div class="swim-cell" role="cell">
                {#if laneOpen && cell.length > 0}
                  <ul class="cell-cards">
                    {#each cell as task, cardIdx (task.id)}
                      <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
                      <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
                      <li
                        class="card-wrapper"
                        data-card
                        tabindex="-1"
                        onkeydown={(e) =>
                          onCardKeydown(e, {
                            status: column.status,
                            groupIdx: 0,
                            cardIdx,
                          })}
                      >
                        <TaskCard
                          task={task}
                          onClick={openTask}
                          compact
                          focused={selectedId === task.id}
                        />
                      </li>
                    {/each}
                  </ul>
                {:else if laneOpen}
                  <div class="drop-slot" aria-hidden="true"></div>
                {/if}
              </div>
            {/if}
          {/each}
        </div>
      {/each}
    </div>
  {/if}
</section>

<style>
  .kanban-tab {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    width: 100%;
    color: var(--text);
    height: 100%;
    min-height: 0;
    overflow: hidden;
  }

  .kanban-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    padding: 0 2px;
    flex-shrink: 0;
  }

  .header-left {
    display: flex;
    align-items: baseline;
    gap: var(--space-3);
  }

  .kanban-title {
    margin: 0;
    font-size: var(--text-md);
    font-weight: 600;
    color: var(--text);
    letter-spacing: 0.01em;
  }

  .axis {
    color: var(--text-faint);
    font-weight: 500;
    font-size: var(--text-sm);
  }

  .kanban-total {
    margin: 0;
    font-size: var(--text-xs);
    color: var(--text-dim);
    font-variant-numeric: tabular-nums;
  }

  .mode-toggle {
    display: inline-flex;
    gap: 2px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: 2px;
  }

  .mode-btn {
    font: inherit;
    font-size: var(--text-2xs);
    background: transparent;
    border: none;
    color: var(--text-dim);
    padding: 4px 10px;
    border-radius: var(--radius-sm);
    cursor: pointer;
    transition: color var(--ease), background var(--ease);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .mode-btn:hover {
    color: var(--text);
  }

  .mode-btn.active {
    color: var(--accent);
    background: var(--accent-soft);
  }

  .mode-btn:focus-visible {
    outline: none;
    box-shadow: var(--shadow-focus);
  }

  /* ---------- Column-first board ---------- */

  .kanban-board {
    display: grid;
    grid-template-columns: repeat(5, minmax(240px, 1fr));
    gap: var(--space-2);
    align-items: flex-start;
    width: 100%;
    flex: 1;
    min-height: 0;
    overflow-y: auto;
  }

  @media (max-width: 1200px) {
    .kanban-board {
      display: flex;
      flex-direction: row;
      overflow-x: auto;
      overflow-y: auto;
      scroll-snap-type: x proximity;
      padding-bottom: 4px;
    }

    .kanban-column {
      flex: 0 0 280px;
      scroll-snap-align: start;
    }
  }

  @media (max-width: 640px) {
    .kanban-board {
      flex-direction: column;
      overflow-x: visible;
    }

    .kanban-column {
      flex: 1 1 auto;
      width: 100%;
    }
  }

  .kanban-column {
    display: flex;
    flex-direction: column;
    gap: 6px;
    background: var(--bg);
    border: 1px solid var(--bg-elev-2);
    border-radius: var(--radius-lg);
    padding: 8px;
    min-height: 100px;
  }

  .column-header {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 4px;
    border-bottom: 1px solid var(--bg-elev-2);
    position: sticky;
    top: 0;
    background: var(--bg);
    z-index: 2;
  }

  .col-glyph {
    font-size: var(--text-sm);
    line-height: 1;
    width: 1rem;
    text-align: center;
  }

  .col-name {
    margin: 0;
    font-size: var(--text-xs);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text);
    flex: 1;
  }

  .col-count {
    font-size: var(--text-2xs);
    font-variant-numeric: tabular-nums;
    background: var(--bg-elev-1);
    color: var(--text-dim);
    padding: 2px 8px;
    border-radius: var(--radius-pill);
  }

  .kanban-column.status-pending .col-glyph {
    color: var(--status-pending);
  }
  .kanban-column.status-active .col-glyph {
    color: var(--status-active);
  }
  .kanban-column.status-blocked .col-glyph {
    color: var(--status-blocked);
  }
  .kanban-column.status-done .col-glyph {
    color: var(--status-done);
  }
  .kanban-column.status-cancelled .col-glyph {
    color: var(--status-cancelled);
  }

  .drop-slot {
    margin: 4px 0;
    min-height: 32px;
    border: 1px dashed var(--border);
    border-radius: var(--radius-sm);
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--text-faint);
    font-size: var(--text-2xs);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    font-style: italic;
  }

  .column-body {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .epic-group {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .group-header {
    all: unset;
    box-sizing: border-box;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 6px;
    cursor: pointer;
    border-radius: var(--radius-sm);
    transition: background var(--ease);
    font-size: var(--text-2xs);
    color: var(--text-dim);
  }

  .group-header:hover {
    background: var(--bg-elev-1);
    color: var(--text);
  }

  .group-header:focus-visible {
    outline: none;
    box-shadow: var(--shadow-focus);
  }

  .chevron {
    font-size: 0.6rem;
    color: var(--text-faint);
    width: 0.75rem;
    text-align: center;
  }

  .group-label {
    display: inline-flex;
    gap: 6px;
    flex: 1;
    min-width: 0;
  }

  .group-id {
    color: var(--accent);
    font-weight: 600;
    font-family: var(--font-mono);
    font-size: 0.675rem;
    flex-shrink: 0;
  }

  .group-title {
    color: var(--text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .group-count {
    color: var(--text-faint);
    font-variant-numeric: tabular-nums;
    flex-shrink: 0;
  }

  .group-body {
    list-style: none;
    margin: 0;
    padding: 0 0 0 var(--space-2);
    display: flex;
    flex-direction: column;
    gap: 4px;
    border-left: 1px solid var(--bg-elev-2);
    margin-left: 6px;
  }

  .card-wrapper {
    margin: 0;
  }

  .card-wrapper:focus-visible {
    outline: none;
    box-shadow: var(--shadow-focus);
    border-radius: var(--radius-md);
  }

  /* ---------- Epic-first swim lanes ---------- */

  .swim-board {
    display: flex;
    flex-direction: column;
    gap: 0;
    flex: 1;
    min-height: 0;
    overflow: auto;
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--bg);
  }

  .swim-head {
    display: grid;
    grid-template-columns: 180px repeat(5, minmax(200px, 1fr));
    position: sticky;
    top: 0;
    background: var(--bg-elev-1);
    border-bottom: 1px solid var(--border);
    z-index: 3;
  }

  .swim-head-gutter {
    font-size: var(--text-2xs);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-faint);
    font-weight: 600;
    padding: var(--space-2) var(--space-3);
    border-right: 1px solid var(--border);
  }

  .swim-head-cell {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: var(--space-2) var(--space-3);
    font-size: var(--text-xs);
    font-weight: 600;
    color: var(--text);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    border-right: 1px solid var(--border);
  }

  .swim-head-cell:last-child {
    border-right: none;
  }

  .swim-head-cell.status-pending .col-glyph {
    color: var(--status-pending);
  }
  .swim-head-cell.status-active .col-glyph {
    color: var(--status-active);
  }
  .swim-head-cell.status-blocked .col-glyph {
    color: var(--status-blocked);
  }
  .swim-head-cell.status-done .col-glyph {
    color: var(--status-done);
  }
  .swim-head-cell.status-cancelled .col-glyph {
    color: var(--status-cancelled);
  }

  .swim-row {
    display: grid;
    grid-template-columns: 180px repeat(5, minmax(200px, 1fr));
    border-bottom: 1px solid var(--bg-elev-2);
    align-items: stretch;
    min-height: 80px;
  }

  .swim-row:last-child {
    border-bottom: none;
  }

  .swim-row.collapsed {
    min-height: 0;
  }

  .swim-gutter {
    all: unset;
    box-sizing: border-box;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px;
    padding: var(--space-2) var(--space-3);
    border-right: 1px solid var(--bg-elev-2);
    cursor: pointer;
    transition: background var(--ease);
    background: var(--bg-elev-1);
  }

  .swim-gutter:hover {
    background: var(--bg-elev-2);
  }

  .swim-gutter:focus-visible {
    outline: none;
    box-shadow: var(--shadow-focus);
  }

  .lane-id {
    color: var(--accent);
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    font-weight: 600;
  }

  .lane-title {
    color: var(--text);
    font-size: var(--text-xs);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
    min-width: 0;
  }

  .lane-count {
    color: var(--text-faint);
    font-size: var(--text-2xs);
    font-variant-numeric: tabular-nums;
    margin-left: auto;
  }

  .swim-cell {
    padding: var(--space-2);
    border-right: 1px solid var(--bg-elev-2);
    min-height: 32px;
  }

  .swim-cell:last-child {
    border-right: none;
  }

  .cell-cards {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
</style>
