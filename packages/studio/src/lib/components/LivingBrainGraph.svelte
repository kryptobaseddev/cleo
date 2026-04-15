<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import Graph from 'graphology';
  import Sigma from 'sigma';
  import forceAtlas2 from 'graphology-layout-forceatlas2';
  import type { LBNode, LBEdge, LBSubstrate } from '$lib/server/living-brain/types.js';

  // ---------------------------------------------------------------------------
  // Props
  // ---------------------------------------------------------------------------

  interface Props {
    nodes: LBNode[];
    edges: LBEdge[];
    /** Fired when the user clicks a node. Passes the node ID. */
    onNodeClick?: (id: string) => void;
    height?: string;
  }

  let { nodes, edges, onNodeClick, height = '100%' }: Props = $props();

  // ---------------------------------------------------------------------------
  // Visual encoding maps
  // ---------------------------------------------------------------------------

  /** Substrate fill colour. */
  const SUBSTRATE_COLOR: Record<LBSubstrate, string> = {
    brain: '#3b82f6',
    nexus: '#22c55e',
    tasks: '#f97316',
    conduit: '#a855f7',
    signaldock: '#ef4444',
  };

  /** Edge type colour. */
  const EDGE_COLOR: Record<string, string> = {
    supersedes: '#ef4444',
    affects: '#3b82f6',
    applies_to: '#22c55e',
    calls: '#94a3b8',
    co_retrieved: '#a855f7',
    mentions: '#eab308',
    // fallback handled below
  };

  // ---------------------------------------------------------------------------
  // Refs and reactive state
  // ---------------------------------------------------------------------------

  let container: HTMLDivElement;
  let sigmaInstance: Sigma | null = null;

  let tooltip = $state<{
    label: string;
    kind: string;
    substrate: string;
    weight: number | undefined;
    x: number;
    y: number;
  } | null>(null);

  // ---------------------------------------------------------------------------
  // Helper: derive node size from weight (0–1) → sigma size (4–18)
  // ---------------------------------------------------------------------------
  function nodeSize(n: LBNode): number {
    const w = n.weight ?? 0.3;
    return 4 + w * 14;
  }

  // ---------------------------------------------------------------------------
  // Helper: edge colour with fallback
  // ---------------------------------------------------------------------------
  function edgeColor(type: string): string {
    return EDGE_COLOR[type] ?? 'rgba(148,163,184,0.3)';
  }

  // ---------------------------------------------------------------------------
  // Build graphology instance from LBNode[] / LBEdge[]
  // ---------------------------------------------------------------------------
  function buildGraph(): Graph {
    const g = new Graph({ multi: false, allowSelfLoops: false });

    for (const node of nodes) {
      if (g.hasNode(node.id)) continue;
      const color = SUBSTRATE_COLOR[node.substrate] ?? '#64748b';
      g.addNode(node.id, {
        label: node.label,
        size: nodeSize(node),
        color,
        x: Math.random() * 800 - 400,
        y: Math.random() * 600 - 300,
        kind: node.kind,
        substrate: node.substrate,
        weight: node.weight,
      });
    }

    for (const edge of edges) {
      if (!g.hasNode(edge.source) || !g.hasNode(edge.target)) continue;
      if (edge.source === edge.target) continue; // skip self-loops (allowSelfLoops: false)
      if (g.hasEdge(edge.source, edge.target)) continue;
      const thickness = Math.max(0.5, (edge.weight ?? 0.5) * 3);
      g.addEdge(edge.source, edge.target, {
        color: edgeColor(edge.type),
        size: thickness,
        edgeType: edge.type,
      });
    }

    return g;
  }

  // ---------------------------------------------------------------------------
  // Mount / destroy
  // ---------------------------------------------------------------------------
  onMount(() => {
    if (!container) return;

    const g = buildGraph();
    const nodeCount = g.order;

    if (nodeCount > 1) {
      const iterations = Math.min(500, Math.max(100, 5000 / (nodeCount + 1)));
      forceAtlas2.assign(g, {
        iterations,
        settings: {
          gravity: 1,
          scalingRatio: 2,
          strongGravityMode: false,
          barnesHutOptimize: nodeCount > 300,
        },
      });
    }

    sigmaInstance = new Sigma(g, container, {
      renderEdgeLabels: false,
      defaultEdgeType: 'arrow',
      labelRenderedSizeThreshold: 9,
      labelFont: 'monospace',
      labelSize: 11,
      zIndex: true,
    });

    // Hover — show tooltip
    sigmaInstance.on('enterNode', ({ node, event }) => {
      const attrs = g.getNodeAttributes(node) as {
        label: string;
        kind: string;
        substrate: string;
        weight: number | undefined;
      };
      const rect = container.getBoundingClientRect();
      tooltip = {
        label: attrs.label,
        kind: attrs.kind,
        substrate: attrs.substrate,
        weight: attrs.weight,
        x: event.x - rect.left,
        y: event.y - rect.top,
      };
      container.style.cursor = 'pointer';
    });

    sigmaInstance.on('leaveNode', () => {
      tooltip = null;
      container.style.cursor = 'default';
    });

    // Click — delegate to parent
    sigmaInstance.on('clickNode', ({ node }) => {
      onNodeClick?.(node);
    });
  });

  onDestroy(() => {
    sigmaInstance?.kill();
    sigmaInstance = null;
  });
</script>

<div class="lb-graph-wrap" style="height: {height}; position: relative;">
  <div class="lb-graph-canvas" bind:this={container}></div>

  {#if tooltip}
    <div
      class="lb-tooltip"
      style="left: {tooltip.x + 14}px; top: {tooltip.y + 14}px;"
      aria-hidden="true"
    >
      <span class="tt-label">{tooltip.label}</span>
      <div class="tt-meta">
        <span class="tt-kind">{tooltip.kind}</span>
        <span class="tt-sep">·</span>
        <span class="tt-substrate" data-substrate={tooltip.substrate}>{tooltip.substrate}</span>
        {#if tooltip.weight !== undefined}
          <span class="tt-sep">·</span>
          <span class="tt-weight">w={tooltip.weight.toFixed(2)}</span>
        {/if}
      </div>
    </div>
  {/if}

  {#if nodes.length === 0}
    <div class="lb-empty">No data to display</div>
  {/if}
</div>

<style>
  .lb-graph-wrap {
    width: 100%;
    background: #0a0d14;
    border-radius: 8px;
    overflow: hidden;
    border: 1px solid #2d3748;
  }

  .lb-graph-canvas {
    width: 100%;
    height: 100%;
  }

  .lb-tooltip {
    position: absolute;
    pointer-events: none;
    background: #1a1f2e;
    border: 1px solid #3b4a63;
    border-radius: 6px;
    padding: 0.4rem 0.7rem;
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    z-index: 50;
    max-width: 280px;
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.55);
  }

  .tt-label {
    font-size: 0.8125rem;
    font-weight: 600;
    color: #f1f5f9;
    font-family: monospace;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .tt-meta {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    font-size: 0.6875rem;
    color: #94a3b8;
    flex-wrap: wrap;
  }

  .tt-kind {
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: #64748b;
  }

  .tt-sep {
    color: #334155;
  }

  .tt-substrate[data-substrate='brain'] {
    color: #3b82f6;
  }
  .tt-substrate[data-substrate='nexus'] {
    color: #22c55e;
  }
  .tt-substrate[data-substrate='tasks'] {
    color: #f97316;
  }
  .tt-substrate[data-substrate='conduit'] {
    color: #a855f7;
  }
  .tt-substrate[data-substrate='signaldock'] {
    color: #ef4444;
  }

  .tt-weight {
    font-variant-numeric: tabular-nums;
    color: #64748b;
  }

  .lb-empty {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #64748b;
    font-size: 0.875rem;
  }
</style>
