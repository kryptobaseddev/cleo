<!--
  SvgRenderer — engine-agnostic d3-force + SVG renderer for the shared
  graph kit.

  The renderer is consumed by GraphTab (full bundle projection), by
  TaskDepGraph (focal ego projection), and by any future low-density
  relationship view (≤ 300 nodes). High-density live-animated surfaces
  (Brain, Nexus) use the CosmosRenderer instead.

  ## Label modes

  Operator feedback: dense task graphs don't breathe under face-up
  titles, but sparse ego graphs and single-focus drill-downs need
  readable labels. Three modes:

    - `none`      — zero face-up text. Renderer runs `assertNoFaceUp`
                    against the Wave 1A guard. Hover still shows tooltip.
    - `id-only`   — default. Renders the node id only (ports the current
                    task-graph behaviour and matches `/tmp/task-viz/index.html`).
    - `full`      — two-line pill: id + label. Used in ego graphs / outlines.

  ## Node renderer flavours

    - `pill`      — rounded rectangle (current task look)
    - `circle`    — generic substrate node
    - `card`      — rich (title + meta), largest and slowest

  ## Colour pipeline

  Edge colours resolve from tokens via `resolveEdgeStyleForWebGL` (from
  `$lib/graph/edge-kinds.ts`) on mount. Node colours come from task
  status tokens via `getComputedStyle(documentElement)`. Zero hex
  literals are emitted from this component.

  @task T990
  @wave 1C
-->
<script lang="ts" module>
  import type { EdgeKind, GraphCluster, GraphEdge, GraphNode } from '$lib/graph/types.js';

  /**
   * Simulation-augmented node — d3-force writes `x` / `y` / `fx` / `fy`
   * in place. We wrap rather than mutate the input `GraphNode` so the
   * caller's props stay referentially clean.
   */
  export interface SimGraphNode extends GraphNode {
    x?: number;
    y?: number;
    vx?: number;
    vy?: number;
    fx?: number | null;
    fy?: number | null;
  }

  /**
   * Simulation-augmented edge — d3-force rewrites `source` / `target`
   * to node references during `forceLink(...).id(...)`.
   */
  export interface SimGraphEdge
    extends Omit<GraphEdge, 'source' | 'target'> {
    source: string | SimGraphNode;
    target: string | SimGraphNode;
  }

  /**
   * Available label rendering modes.
   */
  export type SvgLabelMode = 'none' | 'id-only' | 'full';

  /**
   * Available node renderer flavours.
   */
  export type SvgNodeRenderer = 'pill' | 'circle' | 'card';

  /**
   * Resolve a link endpoint id regardless of whether d3 has rewritten
   * the property to a SimGraphNode reference. Used by the `{#each}` key
   * to avoid `[object Object]` collisions.
   */
  export function endpointId(value: SimGraphEdge['source']): string {
    return typeof value === 'string' ? value : value.id;
  }

  /**
   * Build a stable per-node focusable traversal order — descending on
   * weight so the highest-importance nodes come first.
   */
  export function focusOrder(nodes: readonly GraphNode[]): string[] {
    return [...nodes]
      .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0) || a.id.localeCompare(b.id))
      .map((n) => n.id);
  }
</script>

<script lang="ts">
  import { onDestroy, onMount, untrack } from 'svelte';
  import * as d3 from 'd3';

  import { EDGE_STYLE } from '$lib/graph/edge-kinds.js';
  import HoverLabel from '$lib/graph/hover-label.svelte';
  import { assertNoFaceUp } from '$lib/graph/no-face-up.js';

  interface Props {
    /** Node set to render. Order drives focus-traversal when weights tie. */
    nodes: GraphNode[];
    /** Edge set to render. Edge.kind drives colour + dash. */
    edges: GraphEdge[];
    /** Optional cluster metadata (one convex-hull halo per entry ≥ 3 members). */
    clusters?: GraphCluster[];
    /**
     * Filter of which edge kinds to draw. `undefined` means all kinds are
     * visible. Empty set means no edges render (nodes only).
     */
    visibleEdgeKinds?: ReadonlySet<EdgeKind>;
    /** Currently-hovered node id, or null. Drives neighbor highlight. */
    highlightNodeId?: string | null;
    /** Currently-selected node id, or null. Drives accent border. */
    selectedNodeId?: string | null;
    /** Callback when pointer enters / leaves a node. */
    onNodeHover?: (n: GraphNode | null) => void;
    /** Callback when a node is clicked or Enter-pressed. */
    onNodeClick?: (n: GraphNode) => void;
    /** Label mode — see file header comment. */
    showLabels?: SvgLabelMode;
    /** Node renderer flavour. */
    nodeRenderer?: SvgNodeRenderer;
    /** Min/max zoom scale. Defaults to `[0.25, 4]`. */
    zoomExtent?: [number, number];
    /**
     * Reduced-motion flag. When true, the simulation runs in a single
     * synchronous pass with zero tick animation. Defaults to the user's
     * `prefers-reduced-motion` query at mount.
     */
    reducedMotion?: boolean;
    /** Optional aria-label on the root `<svg>`. */
    ariaLabel?: string;
    /** Map of edge meta → hover subtitle, used when hovering an edge. */
    edgeMetaLabel?: (e: GraphEdge) => string;
    /**
     * When true, overlay a small floating toolbar (release/resume,
     * reset view) in the top-right of the canvas. Off by default so
     * lightweight ego views (TaskDepGraph) stay clean.
     */
    showToolbar?: boolean;
    /**
     * When true, overlay a legend showing the dash pattern per active
     * edge kind. GraphTab turns this on; ego graphs leave it off.
     */
    showLegend?: boolean;
  }

  let {
    nodes,
    edges,
    clusters = [],
    visibleEdgeKinds,
    highlightNodeId = null,
    selectedNodeId = null,
    onNodeHover,
    onNodeClick,
    showLabels = 'id-only',
    nodeRenderer = 'pill',
    zoomExtent = [0.25, 4],
    reducedMotion,
    ariaLabel = 'Graph visualisation',
    edgeMetaLabel,
    showToolbar = false,
    showLegend = false,
  }: Props = $props();

  // ---------------------------------------------------------------------------
  // Refs / local state
  // ---------------------------------------------------------------------------

  let svgEl = $state<SVGSVGElement | null>(null);
  let containerEl = $state<HTMLDivElement | null>(null);
  let viewBoxX = $state(0);
  let viewBoxY = $state(0);
  let viewBoxW = $state(1200);
  let viewBoxH = $state(700);

  let simNodes: SimGraphNode[] = $state([]);
  let simLinks: SimGraphEdge[] = $state([]);
  let simulation: d3.Simulation<SimGraphNode, SimGraphEdge> | null = null;
  let physicsPaused = $state(false);

  // Hover tracking — a single node at a time.
  let hoverNode = $state<GraphNode | null>(null);
  let hoverX = $state(0);
  let hoverY = $state(0);

  // Pan state.
  let isPanning = false;
  let panStart: { x: number; y: number; vbX: number; vbY: number } | null = null;

  // Drag state for node manipulation.
  let draggingId: string | null = null;
  let dragOffset: { dx: number; dy: number } | null = null;

  // Resolved node status colours — read from tokens on mount.
  let statusColors = $state<Record<string, string>>({});

  // Neighbour lookup for hover-dim.
  const neighborMap = $derived.by(() => {
    const map = new Map<string, Set<string>>();
    for (const edge of edges) {
      const s = typeof edge.source === 'string' ? edge.source : '';
      const t = typeof edge.target === 'string' ? edge.target : '';
      if (!s || !t) continue;
      let setS = map.get(s);
      if (!setS) {
        setS = new Set<string>();
        map.set(s, setS);
      }
      setS.add(t);
      let setT = map.get(t);
      if (!setT) {
        setT = new Set<string>();
        map.set(t, setT);
      }
      setT.add(s);
    }
    return map;
  });

  const visibleEdgeSet = $derived(visibleEdgeKinds);

  const visibleEdges = $derived(
    visibleEdgeSet ? edges.filter((e) => visibleEdgeSet.has(e.kind)) : edges,
  );

  const activeHoverId = $derived(highlightNodeId ?? hoverNode?.id ?? null);

  // ---------------------------------------------------------------------------
  // Simulation lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Spin up (or restart) the force simulation for the given nodes + edges.
   * Preserves previous `x` / `y` positions where possible so filter
   * toggles don't shuffle the whole layout.
   */
  function startSimulation(nextNodes: GraphNode[], nextEdges: GraphEdge[]): void {
    const prior = new Map(simNodes.map((n) => [n.id, { x: n.x, y: n.y }]));
    const projected: SimGraphNode[] = nextNodes.map((n) => {
      const prev = prior.get(n.id);
      return { ...n, x: prev?.x, y: prev?.y };
    });
    const projectedLinks: SimGraphEdge[] = nextEdges.map((e) => ({ ...e }));

    simNodes = projected;
    simLinks = projectedLinks;

    if (simulation) simulation.stop();

    const width = svgEl?.clientWidth ?? viewBoxW;
    const height = svgEl?.clientHeight ?? viewBoxH;

    simulation = d3
      .forceSimulation<SimGraphNode>(projected)
      .force(
        'link',
        d3
          .forceLink<SimGraphNode, SimGraphEdge>(projectedLinks)
          .id((d: SimGraphNode) => d.id)
          .distance(70)
          .strength((l: SimGraphEdge) => {
            if (l.kind === 'parent' || l.kind === 'contains') return 1;
            if (l.kind === 'extends' || l.kind === 'defines') return 0.7;
            if (l.kind === 'blocks' || l.kind === 'depends') return 0.2;
            return 0.4;
          }),
      )
      .force('charge', d3.forceManyBody<SimGraphNode>().strength(-320))
      .force('center', d3.forceCenter(width / 2, height / 2))
      .force('collide', d3.forceCollide<SimGraphNode>(38));

    if (reducedMotion) {
      // Tick synchronously for N iterations, then stop.
      for (let i = 0; i < 200 && simulation.alpha() > 0.01; i += 1) {
        simulation.tick();
      }
      simulation.stop();
      physicsPaused = true;
      simNodes = [...projected];
      simLinks = [...projectedLinks];
    } else {
      simulation
        .on('tick', () => {
          simNodes = [...projected];
          simLinks = [...projectedLinks];
        })
        .on('end', () => {
          physicsPaused = true;
        });
      physicsPaused = false;
      // Stop once alpha drops.
      const interval = setInterval(() => {
        if (!simulation) {
          clearInterval(interval);
          return;
        }
        if (simulation.alpha() < 0.01) {
          simulation.stop();
          physicsPaused = true;
          clearInterval(interval);
        }
      }, 250);
    }
  }

  onMount(() => {
    // Enforce no-face-up when the caller opts into `'none'` mode.
    if (showLabels === 'none') {
      assertNoFaceUp({ drawLabels: false });
    }

    // Auto-detect prefers-reduced-motion when the caller didn't specify.
    if (reducedMotion === undefined && typeof window !== 'undefined') {
      reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    }

    statusColors = readStatusColors();
    startSimulation(nodes, visibleEdges);
  });

  onDestroy(() => {
    if (simulation) simulation.stop();
  });

  // Restart when the visible id set or edge set changes shape.
  $effect(() => {
    // Establish reactive deps on the inputs without triggering ourselves.
    const idShape = nodes.map((n) => n.id).sort().join('|');
    const edgeShape = visibleEdges.map((e) => e.id).sort().join('|');
    void idShape;
    void edgeShape;
    if (!svgEl) return;
    const nextNodes = nodes;
    const nextEdges = visibleEdges;
    untrack(() => {
      startSimulation(nextNodes, nextEdges);
    });
  });

  // ---------------------------------------------------------------------------
  // Colour resolution from tokens
  // ---------------------------------------------------------------------------

  /**
   * Read the computed CSS custom properties for every task status into a
   * flat map. Called once at mount and again on theme change (if ever).
   */
  function readStatusColors(): Record<string, string> {
    if (typeof window === 'undefined' || typeof document === 'undefined') {
      return {};
    }
    const cs = getComputedStyle(document.documentElement);
    return {
      pending: cs.getPropertyValue('--status-pending').trim(),
      active: cs.getPropertyValue('--status-active').trim(),
      blocked: cs.getPropertyValue('--status-blocked').trim(),
      done: cs.getPropertyValue('--status-done').trim(),
      cancelled: cs.getPropertyValue('--status-cancelled').trim(),
      archived: cs.getPropertyValue('--status-archived').trim(),
      proposed: cs.getPropertyValue('--status-proposed').trim(),
      accent: cs.getPropertyValue('--accent').trim(),
      textDim: cs.getPropertyValue('--text-dim').trim(),
      textFaint: cs.getPropertyValue('--text-faint').trim(),
      borderStrong: cs.getPropertyValue('--border-strong').trim(),
    };
  }

  /**
   * Resolve the node fill for a given kind + status. Circle nodes share
   * the same palette; card nodes use the status colour as a left stripe.
   */
  function nodeFillFor(node: SimGraphNode): string {
    const status = (node.meta?.['status'] as string | undefined) ?? 'pending';
    return statusColors[status] ?? statusColors['pending'] ?? 'var(--status-pending)';
  }

  function nodeStrokeFor(node: SimGraphNode): string {
    if (node.kind === 'epic') return statusColors['accent'] ?? 'var(--accent)';
    return statusColors['borderStrong'] ?? 'var(--border-strong)';
  }

  // ---------------------------------------------------------------------------
  // Interaction helpers
  // ---------------------------------------------------------------------------

  function onNodeHoverStart(node: GraphNode, ev: PointerEvent | FocusEvent): void {
    hoverNode = node;
    updateHoverCoords(ev);
    onNodeHover?.(node);
  }

  function onNodeHoverEnd(): void {
    hoverNode = null;
    onNodeHover?.(null);
  }

  function updateHoverCoords(ev: PointerEvent | FocusEvent | MouseEvent): void {
    if (!containerEl) return;
    const rect = containerEl.getBoundingClientRect();
    const pe = ev as MouseEvent;
    if (pe.clientX !== undefined) {
      hoverX = pe.clientX - rect.left;
      hoverY = pe.clientY - rect.top;
    }
  }

  function onNodeKeydown(e: KeyboardEvent, node: GraphNode): void {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onNodeClick?.(node);
      return;
    }

    // Arrow keys move focus to neighbours in a deterministic order.
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft' || e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const neighbours = [...(neighborMap.get(node.id) ?? new Set())];
      if (neighbours.length === 0) return;
      // Forward / back through the neighbour list.
      const forward = e.key === 'ArrowRight' || e.key === 'ArrowDown';
      const currentIdx = neighbours.indexOf(node.id);
      const nextIdx = forward
        ? (currentIdx + 1) % neighbours.length
        : (currentIdx - 1 + neighbours.length) % neighbours.length;
      const nextId = neighbours[nextIdx];
      if (!nextId) return;
      const nextEl = svgEl?.querySelector<SVGGElement>(`[data-node-id="${nextId}"]`);
      nextEl?.focus();
    }
  }

  // Pan + zoom.
  function onSvgWheel(e: WheelEvent): void {
    e.preventDefault();
    const factor = e.deltaY > 0 ? 1.1 : 0.9;
    const cx = viewBoxX + viewBoxW / 2;
    const cy = viewBoxY + viewBoxH / 2;
    const nextW = Math.max(
      viewBoxW / zoomExtent[1],
      Math.min(viewBoxW / zoomExtent[0], viewBoxW * factor),
    );
    const nextH = Math.max(
      viewBoxH / zoomExtent[1],
      Math.min(viewBoxH / zoomExtent[0], viewBoxH * factor),
    );
    viewBoxW = nextW;
    viewBoxH = nextH;
    viewBoxX = cx - viewBoxW / 2;
    viewBoxY = cy - viewBoxH / 2;
  }

  function onSvgMouseDown(e: MouseEvent): void {
    if (e.button !== 0) return;
    if (e.target !== svgEl) return;
    isPanning = true;
    panStart = { x: e.clientX, y: e.clientY, vbX: viewBoxX, vbY: viewBoxY };
  }

  function onWindowMouseMove(e: MouseEvent): void {
    if (isPanning && panStart && svgEl) {
      const rect = svgEl.getBoundingClientRect();
      const scaleX = viewBoxW / rect.width;
      const scaleY = viewBoxH / rect.height;
      viewBoxX = panStart.vbX - (e.clientX - panStart.x) * scaleX;
      viewBoxY = panStart.vbY - (e.clientY - panStart.y) * scaleY;
      return;
    }
    if (draggingId && dragOffset) {
      const node = simNodes.find((nn) => nn.id === draggingId);
      if (!node) return;
      const vb = clientToViewBox(e.clientX, e.clientY);
      node.fx = vb.x - dragOffset.dx;
      node.fy = vb.y - dragOffset.dy;
      simNodes = [...simNodes];
    }
  }

  function onWindowMouseUp(): void {
    isPanning = false;
    panStart = null;
    if (draggingId) {
      if (simulation) simulation.alphaTarget(0);
      draggingId = null;
      dragOffset = null;
    }
  }

  function clientToViewBox(ex: number, ey: number): { x: number; y: number } {
    if (!svgEl) return { x: 0, y: 0 };
    const rect = svgEl.getBoundingClientRect();
    return {
      x: viewBoxX + ((ex - rect.left) / rect.width) * viewBoxW,
      y: viewBoxY + ((ey - rect.top) / rect.height) * viewBoxH,
    };
  }

  function onNodeMouseDown(e: MouseEvent, n: SimGraphNode): void {
    e.stopPropagation();
    if (e.button !== 0) return;
    draggingId = n.id;
    const vb = clientToViewBox(e.clientX, e.clientY);
    dragOffset = { dx: vb.x - (n.x ?? 0), dy: vb.y - (n.y ?? 0) };
    n.fx = n.x ?? 0;
    n.fy = n.y ?? 0;
    if (simulation) simulation.alphaTarget(0.3).restart();
    physicsPaused = false;
  }

  // ---------------------------------------------------------------------------
  // Public controls — used by the toolbar that wraps this renderer
  // ---------------------------------------------------------------------------

  /**
   * Pin every node at its current position so the layout stops moving.
   */
  function releaseLayout(): void {
    if (!simulation) return;
    for (const n of simNodes) {
      n.fx = n.x ?? 0;
      n.fy = n.y ?? 0;
    }
    simulation.stop();
    physicsPaused = true;
    simNodes = [...simNodes];
  }

  /**
   * Un-pin every node + restart the simulation so the user can iterate
   * on the layout again.
   */
  function resumeLayout(): void {
    for (const n of simNodes) {
      n.fx = null;
      n.fy = null;
    }
    if (simulation) {
      simulation.alpha(0.6).restart();
    } else {
      startSimulation(nodes, visibleEdges);
    }
    physicsPaused = false;
  }

  /**
   * Fit the viewport to the full node set (centred at (0, 0)).
   */
  function resetView(): void {
    if (simNodes.length === 0) {
      viewBoxX = 0;
      viewBoxY = 0;
      viewBoxW = 1200;
      viewBoxH = 700;
      return;
    }
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const n of simNodes) {
      if (n.x === undefined || n.y === undefined) continue;
      if (n.x < minX) minX = n.x;
      if (n.y < minY) minY = n.y;
      if (n.x > maxX) maxX = n.x;
      if (n.y > maxY) maxY = n.y;
    }
    if (!Number.isFinite(minX)) {
      viewBoxX = 0;
      viewBoxY = 0;
      viewBoxW = 1200;
      viewBoxH = 700;
      return;
    }
    const pad = 80;
    viewBoxX = minX - pad;
    viewBoxY = minY - pad;
    viewBoxW = Math.max(300, maxX - minX + pad * 2);
    viewBoxH = Math.max(300, maxY - minY + pad * 2);
  }

  // Legend derivation — distinct kinds present in the current edge set.
  const legendKinds = $derived.by(() => {
    const out = new Map<EdgeKind, { color: string; dash: string | null; label: string }>();
    for (const e of visibleEdges) {
      if (out.has(e.kind)) continue;
      const style = EDGE_STYLE[e.kind];
      out.set(e.kind, {
        color: style.color,
        dash: style.dash ?? null,
        label: humaniseEdgeKind(e.kind),
      });
    }
    return out;
  });

  function humaniseEdgeKind(kind: EdgeKind): string {
    return kind.replace(/_/g, ' ');
  }

  // ---------------------------------------------------------------------------
  // Rendering helpers (pure)
  // ---------------------------------------------------------------------------

  function resolveEndpoint(
    link: SimGraphEdge,
    end: 'source' | 'target',
  ): SimGraphNode | null {
    const v = link[end];
    if (typeof v === 'string') return simNodes.find((n) => n.id === v) ?? null;
    return v;
  }

  function nodeRadius(n: SimGraphNode): number {
    const base = nodeRenderer === 'circle' ? 10 : nodeRenderer === 'card' ? 26 : 14;
    const w = Math.max(0.4, Math.min(1, n.weight ?? 0.6));
    return Math.round(base * (0.75 + w * 0.5));
  }

  function nodePillSize(n: SimGraphNode): { w: number; h: number } {
    const isEpic = n.kind === 'epic';
    if (nodeRenderer === 'card') return { w: isEpic ? 104 : 96, h: isEpic ? 44 : 38 };
    return { w: isEpic ? 64 : 52, h: isEpic ? 28 : 22 };
  }

  function edgeOpacity(edge: SimGraphEdge): number {
    const base = 0.75;
    if (!activeHoverId) return base;
    const s = typeof edge.source === 'string' ? edge.source : edge.source.id;
    const t = typeof edge.target === 'string' ? edge.target : edge.target.id;
    if (s === activeHoverId || t === activeHoverId) return 1;
    return base * 0.35;
  }

  function edgeStrokeWidth(edge: SimGraphEdge): number {
    const style = EDGE_STYLE[edge.kind];
    const base = (style.thickness ?? 0.6) * 1.8;
    const s = typeof edge.source === 'string' ? edge.source : edge.source.id;
    const t = typeof edge.target === 'string' ? edge.target : edge.target.id;
    if (activeHoverId && (s === activeHoverId || t === activeHoverId)) return base + 1;
    return base;
  }

  function nodeOpacity(n: SimGraphNode): number {
    if (!activeHoverId) return 1;
    if (n.id === activeHoverId) return 1;
    const neighbors = neighborMap.get(activeHoverId);
    if (neighbors?.has(n.id)) return 1;
    return 0.35;
  }

  /** Base style (colour + dash + opacity) for one edge. */
  function edgeStyleFor(kind: EdgeKind): { color: string; dash: string | null } {
    const style = EDGE_STYLE[kind];
    return { color: style.color, dash: style.dash ?? null };
  }

  // Cluster centroids — recomputed each tick via simNodes positions.
  const clusterCentroids = $derived.by(() => {
    const centroids = new Map<string, { x: number; y: number; hull: string }>();
    for (const cluster of clusters) {
      if (cluster.memberIds.length < 3) continue;
      const members = cluster.memberIds
        .map((id) => simNodes.find((n) => n.id === id))
        .filter((n): n is SimGraphNode => !!n && n.x !== undefined && n.y !== undefined);
      if (members.length < 3) continue;
      let sx = 0;
      let sy = 0;
      for (const m of members) {
        sx += m.x ?? 0;
        sy += m.y ?? 0;
      }
      const cx = sx / members.length;
      const cy = sy / members.length;
      // Bounding radius.
      let maxR = 0;
      for (const m of members) {
        const dx = (m.x ?? 0) - cx;
        const dy = (m.y ?? 0) - cy;
        const r = Math.sqrt(dx * dx + dy * dy);
        if (r > maxR) maxR = r;
      }
      centroids.set(cluster.id, { x: cx, y: cy, hull: `${maxR + 40}` });
    }
    return centroids;
  });
</script>

<svelte:window onmousemove={onWindowMouseMove} onmouseup={onWindowMouseUp} />

<div bind:this={containerEl} class="svg-renderer" data-node-renderer={nodeRenderer}>
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <svg
    bind:this={svgEl}
    role="img"
    aria-label={ariaLabel}
    class="svg-surface"
    viewBox="{viewBoxX} {viewBoxY} {viewBoxW} {viewBoxH}"
    preserveAspectRatio="xMidYMid meet"
    onwheel={onSvgWheel}
    onmousedown={onSvgMouseDown}
  >
    <defs>
      <marker
        id="sr-arrow"
        viewBox="0 -4 8 8"
        refX="8"
        refY="0"
        markerWidth="6"
        markerHeight="6"
        orient="auto"
      >
        <path d="M0,-4L8,0L0,4" fill="var(--text-faint)" />
      </marker>
    </defs>

    <!-- Cluster backdrops render behind everything. -->
    {#if clusters.length > 0}
      <g class="cluster-backdrops" aria-hidden="true">
        {#each clusters as cluster (cluster.id)}
          {@const c = clusterCentroids.get(cluster.id)}
          {#if c}
            <circle
              class="cluster-halo"
              cx={c.x}
              cy={c.y}
              r={c.hull}
              fill="var(--accent-halo)"
            />
            <text
              class="cluster-label"
              x={c.x}
              y={c.y - Number(c.hull) - 4}
              text-anchor="middle"
              fill="var(--text-dim)"
              font-family="var(--font-sans)"
              font-size="11"
            >
              {cluster.label}
            </text>
          {/if}
        {/each}
      </g>
    {/if}

    <!-- Edges -->
    <g class="edges">
      {#each simLinks as link (link.id)}
        {@const s = resolveEndpoint(link, 'source')}
        {@const t = resolveEndpoint(link, 'target')}
        {#if s && t && s.x !== undefined && s.y !== undefined && t.x !== undefined && t.y !== undefined}
          {@const style = edgeStyleFor(link.kind)}
          <line
            class="edge edge-{link.kind}"
            x1={s.x}
            y1={s.y}
            x2={t.x}
            y2={t.y}
            stroke={style.color}
            stroke-width={edgeStrokeWidth(link)}
            stroke-dasharray={style.dash ?? undefined}
            opacity={edgeOpacity(link)}
            marker-end={link.directional ? 'url(#sr-arrow)' : undefined}
          >
            {#if edgeMetaLabel}
              <title>{edgeMetaLabel(link as unknown as GraphEdge)}</title>
            {/if}
          </line>
        {/if}
      {/each}
    </g>

    <!-- Nodes -->
    <g class="nodes">
      {#each simNodes as n (n.id)}
        {#if n.x !== undefined && n.y !== undefined}
          {@const pill = nodePillSize(n)}
          {@const radius = nodeRadius(n)}
          {@const isSelected = selectedNodeId === n.id}
          {@const blocked = n.meta?.['status'] === 'pending' && n.meta?.['blocked'] === true}
          {@const isFocal = n.meta?.['focal'] === true}
          <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
          <g
            role="button"
            tabindex="0"
            class="node"
            class:selected={isSelected}
            class:blocked-halo={blocked}
            class:focal={isFocal}
            data-node-id={n.id}
            transform="translate({n.x},{n.y})"
            opacity={nodeOpacity(n)}
            onpointerenter={(e) => onNodeHoverStart(n, e)}
            onpointerleave={onNodeHoverEnd}
            onpointermove={(e) => updateHoverCoords(e)}
            onfocus={(e) => onNodeHoverStart(n, e)}
            onblur={onNodeHoverEnd}
            onclick={() => onNodeClick?.(n)}
            onkeydown={(e) => onNodeKeydown(e, n)}
            onmousedown={(e) => onNodeMouseDown(e, n)}
            aria-label={`${n.id}: ${n.label}`}
          >
            {#if nodeRenderer === 'circle'}
              <circle
                class="node-shape"
                cx="0"
                cy="0"
                r={radius}
                fill={nodeFillFor(n)}
                stroke={nodeStrokeFor(n)}
                stroke-width={isSelected ? 2.5 : 1}
              />
            {:else if nodeRenderer === 'card'}
              <rect
                class="node-shape"
                x={-pill.w / 2}
                y={-pill.h / 2}
                width={pill.w}
                height={pill.h}
                rx="6"
                ry="6"
                fill="var(--bg-elev-1)"
                stroke={isSelected ? 'var(--accent)' : nodeStrokeFor(n)}
                stroke-width={isSelected ? 2.5 : 1}
              />
              <rect
                class="node-stripe"
                x={-pill.w / 2}
                y={-pill.h / 2}
                width="4"
                height={pill.h}
                rx="2"
                ry="2"
                fill={nodeFillFor(n)}
              />
            {:else}
              <rect
                class="node-shape"
                x={-pill.w / 2}
                y={-pill.h / 2}
                width={pill.w}
                height={pill.h}
                rx={n.kind === 'epic' ? 3 : 8}
                ry={n.kind === 'epic' ? 3 : 8}
                fill={nodeFillFor(n)}
                stroke={isSelected ? 'var(--accent)' : nodeStrokeFor(n)}
                stroke-width={isSelected ? 2.5 : 1}
              />
            {/if}

            {#if showLabels === 'id-only'}
              <text
                class="node-id"
                text-anchor="middle"
                dominant-baseline="middle"
                font-family="var(--font-mono)"
                font-size="10"
                font-weight="600"
                pointer-events="none"
                fill={nodeRenderer === 'card' ? 'var(--text)' : n.kind === 'epic' ? 'var(--bg)' : 'var(--bg)'}
              >
                {n.id}
              </text>
            {:else if showLabels === 'full'}
              <text
                class="node-id"
                x={nodeRenderer === 'card' ? -pill.w / 2 + 12 : 0}
                y={nodeRenderer === 'card' ? -pill.h / 2 + 14 : -4}
                text-anchor={nodeRenderer === 'card' ? 'start' : 'middle'}
                dominant-baseline="middle"
                font-family="var(--font-mono)"
                font-size="10"
                font-weight="600"
                pointer-events="none"
                fill={nodeRenderer === 'card' ? 'var(--accent)' : 'var(--bg)'}
              >
                {n.id}
              </text>
              <text
                class="node-label"
                x={nodeRenderer === 'card' ? -pill.w / 2 + 12 : 0}
                y={nodeRenderer === 'card' ? pill.h / 2 - 10 : 8}
                text-anchor={nodeRenderer === 'card' ? 'start' : 'middle'}
                dominant-baseline="middle"
                font-family="var(--font-sans)"
                font-size="9"
                pointer-events="none"
                fill={nodeRenderer === 'card' ? 'var(--text-dim)' : 'var(--text)'}
              >
                {n.label.length > 18 ? n.label.slice(0, 16) + '…' : n.label}
              </text>
            {/if}
          </g>
        {/if}
      {/each}
    </g>
  </svg>

  {#if showToolbar}
    <div class="toolbar" role="toolbar" aria-label="Graph controls">
      {#if physicsPaused}
        <button
          type="button"
          class="tb-btn"
          onclick={resumeLayout}
          aria-label="Resume physics"
        >
          Resume physics
        </button>
      {:else}
        <button
          type="button"
          class="tb-btn"
          onclick={releaseLayout}
          aria-label="Release layout"
        >
          Release layout
        </button>
      {/if}
      <button
        type="button"
        class="tb-btn"
        onclick={resetView}
        aria-label="Reset view"
      >
        Reset view
      </button>
    </div>
  {/if}

  {#if showLegend && legendKinds.size > 0}
    <div class="legend" aria-label="Edge legend">
      {#each [...legendKinds.entries()] as [kind, meta] (kind)}
        <span class="legend-item">
          <svg class="legend-swatch" viewBox="0 0 20 4" aria-hidden="true">
            <line
              x1="0"
              y1="2"
              x2="20"
              y2="2"
              stroke={meta.color}
              stroke-width="1.6"
              stroke-dasharray={meta.dash ?? undefined}
            />
          </svg>
          <span class="legend-label">{meta.label}</span>
        </span>
      {/each}
    </div>
  {/if}

  <HoverLabel
    node={hoverNode}
    x={hoverX}
    y={hoverY}
    secondary={typeof hoverNode?.meta?.['status'] === 'string'
      ? (hoverNode.meta['status'] as string)
      : null}
  />
</div>

<style>
  .svg-renderer {
    position: relative;
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
    background: var(--bg);
    border-radius: var(--radius-lg);
    overflow: hidden;
  }

  .svg-surface {
    width: 100%;
    height: 100%;
    display: block;
    cursor: grab;
  }

  .svg-surface:active {
    cursor: grabbing;
  }

  .edge {
    transition: opacity var(--ease), stroke-width var(--ease);
  }

  .node {
    cursor: pointer;
    transition: opacity var(--ease);
  }

  .node:focus-visible .node-shape {
    outline: none;
    stroke: var(--accent);
    stroke-width: 2.5;
    filter: drop-shadow(0 0 8px var(--accent-halo));
  }

  .node.selected .node-shape {
    stroke: var(--accent);
    stroke-width: 2.5;
  }

  .node.blocked-halo .node-shape {
    filter: drop-shadow(0 0 6px var(--danger));
  }

  .node.focal .node-shape {
    stroke: var(--accent);
    stroke-width: 3;
    filter: drop-shadow(0 0 12px var(--accent-halo));
  }

  .cluster-halo {
    opacity: 0.08;
  }

  .cluster-label {
    letter-spacing: 0.08em;
    text-transform: uppercase;
    font-weight: 600;
    opacity: 0.7;
    pointer-events: none;
  }

  .toolbar {
    position: absolute;
    top: var(--space-3);
    right: var(--space-3);
    display: inline-flex;
    gap: var(--space-1);
    padding: var(--space-1);
    background: color-mix(in srgb, var(--bg-elev-1) 82%, transparent);
    backdrop-filter: blur(8px) saturate(140%);
    -webkit-backdrop-filter: blur(8px) saturate(140%);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    z-index: 5;
  }

  .tb-btn {
    background: transparent;
    border: 1px solid transparent;
    color: var(--text-dim);
    font-family: inherit;
    font-size: var(--text-xs);
    padding: 4px 10px;
    border-radius: var(--radius-sm);
    cursor: pointer;
    transition: color var(--ease), border-color var(--ease), background var(--ease);
  }

  .tb-btn:hover {
    color: var(--text);
    background: var(--bg-elev-2);
    border-color: var(--border-strong);
  }

  .tb-btn:focus-visible {
    outline: none;
    box-shadow: var(--shadow-focus);
  }

  .legend {
    position: absolute;
    bottom: var(--space-3);
    right: var(--space-3);
    display: inline-flex;
    flex-wrap: wrap;
    gap: var(--space-3);
    padding: var(--space-2) var(--space-3);
    background: color-mix(in srgb, var(--bg-elev-1) 82%, transparent);
    backdrop-filter: blur(8px) saturate(140%);
    -webkit-backdrop-filter: blur(8px) saturate(140%);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    z-index: 4;
    font-size: var(--text-2xs);
    color: var(--text-dim);
  }

  .legend-item {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }

  .legend-swatch {
    width: 20px;
    height: 4px;
    display: inline-block;
  }

  .legend-label {
    text-transform: lowercase;
    letter-spacing: 0.04em;
  }

  @media (prefers-reduced-motion: reduce) {
    .edge,
    .node {
      transition: none;
    }
  }
</style>
