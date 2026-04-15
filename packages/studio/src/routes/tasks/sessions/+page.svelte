<script lang="ts">
  import type { PageData } from './$types';
  import type { SessionEntry } from './+page.server.js';

  interface Props {
    data: PageData;
  }
  let { data }: Props = $props();

  const sessions: SessionEntry[] = data.sessions ?? [];

  let expandedId = $state<string | null>(null);

  function toggle(id: string): void {
    expandedId = expandedId === id ? null : id;
  }

  function formatDuration(ms: number | null): string {
    if (ms === null) return '—';
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${s % 60}s`;
    const h = Math.floor(m / 60);
    return `${h}h ${m % 60}m`;
  }

  function formatDate(iso: string): string {
    try {
      return new Date(iso).toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return iso;
    }
  }

  function statusClass(s: string): string {
    if (s === 'active') return 'sess-active';
    if (s === 'ended') return 'sess-ended';
    return 'sess-other';
  }

  const totalCompleted = sessions.reduce((sum, s) => sum + s.completedCount, 0);
  const totalCreated = sessions.reduce((sum, s) => sum + s.createdCount, 0);
  const activeSessions = sessions.filter((s) => s.status === 'active').length;
</script>

<svelte:head>
  <title>Sessions — CLEO Studio</title>
</svelte:head>

<div class="sessions-view">
  <div class="page-header">
    <div class="header-left">
      <h1 class="page-title">Sessions</h1>
      <nav class="tasks-nav">
        <a href="/tasks" class="nav-tab">Dashboard</a>
        <a href="/tasks/pipeline" class="nav-tab">Pipeline</a>
        <a href="/tasks/sessions" class="nav-tab active">Sessions</a>
      </nav>
    </div>
    <div class="header-stats">
      <span class="hstat"><strong>{sessions.length}</strong> sessions</span>
      <span class="hstat"><strong>{totalCreated}</strong> created</span>
      <span class="hstat"><strong>{totalCompleted}</strong> completed</span>
      {#if activeSessions > 0}
        <span class="hstat hstat-active"><strong>{activeSessions}</strong> active</span>
      {/if}
    </div>
  </div>

  {#if sessions.length === 0}
    <div class="empty-state">No sessions found in tasks.db</div>
  {:else}
    <div class="timeline">
      {#each sessions as sess}
        <div class="timeline-item">
          <div class="timeline-connector">
            <div class="timeline-dot {statusClass(sess.status)}"></div>
            <div class="timeline-line"></div>
          </div>

          <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
          <div
            class="session-card"
            class:expanded={expandedId === sess.id}
            onclick={() => toggle(sess.id)}
          >
            <div class="session-header">
              <div class="session-title-row">
                <span class="session-status-badge {statusClass(sess.status)}">{sess.status}</span>
                <span class="session-name">{sess.name ?? sess.id}</span>
              </div>
              <div class="session-meta-row">
                <span class="session-time">{formatDate(sess.startedAt)}</span>
                {#if sess.endedAt}
                  <span class="session-sep">→</span>
                  <span class="session-time">{formatDate(sess.endedAt)}</span>
                  <span class="session-duration">{formatDuration(sess.durationMs)}</span>
                {/if}
                {#if sess.agent}
                  <span class="session-agent">{sess.agent}</span>
                {/if}
              </div>
              <div class="session-counts">
                {#if sess.currentTask}
                  <span class="count-chip count-active">
                    active: <a
                      href="/tasks/{sess.currentTask.id}"
                      class="active-task-link"
                      onclick={(e) => e.stopPropagation()}
                    >{sess.currentTask.id}</a>
                  </span>
                {/if}
                {#if sess.completedCount > 0}
                  <span class="count-chip count-done">{sess.completedCount} completed</span>
                {/if}
                {#if sess.createdCount > 0}
                  <span class="count-chip count-created">{sess.createdCount} created</span>
                {/if}
                {#if sess.workedTasks.length > 0}
                  <span class="count-chip count-worked">{sess.workedTasks.length} worked</span>
                {/if}
                {#if sess.completedCount === 0 && sess.createdCount === 0 && !sess.currentTask && sess.workedTasks.length === 0}
                  <span class="count-chip count-empty">no tasks</span>
                {/if}
              </div>
            </div>

            {#if expandedId === sess.id}
              {#if sess.currentTask}
                <div class="session-tasks">
                  <div class="tasks-label">Active Task</div>
                  <a
                    href="/tasks/{sess.currentTask.id}"
                    class="completed-task-row active-row"
                    onclick={(e) => e.stopPropagation()}
                  >
                    <span class="ct-id">{sess.currentTask.id}</span>
                    <span class="ct-title">{sess.currentTask.title}</span>
                    <span class="ct-status ct-status-active">in progress</span>
                  </a>
                </div>
              {/if}
              {#if sess.workedTasks.length > 0}
                <div class="session-tasks">
                  <div class="tasks-label">Task Work History</div>
                  {#each sess.workedTasks as t (t.id + t.setAt)}
                    <a
                      href="/tasks/{t.id}"
                      class="completed-task-row"
                      onclick={(e) => e.stopPropagation()}
                    >
                      <span class="ct-id">{t.id}</span>
                      <span class="ct-title">{t.title}</span>
                      <span class="ct-time">{formatDate(t.setAt)}</span>
                      <span class="ct-status">{t.clearedAt ? 'done' : 'active'}</span>
                    </a>
                  {/each}
                </div>
              {/if}
              {#if sess.completedTasks.length > 0}
                <div class="session-tasks">
                  <div class="tasks-label">Completed Tasks</div>
                  {#each sess.completedTasks as t}
                    <a
                      href="/tasks/{t.id}"
                      class="completed-task-row"
                      onclick={(e) => e.stopPropagation()}
                    >
                      <span class="ct-id">{t.id}</span>
                      <span class="ct-title">{t.title}</span>
                      <span class="ct-status">{t.status}</span>
                    </a>
                  {/each}
                </div>
              {/if}
            {/if}
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .sessions-view {
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
    max-width: 900px;
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

  .header-stats {
    display: flex;
    gap: 1rem;
  }

  .hstat {
    font-size: 0.8125rem;
    color: #64748b;
  }

  .hstat strong {
    color: #94a3b8;
    font-variant-numeric: tabular-nums;
  }

  .hstat-active {
    color: #22c55e;
  }

  .hstat-active strong {
    color: #22c55e;
  }

  .empty-state {
    padding: 2rem;
    text-align: center;
    color: #475569;
    font-size: 0.875rem;
    background: #1a1f2e;
    border: 1px dashed #2d3748;
    border-radius: 8px;
  }

  /* Timeline */
  .timeline {
    display: flex;
    flex-direction: column;
    gap: 0;
  }

  .timeline-item {
    display: flex;
    gap: 1rem;
    align-items: flex-start;
  }

  .timeline-connector {
    display: flex;
    flex-direction: column;
    align-items: center;
    flex-shrink: 0;
    padding-top: 0.875rem;
  }

  .timeline-dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    flex-shrink: 0;
    background: #2d3748;
  }

  .timeline-dot.sess-active {
    background: #22c55e;
    box-shadow: 0 0 6px #22c55e;
  }

  .timeline-dot.sess-ended {
    background: #3b82f6;
  }

  .timeline-line {
    width: 1px;
    flex: 1;
    background: #1e2435;
    min-height: 1rem;
    margin-top: 2px;
  }

  .timeline-item:last-child .timeline-line {
    display: none;
  }

  /* Session card */
  .session-card {
    flex: 1;
    background: #1a1f2e;
    border: 1px solid #2d3748;
    border-radius: 8px;
    padding: 0.875rem;
    margin-bottom: 0.625rem;
    cursor: pointer;
    transition: border-color 0.15s, background 0.15s;
  }

  .session-card:hover {
    border-color: #3d4a60;
    background: #1d2236;
  }

  .session-card.expanded {
    border-color: rgba(168, 85, 247, 0.3);
  }

  .session-header {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
  }

  .session-title-row {
    display: flex;
    align-items: center;
    gap: 0.625rem;
  }

  .session-status-badge {
    font-size: 0.675rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    padding: 0.15rem 0.5rem;
    border-radius: 3px;
    flex-shrink: 0;
  }

  .sess-active {
    color: #22c55e;
    background: rgba(34, 197, 94, 0.1);
  }

  .sess-ended {
    color: #64748b;
    background: #1e2435;
  }

  .sess-other {
    color: #94a3b8;
    background: #1e2435;
  }

  .session-name {
    font-size: 0.9375rem;
    font-weight: 600;
    color: #e2e8f0;
  }

  .session-meta-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .session-time {
    font-size: 0.75rem;
    color: #64748b;
    font-variant-numeric: tabular-nums;
  }

  .session-sep {
    font-size: 0.75rem;
    color: #2d3748;
  }

  .session-duration {
    font-size: 0.75rem;
    color: #94a3b8;
    background: #1e2435;
    padding: 0.1rem 0.375rem;
    border-radius: 3px;
    font-variant-numeric: tabular-nums;
  }

  .session-agent {
    font-size: 0.75rem;
    color: #a855f7;
    font-family: monospace;
  }

  .session-counts {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .count-chip {
    font-size: 0.7rem;
    padding: 0.15rem 0.5rem;
    border-radius: 3px;
    font-weight: 500;
  }

  .count-done {
    background: rgba(34, 197, 94, 0.1);
    color: #22c55e;
  }

  .count-created {
    background: rgba(59, 130, 246, 0.1);
    color: #3b82f6;
  }

  .count-worked {
    background: rgba(245, 158, 11, 0.1);
    color: #f59e0b;
  }

  .count-active {
    background: rgba(168, 85, 247, 0.15);
    color: #c084fc;
    display: flex;
    align-items: center;
    gap: 0.25rem;
  }

  .active-task-link {
    color: #a855f7;
    text-decoration: none;
    font-weight: 700;
  }

  .active-task-link:hover {
    text-decoration: underline;
  }

  .count-empty {
    background: #1e2435;
    color: #475569;
  }

  /* Expanded tasks list */
  .session-tasks {
    margin-top: 0.75rem;
    padding-top: 0.75rem;
    border-top: 1px solid #1e2435;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .tasks-label {
    font-size: 0.7rem;
    color: #64748b;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-bottom: 0.25rem;
  }

  .completed-task-row {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    padding: 0.375rem 0.625rem;
    background: #0f1117;
    border-radius: 4px;
    text-decoration: none;
    color: inherit;
    transition: background 0.15s;
  }

  .completed-task-row:hover {
    background: #13182a;
  }

  .ct-id {
    font-size: 0.675rem;
    color: #a855f7;
    font-weight: 600;
    flex-shrink: 0;
  }

  .ct-title {
    font-size: 0.8125rem;
    color: #e2e8f0;
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .ct-status {
    font-size: 0.675rem;
    color: #64748b;
    flex-shrink: 0;
  }

  .ct-status-active {
    color: #a855f7;
    font-weight: 600;
  }

  .ct-time {
    font-size: 0.675rem;
    color: #475569;
    flex-shrink: 0;
    font-variant-numeric: tabular-nums;
  }

  .active-row {
    border-left: 2px solid rgba(168, 85, 247, 0.4);
  }
</style>
