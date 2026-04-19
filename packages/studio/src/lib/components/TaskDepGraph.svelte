<!--
  TaskDepGraph — focal-task dependency visualization for `/tasks/[id]`.

  Small ego graph showing the target task plus its 1-hop upstream
  (blockers) and 1-hop downstream (dependents).  Rewritten in Wave 1C
  of T990 to consume the shared {@link SvgRenderer} instead of the
  legacy sigma + graphology path — the two implementations now share
  one engine, token pipeline, and hover/label contract.

  Public prop API is preserved for its callers (`/tasks/[id]` detail
  page lives in Wave 1E).  The legacy `{ nodes, edges }` shape accepts
  a small superset of the upstream/downstream data previously passed;
  we project it into the shared graph kit shape internally.

  @module lib/components/TaskDepGraph
-->
<script lang="ts">
  import { goto } from '$app/navigation';

  import type {
    GraphEdge as KitGraphEdge,
    GraphNode as KitGraphNode,
  } from '$lib/graph/types.js';
  import SvgRenderer from '$lib/graph/renderers/SvgRenderer.svelte';

  /**
   * Legacy node shape accepted by this component.  Preserved so callers
   * don't have to migrate at the same time as the renderer swap.
   */
  export interface TaskDepNode {
    id: string;
    title: string;
    status: string;
    priority: string;
    type: string;
    isFocus: boolean;
  }

  /**
   * Legacy edge shape.  Assumed directional from `source → target`.
   */
  export interface TaskDepEdge {
    source: string;
    target: string;
  }

  interface Props {
    nodes: TaskDepNode[];
    edges: TaskDepEdge[];
    /** Panel height. Defaults to `260px` to match the previous layout. */
    height?: string;
  }

  let { nodes, edges, height = '260px' }: Props = $props();

  /**
   * Project the legacy inputs into the shared graph kit shape.  The
   * focal node is tagged via `meta.focal` so {@link SvgRenderer} applies
   * the accent halo.
   */
  const kitNodes = $derived<KitGraphNode[]>(
    nodes.map((n) => ({
      id: n.id,
      substrate: 'tasks' as const,
      kind: n.type || 'task',
      label: n.title,
      category: null,
      weight: n.isFocus ? 1 : 0.6,
      meta: {
        status: n.status,
        priority: n.priority,
        focal: n.isFocus,
      },
    })),
  );

  const kitEdges = $derived<KitGraphEdge[]>(
    edges
      .filter((e) => e.source !== e.target)
      .map((e, idx) => ({
        id: `dep-${idx}:${e.source}->${e.target}`,
        source: e.source,
        target: e.target,
        kind: 'depends' as const,
        directional: true,
        weight: 0.6,
      })),
  );

  function onNodeClick(n: KitGraphNode): void {
    void goto(`/tasks/${n.id}`);
  }
</script>

<div class="dep-graph-wrap" style="--dep-graph-height: {height};">
  {#if nodes.length === 0}
    <div class="dep-graph-empty">No dependencies</div>
  {:else}
    <SvgRenderer
      nodes={kitNodes}
      edges={kitEdges}
      showLabels="full"
      nodeRenderer="circle"
      onNodeClick={onNodeClick}
      ariaLabel="Task dependency neighbourhood"
    />
  {/if}
</div>

<style>
  .dep-graph-wrap {
    position: relative;
    width: 100%;
    height: var(--dep-graph-height, 260px);
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    overflow: hidden;
  }

  .dep-graph-empty {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--text-faint);
    font-size: var(--text-sm);
    pointer-events: none;
  }
</style>
