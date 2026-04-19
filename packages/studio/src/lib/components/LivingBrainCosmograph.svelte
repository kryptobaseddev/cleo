<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { Graph as CosmosGraph } from '@cosmograph/cosmos';
  import type { GraphConfigInterface } from '@cosmograph/cosmos';
  import type { LBNode, LBEdge, LBSubstrate } from '@cleocode/brain';

  // ---------------------------------------------------------------------------
  // Props — intentionally mirrors LivingBrainGraph.svelte's Props interface
  //
  // Trade-off note (cosmos.gl 2.0):
  //   GPU layout + rendering supports up to ~1M nodes, making it the right
  //   choice for graphs above 2 000 nodes.  However, the v2 API is index-based
  //   (Float32Array positions/colors/sizes + numeric onClick index), so
  //   per-node pulse animation requires a full color buffer update rather than
  //   a single node mutation.  LivingBrainGraph (sigma 3) remains the default
  //   renderer for <2 000 nodes where tooltip fidelity and pulse UX matter more.
  //
  //   The /brain page toggle auto-activates GPU mode when filteredGraph.nodes.length
  //   exceeds 2 000; users can also opt in manually below that threshold.
  // ---------------------------------------------------------------------------

  /**
   * Props interface matching LivingBrainGraph.svelte so the two renderers
   * are interchangeable in the page template.
   */
  interface Props {
    nodes: LBNode[];
    edges: LBEdge[];
    /** Fired when the user clicks a node. Passes the node ID. */
    onNodeClick?: (id: string) => void;
    height?: string;
    /**
     * Set of node IDs currently pulsing (new/updated).
     *
     * In cosmos.gl 2.0 there is no per-node animation API; when this set is
     * non-empty the component does a `fitView` on the first pulsing node as a
     * best-effort visual cue and schedules a full color-buffer re-upload after
     * the pulse duration.  This is a known trade-off relative to sigma's
     * per-node pulse; documented here for future improvement.
     */
    pulsingNodes?: Set<string>;
    /**
     * Set of edge keys (`${source}|${target}`) currently pulsing.
     *
     * cosmos.gl 2.0 does not support per-link animation; this prop is accepted
     * for API parity but has no visible effect.  A full link-color buffer
     * re-upload would be required for visual feedback.
     */
    pulsingEdges?: Set<string>;
    /**
     * Called when the cosmos.gl renderer fails to initialise (e.g. WebGL
     * unavailable).  The parent page should use this to revert to the Standard
     * renderer so the user never sees a blank canvas.
     *
     * @param reason - Human-readable failure description.
     */
    onInitFailed?: (reason: string) => void;
  }

  let {
    nodes,
    edges,
    onNodeClick,
    height = '100%',
    pulsingNodes = new Set<string>(),
    pulsingEdges: _pulsingEdges = new Set<string>(),
    onInitFailed,
  }: Props = $props();

  // ---------------------------------------------------------------------------
  // Visual encoding maps (must mirror LivingBrainGraph.svelte)
  // ---------------------------------------------------------------------------

  /** Substrate fill colour (hex). */
  const SUBSTRATE_COLOR: Record<LBSubstrate, string> = {
    brain: '#3b82f6',
    nexus: '#22c55e',
    tasks: '#f97316',
    conduit: '#a855f7',
    signaldock: '#ef4444',
  };

  /** Edge type colour (hex). */
  const EDGE_COLOR: Record<string, string> = {
    supersedes: '#ef4444',
    affects: '#3b82f6',
    applies_to: '#22c55e',
    calls: '#94a3b8',
    co_retrieved: '#a855f7',
    mentions: '#eab308',
  };

  /** Fallback edge colour for unknown types. */
  const EDGE_FALLBACK = '#94a3b8';

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Parses a hex colour string (e.g. '#3b82f6') into an RGBA tuple in 0.0–1.0
   * range expected by cosmos.gl's Float32Array color buffers.
   *
   * cosmos.gl's setPointColors / setLinkColors accept Float32Arrays where each
   * RGBA component is a WebGL float in [0.0, 1.0].  Values outside this range
   * clamp to 1.0 in the shader, producing white/invisible geometry.
   *
   * @param hex - Six-digit hex colour, with or without '#'.
   * @param alpha - Alpha component in the 0.0–1.0 range (default: 1.0).
   * @returns RGBA tuple [r, g, b, a] with each value in [0.0, 1.0].
   */
  function hexToRgba(hex: string, alpha = 1.0): [number, number, number, number] {
    const h = hex.replace('#', '');
    const r = Number.parseInt(h.slice(0, 2), 16) / 255;
    const g = Number.parseInt(h.slice(2, 4), 16) / 255;
    const b = Number.parseInt(h.slice(4, 6), 16) / 255;
    return [r, g, b, alpha];
  }

  /**
   * Returns an RGBA tuple (0.0–1.0) for the given edge type string.
   *
   * @param type - Edge type key (e.g. 'calls', 'supersedes').
   */
  function edgeRgba(type: string): [number, number, number, number] {
    const hex = EDGE_COLOR[type] ?? EDGE_FALLBACK;
    return hexToRgba(hex, 0.7);
  }

  /**
   * Derives node display size from the normalised weight value.
   *
   * Matches the formula in LivingBrainGraph.svelte: 4 + w * 14, scaled to
   * cosmos.gl's point size units (which render slightly larger).
   *
   * @param node - The source LBNode.
   */
  function nodeSize(node: LBNode): number {
    const w = node.weight ?? 0.3;
    return 4 + w * 14;
  }

  // ---------------------------------------------------------------------------
  // Pulse duration (ms) — matches the constant in LivingBrainGraph.svelte
  // ---------------------------------------------------------------------------

  /** Duration of a pulse animation in milliseconds. */
  const PULSE_DURATION_MS = 1_500;

  // ---------------------------------------------------------------------------
  // DOM ref + cosmos instance
  // ---------------------------------------------------------------------------

  let container: HTMLDivElement;
  let cosmos: CosmosGraph | null = null;

  /**
   * Whether cosmos failed to initialise (WebGL2 unavailable or constructor
   * threw).  When true, the fallback message is rendered and the parent page
   * receives a signal to revert to the Standard renderer.
   */
  let initFailed = $state(false);

  /**
   * Human-readable reason for the init failure, shown in the fallback banner.
   */
  let failureReason = $state('');

  /**
   * Tracks whether the component has mounted (guards reactive effects from
   * firing before the DOM container is ready).
   */
  let mounted = false;

  /**
   * Index-keyed lookup: maps numeric point index → string node ID.
   * Rebuilt whenever the data changes.
   */
  let indexToId: string[] = [];

  // ---------------------------------------------------------------------------
  // Build flat typed arrays from LBNode[] / LBEdge[]
  // ---------------------------------------------------------------------------

  /**
   * Converts the current `nodes` and `edges` props into the flat Float32Array
   * buffers expected by cosmos.gl v2.
   *
   * All colour values are normalised to 0.0–1.0 as required by the WebGL
   * attribute buffers; passing 0–255 clamps every channel to white.
   *
   * @returns An object with positions, colors, sizes (points) and links, linkColors,
   *   linkWidths arrays, plus the rebuilt indexToId map.
   */
  function buildBuffers(): {
    positions: Float32Array;
    colors: Float32Array;
    sizes: Float32Array;
    links: Float32Array;
    linkColors: Float32Array;
    linkWidths: Float32Array;
    idToIndex: Map<string, number>;
    idxToId: string[];
  } {
    const idToIndex = new Map<string, number>();
    const idxToId: string[] = [];

    // Assign stable indices for all nodes
    nodes.forEach((n, i) => {
      idToIndex.set(n.id, i);
      idxToId.push(n.id);
    });

    // Point positions: random initial layout (cosmos simulates from here)
    const positions = new Float32Array(nodes.length * 2);
    for (let i = 0; i < nodes.length; i++) {
      positions[i * 2] = Math.random() * 800 - 400;
      positions[i * 2 + 1] = Math.random() * 600 - 300;
    }

    // Point colours: [r, g, b, a, ...] — all values in 0.0–1.0 (WebGL range)
    const colors = new Float32Array(nodes.length * 4);
    for (let i = 0; i < nodes.length; i++) {
      const hex = SUBSTRATE_COLOR[nodes[i].substrate] ?? '#64748b';
      const [r, g, b, a] = hexToRgba(hex, 0.9);
      colors[i * 4] = r;
      colors[i * 4 + 1] = g;
      colors[i * 4 + 2] = b;
      colors[i * 4 + 3] = a;
    }

    // Point sizes
    const sizes = new Float32Array(nodes.length);
    for (let i = 0; i < nodes.length; i++) {
      sizes[i] = nodeSize(nodes[i]);
    }

    // Filter valid edges: both endpoints must exist and no self-loops
    const validEdges: LBEdge[] = [];
    const seenEdges = new Set<string>();
    for (const e of edges) {
      if (e.source === e.target) continue;
      if (!idToIndex.has(e.source) || !idToIndex.has(e.target)) continue;
      const key = `${e.source}|${e.target}`;
      if (seenEdges.has(key)) continue;
      seenEdges.add(key);
      validEdges.push(e);
    }

    // Link index pairs: [src0, tgt0, src1, tgt1, ...]
    const links = new Float32Array(validEdges.length * 2);
    // Link colours: [r, g, b, a, ...] — all values in 0.0–1.0 (WebGL range)
    const linkColors = new Float32Array(validEdges.length * 4);
    const linkWidths = new Float32Array(validEdges.length);

    for (let i = 0; i < validEdges.length; i++) {
      const e = validEdges[i];
      const srcIdx = idToIndex.get(e.source) ?? 0;
      const tgtIdx = idToIndex.get(e.target) ?? 0;
      links[i * 2] = srcIdx;
      links[i * 2 + 1] = tgtIdx;

      const [r, g, b, a] = edgeRgba(e.type);
      linkColors[i * 4] = r;
      linkColors[i * 4 + 1] = g;
      linkColors[i * 4 + 2] = b;
      linkColors[i * 4 + 3] = a;

      linkWidths[i] = 0.5 + (e.weight ?? 0.5) * 2.5;
    }

    return { positions, colors, sizes, links, linkColors, linkWidths, idToIndex, idxToId };
  }

  // ---------------------------------------------------------------------------
  // Pulse handling
  //
  // cosmos.gl v2 has no per-node animation API.  We approximate pulse feedback
  // by zooming to the first pulsing node (if any) and re-uploading the color
  // buffer with pulsing nodes brightened to white, then restoring after
  // PULSE_DURATION_MS.  This is a best-effort trade-off relative to sigma's
  // frame-by-frame pulse; documented in the Props TSDoc.
  // ---------------------------------------------------------------------------

  /**
   * Applies a best-effort pulse visual for nodes in `pulsingNodes`.
   *
   * Uploads a modified color buffer with pulsing nodes set to white, then
   * schedules restoration after `PULSE_DURATION_MS`.
   *
   * @param idToIndex - Current ID→index map.
   */
  function applyPulses(idToIndex: Map<string, number>): void {
    if (!cosmos || pulsingNodes.size === 0) return;

    // Rebuild base colors in 0.0–1.0 range, override pulsing nodes to white
    const colors = new Float32Array(nodes.length * 4);
    for (let i = 0; i < nodes.length; i++) {
      const isPulsing = pulsingNodes.has(nodes[i].id);
      const hex = isPulsing ? '#ffffff' : (SUBSTRATE_COLOR[nodes[i].substrate] ?? '#64748b');
      const alpha = isPulsing ? 1.0 : 0.9;
      const [r, g, b, a] = hexToRgba(hex, alpha);
      colors[i * 4] = r;
      colors[i * 4 + 1] = g;
      colors[i * 4 + 2] = b;
      colors[i * 4 + 3] = a;
    }

    cosmos.setPointColors(colors);

    // Zoom to the first pulsing node's position as a visual beacon
    const firstId = [...pulsingNodes][0];
    if (firstId !== undefined) {
      const idx = idToIndex.get(firstId);
      if (idx !== undefined) {
        cosmos.zoomToPointByIndex(idx, 500, 2, false);
      }
    }

    // Restore base colors after pulse duration
    setTimeout(() => {
      if (!cosmos) return;
      const restored = new Float32Array(nodes.length * 4);
      for (let i = 0; i < nodes.length; i++) {
        const hex = SUBSTRATE_COLOR[nodes[i].substrate] ?? '#64748b';
        const [r, g, b, a] = hexToRgba(hex, 0.9);
        restored[i * 4] = r;
        restored[i * 4 + 1] = g;
        restored[i * 4 + 2] = b;
        restored[i * 4 + 3] = a;
      }
      cosmos.setPointColors(restored);
    }, PULSE_DURATION_MS);
  }

  // ---------------------------------------------------------------------------
  // WebGL2 availability check
  // ---------------------------------------------------------------------------

  /**
   * Returns true when the browser can create a WebGL2 context.
   *
   * cosmos.gl uses regl which falls back to WebGL1, but an early check lets us
   * show a meaningful fallback rather than a silent blank canvas.
   */
  function checkWebGl(): boolean {
    try {
      const testCanvas = document.createElement('canvas');
      const gl = testCanvas.getContext('webgl2') ?? testCanvas.getContext('webgl');
      return gl !== null;
    } catch {
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Initialise cosmos
  // ---------------------------------------------------------------------------

  /**
   * Builds all buffer arrays and creates (or recreates) the cosmos.gl GPU
   * renderer.  Destroys any existing instance first to avoid canvas leaks.
   *
   * Wrapped in try/catch: on any failure (WebGL unavailable, API mismatch,
   * etc.) `initFailed` is set and a user-visible fallback is rendered.
   */
  function initCosmos(): void {
    if (!mounted || !container) return;

    // Destroy previous instance
    if (cosmos) {
      cosmos.destroy();
      cosmos = null;
    }

    // Pre-flight: confirm WebGL is available before handing control to regl
    if (!checkWebGl()) {
      initFailed = true;
      failureReason = 'WebGL not available in this browser';
      onInitFailed?.('WebGL not available in this browser');
      return;
    }

    try {
      const { positions, colors, sizes, links, linkColors, linkWidths, idToIndex, idxToId } =
        buildBuffers();

      indexToId = idxToId;

      const config: GraphConfigInterface = {
        backgroundColor: '#0a0d14',
        spaceSize: 4096,
        pointColor: '#64748b',
        pointSize: 6,
        renderHoveredPointRing: true,
        hoveredPointRingColor: '#ffffff',
        hoveredPointCursor: 'pointer',
        linkColor: '#94a3b8',
        linkWidth: 1,
        renderLinks: true,
        simulationGravity: 0.25,
        simulationRepulsion: 1.0,
        simulationLinkSpring: 1.0,
        simulationLinkDistance: 10,
        simulationFriction: 0.85,
        fitViewDelay: 800,
        fitViewPadding: 0.15,
        onClick: (index: number | undefined) => {
          if (index === undefined) return;
          const id = indexToId[index];
          if (id !== undefined) onNodeClick?.(id);
        },
      };

      cosmos = new CosmosGraph(container, config);

      cosmos.setPointPositions(positions);
      cosmos.setPointColors(colors);
      cosmos.setPointSizes(sizes);
      cosmos.setLinks(links);
      cosmos.setLinkColors(linkColors);
      cosmos.setLinkWidths(linkWidths);

      // CRITICAL: cosmos.gl 2.0 requires `render()` — not `start()` — as the
      // very first call after setting data via set*() methods.
      //
      // Root cause (T685): after `new CosmosGraph(container, config)` and before
      // any data upload, `graph.pointPositions` is undefined, so
      // `graph.pointsNumber` returns `undefined` (falsy).  `start()` guards on
      // `this.graph.pointsNumber` and silently does NOTHING when it is falsy.
      //
      // `render(alpha)` calls `this.graph.update()` first, which copies
      // `inputPointPositions → pointPositions` (making `pointsNumber` valid),
      // then calls `this.update(alpha)` which runs `create()` + `initPrograms()`
      // + `start(alpha)` — the full initialisation sequence.
      //
      // On subsequent data refreshes the component calls `initCosmos()` which
      // destroys the old instance and creates a fresh one, so this first-render
      // path is always exercised for every mount.
      cosmos.render(1.0);

      // Apply any initial pulses
      if (pulsingNodes.size > 0) {
        const idToIdx = new Map<string, number>();
        for (let i = 0; i < idxToId.length; i++) {
          const id = idxToId[i];
          if (id !== undefined) idToIdx.set(id, i);
        }
        applyPulses(idToIdx);
      }

      // Fit the camera to the simulated layout. We schedule three attempts:
      //   - 500ms (after first paint cycle when CSS grid has computed dimensions)
      //   - immediate via requestAnimationFrame (in case simulation settled fast)
      //   - 1.5s later (after most force-layout convergence)
      setTimeout(() => {
        if (cosmos) cosmos.fitView(500, 0.15);
      }, 500);
      requestAnimationFrame(() => {
        if (cosmos) cosmos.fitView(800, 0.15);
      });
      setTimeout(() => {
        if (cosmos) cosmos.fitView(500, 0.15);
      }, 1_500);

      initFailed = false;
      failureReason = '';
    } catch (err) {
      cosmos = null;
      initFailed = true;
      const reason =
        err instanceof Error ? err.message : 'cosmos.gl renderer failed to initialise';
      failureReason = reason;
      onInitFailed?.(reason);
    }
  }

  // ---------------------------------------------------------------------------
  // Mount / destroy
  // ---------------------------------------------------------------------------

  onMount(() => {
    mounted = true;
    initCosmos();
  });

  onDestroy(() => {
    mounted = false;
    cosmos?.destroy();
    cosmos = null;
  });

  // ---------------------------------------------------------------------------
  // React to data changes — rebuild entire renderer
  //
  // The effect explicitly reads `nodes` and `edges` to track them as reactive
  // deps.  It only calls initCosmos when mounted (container is available);
  // this prevents a double-init on the initial mount tick.
  // ---------------------------------------------------------------------------

  $effect(() => {
    // Capture reactive deps: any change to nodes or edges triggers this block.
    // Using void casts prevents the linter from complaining about unused reads.
    void nodes;
    void edges;
    // Only re-init after the component has fully mounted so that `container`
    // is bound.  The onMount handler covers the initial init.
    if (mounted && cosmos !== null) {
      initCosmos();
    }
  });

  // ---------------------------------------------------------------------------
  // React to pulse changes
  // ---------------------------------------------------------------------------

  $effect(() => {
    if (!cosmos || pulsingNodes.size === 0) return;
    // Build current idToIndex on demand (indexToId is always in sync post-init)
    const idToIndex = new Map<string, number>();
    for (let i = 0; i < indexToId.length; i++) {
      const id = indexToId[i];
      if (id !== undefined) idToIndex.set(id, i);
    }
    applyPulses(idToIndex);
  });
</script>

<div class="lbc-wrap" style="height: {height}; position: relative;">
  {#if initFailed}
    <!-- Graceful fallback: GPU renderer unavailable -->
    <div class="lbc-fallback">
      <span class="lbc-fallback-icon">!</span>
      <span class="lbc-fallback-msg">
        GPU renderer unavailable — using Standard
        {#if failureReason}
          <span class="lbc-fallback-reason">({failureReason})</span>
        {/if}
      </span>
    </div>
  {:else}
    <div class="lbc-canvas" bind:this={container}></div>

    {#if nodes.length === 0}
      <div class="lbc-empty">No data to display</div>
    {/if}

    <!-- GPU mode badge -->
    <div class="lbc-badge" aria-label="GPU-accelerated renderer active">GPU</div>
  {/if}
</div>

<style>
  .lbc-wrap {
    width: 100%;
    height: 100%;
    min-height: 0;
    background: #0a0d14;
    border-radius: 8px;
    overflow: hidden;
    border: 1px solid #2d3748;
    position: relative;
  }

  .lbc-canvas {
    width: 100%;
    height: 100%;
    min-height: 0;
  }

  /* cosmos.gl renders into a child canvas — ensure it fills the container */
  .lbc-canvas :global(canvas) {
    width: 100% !important;
    height: 100% !important;
    display: block;
  }

  .lbc-empty {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #64748b;
    font-size: 0.875rem;
  }

  .lbc-badge {
    position: absolute;
    bottom: 0.5rem;
    right: 0.625rem;
    padding: 0.1rem 0.4rem;
    border-radius: 4px;
    background: rgba(168, 85, 247, 0.15);
    border: 1px solid rgba(168, 85, 247, 0.4);
    color: #a855f7;
    font-size: 0.625rem;
    font-weight: 700;
    letter-spacing: 0.08em;
    pointer-events: none;
  }

  /* Fallback banner shown when cosmos.gl fails to initialise */
  .lbc-fallback {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    padding: 1rem;
    background: rgba(239, 68, 68, 0.06);
    border: 1px solid rgba(239, 68, 68, 0.3);
    border-radius: 8px;
    color: #ef4444;
    font-size: 0.8125rem;
    font-weight: 500;
  }

  .lbc-fallback-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.25rem;
    height: 1.25rem;
    border-radius: 50%;
    border: 1.5px solid #ef4444;
    font-size: 0.75rem;
    font-weight: 700;
    flex-shrink: 0;
  }

  .lbc-fallback-reason {
    color: #f87171;
    font-weight: 400;
    font-style: italic;
    margin-left: 0.25rem;
  }
</style>
