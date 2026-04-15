<script lang="ts">
  import type { PageData } from './$types';
  import type { EpicProgress, RecentTask } from './+page.server.js';

  interface Props {
    data: PageData;
  }
  let { data }: Props = $props();

  const stats = data.stats;
  const recentTasks: RecentTask[] = data.recentTasks ?? [];
  const epicProgress: EpicProgress[] = data.epicProgress ?? [];

  function priorityClass(p: string): string {
    if (p === 'critical') return 'priority-critical';
    if (p === 'high') return 'priority-high';
    if (p === 'medium') return 'priority-medium';
    return 'priority-low';
  }

  function statusIcon(s: string): string {
    if (s === 'done') return '✓';
    if (s === 'active') return '●';
    if (s === 'blocked') return '✗';
    return '○';
  }

  function statusClass(s: string): string {
    if (s === 'done') return 'status-done';
    if (s === 'active') return 'status-active';
    if (s === 'blocked') return 'status-blocked';
    return 'status-pending';
  }

  function progressPct(ep: EpicProgress): number {
    if (ep.total === 0) return 0;
    return Math.round((ep.done / ep.total) * 100);
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
</script>

<svelte:head>
  <title>Tasks — CLEO Studio</title>
</svelte:head>

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
        <div class="stat-card muted">
          <span class="stat-num">{stats.archived}</span>
          <span class="stat-lbl">Archived</span>
        </div>
      </div>

      <div class="priority-breakdown">
        <div class="section-label">Priority</div>
        <div class="priority-bars">
          {#each [['critical', stats.critical], ['high', stats.high], ['medium', stats.medium], ['low', stats.low]] as [label, count]}
            {@const total = stats.critical + stats.high + stats.medium + stats.low}
            {@const pct = total > 0 ? Math.round((Number(count) / total) * 100) : 0}
            <div class="priority-row">
              <span class="priority-label {priorityClass(String(label))}">{label}</span>
              <div class="priority-bar-track">
                <div
                  class="priority-bar-fill {priorityClass(String(label))}"
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

  <div class="lower-grid">
    {#if epicProgress.length > 0}
      <section class="panel">
        <h2 class="panel-title">Epic Progress</h2>
        <div class="epic-list">
          {#each epicProgress as ep}
            <a href="/tasks/tree/{ep.id}" class="epic-row">
              <div class="epic-header-row">
                <span class="epic-id">{ep.id}</span>
                <span class="epic-title">{ep.title}</span>
                <span class="epic-pct">{progressPct(ep)}%</span>
              </div>
              <div class="epic-progress-bar">
                <div class="epic-done-bar" style="width:{progressPct(ep)}%"></div>
              </div>
              <div class="epic-sub-counts">
                <span class="sub-done">{ep.done} done</span>
                <span class="sub-active">{ep.active} active</span>
                <span class="sub-pending">{ep.pending} pending</span>
              </div>
            </a>
          {/each}
        </div>
      </section>
    {/if}

    {#if recentTasks.length > 0}
      <section class="panel">
        <h2 class="panel-title">Recent Activity</h2>
        <div class="task-list">
          {#each recentTasks as t}
            <a href="/tasks/{t.id}" class="task-row">
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
  </div>
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

  .stat-card.primary { border-color: #a855f7; }
  .stat-card.status-active-card { border-color: rgba(59, 130, 246, 0.4); }
  .stat-card.status-done-card { border-color: rgba(34, 197, 94, 0.4); }
  .stat-card.muted { opacity: 0.6; }

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

  :global(.priority-critical) { color: #ef4444; }
  :global(.priority-high) { color: #f97316; }
  :global(.priority-medium) { color: #eab308; }
  :global(.priority-low) { color: #64748b; }

  .priority-bar-fill.priority-critical { background: #ef4444; }
  .priority-bar-fill.priority-high { background: #f97316; }
  .priority-bar-fill.priority-medium { background: #eab308; }
  .priority-bar-fill.priority-low { background: #64748b; }

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
    .lower-grid { grid-template-columns: 1fr; }
  }

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
  }

  .epic-list { display: flex; flex-direction: column; }

  .epic-row {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    padding: 0.75rem 1rem;
    border-bottom: 1px solid #1e2435;
    text-decoration: none;
    color: inherit;
    transition: background 0.15s;
  }

  .epic-row:hover { background: #21273a; }
  .epic-row:last-child { border-bottom: none; }

  .epic-header-row {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
  }

  .epic-id { font-size: 0.7rem; color: #a855f7; font-weight: 600; flex-shrink: 0; }
  .epic-title { font-size: 0.8125rem; color: #e2e8f0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .epic-pct { font-size: 0.75rem; color: #94a3b8; font-variant-numeric: tabular-nums; flex-shrink: 0; }

  .epic-progress-bar {
    height: 4px;
    background: #2d3748;
    border-radius: 2px;
    overflow: hidden;
  }

  .epic-done-bar {
    height: 100%;
    background: #22c55e;
    border-radius: 2px;
    transition: width 0.3s ease;
  }

  .epic-sub-counts { display: flex; gap: 0.75rem; font-size: 0.7rem; }
  .sub-done { color: #22c55e; }
  .sub-active { color: #3b82f6; }
  .sub-pending { color: #64748b; }

  .task-list { display: flex; flex-direction: column; }

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

  .task-row:hover { background: #21273a; }
  .task-row:last-child { border-bottom: none; }

  .task-status-icon { font-size: 0.75rem; width: 1rem; text-align: center; flex-shrink: 0; }

  :global(.status-done) { color: #22c55e; }
  :global(.status-active) { color: #3b82f6; }
  :global(.status-blocked) { color: #ef4444; }
  :global(.status-pending) { color: #475569; }

  .task-info { display: flex; align-items: baseline; gap: 0.5rem; flex: 1; min-width: 0; }
  .task-id { font-size: 0.7rem; color: #a855f7; font-weight: 600; flex-shrink: 0; }
  .task-title { font-size: 0.8125rem; color: #e2e8f0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  .task-meta { display: flex; align-items: center; gap: 0.5rem; flex-shrink: 0; }

  .task-priority { font-size: 0.675rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; }
  .task-stage { font-size: 0.675rem; color: #475569; background: #1e2435; padding: 0.1rem 0.375rem; border-radius: 3px; }
  .task-time { font-size: 0.675rem; color: #475569; font-variant-numeric: tabular-nums; }
</style>
