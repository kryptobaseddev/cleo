<!--
  RecentActivityFeed — last-N task updates extracted verbatim from
  `packages/studio/src/routes/tasks/+page.svelte:412-434`.

  Preservation contract per `docs/specs/CLEO-TASK-DASHBOARD-SPEC.md` §9:
    - Last 20 non-archived tasks by `updated_at DESC` (server enforces the
      limit; this component just renders the list).
    - Row click navigates to `/tasks/{id}` — full detail page, NOT the
      drawer. Preserves existing deep-link target per ADR operator note.
    - Archive toggle shown separately from cancellation toggle at the
      dashboard level — this component doesn't own that state.

  Presentational only. No API calls.

  @task T950
  @epic T949
-->
<script lang="ts">
  import type { TaskPriority, TaskStatus } from '@cleocode/contracts';
  import { formatTime, priorityClass, statusClass, statusIcon } from './format.js';

  /**
   * A single row in the Recent Activity feed.
   *
   * Matches the server-shape returned by the `SELECT ... FROM tasks` in
   * `routes/tasks/+page.server.ts`.
   */
  export interface RecentTaskRow {
    /** Task ID. */
    id: string;
    /** Task title. */
    title: string;
    /** Task status. */
    status: TaskStatus;
    /** Task priority. */
    priority: TaskPriority;
    /** Task type — epic/task/subtask. Rendered as a chip when non-task. */
    type: string;
    /** RCASD-IVTR+C pipeline stage, or null for research-stage tasks. */
    pipeline_stage: string | null;
    /** ISO 8601 updated timestamp for the relative-time renderer. */
    updated_at: string;
  }

  /**
   * Props for {@link RecentActivityFeed}.
   */
  interface Props {
    /** Ordered list of recent tasks (newest first). */
    tasks: RecentTaskRow[];
    /**
     * Override the default deep-link target. Defaults to `/tasks/{id}`.
     * Exposed so the Explorer can route through `?selected=T###` instead.
     */
    hrefFor?: (task: RecentTaskRow) => string;
  }

  let { tasks, hrefFor }: Props = $props();

  function defaultHref(t: RecentTaskRow): string {
    return `/tasks/${t.id}`;
  }

  const resolveHref = $derived(hrefFor ?? defaultHref);
</script>

{#if tasks.length > 0}
  <section class="panel">
    <h2 class="panel-title">Recent Activity</h2>
    <div class="task-list">
      {#each tasks as t (t.id)}
        <a href={resolveHref(t)} class="task-row">
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

<style>
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
    margin: 0;
  }

  .task-list {
    display: flex;
    flex-direction: column;
  }

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

  .task-row:hover {
    background: #21273a;
  }

  .task-row:last-child {
    border-bottom: none;
  }

  .task-status-icon {
    font-size: 0.75rem;
    width: 1rem;
    text-align: center;
    flex-shrink: 0;
  }

  .task-info {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    flex: 1;
    min-width: 0;
  }

  .task-id {
    font-size: 0.7rem;
    color: #a855f7;
    font-weight: 600;
    flex-shrink: 0;
  }

  .task-title {
    font-size: 0.8125rem;
    color: #e2e8f0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .task-meta {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-shrink: 0;
  }

  .task-priority {
    font-size: 0.675rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .task-stage {
    font-size: 0.675rem;
    color: #475569;
    background: #1e2435;
    padding: 0.1rem 0.375rem;
    border-radius: 3px;
  }

  .task-time {
    font-size: 0.675rem;
    color: #475569;
    font-variant-numeric: tabular-nums;
  }

  /* Status colours — applied via `status-<name>` classes resolved in format.ts */
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
    color: #f59e0b;
  }
  :global(.status-cancelled) {
    color: #94a3b8;
  }
  :global(.status-archived) {
    color: #64748b;
  }
  :global(.status-proposed) {
    color: #a855f7;
  }

  /* Priority colours */
  :global(.priority-critical) {
    color: #fca5a5;
  }
  :global(.priority-high) {
    color: #fca5a5;
  }
  :global(.priority-medium) {
    color: #f59e0b;
  }
  :global(.priority-low) {
    color: #9ca3af;
  }
</style>
