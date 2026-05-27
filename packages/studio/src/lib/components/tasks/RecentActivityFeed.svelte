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
    background: var(--bg-elev-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    overflow: hidden;
  }

  .panel-title {
    padding: 0.75rem 1rem;
    font-size: var(--text-sm);
    font-weight: 600;
    color: var(--text-dim);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    border-bottom: 1px solid var(--border);
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
    border-bottom: 1px solid var(--border);
    text-decoration: none;
    color: inherit;
    transition: background var(--ease);
  }

  .task-row:hover {
    background: var(--bg-elev-2);
  }

  .task-row:last-child {
    border-bottom: none;
  }

  .task-status-icon {
    font-size: var(--text-xs);
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
    color: var(--accent);
    font-weight: 600;
    flex-shrink: 0;
  }

  .task-title {
    font-size: var(--text-sm);
    color: var(--text);
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
    color: var(--text-faint);
    background: var(--bg-elev-1);
    padding: 0.1rem 0.375rem;
    border-radius: var(--radius-xs);
  }

  .task-time {
    font-size: 0.675rem;
    color: var(--text-faint);
    font-variant-numeric: tabular-nums;
  }

  /* Status colours — applied via `status-<name>` classes resolved in format.ts */
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
  :global(.status-cancelled) {
    color: var(--text-dim);
  }
  :global(.status-archived) {
    color: var(--status-archived);
  }
  :global(.status-proposed) {
    color: var(--status-proposed);
  }

  /* Priority colours */
  :global(.priority-critical) {
    color: color-mix(in srgb, var(--priority-critical) 65%, var(--text));
  }
  :global(.priority-high) {
    color: color-mix(in srgb, var(--priority-high) 65%, var(--text));
  }
  :global(.priority-medium) {
    color: var(--priority-medium);
  }
  :global(.priority-low) {
    color: var(--text-dim);
  }
</style>
