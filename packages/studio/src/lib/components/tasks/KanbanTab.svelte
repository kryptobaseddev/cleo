<!--
  KanbanTab — status-axis Kanban board with top-level-epic sub-grouping.

  Wave 1C of T949 (Studio /tasks Explorer merge). Third of the three
  Explorer tabs (Hierarchy / Graph / Kanban).

  ## Axis distinction

  - `/tasks` Kanban (this file) → axis is `status`.
  - `/tasks/pipeline`           → axis is `pipeline_stage` (RCASD-IVTR+C).

  Operator decision captured in `docs/specs/CLEO-TASK-DASHBOARD-SPEC.md`
  §5.4. Both tools live; Kanban is the status-first at-a-glance view.

  ## Rendering contract

  - Five columns in canonical order: `pending | active | blocked | done |
    cancelled`. Each column header shows the status icon/name + task count.
  - Inside each column, tasks are grouped by their **top-level ancestor
    epic**. The epic sub-header shows `<epicId>: <epicTitle> — N tasks`
    and is collapsible. Tasks with no root-epic ancestor go under a
    `No epic` group.
  - Cards use the shared {@link TaskCard} (compact=true) — clicking opens
    the DetailDrawer via `filters.setSelected(task.id)`.
  - Drag-to-update status is explicitly OUT OF SCOPE (operator decision
    pending). Cards render as static buttons only.

  ## Responsive behaviour

  Below 1200px viewport width, columns become horizontally scrollable
  (min-width fixed per column) so narrow screens still get a usable
  kanban. Below 640px each column full-bleeds and stacks vertically.

  @task T955
  @epic T949
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
  } from './kanban-bucketing.js';
  import { statusIcon } from './format.js';
  import TaskCard from './TaskCard.svelte';

  /**
   * Props for {@link KanbanTab}.
   */
  interface Props {
    /** Full task set for the active project, already archive-filtered. */
    tasks: Task[];
    /** Dependency edges (unused here but passed through for parity). */
    deps: TaskDependencyEdge[];
    /** Shared Task Explorer filter store ({@link TaskFilters}). */
    filters: TaskFilters;
  }

  let { tasks, deps: _deps, filters }: Props = $props();

  // ---------------------------------------------------------------------------
  // Reactive derivations
  // ---------------------------------------------------------------------------

  /**
   * Narrowed filter predicate — copies only the subset Kanban cares about,
   * staying disconnected from future additions to {@link TaskFilterState}.
   */
  const predicate = $derived<KanbanFilterPredicate>({
    query: filters.state.query,
    priority: filters.state.priority,
    labels: filters.state.labels,
    cancelled: filters.state.cancelled,
    status: filters.state.status,
  });

  /** Id→Task lookup for ancestor resolution. Rebuilt when tasks change. */
  const byId = $derived(indexTasksById(tasks));

  /** Tasks after every non-status filter is applied. */
  const filteredTasks = $derived(applyKanbanFilters(tasks, predicate));

  /** Columns × epic groups for rendering. */
  const buckets = $derived(bucketKanbanTasks(filteredTasks, byId));

  /** Denominator for the "Showing X of Y" header. */
  const totalTasks = $derived(tasks.length);

  /**
   * Collapsed state keyed by `${status}::${epicId}`. Reactive set so the
   * component re-renders when a group is toggled. Default = all expanded.
   */
  let collapsed = $state(new Set<string>());

  /** Selected task id (from filter store), for focused-state highlight. */
  const selectedId = $derived(filters.state.selected);

  // ---------------------------------------------------------------------------
  // Event handlers
  // ---------------------------------------------------------------------------

  /**
   * Open the DetailDrawer for the clicked task by writing the URL-backed
   * `selected` filter. The dashboard page owns the actual drawer render.
   */
  function openTask(task: Task): void {
    filters.setSelected(task.id);
  }

  /**
   * Toggle the collapsed state for a specific column × epic group.
   */
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

  /** Stable key-builder so the template + handler agree. */
  function groupKey(status: string, epicId: string): string {
    return `${status}::${epicId}`;
  }

  /** Derive a column's visibility from the current filter predicate. */
  function isColumnVisible(col: KanbanColumn): boolean {
    return columnIsVisible(col.status, predicate);
  }

  /** Capitalize a status for the column header label. */
  function statusLabel(s: string): string {
    return s.charAt(0).toUpperCase() + s.slice(1);
  }
</script>

<section class="kanban-tab" aria-label="Kanban by status">
  <header class="kanban-header">
    <h2 class="kanban-title">Kanban · by status</h2>
    <p class="kanban-total" aria-live="polite">
      Showing {buckets.filteredTotal} of {totalTasks} tasks
    </p>
  </header>

  <div class="kanban-board" role="list" aria-label="Status columns">
    {#each buckets.columns as column (column.status)}
      {#if isColumnVisible(column)}
        <article
          class="kanban-column status-{column.status}"
          role="listitem"
          aria-label={`${statusLabel(column.status)} column: ${column.taskCount} tasks`}
        >
          <header class="column-header">
            <span class="col-glyph" aria-hidden="true">{statusIcon(column.status)}</span>
            <h3 class="col-name">{statusLabel(column.status)}</h3>
            <span class="col-count" aria-label={`${column.taskCount} tasks`}>{column.taskCount}</span>
          </header>

          {#if column.groups.length === 0}
            <p class="column-empty">No tasks</p>
          {:else}
            <div class="column-body">
              {#each column.groups as group (group.epicId)}
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
                      {#if group.epicId === '__no_epic__'}
                        <span class="group-title">{group.epicTitle}</span>
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
                      {#each group.tasks as task (task.id)}
                        <li class="card-wrapper">
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
</section>

<style>
  .kanban-tab {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    width: 100%;
    color: #e2e8f0;
  }

  .kanban-header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 1rem;
    padding: 0 0.25rem;
  }

  .kanban-title {
    margin: 0;
    font-size: 0.9rem;
    font-weight: 600;
    color: #e2e8f0;
    letter-spacing: 0.02em;
  }

  .kanban-total {
    margin: 0;
    font-size: 0.75rem;
    color: #94a3b8;
    font-variant-numeric: tabular-nums;
  }

  .kanban-board {
    display: grid;
    grid-template-columns: repeat(5, minmax(240px, 1fr));
    gap: 0.5rem;
    align-items: flex-start;
    width: 100%;
  }

  @media (max-width: 1200px) {
    .kanban-board {
      display: flex;
      flex-direction: row;
      overflow-x: auto;
      scroll-snap-type: x proximity;
      padding-bottom: 0.25rem;
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
    gap: 0.4rem;
    background: #0a0c14;
    border: 1px solid #1e2435;
    border-radius: 8px;
    padding: 0.55rem;
    min-height: 100px;
  }

  .column-header {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding-bottom: 0.35rem;
    border-bottom: 1px solid #1e2435;
  }

  .col-glyph {
    font-size: 0.8rem;
    line-height: 1;
    width: 1rem;
    text-align: center;
  }

  .col-name {
    margin: 0;
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: #cbd5e1;
    flex: 1;
  }

  .col-count {
    font-size: 0.7rem;
    font-variant-numeric: tabular-nums;
    background: #13182a;
    color: #94a3b8;
    padding: 0.1rem 0.45rem;
    border-radius: 999px;
  }

  .kanban-column.status-pending .col-glyph { color: #f59e0b; }
  .kanban-column.status-active  .col-glyph { color: #3b82f6; }
  .kanban-column.status-blocked .col-glyph { color: #ef4444; }
  .kanban-column.status-done    .col-glyph { color: #22c55e; }
  .kanban-column.status-cancelled .col-glyph { color: #94a3b8; }

  .column-empty {
    color: #475569;
    font-size: 0.7rem;
    margin: 0.4rem 0.1rem;
    text-align: center;
    font-style: italic;
  }

  .column-body {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }

  .epic-group {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }

  .group-header {
    all: unset;
    box-sizing: border-box;
    display: flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0.2rem 0.3rem;
    cursor: pointer;
    border-radius: 4px;
    transition: background 0.15s;
    font-size: 0.7rem;
    color: #94a3b8;
  }

  .group-header:hover {
    background: #13182a;
    color: #cbd5e1;
  }

  .group-header:focus-visible {
    outline: 2px solid rgba(168, 85, 247, 0.6);
    outline-offset: 1px;
  }

  .chevron {
    font-size: 0.6rem;
    color: #64748b;
    width: 0.75rem;
    text-align: center;
  }

  .group-label {
    display: inline-flex;
    gap: 0.35rem;
    flex: 1;
    min-width: 0;
  }

  .group-id {
    color: #a855f7;
    font-weight: 600;
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    font-size: 0.675rem;
    flex-shrink: 0;
  }

  .group-title {
    color: #cbd5e1;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .group-count {
    color: #64748b;
    font-variant-numeric: tabular-nums;
    flex-shrink: 0;
  }

  .group-body {
    list-style: none;
    margin: 0;
    padding: 0 0 0 0.75rem;
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    border-left: 1px solid #1e2435;
    margin-left: 0.375rem;
  }

  .card-wrapper {
    margin: 0;
  }
</style>
