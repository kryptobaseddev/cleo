<!--
  CosmosRenderer — WebGL2 graph canvas built on @cosmograph/cosmos v2.

  Honours the no-face-up guard: zero leaf-level labels on the canvas.
  Hover reveals the node's label through a `<HoverLabel>` anchored in
  screen coordinates. Community captions appear through
  `<ClusterLabelLayer>`; structural nodes get a tint per kind and
  cluster members colour-by-community (cosmos cluster palette cycle).

  @task T990
  @wave 1B
-->
<script lang="ts">
  import { onDestroy, onMount, untrack } from 'svelte';
  import { Graph as CosmosGraph } from '@cosmograph/cosmos';
  import type { GraphConfigInterface } from '@cosmograph/cosmos';

  import { ALL_EDGE_KINDS, EDGE_STYLE, resolveEdgeStyleForWebGL, invalidateEdgeStyleCache } from '../edge-kinds.js';
  import type { EdgeKind, GraphCluster, GraphEdge, GraphNode } from '../types.js';
  import { assertNoFaceUp } from '../no-face-up.js';
  import HoverLabel from '../hover-label.svelte';
  import ClusterLabelLayer, { type ClusterLabelPoint } from '../cluster-label-layer.svelte';

  /**
   * Props consumed by the macro / community / ego / flow views.
   */
  interface Props {
    /** Graph nodes — must include a stable id for every entry. */
    nodes: GraphNode[];
    /** Graph edges — invalid endpoints are dropped silently. */
    edges: GraphEdge[];
    /** Optional cluster registry for the caption layer. */
    clusters?: GraphCluster[];
    /** Edge kinds currently rendered. Absent kinds fade to zero alpha. */
    visibleEdgeKinds?: Set<EdgeKind>;
    /** Node kinds currently rendered. Absent kinds fade to zero alpha. */
    visibleNodeKinds?: Set<string>;
    /** Node id to focus (camera pan + selection ring). */
    highlightNodeId?: string | null;
    /** Called when the user pointer enters / exits a node. */
    onNodeHover?: (node: GraphNode | null) => void;
    /** Click handler — receives the full node object. */
    onNodeClick?: (node: GraphNode) => void;
    /** Show the cluster-caption overlay. Default: true. */
    showClusterLabels?: boolean;
    /**
     * Explicit reduced-motion toggle. When omitted, the component
     * reads `prefers-reduced-motion` at mount and on change.
     */
    reducedMotion?: boolean;
    /** Canvas height. Default `100%`. */
    height?: string;
    /** Fired when the renderer fails to initialise (WebGL2 unavailable). */
    onInitFailed?: (reason: string) => void;
    /**
     * Optional base alpha for non-highlighted nodes/edges.  Useful for
     * the ego view to dim hop-2 while staying visible.
     */
    baseAlpha?: number;
  }

  let {
    nodes,
    edges,
    clusters = [],
    visibleEdgeKinds,
    visibleNodeKinds,
    highlightNodeId = null,
    onNodeHover,
    onNodeClick,
    showClusterLabels = true,
    reducedMotion,
    height = '100%',
    onInitFailed,
    baseAlpha = 0.85,
  }: Props = $props();

  // ---------------------------------------------------------------
  // Refs + reactive state
  // ---------------------------------------------------------------

  let container: HTMLDivElement;
  // Reactive only because the template reads `cosmos` to gate the
  // ClusterLabelLayer / HoverLabel panels.  Imperative mutations
  // continue to write through `cosmos = ...`.
  let cosmos: CosmosGraph | null = $state(null);
  let indexToId: string[] = [];
  let idToIndex = new Map<string, number>();
  let linkIndexByKey = new Map<string, number>();

  let hovered = $state<GraphNode | null>(null);
  let hoverX = $state(0);
  let hoverY = $state(0);
  let hoverSecondary = $state<string | null>(null);
  let clusterPoints = $state<ClusterLabelPoint[]>([]);
  let currentZoom = $state(1);
  let initFailureReason = $state<string | null>(null);

  // ---------------------------------------------------------------
  // Palette helpers
  // ---------------------------------------------------------------

  /**
   * Structural node colour table — reads semantic tokens at runtime via
   * the same dispatch as edge-kinds.ts, so theme swaps flow through.
   */
  const KIND_CSS_VAR: Record<string, string> = {
    project: 'var(--accent)',
    package: 'var(--accent)',
    module: 'var(--accent)',
    folder: 'var(--text-dim)',
    file: 'var(--info)',
    namespace: 'var(--accent)',
    class: 'var(--warning)',
    struct: 'var(--warning)',
    interface: 'var(--priority-critical)',
    trait: 'var(--priority-critical)',
    enum: 'var(--warning)',
    function: 'var(--success)',
    method: 'var(--success)',
    type_alias: 'var(--accent)',
    typedef: 'var(--accent)',
    property: 'var(--text-dim)',
    variable: 'var(--text-dim)',
    const: 'var(--text-dim)',
    community: 'var(--accent)',
    process: 'var(--priority-critical)',
    route: 'var(--priority-critical)',
    tool: 'var(--accent)',
  };

  /**
   * Cluster palette — 12-colour cycle of tokenised semantic hues. No
   * hex. All tokens already live in tokens.css.
   */
  const CLUSTER_CSS_CYCLE: readonly string[] = [
    'var(--info)',
    'var(--accent)',
    'var(--success)',
    'var(--warning)',
    'var(--danger)',
    'var(--priority-critical)',
    'color-mix(in srgb, var(--info) 60%, var(--accent) 40%)',
    'color-mix(in srgb, var(--success) 50%, var(--info) 50%)',
    'color-mix(in srgb, var(--warning) 60%, var(--danger) 40%)',
    'color-mix(in srgb, var(--accent) 70%, white 30%)',
    'color-mix(in srgb, var(--info) 40%, var(--priority-critical) 60%)',
    'color-mix(in srgb, var(--success) 40%, var(--warning) 60%)',
  ];

  /** Stable per-category colour mapping, derived on data change. */
  let categoryColor = new Map<string, string>();

  /**
   * Per-category colour picker. Re-runs deterministically whenever the
   * ordered list of categories changes.
   */
  function assignCategoryColors(): void {
    categoryColor = new Map<string, string>();
    const seen: string[] = [];
    for (const node of nodes) {
      const cat = node.category ?? null;
      if (cat === null) continue;
      if (!categoryColor.has(cat)) {
        seen.push(cat);
        const colour = CLUSTER_CSS_CYCLE[(seen.length - 1) % CLUSTER_CSS_CYCLE.length];
        categoryColor.set(cat, colour);
      }
    }
  }

  /**
   * Probe a CSS colour expression through `document`'s computed style
   * machinery to obtain a concrete `[r,g,b]` 0-1 triplet. Reuses the
   * same helper shape as `edge-kinds.ts` but lives locally because we
   * do not want to export a public WebGL-node-colour function yet.
   */
  function probeRgb(cssExpr: string): [number, number, number] {
    if (typeof document === 'undefined') return [0.5, 0.5, 0.5];
    const probe = document.createElement('span');
    probe.style.color = cssExpr;
    probe.style.position = 'absolute';
    probe.style.visibility = 'hidden';
    probe.style.pointerEvents = 'none';
    document.body.appendChild(probe);
    const computed = window.getComputedStyle(probe).color;
    document.body.removeChild(probe);
    const match = /rgba?\(([^)]+)\)/i.exec(computed);
    if (!match) return [1, 1, 1];
    const parts = match[1].split(/[,\s/]+/).filter((p) => p.length > 0);
    if (parts.length < 3) return [1, 1, 1];
    const r = Number.parseFloat(parts[0]);
    const g = Number.parseFloat(parts[1]);
    const b = Number.parseFloat(parts[2]);
    return [r / 255, g / 255, b / 255];
  }

  /**
   * Resolve the per-node colour — category tint wins for symbol kinds
   * in a cluster; structural kinds keep their KIND palette.
   */
  function resolveNodeRgb(node: GraphNode): [number, number, number] {
    const isSymbol = [
      'function',
      'method',
      'class',
      'interface',
      'trait',
      'struct',
      'enum',
      'type_alias',
      'typedef',
      'property',
      'variable',
      'const',
    ].includes(node.kind);
    if (isSymbol && node.category) {
      const expr = categoryColor.get(node.category);
      if (expr) return probeRgb(expr);
    }
    return probeRgb(KIND_CSS_VAR[node.kind] ?? 'var(--text-dim)');
  }

  /** Simple log-scaled size for a single node. */
  function resolveNodeSize(node: GraphNode): number {
    const w = node.weight ?? 0.3;
    const base =
      node.kind === 'project' ? 22 :
      node.kind === 'package' ? 18 :
      node.kind === 'module' ? 14 :
      node.kind === 'folder' ? 11 :
      node.kind === 'community' ? 14 :
      node.kind === 'class' || node.kind === 'struct' ? 9 :
      node.kind === 'interface' || node.kind === 'trait' ? 8 :
      node.kind === 'enum' ? 7 :
      node.kind === 'file' ? 6 :
      node.kind === 'function' || node.kind === 'constructor' ? 5 :
      node.kind === 'method' ? 4 :
      3;
    return base + w * 6;
  }

  // ---------------------------------------------------------------
  // Float32 buffer builders
  // ---------------------------------------------------------------

  /**
   * Pack the current node + edge arrays into the flat Float32Arrays
   * cosmos expects.  Also returns the idToIndex map so callers (hover,
   * focus, highlight) can translate back and forth.
   */
  function buildBuffers(): {
    positions: Float32Array;
    colors: Float32Array;
    sizes: Float32Array;
    links: Float32Array;
    linkColors: Float32Array;
    linkWidths: Float32Array;
    linkArrows: boolean[];
    idxToId: string[];
    idToIdx: Map<string, number>;
    linkKey: Map<string, number>;
    clusterAssignments: (number | undefined)[];
    clusterPositions: (number | undefined)[];
  } {
    const idToIdx = new Map<string, number>();
    const idxToId: string[] = [];
    nodes.forEach((n, i) => {
      idToIdx.set(n.id, i);
      idxToId.push(n.id);
    });

    // Positions — cosmos simulates from a random start.  We scatter
    // in a circle so the initial frame isn't a vertical bar.
    const positions = new Float32Array(nodes.length * 2);
    for (let i = 0; i < nodes.length; i++) {
      const a = (i / Math.max(1, nodes.length)) * Math.PI * 2;
      const r = 40 + Math.random() * 160;
      positions[i * 2] = Math.cos(a) * r;
      positions[i * 2 + 1] = Math.sin(a) * r;
    }

    // Per-node colours
    const colors = new Float32Array(nodes.length * 4);
    const sizes = new Float32Array(nodes.length);
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      const [r, g, b] = resolveNodeRgb(node);
      const kindVisible = !visibleNodeKinds || visibleNodeKinds.has(node.kind);
      const alpha = kindVisible ? baseAlpha : 0;
      colors[i * 4] = r;
      colors[i * 4 + 1] = g;
      colors[i * 4 + 2] = b;
      colors[i * 4 + 3] = alpha;
      sizes[i] = resolveNodeSize(node);
    }

    // Cluster assignments — map every node that has a category to a
    // deterministic cluster index.  Cosmos uses this for cluster-force
    // (tighter radial binding).
    const categoryToClusterIdx = new Map<string, number>();
    const clusterAssignments: (number | undefined)[] = new Array(nodes.length);
    for (let i = 0; i < nodes.length; i++) {
      const cat = nodes[i].category ?? null;
      if (cat === null) {
        clusterAssignments[i] = undefined;
        continue;
      }
      if (!categoryToClusterIdx.has(cat)) {
        categoryToClusterIdx.set(cat, categoryToClusterIdx.size);
      }
      clusterAssignments[i] = categoryToClusterIdx.get(cat);
    }

    // Cluster positions — golden-angle ring so categories don't collapse.
    const clusterCount = categoryToClusterIdx.size;
    const clusterPositions: (number | undefined)[] = [];
    if (clusterCount > 0) {
      const radius = Math.max(120, 40 * Math.sqrt(clusterCount));
      const golden = Math.PI * (3 - Math.sqrt(5));
      // setClusterPositions expects alternating x,y pairs OR undefined pairs.
      let idx = 0;
      for (const _cat of categoryToClusterIdx.keys()) {
        const a = idx * golden;
        const r = radius * Math.sqrt((idx + 1) / clusterCount);
        clusterPositions.push(Math.cos(a) * r);
        clusterPositions.push(Math.sin(a) * r);
        idx++;
      }
    }

    // Edges → flat link buffers.
    const linkIndices: number[] = [];
    const linkColorArr: number[] = [];
    const linkWidths: number[] = [];
    const linkArrows: boolean[] = [];
    const linkKey = new Map<string, number>();

    let linkI = 0;
    for (const edge of edges) {
      const s = idToIdx.get(edge.source);
      const t = idToIdx.get(edge.target);
      if (s === undefined || t === undefined) continue;
      if (s === t) continue;
      const kindVisible = !visibleEdgeKinds || visibleEdgeKinds.has(edge.kind);
      if (!kindVisible) continue;

      const style = EDGE_STYLE[edge.kind];
      const [r, g, b] = resolveEdgeStyleForWebGL(edge.kind);
      const a = 0.68;
      linkIndices.push(s, t);
      linkColorArr.push(r, g, b, a);
      const w = 0.5 + (edge.weight ?? 0.4) * 1.2;
      linkWidths.push(Math.max(0.4, w * style.thickness));
      linkArrows.push(edge.directional ?? style.arrow ?? false);
      linkKey.set(edge.id, linkI);
      linkI++;
    }

    return {
      positions,
      colors,
      sizes,
      links: new Float32Array(linkIndices),
      linkColors: new Float32Array(linkColorArr),
      linkWidths: new Float32Array(linkWidths),
      linkArrows,
      idxToId,
      idToIdx,
      linkKey,
      clusterAssignments,
      clusterPositions,
    };
  }

  // ---------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------

  let mounted = false;
  const RM_QUERY = '(prefers-reduced-motion: reduce)';

  /**
   * Detect reduced-motion preference — used both to seed the prop
   * default and to respond to media-query changes at runtime.
   */
  function prefersReducedMotion(): boolean {
    if (typeof window === 'undefined') return false;
    if (typeof reducedMotion === 'boolean') return reducedMotion;
    return window.matchMedia(RM_QUERY).matches;
  }

  onMount(() => {
    assignCategoryColors();
    invalidateEdgeStyleCache();
    try {
      assertNoFaceUp({ drawLabels: false });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      initFailureReason = message;
      onInitFailed?.(message);
      return;
    }

    if (!container) return;

    // WebGL2 probe — fallback gracefully if unavailable.
    const probeCanvas = document.createElement('canvas');
    const probeGl = probeCanvas.getContext('webgl2');
    if (!probeGl) {
      initFailureReason = 'WebGL2 is not available on this browser.';
      onInitFailed?.(initFailureReason);
      return;
    }

    const rm = prefersReducedMotion();

    try {
      // Resolve token-driven defaults once per init so the cosmos
      // config never carries a hard-coded hex literal.
      const defaultPointRgb = probeRgb('var(--text-dim)');
      const defaultLinkRgb = probeRgb('var(--text-faint)');
      const accentRgb = probeRgb('var(--accent)');
      const textRgb = probeRgb('var(--text)');
      const to255 = (v: number): number => Math.round(v * 255);
      const pointDefault: [number, number, number, number] = [
        to255(defaultPointRgb[0]),
        to255(defaultPointRgb[1]),
        to255(defaultPointRgb[2]),
        255,
      ];
      const linkDefault: [number, number, number, number] = [
        to255(defaultLinkRgb[0]),
        to255(defaultLinkRgb[1]),
        to255(defaultLinkRgb[2]),
        255,
      ];
      const hoverRingRgba: [number, number, number, number] = [
        to255(accentRgb[0]),
        to255(accentRgb[1]),
        to255(accentRgb[2]),
        255,
      ];
      const focusRingRgba: [number, number, number, number] = [
        to255(textRgb[0]),
        to255(textRgb[1]),
        to255(textRgb[2]),
        255,
      ];

      const config: GraphConfigInterface = {
        backgroundColor: [0, 0, 0, 0],
        spaceSize: 4096,
        pointColor: pointDefault,
        pointSize: 6,
        pointSizeScale: 1,
        pointGreyoutOpacity: 0.08,
        renderLinks: true,
        linkColor: linkDefault,
        linkWidth: 1,
        linkWidthScale: 1,
        linkGreyoutOpacity: 0.08,
        linkArrows: true,
        linkArrowsSizeScale: 0.8,
        linkVisibilityDistanceRange: [40, 160],
        linkVisibilityMinTransparency: 0.35,
        curvedLinks: true,
        curvedLinkWeight: 0.75,
        curvedLinkControlPointDistance: 0.35,
        hoveredPointCursor: 'pointer',
        renderHoveredPointRing: true,
        hoveredPointRingColor: hoverRingRgba,
        focusedPointRingColor: focusRingRgba,
        scalePointsOnZoom: true,
        simulationGravity: rm ? 0 : 0.18,
        simulationRepulsion: rm ? 0 : 1.3,
        simulationLinkSpring: rm ? 0 : 1.1,
        simulationLinkDistance: 14,
        simulationFriction: 0.86,
        simulationCluster: rm ? 0 : 0.25,
        simulationDecay: rm ? 1 : 3000,
        enableSimulation: !rm,
        enableDrag: true,
        enableZoom: true,
        fitViewOnInit: true,
        fitViewPadding: 0.12,
        fitViewDuration: 350,
        showFPSMonitor: false,
        pixelRatio: Math.min(2, window.devicePixelRatio || 1),
        onClick: (index) => {
          if (index === undefined) return;
          const id = indexToId[index];
          const node = nodes.find((n) => n.id === id);
          if (node) onNodeClick?.(node);
        },
        onPointMouseOver: (index, pos, _ev) => {
          const id = indexToId[index];
          const node = nodes.find((n) => n.id === id);
          if (!node || !cosmos || !container) return;
          hovered = node;
          const screen = cosmos.spaceToScreenPosition(pos);
          hoverX = screen[0];
          hoverY = screen[1];
          hoverSecondary =
            (typeof node.meta?.filePath === 'string' && node.meta.filePath) || null;
          onNodeHover?.(node);
        },
        onPointMouseOut: () => {
          hovered = null;
          hoverSecondary = null;
          onNodeHover?.(null);
        },
        onZoom: (event) => {
          if (event && event.transform) {
            currentZoom = event.transform.k;
          } else if (cosmos) {
            currentZoom = cosmos.getZoomLevel();
          }
          recomputeClusterPoints();
        },
        onSimulationTick: () => {
          recomputeClusterPoints();
        },
        onSimulationEnd: () => {
          recomputeClusterPoints();
        },
      };

      cosmos = new CosmosGraph(container, config);
      syncData();
      mounted = true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      initFailureReason = `Failed to initialise cosmos: ${message}`;
      onInitFailed?.(initFailureReason);
    }
  });

  onDestroy(() => {
    if (cosmos) {
      try {
        cosmos.destroy();
      } catch {
        // cosmos already destroyed — ignore.
      }
      cosmos = null;
    }
  });

  // ---------------------------------------------------------------
  // Reactive updates — push new buffers whenever data / filters change
  // ---------------------------------------------------------------

  $effect(() => {
    // Read dependencies to subscribe.
    // Use void to avoid unused-expression lint; trigger on reference.
    void nodes.length;
    void edges.length;
    void visibleEdgeKinds;
    void visibleNodeKinds;
    void baseAlpha;
    if (!mounted) return;
    untrack(() => {
      syncData();
    });
  });

  $effect(() => {
    void highlightNodeId;
    if (!mounted || !cosmos) return;
    const id = highlightNodeId;
    if (!id) return;
    const idx = idToIndex.get(id);
    if (typeof idx === 'number') {
      untrack(() => {
        cosmos?.setFocusedPointByIndex(idx);
        cosmos?.zoomToPointByIndex(idx, 600, 3, false);
      });
    }
  });

  /**
   * Full data refresh path — rebuild buffers, push to cosmos, restart
   * simulation for a short pulse, then settle.
   */
  function syncData(): void {
    if (!cosmos) return;
    assignCategoryColors();
    const buffers = buildBuffers();
    indexToId = buffers.idxToId;
    idToIndex = buffers.idToIdx;
    linkIndexByKey = buffers.linkKey;

    cosmos.setPointPositions(buffers.positions);
    cosmos.setPointColors(buffers.colors);
    cosmos.setPointSizes(buffers.sizes);
    cosmos.setLinks(buffers.links);
    cosmos.setLinkColors(buffers.linkColors);
    cosmos.setLinkWidths(buffers.linkWidths);
    cosmos.setLinkArrows(buffers.linkArrows);
    if (buffers.clusterAssignments.length > 0) {
      cosmos.setPointClusters(buffers.clusterAssignments);
      cosmos.setClusterPositions(buffers.clusterPositions);
    }
    cosmos.render(prefersReducedMotion() ? 0 : 0.6);
    recomputeClusterPoints();
  }

  /**
   * Project every cluster centroid to screen coordinates and publish
   * it through the reactive `clusterPoints` store consumed by
   * ClusterLabelLayer.
   */
  function recomputeClusterPoints(): void {
    if (!cosmos || !container || clusters.length === 0) {
      clusterPoints = [];
      return;
    }
    // Collect members as their current positions.
    const positions = cosmos.getPointPositions();
    const next: ClusterLabelPoint[] = [];
    for (const cluster of clusters) {
      let sx = 0;
      let sy = 0;
      let n = 0;
      for (const memberId of cluster.memberIds) {
        const idx = idToIndex.get(memberId);
        if (typeof idx !== 'number') continue;
        sx += positions[idx * 2];
        sy += positions[idx * 2 + 1];
        n++;
      }
      if (n === 0) continue;
      const cx = sx / n;
      const cy = sy / n;
      const [sxPx, syPx] = cosmos.spaceToScreenPosition([cx, cy]);
      next.push({
        id: cluster.id,
        label: cluster.label,
        memberCount: cluster.memberIds.length,
        x: sxPx,
        y: syPx,
        tint: categoryColor.get(cluster.id) ?? 'var(--text-dim)',
      });
    }
    clusterPoints = next;
  }

  // Export read-only introspection for tests / telemetry
  /** Number of edge-kind buckets we can render — from the shared kit. */
  export const edgeKindCount = ALL_EDGE_KINDS.length;
</script>

<div class="cosmos-wrap" style="height: {height};">
  <div class="cosmos-canvas" bind:this={container}></div>

  {#if showClusterLabels && cosmos}
    <ClusterLabelLayer points={clusterPoints} zoom={currentZoom} />
  {/if}

  <HoverLabel node={hovered} x={hoverX} y={hoverY} secondary={hoverSecondary} />

  {#if initFailureReason}
    <div class="init-failure" role="status" aria-live="polite">
      <strong>Graph renderer unavailable.</strong>
      <span>{initFailureReason}</span>
    </div>
  {/if}
</div>

<style>
  .cosmos-wrap {
    position: relative;
    width: 100%;
    background:
      radial-gradient(
        1200px 600px at 50% 45%,
        color-mix(in srgb, var(--accent-halo) 70%, transparent) 0%,
        transparent 70%
      ),
      linear-gradient(180deg, var(--bg) 0%, color-mix(in srgb, var(--bg) 85%, black 15%) 100%);
    border-radius: var(--radius-lg);
    overflow: hidden;
    border: 1px solid var(--border);
    isolation: isolate;
  }

  .cosmos-wrap::before {
    content: '';
    position: absolute;
    inset: 0;
    pointer-events: none;
    background-image:
      linear-gradient(
        to right,
        color-mix(in srgb, var(--border) 35%, transparent) 1px,
        transparent 1px
      ),
      linear-gradient(
        to bottom,
        color-mix(in srgb, var(--border) 35%, transparent) 1px,
        transparent 1px
      );
    background-size: 64px 64px;
    background-position: -1px -1px;
    mask-image: radial-gradient(
      ellipse at center,
      black 30%,
      transparent 85%
    );
    opacity: 0.4;
    z-index: 0;
  }

  .cosmos-canvas {
    position: relative;
    z-index: 1;
    width: 100%;
    height: 100%;
  }

  .init-failure {
    position: absolute;
    inset: var(--space-4);
    display: flex;
    align-items: center;
    justify-content: center;
    flex-direction: column;
    gap: var(--space-2);
    text-align: center;
    padding: var(--space-6);
    background: var(--bg-elev-2);
    border: 1px dashed var(--border-strong);
    border-radius: var(--radius-lg);
    color: var(--text-dim);
    font-size: var(--text-sm);
    z-index: 2;
  }

  .init-failure strong {
    color: var(--danger);
    font-weight: 600;
  }
</style>
