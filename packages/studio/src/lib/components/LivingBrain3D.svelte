<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import ForceGraph3D from '3d-force-graph';
  import * as THREE from 'three';
  import { EffectComposer, RenderPass, UnrealBloomPass } from 'three-stdlib';
  import type { LBNode, LBEdge, LBSubstrate } from '@cleocode/brain';
  import { livingBrainGraphStore } from '$lib/stores/living-brain-graph.js';
  import type Graph from 'graphology';

  // ---------------------------------------------------------------------------
  // Props — matches LivingBrainGraph and LivingBrainCosmograph
  // ---------------------------------------------------------------------------

  /**
   * Props interface matching LivingBrainGraph.svelte and
   * LivingBrainCosmograph.svelte for plug-compatible rendering.
   */
  interface Props {
    nodes: LBNode[];
    edges: LBEdge[];
    /** Fired when the user clicks a node. Passes the node ID. */
    onNodeClick?: (id: string) => void;
    height?: string;
    /** Set of node IDs currently pulsing (new/updated). */
    pulsingNodes?: Set<string>;
    /** Set of edge keys (`${source}|${target}`) currently pulsing. */
    pulsingEdges?: Set<string>;
    /** UnrealBloomPass intensity (strength) — controls neon synapse glow effect. */
    bloomIntensity?: number;
  }

  let {
    nodes,
    edges,
    onNodeClick,
    height = '100%',
    pulsingNodes = new Set<string>(),
    pulsingEdges = new Set<string>(),
    bloomIntensity = 1.5,
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

  /**
   * Edge type colour map — must match LivingBrainGraph edge colors
   * for visual consistency across renderers.
   */
  const EDGE_COLOR: Record<string, string> = {
    supersedes: '#ef4444',
    contradicts: '#dc2626',
    derived_from: '#f59e0b',
    produced_by: '#fb923c',
    informed_by: '#fbbf24',
    documents: '#10b981',
    summarizes: '#06b6d4',
    applies_to: '#22c55e',
    references: '#84cc16',
    code_reference: '#65a30d',
    modified_by: '#0ea5e9',
    affects: '#3b82f6',
    calls: '#94a3b8',
    has_method: '#cbd5e1',
    has_property: '#94a3b8',
    extends: '#a78bfa',
    implements: '#c084fc',
    imports: '#7dd3fc',
    contains: '#64748b',
    part_of: '#f97316',
    parent_of: '#fb923c',
    co_retrieved: '#a855f7',
    relates_to: '#a855f7',
    mentions: '#eab308',
    messages: '#fbbf24',
  };

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Derives node display size from the normalised weight value.
   * Matches the formula in LivingBrainGraph.svelte: 4 + w * 14
   *
   * @param node - The source LBNode.
   */
  function nodeSize(node: LBNode): number {
    const w = node.weight ?? 0.3;
    return 4 + w * 14;
  }

  /**
   * Returns the colour for an edge type with fallback.
   *
   * @param type - Edge type key.
   */
  function edgeColor(type: string): string {
    return EDGE_COLOR[type] ?? 'rgba(148,163,184,0.6)';
  }

  /**
   * Projects 3D world coordinates to 2D screen coordinates using camera projection.
   * Converts NDC (normalized device coordinates, -1 to +1) to screen pixels.
   * Returns null if point is behind camera (z > 1) or undefined camera.
   *
   * @param pos3d - 3D world position vector.
   * @param camera - THREE.Camera instance (typically PerspectiveCamera).
   * @param width - Canvas width in pixels.
   * @param height - Canvas height in pixels.
   */
  function projectToScreen(
    pos3d: THREE.Vector3,
    camera: THREE.Camera,
    width: number,
    height: number
  ): { x: number; y: number; z: number } | null {
    if (!camera) return null;

    const ndc = new THREE.Vector3();
    ndc.copy(pos3d);
    ndc.project(camera);

    // Cull points behind camera
    if (ndc.z > 1) return null;

    // Convert NDC (-1 to +1) to screen pixels
    const screenX = (ndc.x + 1) * 0.5 * width;
    const screenY = (1 - ndc.y) * 0.5 * height;

    return { x: screenX, y: screenY, z: ndc.z };
  }

  /**
   * Updates visible node list via 3D→2D projection.
   * Called each animation frame to track node labels as camera moves.
   */
  function updateLabelProjections(): void {
    if (!graph3d?.camera() || !graph3d.scene() || !container) {
      visibleNodes = [];
      return;
    }

    const camera = graph3d.camera();
    const width = container.clientWidth || 800;
    const height = container.clientHeight || 600;
    const scene = graph3d.scene();

    // Fetch node objects from 3d-force-graph
    const graphNodes: unknown[] | null = graph3d.graphData?.().nodes ?? null;
    if (!graphNodes) {
      visibleNodes = [];
      return;
    }

    const updates: VisibleNode[] = [];

    for (const nodeObj of graphNodes) {
      const node = nodeObj as {
        id: string;
        label: string;
        x?: number;
        y?: number;
        z?: number;
      } | null;

      if (!node || !node.label) continue;

      const pos3d = new THREE.Vector3(
        node.x ?? 0,
        node.y ?? 0,
        node.z ?? 0
      );

      const projected = projectToScreen(pos3d, camera, width, height);

      if (!projected) {
        updates.push({
          id: node.id,
          label: node.label,
          screenX: 0,
          screenY: 0,
          isVisible: false,
        });
        continue;
      }

      // Cull off-screen labels (with 20px margin buffer)
      const margin = 20;
      const isOffScreen =
        projected.x < -margin ||
        projected.x > width + margin ||
        projected.y < -margin ||
        projected.y > height + margin;

      updates.push({
        id: node.id,
        label: node.label,
        screenX: projected.x,
        screenY: projected.y,
        isVisible: !isOffScreen,
      });
    }

    visibleNodes = updates;
  }

  // ---------------------------------------------------------------------------
  // Pulse duration constant (ms) — must match LivingBrainGraph
  // ---------------------------------------------------------------------------

  /** How long a pulse animation lasts in milliseconds. */
  const PULSE_DURATION_MS = 1_500;

  // ---------------------------------------------------------------------------
  // Bloom pass constants
  // ---------------------------------------------------------------------------

  /** UnrealBloomPass configuration constants. */
  const BLOOM_CONFIG = {
    radius: 0.4,
    threshold: 0.85,
  };

  // ---------------------------------------------------------------------------
  // DOM ref + ForceGraph3D instance
  // ---------------------------------------------------------------------------

  let container: HTMLDivElement;
  let overlayRef: HTMLDivElement;
  let graph3d: ReturnType<typeof ForceGraph3D> | null = null;
  let mounted = false;

  /**
   * EffectComposer instance for post-processing pipeline.
   */
  let effectComposer: EffectComposer | null = null;

  /**
   * UnrealBloomPass instance for neon glow effect.
   */
  let bloomPass: UnrealBloomPass | null = null;

  /**
   * Maps node ID → THREE.Color for pulse tracking and restoration.
   */
  let nodeColorMap = new Map<string, THREE.Color>();

  /**
   * Maps edge key (`${source}|${target}`) → original color string for pulse restoration.
   */
  let edgeColorMap = new Map<string, string>();

  /**
   * Visible nodes with computed screen coordinates.
   * Updated via RAF in projection loop; used in Svelte each block.
   */
  interface VisibleNode {
    id: string;
    label: string;
    screenX: number;
    screenY: number;
    isVisible: boolean;
  }

  let visibleNodes = $state<VisibleNode[]>([]);

  /**
   * RAF handle for projection loop.
   */
  let projectionRafId: number | null = null;

  // ---------------------------------------------------------------------------
  // Bloom post-processing setup
  // ---------------------------------------------------------------------------

  /**
   * Initializes the EffectComposer with RenderPass and UnrealBloomPass.
   * Called after ForceGraph3D is fully initialized.
   */
  function initBloomPass(): void {
    if (!graph3d) return;

    try {
      // Get the effect composer from 3d-force-graph's postProcessingComposer API
      effectComposer = graph3d.postProcessingComposer() as EffectComposer;

      // Add RenderPass (required first pass to render the scene)
      const scene = graph3d.scene() as THREE.Scene;
      const camera = graph3d.camera() as THREE.Camera;

      // Clear any existing passes and add our passes
      const renderPass = new RenderPass(scene, camera);
      effectComposer.addPass(renderPass);

      // Create and add UnrealBloomPass with initial bloom intensity
      bloomPass = new UnrealBloomPass(
        new THREE.Vector2(container.clientWidth, container.clientHeight),
        bloomIntensity,
        BLOOM_CONFIG.radius,
        BLOOM_CONFIG.threshold
      );

      effectComposer.addPass(bloomPass);
    } catch (err) {
      // Silently fail if bloom setup fails — 3D renderer continues without bloom
      effectComposer = null;
      bloomPass = null;
    }
  }

  /**
   * Updates bloom pass intensity when bloomIntensity prop changes.
   */
  function updateBloomIntensity(): void {
    if (bloomPass) {
      bloomPass.strength = bloomIntensity;
    }
  }

  /**
   * Handles window resize: updates bloom pass resolution to avoid mismatch.
   */
  function handleResize(): void {
    if (!bloomPass || !container) return;

    const width = container.clientWidth;
    const height = container.clientHeight;

    if (width > 0 && height > 0) {
      bloomPass.resolution.set(width, height);
    }
  }

  /**
   * Disposes of bloom pass and effect composer resources.
   */
  function disposeBloom(): void {
    if (bloomPass) {
      bloomPass.dispose();
      bloomPass = null;
    }

    if (effectComposer) {
      effectComposer.dispose();
      effectComposer = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Build 3D force graph from shared Graphology instance or LBNode[] / LBEdge[]
  // ---------------------------------------------------------------------------

  /**
   * Extracts 3D node and link data from the shared Graphology instance.
   * This reuses the layout positions computed by ForceAtlas2 in LivingBrainGraph,
   * eliminating duplicate layout computation and API calls.
   *
   * @param graphologyInstance - The shared Graphology graph instance
   * @returns Object with `nodes` and `links` arrays ready for `.graphData()`
   */
  function buildGraphDataFromGraphology(graphologyInstance: Graph): {
    nodes: unknown[];
    links: unknown[];
  } {
    nodeColorMap.clear();
    edgeColorMap.clear();

    const graphNodes: unknown[] = [];

    // Extract nodes from graphology instance
    for (const nodeId of graphologyInstance.nodes()) {
      const attrs = graphologyInstance.getNodeAttributes(nodeId) as {
        label?: string;
        size?: number;
        color?: string;
        substrate?: LBSubstrate;
        kind?: string;
        weight?: number;
        x?: number;
        y?: number;
      };

      if (!attrs.label) continue;

      const color = attrs.color ?? '#64748b';
      nodeColorMap.set(nodeId, new THREE.Color(color));

      graphNodes.push({
        id: nodeId,
        label: attrs.label,
        size: attrs.size ?? 8,
        color,
        substrate: attrs.substrate ?? 'brain',
        kind: attrs.kind ?? 'unknown',
        weight: attrs.weight,
        x: attrs.x,
        y: attrs.y,
        z: 0, // Start at z=0; force simulation will adjust
      });
    }

    const graphLinks: unknown[] = [];
    const seenEdges = new Set<string>();

    // Extract edges from graphology instance
    for (const [src, tgt] of graphologyInstance.edges()) {
      const edgeKey = `${src}|${tgt}`;
      if (seenEdges.has(edgeKey)) continue;
      seenEdges.add(edgeKey);

      const attrs = graphologyInstance.getEdgeAttributes([src, tgt]) as {
        color?: string;
        edgeType?: string;
        size?: number;
      };

      const color = attrs.color ?? 'rgba(148,163,184,0.6)';
      edgeColorMap.set(edgeKey, color);

      graphLinks.push({
        source: src,
        target: tgt,
        color,
        type: attrs.edgeType ?? 'unknown',
      });
    }

    return { nodes: graphNodes, links: graphLinks };
  }

  /**
   * Constructs the nodes and links data structures for ForceGraph3D from LBNode[]/LBEdge[].
   * Used as fallback when shared Graphology instance is not available.
   * Returns an object with `nodes` and `links` arrays ready for `.graphData()`.
   */
  function buildGraphDataFromProps(): { nodes: unknown[]; links: unknown[] } {
    // Clear color maps for rebuild
    nodeColorMap.clear();
    edgeColorMap.clear();

    const graphNodes = nodes.map((n) => {
      const baseColor = SUBSTRATE_COLOR[n.substrate] ?? '#64748b';
      const isPulsing = pulsingNodes.has(n.id);
      const color = isPulsing ? '#ffffff' : baseColor;

      nodeColorMap.set(n.id, new THREE.Color(color));

      return {
        id: n.id,
        label: n.label,
        size: nodeSize(n),
        color,
        substrate: n.substrate,
        kind: n.kind,
        weight: n.weight,
        meta: n.meta,
      };
    });

    const graphLinks: unknown[] = [];
    const seenEdges = new Set<string>();

    for (const edge of edges) {
      if (edge.source === edge.target) continue; // skip self-loops
      if (!nodes.some((n) => n.id === edge.source) || !nodes.some((n) => n.id === edge.target)) {
        continue; // skip edges to non-existent nodes
      }

      const edgeKey = `${edge.source}|${edge.target}`;
      if (seenEdges.has(edgeKey)) continue;
      seenEdges.add(edgeKey);

      const isPulsing = pulsingEdges.has(edgeKey);
      const color = isPulsing ? '#ffffff' : edgeColor(edge.type);
      edgeColorMap.set(edgeKey, color);

      graphLinks.push({
        source: edge.source,
        target: edge.target,
        color,
        type: edge.type,
        weight: edge.weight,
      });
    }

    return { nodes: graphNodes, links: graphLinks };
  }

  // ---------------------------------------------------------------------------
  // Initialise 3D force graph
  // ---------------------------------------------------------------------------

  /**
   * Creates a new ForceGraph3D instance with the current nodes/edges data.
   * Prefers the shared Graphology instance (which has layout data) over
   * building from props, to avoid duplicate layout computation.
   * Cleans up any existing instance first.
   */
  function initGraph3D(sharedGraph: Graph | null): void {
    if (!mounted || !container) return;

    // Kill existing instance before rebuilding
    if (graph3d) {
      disposeBloom();
      graph3d._destructor?.();
      graph3d = null;
    }

    // Prefer shared Graphology instance (has layout positions from ForceAtlas2)
    // Fall back to building from props if shared graph is not available
    const { nodes: graphNodes, links: graphLinks } = sharedGraph
      ? buildGraphDataFromGraphology(sharedGraph)
      : buildGraphDataFromProps();

    if (graphNodes.length === 0) {
      // No data to render — skip initialization
      return;
    }

    try {
      graph3d = ForceGraph3D()(container)
        .graphData({ nodes: graphNodes, links: graphLinks })
        .nodeLabel('label')
        .nodeAutoColorBy('substrate')
        .nodeColor((node: unknown) => {
          const n = node as { id: string; color: string };
          return n.color;
        })
        .linkColor((link: unknown) => {
          const l = link as { color: string };
          return l.color;
        })
        .linkDirectionalParticles(1)
        .linkDirectionalParticleSpeed(0.005)
        .d3Force('charge', null) // Disable charge force for stability
        .onNodeClick((node: unknown) => {
          const n = node as { id: string };
          onNodeClick?.(n.id);
        });

      // Initialize bloom post-processing after graph is ready
      initBloomPass();

      // Set up resize listener for bloom resolution
      window.addEventListener('resize', handleResize);
    } catch (err) {
      // If 3d-force-graph init fails, silently fail — parent page can fallback
      graph3d = null;
      disposeBloom();
    }
  }

  // ---------------------------------------------------------------------------
  // Mount / destroy
  // ---------------------------------------------------------------------------

  /**
   * Starts the RAF loop for label projection updates.
   * Called every frame to keep labels in sync with camera movement.
   */
  function startProjectionLoop(): void {
    const tick = (): void => {
      updateLabelProjections();
      projectionRafId = requestAnimationFrame(tick);
    };
    projectionRafId = requestAnimationFrame(tick);
  }

  /**
   * Stops the RAF projection loop.
   */
  function stopProjectionLoop(): void {
    if (projectionRafId !== null) {
      cancelAnimationFrame(projectionRafId);
      projectionRafId = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Shared graph subscription
  // ---------------------------------------------------------------------------

  let sharedGraphInstance: Graph | null = null;

  const unsubscribe = livingBrainGraphStore.subscribe((value) => {
    sharedGraphInstance = value;
    // Rebuild when shared graph updates (e.g., new layout from ForceAtlas2)
    if (mounted && graph3d !== null) {
      initGraph3D(sharedGraphInstance);
    }
  });

  onMount(() => {
    mounted = true;
    initGraph3D(sharedGraphInstance);
    startProjectionLoop();
  });

  onDestroy(() => {
    mounted = false;
    window.removeEventListener('resize', handleResize);
    disposeBloom();
    unsubscribe();
    stopProjectionLoop();
    if (graph3d) {
      graph3d._destructor?.();
      graph3d = null;
    }
    // Clean up child elements (canvas, etc.)
    while (container?.firstChild) {
      container.removeChild(container.firstChild);
    }
  });

  // ---------------------------------------------------------------------------
  // React to prop-driven data changes — rebuild the graph entirely
  // ---------------------------------------------------------------------------

  $effect(() => {
    // Capture reactive deps (props can change independently of shared graph)
    const _n = nodes;
    const _e = edges;
    if (mounted && graph3d !== null) {
      // Use shared graph if available, otherwise fall back to props
      initGraph3D(sharedGraphInstance);
    }
  });

  // ---------------------------------------------------------------------------
  // React to bloom intensity changes
  // ---------------------------------------------------------------------------

  $effect(() => {
    const _intensity = bloomIntensity;
    updateBloomIntensity();
  });

  // ---------------------------------------------------------------------------
  // React to pulse changes
  // ---------------------------------------------------------------------------

  $effect(() => {
    if (!graph3d || (pulsingNodes.size === 0 && pulsingEdges.size === 0)) return;

    const now = Date.now();

    // Apply node pulse visual (set to white)
    for (const nodeId of pulsingNodes) {
      if (!nodeColorMap.has(nodeId)) continue;
      // Note: 3d-force-graph doesn't have direct per-node update API;
      // full rebuild would be needed for visual feedback.
      // For now, we track pulse state but don't animate per-node.
      // This is a known trade-off (documented in Props).
    }

    // Apply edge pulse visual (set to white)
    for (const edgeKey of pulsingEdges) {
      if (!edgeColorMap.has(edgeKey)) continue;
      // Same trade-off: track but don't animate per-edge.
    }

    // Schedule visual reset after pulse duration
    setTimeout(() => {
      if (!graph3d || !mounted) return;
      // Rebuild with original colors
      const { nodes: graphNodes, links: graphLinks } = sharedGraphInstance
        ? buildGraphDataFromGraphology(sharedGraphInstance)
        : buildGraphDataFromProps();
      graph3d.graphData({ nodes: graphNodes, links: graphLinks });
    }, PULSE_DURATION_MS);
  });
</script>

<div class="lb3d-wrap" style="height: {height}; position: relative;">
  {#if nodes.length === 0}
    <div class="lb3d-empty">No data to display</div>
  {:else}
    <div class="lb3d-canvas" bind:this={container}></div>
    <div class="label-overlay" bind:this={overlayRef}>
      {#each visibleNodes as node (node.id)}
        {#if node.isVisible}
          <div
            class="node-label"
            style:transform="translate3d({node.screenX}px, {node.screenY}px, 0)"
            title={node.label}
          >
            {node.label}
          </div>
        {/if}
      {/each}
    </div>
  {/if}
</div>

<style>
  .lb3d-wrap {
    width: 100%;
    background: #0a0d14;
    border-radius: 8px;
    overflow: hidden;
    border: 1px solid #2d3748;
    position: relative;
  }

  .lb3d-canvas {
    width: 100%;
    height: 100%;
    display: block;
  }

  .lb3d-canvas :global(canvas) {
    width: 100% !important;
    height: 100% !important;
    display: block !important;
  }

  .lb3d-empty {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #64748b;
    font-size: 0.875rem;
  }

  .label-overlay {
    position: absolute;
    inset: 0;
    pointer-events: none;
    overflow: hidden;
  }

  .node-label {
    position: absolute;
    /* Transform origin at top-left for cleaner positioning */
    transform-origin: 0 0;
    /* Use transform for performance; avoid layout thrash */
    will-change: transform;
    /* Subtle dark pill background for contrast, matching LivingBrainGraph */
    background: rgba(10, 13, 20, 0.82);
    color: #f1f5f9;
    font-size: 0.75rem;
    font-weight: 500;
    padding: 2px 4px;
    border-radius: 3px;
    white-space: nowrap;
    /* Slight shadow for depth */
    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.4);
    /* Override parent's pointer-events: none for individual tooltip support */
    pointer-events: auto;
    user-select: none;
    line-height: 1;
  }
</style>
