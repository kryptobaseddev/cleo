<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import Graph from 'graphology';
  import Sigma from 'sigma';
  import { EdgeArrowProgram } from 'sigma/rendering';
  import type { NodeLabelDrawingFunction } from 'sigma/rendering';
  import forceAtlas2 from 'graphology-layout-forceatlas2';
  import type { LBNode, LBEdge, LBSubstrate } from '@cleocode/brain';
  import { livingBrainGraphStore } from '$lib/stores/living-brain-graph.js';

  // ---------------------------------------------------------------------------
  // Props
  // ---------------------------------------------------------------------------

  interface Props {
    nodes: LBNode[];
    edges: LBEdge[];
    /** Fired when the user clicks a node. Passes the node ID. */
    onNodeClick?: (id: string) => void;
    height?: string;
    /** Set of node IDs that are currently pulsing (new/updated). */
    pulsingNodes?: Set<string>;
    /** Set of edge keys (`${source}|${target}`) that are currently pulsing. */
    pulsingEdges?: Set<string>;
  }

  let {
    nodes,
    edges,
    onNodeClick,
    height = '100%',
    pulsingNodes = new Set<string>(),
    pulsingEdges = new Set<string>(),
  }: Props = $props();

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

  /**
   * Edge type colour map — covers ALL edge types emitted by the API
   * (T651 expanded the set significantly — keep this in sync).
   * Unknown types fall back to a slightly brighter gray than before so
   * cross-substrate bridges are still legible against the dark canvas.
   */
  const EDGE_COLOR: Record<string, string> = {
    // Memory provenance / supersession
    supersedes: '#ef4444',
    contradicts: '#dc2626',
    derived_from: '#f59e0b',
    produced_by: '#fb923c',
    informed_by: '#fbbf24',
    documents: '#10b981',
    summarizes: '#06b6d4',
    // Bridge edges (brain ↔ code / tasks / sessions)
    applies_to: '#22c55e',
    references: '#84cc16',
    code_reference: '#65a30d',
    modified_by: '#0ea5e9',
    affects: '#3b82f6',
    // Code edges
    calls: '#94a3b8',
    has_method: '#cbd5e1',
    has_property: '#94a3b8',
    extends: '#a78bfa',
    implements: '#c084fc',
    imports: '#7dd3fc',
    contains: '#64748b',
    // Workflow edges
    part_of: '#f97316',
    parent_of: '#fb923c',
    // Plastic edges (Hebbian / STDP)
    co_retrieved: '#a855f7',
    relates_to: '#a855f7',
    // Conduit / messaging
    mentions: '#eab308',
    messages: '#fbbf24',
    // fallback below
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
    // Fallback: brighter than 30% gray so unmapped types remain visible.
    // If you see a lot of these on the canvas, add the type to EDGE_COLOR.
    return EDGE_COLOR[type] ?? 'rgba(203,213,225,0.6)';
  }

  // ---------------------------------------------------------------------------
  // Helper: truncate long labels for display on canvas
  // ---------------------------------------------------------------------------

  /** Maximum label characters shown on-canvas; full label is in the tooltip. */
  const LABEL_MAX_CHARS = 24;

  /**
   * Truncates a label string to `max` characters, appending an ellipsis when
   * truncation is applied.
   *
   * @param s - The raw label string.
   * @param max - Maximum characters (default: 24).
   */
  function truncateLabel(s: string, max = LABEL_MAX_CHARS): string {
    return s.length > max ? `${s.slice(0, max - 1)}\u2026` : s;
  }

  // ---------------------------------------------------------------------------
  // Custom label renderer: white text on a semi-transparent dark pill
  // ---------------------------------------------------------------------------

  /**
   * Custom sigma node label drawing function that renders a rounded-rect
   * background behind the label text for readability on dark canvas backgrounds.
   * Labels are only drawn for nodes at or above the size threshold enforced by
   * sigma's label-density grid; this function is called only when sigma decides
   * a label should be visible.
   */
  const drawNodeLabel: NodeLabelDrawingFunction = (context, data, settings): void => {
    if (!data.label) return;

    const size: number = settings.labelSize;
    const font: string = settings.labelFont;
    const weight: string = settings.labelWeight;

    context.font = `${weight} ${size}px ${font}`;

    const label = data.label;
    const textWidth = context.measureText(label).width;

    // Pill dimensions
    const paddingH = 4;
    const paddingV = 2;
    const pillW = textWidth + paddingH * 2;
    const pillH = size + paddingV * 2;
    const pillX = data.x + data.size + 3;
    const pillY = data.y - size / 2 - paddingV;

    // Dark background pill
    context.fillStyle = 'rgba(10, 13, 20, 0.82)';
    context.beginPath();
    if (context.roundRect) {
      context.roundRect(pillX, pillY, pillW, pillH, 3);
    } else {
      // Fallback for environments without roundRect
      context.rect(pillX, pillY, pillW, pillH);
    }
    context.fill();

    // White label text
    context.fillStyle = '#f1f5f9';
    context.fillText(label, pillX + paddingH, data.y + size / 3);
  };

  // ---------------------------------------------------------------------------
  // Pulse duration constant (ms)
  // ---------------------------------------------------------------------------

  /** How long a pulse animation lasts in milliseconds (ease-out fade). */
  const PULSE_DURATION_MS = 1_500;

  // ---------------------------------------------------------------------------
  // Build graphology instance from LBNode[] / LBEdge[]
  // ---------------------------------------------------------------------------
  function buildGraph(): Graph {
    const g = new Graph({ multi: false, allowSelfLoops: false });

    const now = Date.now();

    for (const node of nodes) {
      if (g.hasNode(node.id)) continue;
      const isPulsing = pulsingNodes.has(node.id);
      const baseColor = SUBSTRATE_COLOR[node.substrate] ?? '#64748b';
      // Pulsing nodes get a larger size and brighter (full-opacity white-blend) color
      const color = isPulsing ? '#ffffff' : baseColor;
      const size = isPulsing ? nodeSize(node) * 2 : nodeSize(node);
      g.addNode(node.id, {
        label: truncateLabel(node.label),
        size,
        color,
        x: Math.random() * 800 - 400,
        y: Math.random() * 600 - 300,
        kind: node.kind,
        substrate: node.substrate,
        weight: node.weight,
        fullLabel: node.label,
        pulseUntil: isPulsing ? now + PULSE_DURATION_MS : null,
      });
    }

    for (const edge of edges) {
      if (!g.hasNode(edge.source) || !g.hasNode(edge.target)) continue;
      if (edge.source === edge.target) continue; // skip self-loops (allowSelfLoops: false)
      if (g.hasEdge(edge.source, edge.target)) continue;
      const edgeKey = `${edge.source}|${edge.target}`;
      const isPulsing = pulsingEdges.has(edgeKey);
      const baseThickness = Math.max(0.5, (edge.weight ?? 0.5) * 3);
      g.addEdge(edge.source, edge.target, {
        color: isPulsing ? '#ffffff' : edgeColor(edge.type),
        size: isPulsing ? baseThickness * 2.5 : baseThickness,
        edgeType: edge.type,
        pulseUntil: isPulsing ? now + PULSE_DURATION_MS : null,
      });
    }

    return g;
  }

  // ---------------------------------------------------------------------------
  // Apply pulse visuals to an existing graph (called when pulsingNodes/Edges
  // props change without a full re-mount)
  // ---------------------------------------------------------------------------

  /**
   * Updates node and edge attributes in the live graphology instance to
   * reflect the current `pulsingNodes` and `pulsingEdges` prop values.
   *
   * @param g - The live graphology graph to mutate.
   */
  function applyPulses(g: Graph): void {
    const now = Date.now();

    for (const nodeId of pulsingNodes) {
      if (!g.hasNode(nodeId)) continue;
      const attrs = g.getNodeAttributes(nodeId) as {
        substrate: LBSubstrate;
        weight: number | undefined;
        size: number;
        color: string;
        label: string;
        kind: string;
        x: number;
        y: number;
        pulseUntil: number | null;
      };
      const baseColor = SUBSTRATE_COLOR[attrs.substrate] ?? '#64748b';
      // Build a synthetic node for size calculation
      const syntheticNode: LBNode = {
        id: nodeId,
        kind: attrs.kind as LBNode['kind'],
        substrate: attrs.substrate,
        label: attrs.label,
        weight: attrs.weight,
        createdAt: null,
        meta: {},
      };
      g.setNodeAttribute(nodeId, 'color', '#ffffff');
      g.setNodeAttribute(nodeId, 'size', nodeSize(syntheticNode) * 2);
      g.setNodeAttribute(nodeId, 'pulseUntil', now + PULSE_DURATION_MS);

      // Schedule reset after pulse duration
      setTimeout(() => {
        if (!g.hasNode(nodeId)) return;
        g.setNodeAttribute(nodeId, 'color', baseColor);
        g.setNodeAttribute(nodeId, 'size', nodeSize(syntheticNode));
        g.setNodeAttribute(nodeId, 'pulseUntil', null);
        sigmaInstance?.refresh();
      }, PULSE_DURATION_MS);
    }

    for (const edgeKey of pulsingEdges) {
      const [src, tgt] = edgeKey.split('|');
      if (!src || !tgt || !g.hasEdge(src, tgt)) continue;
      const attrs = g.getEdgeAttributes(g.edge(src, tgt)) as {
        edgeType: string;
        size: number;
        color: string;
        pulseUntil: number | null;
      };
      const baseColor = edgeColor(attrs.edgeType);
      const baseSize = attrs.size;
      g.setEdgeAttribute(g.edge(src, tgt), 'color', '#ffffff');
      g.setEdgeAttribute(g.edge(src, tgt), 'size', baseSize * 2.5);
      g.setEdgeAttribute(g.edge(src, tgt), 'pulseUntil', now + PULSE_DURATION_MS);

      setTimeout(() => {
        if (!g.hasNode(src) || !g.hasNode(tgt) || !g.hasEdge(src, tgt)) return;
        g.setEdgeAttribute(g.edge(src, tgt), 'color', baseColor);
        g.setEdgeAttribute(g.edge(src, tgt), 'size', baseSize);
        g.setEdgeAttribute(g.edge(src, tgt), 'pulseUntil', null);
        sigmaInstance?.refresh();
      }, PULSE_DURATION_MS);
    }

    sigmaInstance?.refresh();
  }

  // ---------------------------------------------------------------------------
  // Initialise sigma with the current graph data
  // ---------------------------------------------------------------------------

  /**
   * Builds a new graphology graph, runs ForceAtlas2 layout, then creates a
   * fresh Sigma instance. Any existing Sigma instance is killed first.
   * Updates the shared graph context so other renderers can consume it.
   */
  function initSigma(): void {
    if (!container) return;

    // Kill existing instance before rebuilding (handles prop-change re-init)
    if (sigmaInstance) {
      sigmaInstance.kill();
      sigmaInstance = null;
    }

    const g = buildGraph();
    const nodeCount = g.order;

    // Update shared graph store so other renderers (e.g., LivingBrain3D) can read layout data
    livingBrainGraphStore.set(g);

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
      labelWeight: '500',
      labelColor: { color: '#f1f5f9' },
      defaultDrawNodeLabel: drawNodeLabel,
      zIndex: true,
      edgeProgramClasses: { arrow: EdgeArrowProgram },
    });

    // Hover — show tooltip
    sigmaInstance.on('enterNode', ({ node, event }) => {
      const attrs = g.getNodeAttributes(node) as {
        fullLabel: string;
        kind: string;
        substrate: string;
        weight: number | undefined;
      };
      const rect = container.getBoundingClientRect();
      tooltip = {
        label: attrs.fullLabel,
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
  }

  // ---------------------------------------------------------------------------
  // Mount / destroy
  // ---------------------------------------------------------------------------
  onMount(() => {
    initSigma();
  });

  onDestroy(() => {
    sigmaInstance?.kill();
    sigmaInstance = null;
  });

  // React to nodes/edges prop changes — rebuild the graph entirely
  $effect(() => {
    // Access reactive props to register dependencies
    const _n = nodes;
    const _e = edges;
    if (sigmaInstance) {
      initSigma();
    }
  });

  // React to new pulses pushed from the parent page
  $effect(() => {
    if (!sigmaInstance) return;
    const g = sigmaInstance.getGraph();
    if (pulsingNodes.size > 0 || pulsingEdges.size > 0) {
      applyPulses(g);
    }
  });

  // Clean up store on unmount
  onDestroy(() => {
    livingBrainGraphStore.set(null);
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
