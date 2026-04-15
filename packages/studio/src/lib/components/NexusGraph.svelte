<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { goto } from '$app/navigation';
  import Graph from 'graphology';
  import Sigma from 'sigma';
  import forceAtlas2 from 'graphology-layout-forceatlas2';

  interface NodeData {
    id: string;
    label: string;
    kind?: string;
    size?: number;
    color?: string;
    /** For ego network: 0=center, 1=hop1, 2=hop2 */
    hop?: number;
    communityId?: string | null;
    filePath?: string;
    callerCount?: number;
  }

  interface EdgeData {
    source: string;
    target: string;
    type?: string;
  }

  interface Props {
    nodes: NodeData[];
    edges: EdgeData[];
    /** Navigate to this URL pattern on node click. :id replaced with node id. */
    drillDownBase?: string;
    /** Whether node IDs are community IDs (macro view). */
    isMacroView?: boolean;
    height?: string;
  }

  let {
    nodes,
    edges,
    drillDownBase = '',
    isMacroView = false,
    height = '100%',
  }: Props = $props();

  let container: HTMLDivElement;
  let sigmaInstance: Sigma | null = null;
  let tooltip = $state<{ label: string; kind: string; x: number; y: number } | null>(null);

  /** Color by node kind. */
  function kindColor(kind: string): string {
    const map: Record<string, string> = {
      function: '#3b82f6',
      method: '#06b6d4',
      class: '#8b5cf6',
      interface: '#10b981',
      type_alias: '#f59e0b',
      enum: '#ef4444',
      property: '#94a3b8',
      file: '#64748b',
      folder: '#475569',
      community: '#ec4899',
      process: '#f97316',
    };
    return map[kind] ?? '#64748b';
  }

  /** Compute node size from callerCount or explicit size prop. */
  function nodeSize(node: NodeData): number {
    if (node.size !== undefined) return node.size;
    const base = isMacroView ? 6 : 4;
    const callers = node.callerCount ?? 0;
    return base + Math.log1p(callers) * 2;
  }

  function buildGraph(): Graph {
    const graph = new Graph({ multi: false, allowSelfLoops: false });

    for (const node of nodes) {
      if (graph.hasNode(node.id)) continue;
      const color = node.color ?? kindColor(node.kind ?? 'function');
      const size = nodeSize(node);
      graph.addNode(node.id, {
        label: node.label,
        size,
        color,
        x: Math.random() * 800 - 400,
        y: Math.random() * 600 - 300,
        kind: node.kind ?? '',
        filePath: node.filePath ?? '',
        callerCount: node.callerCount ?? 0,
        hop: node.hop ?? 0,
      });
    }

    for (const edge of edges) {
      if (!graph.hasNode(edge.source) || !graph.hasNode(edge.target)) continue;
      if (graph.hasEdge(edge.source, edge.target)) continue;
      graph.addEdge(edge.source, edge.target, {
        color: 'rgba(148,163,184,0.25)',
        size: 0.8,
        type: edge.type ?? 'calls',
      });
    }

    return graph;
  }

  onMount(() => {
    if (!container) return;

    const graph = buildGraph();

    // Run ForceAtlas2 layout synchronously for initial placement.
    const nodeCount = graph.order;
    const iterations = Math.min(500, Math.max(100, 5000 / (nodeCount + 1)));
    if (nodeCount > 1) {
      forceAtlas2.assign(graph, {
        iterations,
        settings: {
          gravity: 1,
          scalingRatio: 2,
          strongGravityMode: false,
          barnesHutOptimize: nodeCount > 300,
        },
      });
    }

    sigmaInstance = new Sigma(graph, container, {
      renderEdgeLabels: false,
      defaultEdgeType: 'arrow',
      labelRenderedSizeThreshold: 8,
      labelFont: 'monospace',
      labelSize: 11,
      zIndex: true,
    });

    // Hover: show tooltip.
    sigmaInstance.on('enterNode', ({ node, event }) => {
      const attrs = graph.getNodeAttributes(node) as {
        label: string;
        kind: string;
        x: number;
        y: number;
      };
      const containerRect = container.getBoundingClientRect();
      tooltip = {
        label: attrs.label,
        kind: attrs.kind,
        x: event.x - containerRect.left,
        y: event.y - containerRect.top,
      };
      container.style.cursor = 'pointer';
    });

    sigmaInstance.on('leaveNode', () => {
      tooltip = null;
      container.style.cursor = 'default';
    });

    // Click: navigate to drill-down.
    sigmaInstance.on('clickNode', ({ node }) => {
      if (!drillDownBase) return;
      const target = drillDownBase.replace(':id', encodeURIComponent(node));
      void goto(target);
    });
  });

  onDestroy(() => {
    sigmaInstance?.kill();
    sigmaInstance = null;
  });
</script>

<div class="nexus-graph-wrap" style="height: {height}; position: relative;">
  <div class="nexus-graph-canvas" bind:this={container}></div>

  {#if tooltip}
    <div
      class="node-tooltip"
      style="left: {tooltip.x + 12}px; top: {tooltip.y + 12}px;"
      aria-hidden="true"
    >
      <span class="tooltip-label">{tooltip.label}</span>
      <span class="tooltip-kind">{tooltip.kind}</span>
    </div>
  {/if}

  {#if nodes.length === 0}
    <div class="empty-state">No data to display</div>
  {/if}
</div>

<style>
  .nexus-graph-wrap {
    width: 100%;
    background: #0f1117;
    border-radius: 8px;
    overflow: hidden;
    border: 1px solid #2d3748;
  }

  .nexus-graph-canvas {
    width: 100%;
    height: 100%;
  }

  .node-tooltip {
    position: absolute;
    pointer-events: none;
    background: #1a1f2e;
    border: 1px solid #3b4a63;
    border-radius: 6px;
    padding: 0.375rem 0.625rem;
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    z-index: 50;
    max-width: 260px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);
  }

  .tooltip-label {
    font-size: 0.8125rem;
    font-weight: 600;
    color: #f1f5f9;
    font-family: monospace;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .tooltip-kind {
    font-size: 0.6875rem;
    color: #64748b;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .empty-state {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #64748b;
    font-size: 0.875rem;
  }
</style>
