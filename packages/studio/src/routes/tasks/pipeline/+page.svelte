<script lang="ts">
  import type { PageData } from './$types';
  import type { PipelineColumn, PipelineTask } from './+page.server.js';

  interface Props {
    data: PageData;
  }
  let { data }: Props = $props();

  const columns: PipelineColumn[] = data.columns ?? [];

  function priorityClass(p: string): string {
    if (p === 'critical') return 'p-critical';
    if (p === 'high') return 'p-high';
    if (p === 'medium') return 'p-medium';
    return 'p-low';
  }

  function statusIcon(s: string): string {
    if (s === 'done') return '✓';
    if (s === 'active') return '●';
    if (s === 'blocked') return '✗';
    return '○';
  }

  function statusClass(s: string): string {
    if (s === 'done') return 'sc-done';
    if (s === 'active') return 'sc-active';
    if (s === 'blocked') return 'sc-blocked';
    return 'sc-pending';
  }

  function gatesPassed(task: PipelineTask): { i: boolean; t: boolean; q: boolean } {
    try {
      if (!task.verification_json) return { i: false, t: false, q: false };
      const v = JSON.parse(task.verification_json);
      return {
        i: v.gates?.implemented ?? false,
        t: v.gates?.testsPassed ?? false,
        q: v.gates?.qaPassed ?? false,
      };
    } catch {
      return { i: false, t: false, q: false };
    }
  }

  // Keyboard navigation
  let focusedCol = $state(0);
  let focusedRow = $state(0);

  function handleKeydown(e: KeyboardEvent): void {
    if (e.key === 'ArrowRight') {
      focusedCol = Math.min(focusedCol + 1, columns.length - 1);
      focusedRow = 0;
    } else if (e.key === 'ArrowLeft') {
      focusedCol = Math.max(focusedCol - 1, 0);
      focusedRow = 0;
    } else if (e.key === 'ArrowDown') {
      const maxRow = (columns[focusedCol]?.tasks.length ?? 1) - 1;
      focusedRow = Math.min(focusedRow + 1, maxRow);
    } else if (e.key === 'ArrowUp') {
      focusedRow = Math.max(focusedRow - 1, 0);
    }
  }

  // Total non-archived tasks
  const totalTasks = columns.reduce((sum, c) => sum + c.count, 0);
</script>

<svelte:head>
  <title>Pipeline — CLEO Studio</title>
</svelte:head>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div class="pipeline-view" role="main" onkeydown={handleKeydown} tabindex="-1">
  <div class="page-header">
    <div class="header-left">
      <h1 class="page-title">Pipeline</h1>
      <nav class="tasks-nav">
        <a href="/tasks" class="nav-tab">Dashboard</a>
        <a href="/tasks/pipeline" class="nav-tab active">Pipeline</a>
        <a href="/tasks/sessions" class="nav-tab">Sessions</a>
      </nav>
    </div>
    <span class="total-count">{totalTasks} tasks</span>
  </div>

  <div class="kanban-scroll">
    <div class="kanban-board">
      {#each columns as col, ci}
        <div class="kanban-col" class:col-focused={ci === focusedCol}>
          <div class="col-header">
            <span class="col-label">{col.label}</span>
            <span class="col-count">{col.count}</span>
          </div>
          <div class="col-body">
            {#each col.tasks as task, ri}
              {@const gates = gatesPassed(task)}
              <a
                href="/tasks/{task.id}"
                class="task-card"
                class:card-focused={ci === focusedCol && ri === focusedRow}
              >
                <div class="card-top">
                  <span class="card-id">{task.id}</span>
                  <span class="card-status {statusClass(task.status)}">{statusIcon(task.status)}</span>
                </div>
                <p class="card-title">{task.title}</p>
                <div class="card-footer">
                  <span class="card-priority {priorityClass(task.priority)}">{task.priority}</span>
                  {#if task.size}
                    <span class="card-size">{task.size}</span>
                  {/if}
                  <div class="card-gates">
                    <span class="g-dot" class:g-pass={gates.i} title="Implemented">I</span>
                    <span class="g-dot" class:g-pass={gates.t} title="Tests">T</span>
                    <span class="g-dot" class:g-pass={gates.q} title="QA">Q</span>
                  </div>
                </div>
              </a>
            {/each}
            {#if col.tasks.length === 0}
              <div class="col-empty">—</div>
            {/if}
          </div>
        </div>
      {/each}
    </div>
  </div>

  <p class="keyboard-hint">Arrow keys to navigate · Enter to open</p>
</div>

<style>
  .pipeline-view {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    height: calc(100vh - 8rem);
    outline: none;
  }

  .page-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 1rem;
    flex-shrink: 0;
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

  .total-count {
    font-size: 0.8125rem;
    color: #64748b;
    font-variant-numeric: tabular-nums;
  }

  /* Kanban */
  .kanban-scroll {
    flex: 1;
    overflow-x: auto;
    overflow-y: hidden;
    padding-bottom: 0.5rem;
  }

  .kanban-board {
    display: flex;
    gap: 0.75rem;
    height: 100%;
    min-width: max-content;
  }

  .kanban-col {
    display: flex;
    flex-direction: column;
    width: 220px;
    flex-shrink: 0;
    background: #1a1f2e;
    border: 1px solid #2d3748;
    border-radius: 8px;
    overflow: hidden;
    transition: border-color 0.15s;
  }

  .kanban-col.col-focused {
    border-color: rgba(168, 85, 247, 0.4);
  }

  .col-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.625rem 0.75rem;
    border-bottom: 1px solid #2d3748;
    background: #161b27;
    flex-shrink: 0;
  }

  .col-label {
    font-size: 0.75rem;
    font-weight: 600;
    color: #94a3b8;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .col-count {
    font-size: 0.7rem;
    color: #64748b;
    background: #0f1117;
    padding: 0.1rem 0.375rem;
    border-radius: 3px;
    font-variant-numeric: tabular-nums;
  }

  .col-body {
    flex: 1;
    overflow-y: auto;
    padding: 0.5rem;
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
  }

  .col-empty {
    text-align: center;
    padding: 1rem;
    font-size: 0.75rem;
    color: #2d3748;
  }

  /* Task cards */
  .task-card {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    padding: 0.625rem;
    background: #0f1117;
    border: 1px solid #1e2435;
    border-radius: 6px;
    text-decoration: none;
    color: inherit;
    transition: border-color 0.15s, background 0.15s;
    cursor: pointer;
  }

  .task-card:hover {
    border-color: #3d4a60;
    background: #13182a;
  }

  .task-card.card-focused {
    border-color: #a855f7;
    outline: none;
  }

  .card-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .card-id {
    font-size: 0.675rem;
    color: #a855f7;
    font-weight: 600;
  }

  .card-status {
    font-size: 0.675rem;
  }

  .card-title {
    font-size: 0.8125rem;
    color: #e2e8f0;
    line-height: 1.4;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .card-footer {
    display: flex;
    align-items: center;
    gap: 0.375rem;
  }

  .card-priority {
    font-size: 0.625rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .card-size {
    font-size: 0.625rem;
    color: #475569;
    background: #1e2435;
    padding: 0.1rem 0.3rem;
    border-radius: 2px;
  }

  .card-gates {
    display: flex;
    gap: 2px;
    margin-left: auto;
  }

  .g-dot {
    font-size: 0.55rem;
    width: 13px;
    height: 13px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 2px;
    background: #1e2435;
    color: #2d3748;
    font-weight: 700;
  }

  .g-dot.g-pass {
    background: rgba(34, 197, 94, 0.12);
    color: #22c55e;
  }

  /* Status colors */
  .sc-done { color: #22c55e; }
  .sc-active { color: #3b82f6; }
  .sc-blocked { color: #ef4444; }
  .sc-pending { color: #475569; }

  /* Priority colors */
  .p-critical { color: #ef4444; }
  .p-high { color: #f97316; }
  .p-medium { color: #eab308; }
  .p-low { color: #64748b; }

  .keyboard-hint {
    font-size: 0.7rem;
    color: #2d3748;
    text-align: center;
    flex-shrink: 0;
  }
</style>
