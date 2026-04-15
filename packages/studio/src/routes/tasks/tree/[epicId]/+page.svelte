<script lang="ts">
  import type { PageData } from './$types';
  import type { TreeNode } from './+page.server.js';

  interface Props {
    data: PageData;
  }
  let { data }: Props = $props();

  const { epic, stats } = data;

  // Collapsed state: set of IDs that are collapsed
  let collapsed = $state<Set<string>>(new Set());

  function toggleNode(id: string): void {
    const next = new Set(collapsed);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    collapsed = next;
  }

  function expandAll(): void {
    collapsed = new Set();
  }

  function collapseAll(): void {
    const all = new Set<string>();
    function collect(node: TreeNode): void {
      if (node.children.length > 0) {
        all.add(node.id);
        for (const c of node.children) collect(c);
      }
    }
    if (epic) collect(epic);
    collapsed = all;
  }

  function priorityClass(p: string): string {
    if (p === 'critical') return 'pc-critical';
    if (p === 'high') return 'pc-high';
    if (p === 'medium') return 'pc-medium';
    return 'pc-low';
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

  function gatesFromJson(json: string | null): { i: boolean; t: boolean; q: boolean } {
    try {
      if (!json) return { i: false, t: false, q: false };
      const v = JSON.parse(json);
      return {
        i: v.gates?.implemented ?? false,
        t: v.gates?.testsPassed ?? false,
        q: v.gates?.qaPassed ?? false,
      };
    } catch {
      return { i: false, t: false, q: false };
    }
  }

  const progressPct = stats ? (stats.total > 0 ? Math.round((stats.done / stats.total) * 100) : 0) : 0;

  // Keyboard navigation
  function handleKeydown(e: KeyboardEvent, id: string): void {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggleNode(id);
    }
  }
</script>

<svelte:head>
  <title>{epic?.id ?? 'Tree'} — CLEO Studio</title>
</svelte:head>

<div class="tree-view">
  <nav class="breadcrumb">
    <a href="/tasks">Tasks</a>
    <span class="crumb-sep">›</span>
    <span class="crumb-current">Tree: {epic?.id ?? '...'}</span>
  </nav>

  {#if epic}
    <div class="tree-header">
      <div class="tree-title-row">
        <span class="epic-id-badge">{epic.id}</span>
        <span class="epic-type-badge">{epic.type}</span>
        <span class="epic-status {statusClass(epic.status)}">{statusIcon(epic.status)} {epic.status}</span>
        <span class="epic-priority {priorityClass(epic.priority)}">{epic.priority}</span>
      </div>
      <h1 class="tree-title">{epic.title}</h1>

      {#if stats}
        <div class="tree-stats">
          <div class="tree-progress-bar">
            <div class="tree-done-fill" style="width:{progressPct}%"></div>
          </div>
          <div class="tree-stat-row">
            <span class="ts-done">{stats.done} done</span>
            <span class="ts-active">{stats.active} active</span>
            <span class="ts-pending">{stats.pending} pending</span>
            {#if stats.archived > 0}
              <span class="ts-archived">{stats.archived} archived</span>
            {/if}
            <span class="ts-total">{stats.total} total · {progressPct}%</span>
          </div>
        </div>
      {/if}

      <div class="tree-controls">
        <button class="tree-btn" onclick={expandAll}>Expand All</button>
        <button class="tree-btn" onclick={collapseAll}>Collapse All</button>
      </div>
    </div>

    <div class="tree-body">
      {#snippet renderNode(node: TreeNode, depth: number)}
        {@const isCollapsed = collapsed.has(node.id)}
        {@const gates = gatesFromJson(node.verification_json)}
        {@const hasChildren = node.children.length > 0}
        <div class="tree-node" style="--depth:{depth}">
          <div
            class="node-row"
            class:node-done={node.status === 'done'}
          >
            <div class="node-indent" style="width:{depth * 20}px"></div>

            {#if hasChildren}
              <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
              <span
                class="node-toggle"
                onclick={() => toggleNode(node.id)}
                role="button"
                tabindex="0"
                onkeydown={(e) => handleKeydown(e, node.id)}
                aria-label={isCollapsed ? 'Expand' : 'Collapse'}
              >{isCollapsed ? '▶' : '▼'}</span>
            {:else}
              <span class="node-toggle node-leaf">·</span>
            {/if}

            <a href="/tasks/{node.id}" class="node-link">
              <span class="node-id">{node.id}</span>
              <span class="node-status {statusClass(node.status)}">{statusIcon(node.status)}</span>
              <span class="node-title">{node.title}</span>
              <span class="node-priority {priorityClass(node.priority)}">{node.priority}</span>
              {#if node.pipeline_stage}
                <span class="node-stage">{node.pipeline_stage}</span>
              {/if}
              <div class="node-gates">
                <span class="ng" class:ng-pass={gates.i} title="Implemented">I</span>
                <span class="ng" class:ng-pass={gates.t} title="Tests">T</span>
                <span class="ng" class:ng-pass={gates.q} title="QA">Q</span>
              </div>
            </a>
          </div>

          {#if !isCollapsed && hasChildren}
            <div class="node-children">
              {#each node.children as child}
                {@render renderNode(child, depth + 1)}
              {/each}
            </div>
          {/if}
        </div>
      {/snippet}

      {@render renderNode(epic, 0)}
    </div>
  {:else}
    <div class="not-found">Epic not found</div>
  {/if}
</div>

<style>
  .tree-view {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    max-width: 1000px;
    margin: 0 auto;
  }

  .breadcrumb {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    font-size: 0.8125rem;
    color: #64748b;
  }

  .breadcrumb a {
    color: #64748b;
    text-decoration: none;
  }

  .breadcrumb a:hover {
    color: #a855f7;
  }

  .crumb-sep {
    color: #475569;
  }

  .crumb-current {
    color: #94a3b8;
  }

  /* Tree header */
  .tree-header {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    padding: 1rem;
    background: #1a1f2e;
    border: 1px solid #2d3748;
    border-radius: 8px;
  }

  .tree-title-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .epic-id-badge {
    font-size: 0.75rem;
    font-weight: 700;
    color: #a855f7;
    background: rgba(168, 85, 247, 0.1);
    padding: 0.15rem 0.5rem;
    border-radius: 4px;
  }

  .epic-type-badge {
    font-size: 0.7rem;
    color: #64748b;
    background: #1e2435;
    padding: 0.15rem 0.5rem;
    border-radius: 4px;
  }

  .epic-status {
    font-size: 0.75rem;
    font-weight: 600;
  }

  .epic-priority {
    font-size: 0.7rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .tree-title {
    font-size: 1.125rem;
    font-weight: 700;
    color: #f1f5f9;
    line-height: 1.4;
  }

  /* Tree stats */
  .tree-stats {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
  }

  .tree-progress-bar {
    height: 4px;
    background: #1e2435;
    border-radius: 2px;
    overflow: hidden;
  }

  .tree-done-fill {
    height: 100%;
    background: #22c55e;
    border-radius: 2px;
    transition: width 0.3s ease;
  }

  .tree-stat-row {
    display: flex;
    gap: 1rem;
    flex-wrap: wrap;
    font-size: 0.75rem;
  }

  .ts-done { color: #22c55e; }
  .ts-active { color: #3b82f6; }
  .ts-pending { color: #64748b; }
  .ts-archived { color: #374151; }
  .ts-total { color: #94a3b8; margin-left: auto; font-variant-numeric: tabular-nums; }

  /* Controls */
  .tree-controls {
    display: flex;
    gap: 0.5rem;
  }

  .tree-btn {
    padding: 0.25rem 0.75rem;
    border: 1px solid #2d3748;
    background: #0f1117;
    color: #94a3b8;
    border-radius: 4px;
    font-size: 0.75rem;
    cursor: pointer;
    transition: border-color 0.15s, color 0.15s;
  }

  .tree-btn:hover {
    border-color: #a855f7;
    color: #a855f7;
  }

  /* Tree body */
  .tree-body {
    background: #1a1f2e;
    border: 1px solid #2d3748;
    border-radius: 8px;
    overflow: hidden;
  }

  .tree-node {
    display: flex;
    flex-direction: column;
  }

  .node-row {
    display: flex;
    align-items: center;
    padding: 0.375rem 0.75rem 0.375rem 0;
    border-bottom: 1px solid #161b27;
    transition: background 0.1s;
    min-height: 36px;
  }

  .node-row:hover {
    background: #21273a;
  }

  .node-row.node-done {
    opacity: 0.6;
  }

  .node-indent {
    flex-shrink: 0;
  }

  .node-toggle {
    width: 20px;
    text-align: center;
    font-size: 0.6rem;
    color: #64748b;
    flex-shrink: 0;
    cursor: pointer;
    user-select: none;
  }

  .node-toggle:hover {
    color: #a855f7;
  }

  .node-leaf {
    color: #2d3748;
    cursor: default;
  }

  .node-link {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex: 1;
    min-width: 0;
    text-decoration: none;
    color: inherit;
  }

  .node-id {
    font-size: 0.675rem;
    color: #a855f7;
    font-weight: 600;
    flex-shrink: 0;
  }

  .node-status {
    font-size: 0.675rem;
    flex-shrink: 0;
  }

  .node-title {
    font-size: 0.8125rem;
    color: #e2e8f0;
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .node-priority {
    font-size: 0.625rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    flex-shrink: 0;
  }

  .node-stage {
    font-size: 0.625rem;
    color: #475569;
    background: #1e2435;
    padding: 0.1rem 0.3rem;
    border-radius: 2px;
    flex-shrink: 0;
  }

  .node-gates {
    display: flex;
    gap: 2px;
    flex-shrink: 0;
  }

  .ng {
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

  .ng.ng-pass {
    background: rgba(34, 197, 94, 0.12);
    color: #22c55e;
  }

  .node-children {
    border-left: 1px solid #1e2435;
    margin-left: 20px;
  }

  .not-found {
    padding: 2rem;
    text-align: center;
    color: #475569;
    font-size: 0.875rem;
  }

  /* Status colors */
  .sc-done { color: #22c55e; }
  .sc-active { color: #3b82f6; }
  .sc-blocked { color: #ef4444; }
  .sc-pending { color: #475569; }

  /* Priority colors */
  .pc-critical { color: #ef4444; }
  .pc-high { color: #f97316; }
  .pc-medium { color: #eab308; }
  .pc-low { color: #64748b; }
</style>
