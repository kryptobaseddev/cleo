<script lang="ts">
  import type { PageData } from './$types';
  import type { TreeNode } from './+page.server.js';
  import TaskDepGraph from '$lib/components/TaskDepGraph.svelte';

  interface Props {
    data: PageData;
  }
  let { data }: Props = $props();

  const { epic, stats } = data;

  // Collapsed state: set of IDs that are collapsed
  let collapsed = $state<Set<string>>(new Set());

  // Side-panel state
  interface SidePanelData {
    taskId: string;
    title: string;
    status: string;
    nodes: Array<{ id: string; title: string; status: string; priority: string; type: string; isFocus: boolean }>;
    edges: Array<{ source: string; target: string }>;
    upstream: Array<{ id: string; title: string; status: string; priority: string }>;
    downstream: Array<{ id: string; title: string; status: string; priority: string }>;
    loading: boolean;
    error: string | null;
  }

  let sidePanel = $state<SidePanelData | null>(null);

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

  /** Open the dep side panel for a node. */
  async function openDeps(node: TreeNode, ev: MouseEvent): Promise<void> {
    ev.preventDefault();
    ev.stopPropagation();

    if (sidePanel?.taskId === node.id) {
      sidePanel = null;
      return;
    }

    sidePanel = {
      taskId: node.id,
      title: node.title,
      status: node.status,
      nodes: [],
      edges: [],
      upstream: [],
      downstream: [],
      loading: true,
      error: null,
    };

    try {
      const [graphRes, depsRes] = await Promise.all([
        fetch(`/api/tasks/graph?taskId=${encodeURIComponent(node.id)}`),
        fetch(`/api/tasks/${encodeURIComponent(node.id)}/deps`),
      ]);

      if (!graphRes.ok || !depsRes.ok) throw new Error('API error');

      const graphData = (await graphRes.json()) as {
        nodes: Array<{ id: string; title: string; status: string; priority: string; type: string; isFocus: boolean }>;
        edges: Array<{ source: string; target: string }>;
      };
      const depsData = (await depsRes.json()) as {
        upstream: Array<{ id: string; title: string; status: string; priority: string }>;
        downstream: Array<{ id: string; title: string; status: string; priority: string }>;
      };

      sidePanel = {
        taskId: node.id,
        title: node.title,
        status: node.status,
        nodes: graphData.nodes,
        edges: graphData.edges,
        upstream: depsData.upstream,
        downstream: depsData.downstream,
        loading: false,
        error: null,
      };
    } catch (err) {
      if (sidePanel) {
        sidePanel = { ...sidePanel, loading: false, error: String(err) };
      }
    }
  }

  function closePanel(): void {
    sidePanel = null;
  }
</script>

<svelte:head>
  <title>{epic?.id ?? 'Tree'} — CLEO Studio</title>
</svelte:head>

<div class="tree-view" class:has-panel={sidePanel !== null}>
  <nav class="breadcrumb">
    <a href="/tasks">Tasks</a>
    <span class="crumb-sep">›</span>
    <span class="crumb-current">Tree: {epic?.id ?? '...'}</span>
  </nav>

  <div class="tree-layout">
    <!-- Main tree column -->
    <div class="tree-main">
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
            {@const isActive = sidePanel?.taskId === node.id}
            <div class="tree-node" style="--depth:{depth}">
              <div
                class="node-row"
                class:node-done={node.status === 'done'}
                class:node-active-panel={isActive}
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

                <!-- Dep badges -->
                <div class="dep-badges">
                  {#if node.blockedByCount > 0}
                    <button
                      class="dep-badge dep-blocked"
                      title="{node.blockedByCount} upstream blocker{node.blockedByCount > 1 ? 's' : ''} — click to inspect"
                      onclick={(e) => openDeps(node, e)}
                      aria-label="Blocked by {node.blockedByCount} tasks"
                    >
                      ↑{node.blockedByCount}
                    </button>
                  {/if}
                  {#if node.blockingCount > 0}
                    <button
                      class="dep-badge dep-blocking"
                      title="Blocks {node.blockingCount} downstream task{node.blockingCount > 1 ? 's' : ''} — click to inspect"
                      onclick={(e) => openDeps(node, e)}
                      aria-label="Blocking {node.blockingCount} tasks"
                    >
                      ↓{node.blockingCount}
                    </button>
                  {/if}
                  {#if node.blockedByCount === 0 && node.blockingCount === 0}
                    <!-- no deps indicator — keep row height consistent -->
                  {/if}
                </div>
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

    <!-- Dep side panel -->
    {#if sidePanel}
      <aside class="dep-panel" aria-label="Dependency panel for {sidePanel.taskId}">
        <div class="dp-header">
          <div class="dp-title-row">
            <span class="dp-task-id">{sidePanel.taskId}</span>
            <span class="dp-task-status {statusClass(sidePanel.status)}">{statusIcon(sidePanel.status)}</span>
          </div>
          <div class="dp-task-title">{sidePanel.title}</div>
          <button class="dp-close" onclick={closePanel} aria-label="Close dep panel">✕</button>
        </div>

        {#if sidePanel.loading}
          <div class="dp-loading">Loading deps…</div>
        {:else if sidePanel.error}
          <div class="dp-error">{sidePanel.error}</div>
        {:else}
          <!-- Mini sigma graph -->
          <div class="dp-graph-section">
            <TaskDepGraph nodes={sidePanel.nodes} edges={sidePanel.edges} height="220px" />
            <div class="dp-legend">
              <span class="leg purple">■ selected</span>
              <span class="leg green">■ done</span>
              <span class="leg blue">■ active</span>
              <span class="leg gray">■ pending</span>
              <span class="leg red">■ blocked</span>
            </div>
          </div>

          <!-- Upstream blockers list -->
          {#if sidePanel.upstream.length > 0}
            <div class="dp-section">
              <div class="dp-section-title dep-blocked-title">
                ↑ Upstream blockers ({sidePanel.upstream.length})
              </div>
              <ul class="dp-task-list">
                {#each sidePanel.upstream as t}
                  <li class="dp-task-row">
                    <a href="/tasks/{t.id}" class="dp-task-link">
                      <span class="dp-tid">{t.id}</span>
                      <span class="dp-tstatus {statusClass(t.status)}">{statusIcon(t.status)}</span>
                      <span class="dp-ttitle">{t.title}</span>
                    </a>
                  </li>
                {/each}
              </ul>
            </div>
          {:else}
            <div class="dp-section">
              <div class="dp-section-title">↑ Upstream blockers</div>
              <div class="dp-empty">None — task is unblocked</div>
            </div>
          {/if}

          <!-- Downstream dependents list -->
          {#if sidePanel.downstream.length > 0}
            <div class="dp-section">
              <div class="dp-section-title dep-blocking-title">
                ↓ Downstream dependents ({sidePanel.downstream.length})
              </div>
              <ul class="dp-task-list">
                {#each sidePanel.downstream as t}
                  <li class="dp-task-row">
                    <a href="/tasks/{t.id}" class="dp-task-link">
                      <span class="dp-tid">{t.id}</span>
                      <span class="dp-tstatus {statusClass(t.status)}">{statusIcon(t.status)}</span>
                      <span class="dp-ttitle">{t.title}</span>
                    </a>
                  </li>
                {/each}
              </ul>
            </div>
          {:else}
            <div class="dp-section">
              <div class="dp-section-title">↓ Downstream dependents</div>
              <div class="dp-empty">None — nothing depends on this task</div>
            </div>
          {/if}

          <div class="dp-footer">
            <a href="/tasks/{sidePanel.taskId}" class="dp-full-link">Open full task →</a>
          </div>
        {/if}
      </aside>
    {/if}
  </div>
</div>

<style>
  .tree-view {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    max-width: 1000px;
    margin: 0 auto;
  }

  .tree-view.has-panel {
    max-width: 1400px;
  }

  .tree-layout {
    display: flex;
    gap: 1rem;
    align-items: flex-start;
  }

  .tree-main {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 1rem;
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
    padding: 0.375rem 0.5rem 0.375rem 0;
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

  .node-row.node-active-panel {
    background: rgba(168, 85, 247, 0.08);
    border-left: 2px solid #a855f7;
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
    overflow: hidden;
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

  /* Dep badges */
  .dep-badges {
    display: flex;
    gap: 3px;
    flex-shrink: 0;
    margin-left: 6px;
  }

  .dep-badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 22px;
    height: 16px;
    padding: 0 4px;
    border-radius: 3px;
    font-size: 0.6rem;
    font-weight: 700;
    border: none;
    cursor: pointer;
    transition: opacity 0.15s, transform 0.1s;
    font-family: monospace;
    line-height: 1;
  }

  .dep-badge:hover {
    opacity: 0.85;
    transform: scale(1.1);
  }

  .dep-blocked {
    background: rgba(239, 68, 68, 0.2);
    color: #ef4444;
    border: 1px solid rgba(239, 68, 68, 0.3);
  }

  .dep-blocking {
    background: rgba(234, 179, 8, 0.2);
    color: #eab308;
    border: 1px solid rgba(234, 179, 8, 0.3);
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

  /* Dep side panel */
  .dep-panel {
    width: 320px;
    flex-shrink: 0;
    background: #1a1f2e;
    border: 1px solid #2d3748;
    border-radius: 8px;
    display: flex;
    flex-direction: column;
    gap: 0;
    position: sticky;
    top: 1rem;
    max-height: calc(100vh - 2rem);
    overflow-y: auto;
  }

  .dp-header {
    padding: 0.75rem;
    border-bottom: 1px solid #2d3748;
    position: relative;
  }

  .dp-title-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.25rem;
  }

  .dp-task-id {
    font-size: 0.75rem;
    font-weight: 700;
    color: #a855f7;
    background: rgba(168, 85, 247, 0.1);
    padding: 0.1rem 0.4rem;
    border-radius: 3px;
  }

  .dp-task-status {
    font-size: 0.7rem;
  }

  .dp-task-title {
    font-size: 0.8rem;
    color: #94a3b8;
    line-height: 1.4;
    padding-right: 1.5rem;
  }

  .dp-close {
    position: absolute;
    top: 0.5rem;
    right: 0.5rem;
    background: none;
    border: none;
    color: #475569;
    cursor: pointer;
    font-size: 0.75rem;
    padding: 0.25rem;
    border-radius: 3px;
    line-height: 1;
    transition: color 0.15s;
  }

  .dp-close:hover {
    color: #94a3b8;
  }

  .dp-loading,
  .dp-error,
  .dp-empty {
    padding: 0.75rem;
    font-size: 0.75rem;
    color: #64748b;
  }

  .dp-error {
    color: #ef4444;
  }

  .dp-graph-section {
    padding: 0.5rem;
    border-bottom: 1px solid #2d3748;
  }

  .dp-legend {
    display: flex;
    flex-wrap: wrap;
    gap: 0.375rem;
    margin-top: 0.375rem;
    padding: 0 0.25rem;
  }

  .leg {
    font-size: 0.6rem;
    color: #64748b;
    display: flex;
    align-items: center;
    gap: 2px;
  }

  .leg.purple { color: #a855f7; }
  .leg.green { color: #22c55e; }
  .leg.blue { color: #3b82f6; }
  .leg.gray { color: #64748b; }
  .leg.red { color: #ef4444; }

  .dp-section {
    padding: 0.625rem 0.75rem;
    border-bottom: 1px solid #1e2435;
  }

  .dp-section:last-of-type {
    border-bottom: none;
  }

  .dp-section-title {
    font-size: 0.7rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-bottom: 0.375rem;
    color: #64748b;
  }

  .dep-blocked-title { color: #ef4444; }
  .dep-blocking-title { color: #eab308; }

  .dp-task-list {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .dp-task-row {
    display: flex;
  }

  .dp-task-link {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    text-decoration: none;
    color: inherit;
    padding: 0.25rem 0.375rem;
    border-radius: 4px;
    width: 100%;
    transition: background 0.1s;
    min-width: 0;
  }

  .dp-task-link:hover {
    background: #21273a;
  }

  .dp-tid {
    font-size: 0.65rem;
    font-weight: 600;
    color: #a855f7;
    flex-shrink: 0;
  }

  .dp-tstatus {
    font-size: 0.65rem;
    flex-shrink: 0;
  }

  .dp-ttitle {
    font-size: 0.75rem;
    color: #94a3b8;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
    min-width: 0;
  }

  .dp-footer {
    padding: 0.625rem 0.75rem;
    border-top: 1px solid #2d3748;
    margin-top: auto;
  }

  .dp-full-link {
    font-size: 0.75rem;
    color: #a855f7;
    text-decoration: none;
    display: block;
    text-align: center;
    padding: 0.375rem;
    border: 1px solid rgba(168, 85, 247, 0.3);
    border-radius: 4px;
    transition: background 0.15s;
  }

  .dp-full-link:hover {
    background: rgba(168, 85, 247, 0.1);
  }
</style>
