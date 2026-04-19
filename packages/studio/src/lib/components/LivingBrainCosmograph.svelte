<!--
  LivingBrainCosmograph — cosmos.gl GPU-accelerated Flat 2D renderer.

  Post-T990-Wave-1A rebuild: this component now consumes the shared
  kit types ({@link GraphNode} / {@link GraphEdge}) directly — the
  unified /brain page passes kit data from the same adapter the 3D
  renderer uses, so there is a single source of truth for the graph
  shape across both renderers.

  Colours are resolved from tokens at runtime via `getComputedStyle`
  (same trick as `edge-kinds.ts`) — NO hex literals live in this
  file.  Background, fallback dot colour, and edge hues all come from
  `tokens.css`.

  @task T990
-->
<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { Graph as CosmosGraph } from '@cosmograph/cosmos';
  import type { GraphConfigInterface } from '@cosmograph/cosmos';
  import {
    ALL_SUBSTRATES,
    type EdgeKind,
    type GraphEdge,
    type GraphNode,
    type SubstrateId,
    resolveEdgeStyleForWebGL,
  } from '$lib/graph/index.js';

  // ---------------------------------------------------------------------------
  // Props — kit types.  The parent passes the same {@link GraphNode} +
  // {@link GraphEdge} arrays it feeds into {@link ThreeBrainRenderer}.
  // ---------------------------------------------------------------------------

  /**
   * Props for {@link LivingBrainCosmograph}.
   */
  interface Props {
    /** Nodes (kit contract). */
    nodes: GraphNode[];
    /** Edges (kit contract). */
    edges: GraphEdge[];
    /** Fired when the user clicks a node. Passes the node. */
    onNodeSelect?: (node: GraphNode) => void;
    /** Fired when the user clicks empty canvas. */
    onCanvasClear?: () => void;
    /** CSS height of the canvas. */
    height?: string;
    /**
     * Set of node IDs currently pulsing (new/updated).
     *
     * cosmos.gl 2.0 has no per-node animation API; when the set is
     * non-empty we `zoomToPointByIndex` on the first pulsing node and
     * briefly brighten its colour, restoring after
     * {@link PULSE_DURATION_MS}.
     */
    pulsingNodes?: Set<string>;
    /**
     * Called when cosmos.gl fails to initialise (e.g. no WebGL).  The
     * parent page should fall back to the 3D renderer so the operator
     * never sees a blank canvas.
     */
    onInitFailed?: (reason: string) => void;
  }

  let {
    nodes,
    edges,
    onNodeSelect,
    onCanvasClear,
    height = '100%',
    pulsingNodes = new Set<string>(),
    onInitFailed,
  }: Props = $props();

  // ---------------------------------------------------------------------------
  // Tokens — resolved at runtime
  // ---------------------------------------------------------------------------

  /** Substrate accent tokens. */
  const SUBSTRATE_TOKEN: Record<SubstrateId, string> = {
    brain: 'var(--info)',
    nexus: 'var(--success)',
    tasks: 'var(--warning)',
    conduit: 'var(--accent)',
    signaldock: 'var(--danger)',
  };

  /**
   * RGBA tuple in cosmos.gl 2.x wire format for `setPointColors` /
   * `setLinkColors` buffers: RGB + alpha all in `[0..1]`.
   *
   * Verified against the 2.0-beta.26 source (`dist/index.js` `updatePointColor`
   * and `sr()` helper): the Float32Array passed via `setPointColors` is used
   * **directly** as the WebGL texture without further normalisation. The
   * internal config-default resolver (`sr(string)`) divides 0-255 CSS values
   * by 255 before writing, so both paths end at `[0..1]`. The migration
   * guide example (`0.5, 0.5, 1, 1`) reflects this; the d.ts docstring
   * example using `255, 0, 0, 1` was misleading and produced the
   * "white blob" regression because values >1 clamp to 1.0 in the shader.
   */
  type Rgba = [number, number, number, number];

  /**
   * Resolve a CSS colour expression to cosmos.gl 2.x's wire format
   * (`RGB ∈ [0..1]`, `alpha ∈ [0..1]`) by letting the browser compute
   * the value against `:root`. Returns a neutral mid-grey in SSR /
   * non-DOM contexts.
   */
  function resolveCssColor(expr: string, alpha = 0.9): Rgba {
    if (typeof document === 'undefined' || typeof window === 'undefined') {
      return [0.5, 0.5, 0.5, alpha];
    }
    const probe = document.createElement('span');
    probe.style.color = expr;
    probe.style.position = 'absolute';
    probe.style.visibility = 'hidden';
    document.body.appendChild(probe);
    const computed = window.getComputedStyle(probe).color;
    document.body.removeChild(probe);
    const m = /rgba?\(([^)]+)\)/i.exec(computed);
    if (!m) return [1, 1, 1, alpha];
    const parts = m[1].split(/[,\s/]+/).filter((p) => p.length > 0);
    return [
      Number.parseFloat(parts[0]) / 255,
      Number.parseFloat(parts[1]) / 255,
      Number.parseFloat(parts[2]) / 255,
      alpha,
    ];
  }

  /** Cache resolved substrate colours — rebuilt per initCosmos. */
  const substrateRgba = new Map<SubstrateId, Rgba>();

  /** Derives the node display size from its weight. */
  function nodeSize(node: GraphNode): number {
    const w = node.weight ?? 0.3;
    return 4 + w * 14;
  }

  /** Pulse duration (ms) — mirrors ThreeBrainRenderer. */
  const PULSE_DURATION_MS = 1_500;

  // ---------------------------------------------------------------------------
  // DOM ref + cosmos instance
  // ---------------------------------------------------------------------------

  let container = $state<HTMLDivElement | null>(null);
  let cosmos: CosmosGraph | null = null;

  /** Whether cosmos failed to initialise. */
  let initFailed = $state(false);
  /** Human-readable reason for the init failure. */
  let failureReason = $state('');

  /**
   * Whether the component has mounted. Plain boolean — NOT `$state`.
   *
   * This must not be reactive. Making it `$state` caused the data-change
   * `$effect` to access it (triggering tracking) and the first time
   * `initCosmos` set `cosmosInitialized = true` the effect re-evaluated,
   * which called `initCosmos` again, destroying and recreating cosmos in
   * an infinite loop that froze the browser.
   */
  let mounted = false;

  /**
   * Whether cosmos has been initialised at least once for this mount.
   * Plain boolean — NOT `$state` for the same reason as `mounted`.
   * The data-change `$effect` must never track this value.
   */
  let cosmosInitialized = false;

  /** ResizeObserver reference so we can rebuild on size change. */
  let resizeObs: ResizeObserver | null = null;
  /** indexToId lookup, rebuilt on every data refresh. */
  let indexToId: string[] = [];
  /** indexToNode lookup, so onClick can hand the parent a full node. */
  let indexToNode: GraphNode[] = [];

  /**
   * Snapshot of the node + edge counts last seen by the data-change
   * `$effect`.  When the arrays do not change identity, this prevents
   * spurious rebuilds.
   */
  let lastNodeCount = -1;
  let lastEdgeCount = -1;

  // ---------------------------------------------------------------------------
  // Build flat typed arrays from GraphNode[] / GraphEdge[]
  // ---------------------------------------------------------------------------

  /**
   * Flatten the current props into cosmos.gl v2 buffers.  All colours
   * are in [0..1] (WebGL range).  Edges are de-duplicated and
   * endpoint-verified; self-loops are dropped.
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
    idxToNode: GraphNode[];
  } {
    const idToIndex = new Map<string, number>();
    const idxToId: string[] = [];
    const idxToNode: GraphNode[] = [];

    nodes.forEach((n, i) => {
      idToIndex.set(n.id, i);
      idxToId.push(n.id);
      idxToNode.push(n);
    });

    // Initial positions: tight 1% cluster at the center of the space,
    // matching the pattern used by cosmos.gl 2.x's own `beginners/basic-
    // set-up` example (`src/stories/beginners/basic-set-up/data-gen.ts`).
    // The simulation's repulsion force then spreads them outward over the
    // first ~50 frames into the organic layout.
    //
    // Seeding with a WIDE random spread (our prior attempt) defeated the
    // sim: gravity pulled them all back to centre anyway and the
    // simulation energy burned off before they could re-separate, leaving
    // everything stacked on top of each other — the exact regression the
    // operator reported.
    const SPACE_SIZE = 4096;
    const CENTER = SPACE_SIZE / 2;
    const SPREAD = SPACE_SIZE * 0.01; // 1% of spaceSize
    const positions = new Float32Array(nodes.length * 2);
    for (let i = 0; i < nodes.length; i++) {
      positions[i * 2] = CENTER + (Math.random() - 0.5) * SPREAD;
      positions[i * 2 + 1] = CENTER + (Math.random() - 0.5) * SPREAD;
    }

    // Cosmos.gl 2.x expects RGB in [0..255], alpha in [0..1]. The
    // substrateRgba cache is already in that format; the fallback grey
    // below is `(128, 128, 128, 0.9)`, not `(0.5, 0.5, 0.5, 0.9)`.
    const colors = new Float32Array(nodes.length * 4);
    for (let i = 0; i < nodes.length; i++) {
      const rgba = substrateRgba.get(nodes[i].substrate) ?? [0.5, 0.5, 0.5, 0.9];
      colors[i * 4] = rgba[0];
      colors[i * 4 + 1] = rgba[1];
      colors[i * 4 + 2] = rgba[2];
      colors[i * 4 + 3] = rgba[3];
    }

    const sizes = new Float32Array(nodes.length);
    for (let i = 0; i < nodes.length; i++) {
      sizes[i] = nodeSize(nodes[i]);
    }

    // Filter valid edges: both endpoints must exist, no self-loops,
    // no duplicate src|tgt pairs.
    const validEdges: GraphEdge[] = [];
    const seenEdges = new Set<string>();
    for (const e of edges) {
      if (e.source === e.target) continue;
      if (!idToIndex.has(e.source) || !idToIndex.has(e.target)) continue;
      const key = `${e.source}|${e.target}`;
      if (seenEdges.has(key)) continue;
      seenEdges.add(key);
      validEdges.push(e);
    }

    const links = new Float32Array(validEdges.length * 2);
    const linkColors = new Float32Array(validEdges.length * 4);
    const linkWidths = new Float32Array(validEdges.length);

    for (let i = 0; i < validEdges.length; i++) {
      const e = validEdges[i];
      const srcIdx = idToIndex.get(e.source) ?? 0;
      const tgtIdx = idToIndex.get(e.target) ?? 0;
      links[i * 2] = srcIdx;
      links[i * 2 + 1] = tgtIdx;

      // resolveEdgeStyleForWebGL returns RGB in [0..1] — the same scale
      // cosmos.gl 2.x's setLinkColors buffer expects. Pass through directly.
      const rgb = resolveEdgeStyleForWebGL(e.kind satisfies EdgeKind);
      linkColors[i * 4] = rgb[0];
      linkColors[i * 4 + 1] = rgb[1];
      linkColors[i * 4 + 2] = rgb[2];
      linkColors[i * 4 + 3] = 0.7;

      linkWidths[i] = 0.5 + (e.weight ?? 0.5) * 2.5;
    }

    return { positions, colors, sizes, links, linkColors, linkWidths, idToIndex, idxToId, idxToNode };
  }

  // ---------------------------------------------------------------------------
  // Pulse handling — best-effort per-node flash via colour-buffer re-upload.
  // ---------------------------------------------------------------------------

  /**
   * Brighten pulsing nodes to near-white, re-upload the colour buffer,
   * then restore after {@link PULSE_DURATION_MS}.
   */
  function applyPulses(idToIndex: Map<string, number>): void {
    if (!cosmos || pulsingNodes.size === 0) return;
    const white = resolveCssColor('var(--text)', 1);
    const colors = new Float32Array(nodes.length * 4);
    for (let i = 0; i < nodes.length; i++) {
      const isPulsing = pulsingNodes.has(nodes[i].id);
      const rgba = isPulsing ? white : (substrateRgba.get(nodes[i].substrate) ?? [0.5, 0.5, 0.5, 0.9]);
      colors[i * 4] = rgba[0];
      colors[i * 4 + 1] = rgba[1];
      colors[i * 4 + 2] = rgba[2];
      colors[i * 4 + 3] = isPulsing ? 1 : rgba[3];
    }
    cosmos.setPointColors(colors);

    const firstId = [...pulsingNodes][0];
    if (firstId !== undefined) {
      const idx = idToIndex.get(firstId);
      if (idx !== undefined) {
        cosmos.zoomToPointByIndex(idx, 500, 2, false);
      }
    }

    setTimeout(() => {
      if (!cosmos) return;
      const restored = new Float32Array(nodes.length * 4);
      for (let i = 0; i < nodes.length; i++) {
        const rgba = substrateRgba.get(nodes[i].substrate) ?? [0.5, 0.5, 0.5, 0.9];
        restored[i * 4] = rgba[0];
        restored[i * 4 + 1] = rgba[1];
        restored[i * 4 + 2] = rgba[2];
        restored[i * 4 + 3] = rgba[3];
      }
      cosmos.setPointColors(restored);
    }, PULSE_DURATION_MS);
  }

  // ---------------------------------------------------------------------------
  // WebGL2 availability check
  // ---------------------------------------------------------------------------

  /** Returns true when the browser can create a WebGL(2) context. */
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

  function initCosmos(): void {
    if (!mounted || !container) return;

    if (cosmos) {
      cosmos.destroy();
      cosmos = null;
    }

    if (!checkWebGl()) {
      initFailed = true;
      failureReason = 'WebGL not available in this browser';
      onInitFailed?.('WebGL not available in this browser');
      return;
    }

    // Refresh substrate colour cache against the current theme.
    substrateRgba.clear();
    for (const s of ALL_SUBSTRATES) substrateRgba.set(s, resolveCssColor(SUBSTRATE_TOKEN[s], 0.9));

    try {
      const { positions, colors, sizes, links, linkColors, linkWidths, idToIndex, idxToId, idxToNode } =
        buildBuffers();

      indexToId = idxToId;
      indexToNode = idxToNode;

      // Resolve config colours from tokens.  `backgroundColor` accepts
      // a CSS string; we hand through the tokens.css definition so
      // theme swaps flow through.
      const bgExpr = getComputedStyleRootValue('--bg', 'black');
      const fallbackPoint = getComputedStyleRootValue('--text-dim', 'gray');
      const fallbackLink = getComputedStyleRootValue('--border-strong', 'gray');
      const hoverRing = getComputedStyleRootValue('--text', 'white');

      // Physics tuned to match cosmos.gl 2.x's own reference `beginners/
      // basic-set-up` example (copied verbatim from
      // `node_modules/@cosmograph/cosmos/src/stories/beginners/
      // basic-set-up/index.ts`). Every prior home-grown tune collapsed
      // the graph into a single blob because we didn't realise:
      //
      //   1. `simulationLinkDistance` is NOT a pixel distance — at
      //      `1` it means "try to keep linked points close"; the
      //      repulsion force spreads them anyway.
      //   2. `simulationDecay: 100000` is intentionally huge so the
      //      simulation stays live for minutes, not seconds — it keeps
      //      the "breathing" motion going.
      //   3. `pointSize: 4` with `pointSizeScale: 1` (default) is what
      //      cosmos ships for dense graphs; 6 looked right on 200-node
      //      demos but clumped visually at 1500+.
      const config: GraphConfigInterface = {
        backgroundColor: bgExpr,
        spaceSize: 4096,
        pointColor: fallbackPoint,
        pointSize: 4,
        renderHoveredPointRing: true,
        hoveredPointRingColor: hoverRing,
        hoveredPointCursor: 'pointer',
        linkColor: fallbackLink,
        linkWidth: 0.1,
        linkGreyoutOpacity: 0,
        renderLinks: true,
        curvedLinks: true,
        simulationLinkDistance: 1,
        simulationLinkSpring: 2,
        simulationRepulsion: 0.2,
        simulationGravity: 0.1,
        simulationDecay: 100000,
        onClick: (index: number | undefined) => {
          if (index === undefined) {
            onCanvasClear?.();
            return;
          }
          const node = indexToNode[index];
          if (node !== undefined) onNodeSelect?.(node);
        },
      };

      cosmos = new CosmosGraph(container, config);

      cosmos.setPointPositions(positions);
      cosmos.setPointColors(colors);
      cosmos.setPointSizes(sizes);
      cosmos.setLinks(links);
      cosmos.setLinkColors(linkColors);
      cosmos.setLinkWidths(linkWidths);

      // Call pattern copied verbatim from the cosmos.gl 2.x reference
      // example (`beginners/basic-set-up`): `zoom(0.9); render();`
      // without passing a simulation alpha. The library decides the
      // starting alpha internally against its `simulationDecay` config.
      // Calling `render(1.0)` explicitly (our prior approach) over-ran
      // the alpha and caused the simulation to peak instantly then
      // decay before nodes had time to spread.
      cosmos.zoom(0.9);
      cosmos.render();

      // Mark initialized BEFORE scheduling pulse or fit callbacks so that
      // any re-entrant code that checks cosmosInitialized sees the right state.
      cosmosInitialized = true;

      if (pulsingNodes.size > 0) {
        const idToIdx = new Map<string, number>();
        for (let i = 0; i < idxToId.length; i++) {
          const id = idxToId[i];
          if (id !== undefined) idToIdx.set(id, i);
        }
        applyPulses(idToIdx);
      }

      // One late fit once the simulation has had ~3s to spread nodes
      // naturally. Calling fitView any earlier zooms to a transient
      // tight cluster, then the camera stays pinned there as nodes
      // spread out — the "nodes flash then vanish" symptom. Single
      // late fit avoids the race without fighting `simulationDecay`.
      setTimeout(() => {
        if (cosmos) cosmos.fitView(800, 0.18);
      }, 3000);

      initFailed = false;
      failureReason = '';
    } catch (err) {
      cosmos = null;
      cosmosInitialized = false;
      initFailed = true;
      const reason =
        err instanceof Error ? err.message : 'cosmos.gl renderer failed to initialise';
      failureReason = reason;
      onInitFailed?.(reason);
    }
  }

  /**
   * Look up a custom property on `:root` and return its value as a CSS
   * string the browser can parse.  Falls back to the given neutral
   * default in SSR.
   */
  function getComputedStyleRootValue(varName: string, fallback: string): string {
    if (typeof document === 'undefined' || typeof window === 'undefined') return fallback;
    const value = window.getComputedStyle(document.documentElement).getPropertyValue(varName);
    return value.trim() || fallback;
  }

  // ---------------------------------------------------------------------------
  // Mount / destroy
  // ---------------------------------------------------------------------------

  /**
   * Waits until the container has a non-zero layout size, then initialises
   * cosmos. Without this, `new CosmosGraph(container, ...)` can measure a
   * 0×0 container during the `{#if}` branch swap and produce a zero-sized
   * canvas that never renders. ResizeObserver fires synchronously on the
   * first layout pass.
   *
   * Note: cosmos.gl 2.x also calls `resizeCanvas()` on every animation
   * frame, so a 0×0 init will self-heal once the layout settles, but
   * waiting for a non-zero size gives a cleaner first frame.
   */
  function initWhenSized(): void {
    if (!container) return;
    const el = container;
    if (el.clientWidth > 0 && el.clientHeight > 0) {
      initCosmos();
      return;
    }
    resizeObs?.disconnect();
    resizeObs = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height: h } = entry.contentRect;
        if (width > 0 && h > 0) {
          resizeObs?.disconnect();
          resizeObs = null;
          initCosmos();
          return;
        }
      }
    });
    resizeObs.observe(el);
  }

  onMount(() => {
    mounted = true;
    // Double rAF gives the browser one full layout + paint cycle after the
    // `{#if}` branch swap before we measure the container.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (mounted) initWhenSized();
      });
    });
  });

  onDestroy(() => {
    mounted = false;
    cosmosInitialized = false;
    resizeObs?.disconnect();
    resizeObs = null;
    cosmos?.destroy();
    cosmos = null;
  });

  // ---------------------------------------------------------------------------
  // React to data changes — rebuild the renderer only when data actually
  // changes after initial mount.
  //
  // CRITICAL: this `$effect` must NOT read `mounted` or `cosmosInitialized`
  // (both are plain booleans, not `$state`).  If either were `$state`, the
  // effect would track them: setting `cosmosInitialized = true` inside
  // `initCosmos()` would re-trigger the effect, which would call `initCosmos()`
  // again, creating an infinite destroy-recreate loop that freezes the browser.
  //
  // The effect only tracks `nodes.length` and `edges.length`.  Initial mount
  // is handled exclusively by `onMount` → `initWhenSized` → `initCosmos`.
  // Subsequent data-driven rebuilds are handled here, gated by
  // `cosmosInitialized` (plain boolean, not tracked by Svelte).
  // ---------------------------------------------------------------------------

  $effect(() => {
    const nodeCount = nodes.length;
    const edgeCount = edges.length;

    // Guard: only rebuild after the initial mount has completed. We read
    // `cosmosInitialized` as a plain (non-reactive) boolean — Svelte will NOT
    // track it, so this check does not create a feedback cycle.
    if (!cosmosInitialized) return;

    // Guard: skip if the counts haven't actually changed.  This avoids a
    // spurious rebuild when Svelte re-runs the effect for unrelated reasons.
    if (nodeCount === lastNodeCount && edgeCount === lastEdgeCount) return;

    lastNodeCount = nodeCount;
    lastEdgeCount = edgeCount;

    initCosmos();
  });

  // ---------------------------------------------------------------------------
  // React to pulse changes
  // ---------------------------------------------------------------------------

  $effect(() => {
    const pulseCount = pulsingNodes.size;
    if (pulseCount === 0 || !cosmosInitialized) return;
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
        GPU renderer unavailable — using 3D
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
    background: var(--bg);
    border-radius: var(--radius-lg);
    overflow: hidden;
    border: 1px solid var(--border);
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
    color: var(--text-faint);
    font-size: var(--text-base);
  }

  .lbc-badge {
    position: absolute;
    bottom: var(--space-2);
    right: var(--space-2);
    padding: 0.1rem 0.4rem;
    border-radius: var(--radius-sm);
    background: var(--accent-soft);
    border: 1px solid var(--accent);
    color: var(--accent);
    font-size: var(--text-2xs);
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
    padding: var(--space-4);
    background: var(--danger-soft);
    border: 1px solid var(--danger);
    border-radius: var(--radius-lg);
    color: var(--danger);
    font-size: var(--text-sm);
    font-weight: 500;
  }

  .lbc-fallback-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.25rem;
    height: 1.25rem;
    border-radius: 50%;
    border: 1.5px solid var(--danger);
    font-size: var(--text-xs);
    font-weight: 700;
    flex-shrink: 0;
  }

  .lbc-fallback-reason {
    color: var(--danger);
    font-weight: 400;
    font-style: italic;
    margin-left: 0.25rem;
  }
</style>
