<script lang="ts">
  /**
   * TaskDepGraph — Mini sigma.js graph for task dependency/blocker visualization.
   *
   * Renders upstream (blockers) and downstream (dependents) of a focal task.
   * Node color encodes task status; focal task is highlighted larger.
   *
   * @module lib/components/TaskDepGraph
   */
  import { onMount, onDestroy } from 'svelte';
  import { goto } from '$app/navigation';
  import Graph from 'graphology';
  import Sigma from 'sigma';
  import forceAtlas2 from 'graphology-layout-forceatlas2';
  import { BASE_SIGMA_SETTINGS } from './sigma-defaults.js';

  interface GraphNode {
    id: string;
    title: string;
    status: string;
    priority: string;
    type: string;
    isFocus: boolean;
  }

  interface GraphEdge {
    source: string;
    target: string;
  }

  interface Props {
    nodes: GraphNode[];
    edges: GraphEdge[];
    height?: string;
  }

  let { nodes, edges, height = '260px' }: Props = $props();

  let container: HTMLDivElement | undefined = $state();
  let sigmaInstance: Sigma | null = null;
  let tooltip = $state<{ label: string; status: string; x: number; y: number } | null>(null);

  /** Map task status to a display color. */
  function statusColor(status: string, isFocus: boolean): string {
    if (isFocus) return '#a855f7'; // purple = focal node
    if (status === 'done') return '#22c55e';
    if (status === 'active') return '#3b82f6';
    if (status === 'blocked') return '#ef4444';
    return '#64748b'; // pending/default
  }

  function buildGraph(): Graph {
    const graph = new Graph({ multi: false, allowSelfLoops: false });

    for (const node of nodes) {
      if (graph.hasNode(node.id)) continue;
      graph.addNode(node.id, {
        label: node.id,
        size: node.isFocus ? 10 : 7,
        color: statusColor(node.status, node.isFocus),
        x: Math.random() * 600 - 300,
        y: Math.random() * 400 - 200,
        status: node.status,
        title: node.title,
        isFocus: node.isFocus,
      });
    }

    for (const edge of edges) {
      if (!graph.hasNode(edge.source) || !graph.hasNode(edge.target)) continue;
      if (edge.source === edge.target) continue;
      if (graph.hasEdge(edge.source, edge.target)) continue;
      graph.addEdge(edge.source, edge.target, {
        color: 'rgba(148,163,184,0.45)',
        size: 1.5,
        type: 'arrow',
      });
    }

    return graph;
  }

  onMount(() => {
    if (!container) return;

    const graph = buildGraph();

    if (graph.order > 1) {
      const iterations = Math.min(300, Math.max(80, 3000 / (graph.order + 1)));
      forceAtlas2.assign(graph, {
        iterations,
        settings: forceAtlas2.inferSettings(graph),
      });
    } else if (graph.order === 1) {
      // Single node — place at center
      graph.forEachNode((id) => {
        graph.setNodeAttribute(id, 'x', 0);
        graph.setNodeAttribute(id, 'y', 0);
      });
    }

    sigmaInstance = new Sigma(graph, container, {
      ...BASE_SIGMA_SETTINGS,
      labelRenderedSizeThreshold: 1,
      renderEdgeLabels: false,
    });

    sigmaInstance.on('enterNode', ({ node }) => {
      if (!container) return;
      const attrs = graph.getNodeAttributes(node);
      const cam = sigmaInstance!.getNodeDisplayData(node);
      if (cam) {
        const rect = container.getBoundingClientRect();
        tooltip = {
          label: `${node}: ${attrs.title as string}`,
          status: attrs.status as string,
          x: cam.x * rect.width,
          y: cam.y * rect.height,
        };
      }
    });

    sigmaInstance.on('leaveNode', () => {
      tooltip = null;
    });

    sigmaInstance.on('clickNode', ({ node }) => {
      void goto(`/tasks/${node}`);
    });
  });

  onDestroy(() => {
    sigmaInstance?.kill();
    sigmaInstance = null;
  });
</script>

<div class="dep-graph-wrap" style="height:{height}; position:relative;">
  <div class="dep-graph-canvas" bind:this={container} style="width:100%;height:100%;"></div>

  {#if nodes.length === 0}
    <div class="dep-graph-empty">No dependencies</div>
  {/if}

  {#if tooltip}
    <div
      class="dep-tooltip"
      style="left:{tooltip.x}px; top:{tooltip.y}px;"
    >
      <span class="dt-label">{tooltip.label}</span>
      <span class="dt-status dt-{tooltip.status}">{tooltip.status}</span>
    </div>
  {/if}
</div>

<style>
  .dep-graph-wrap {
    position: relative;
    background: #0f1117;
    border: 1px solid #2d3748;
    border-radius: 6px;
    overflow: hidden;
  }

  .dep-graph-canvas {
    display: block;
  }

  .dep-graph-empty {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #475569;
    font-size: 0.8125rem;
    pointer-events: none;
  }

  .dep-tooltip {
    position: absolute;
    transform: translate(-50%, -130%);
    background: #1a1f2e;
    border: 1px solid #2d3748;
    border-radius: 4px;
    padding: 0.25rem 0.5rem;
    pointer-events: none;
    white-space: nowrap;
    z-index: 10;
    display: flex;
    flex-direction: column;
    gap: 2px;
    max-width: 280px;
  }

  .dt-label {
    font-size: 0.7rem;
    color: #e2e8f0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .dt-status {
    font-size: 0.65rem;
    font-weight: 600;
  }

  .dt-done { color: #22c55e; }
  .dt-active { color: #3b82f6; }
  .dt-blocked { color: #ef4444; }
  .dt-pending { color: #64748b; }
</style>
