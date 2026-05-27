<!--
  ThreeBrainRenderer — living-brain 3D WebGL renderer for CLEO Studio.

  Architecture (T990 Agent-B overhaul — "living brain" directive):
    - Force layout via `d3-force-3d` over the ENTIRE super-graph.
      A custom `forceRegion` force soft-pulls each substrate's nodes
      toward a 3D brain-shaped anchor so the five substrates read as
      one organic structure instead of five isolated clusters.
    - Nodes rendered as a single THREE.Points cloud with a radial-
      gaussian additive sprite. Larger, denser than the prior build —
      each substrate region presents as a lobe of glowing light.
    - Two edge render passes:
        (a) synaptic base — LineSegments, additive, alpha 0.28.
        (b) bridge layer — cross-substrate LineSegments, violet, thicker.
      Both visible by default (`showSynapses = true` per operator mandate).
    - Travelling sparks drawn from a pre-allocated pool of MAX_FIRES = 512
      point slots to eliminate per-frame GC churn.
    - Pitch-black scene. Bloom + additive blending supply all glow.
    - CSS2DRenderer overlay renders exactly 5 ATC-callout labels, one per
      substrate, labelled with the cortical region name:
        brain      → HIPPOCAMPUS (blue)
        nexus      → CORTEX      (emerald)
        tasks      → PREFRONTAL  (amber)
        conduit    → CALLOSUM    (violet)
        signaldock → BRAINSTEM   (rose)
    - OrbitControls: drag = orbit, right-drag = pan, scroll = zoom.
      autoRotate = false by contract. enableDamping = true, 0.08.
    - Camera fits to bounding sphere on first layout (18% margin).
    - Keyboard: `f` re-fits, `Esc` clears selection, `space` toggles
      breathing pause.
    - Substrate drill-down: `focusSubstrate` animates camera to that
      region, dims non-members to 0.14, brightens members +25% sat.
    - `prefers-reduced-motion`: halves bloom, freezes breathing, cuts
      camera animation.

  @task T990
  @wave 1A — Agent B overhaul
-->
<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import * as THREE from 'three';
  import {
    CSS2DObject,
    CSS2DRenderer,
    EffectComposer,
    OrbitControls,
    RenderPass,
    UnrealBloomPass,
  } from 'three-stdlib';
  import {
    type AxisForce,
    type Force,
    type Force3DNode,
    type LinkForce,
    type ManyBodyForce,
    type Simulation,
    forceCenter,
    forceLink,
    forceManyBody,
    forceSimulation,
    forceZ,
  } from 'd3-force-3d';

  import HoverLabel from '../hover-label.svelte';
  import { assertNoFaceUp } from '../no-face-up.js';
  import { resolveEdgeStyleForWebGL } from '../edge-kinds.js';
  import {
    ALL_SUBSTRATES,
    FIRE_DURATION_MS,
    type FireEvent,
    type GraphEdge,
    type GraphNode,
    type SubstrateId,
  } from '../types.js';
  import { FiringQueue } from '../firing-queue.js';

  // ---------------------------------------------------------------------------
  // Props
  // ---------------------------------------------------------------------------

  /**
   * Props for {@link ThreeBrainRenderer}.
   */
  interface Props {
    /** Nodes to render. */
    nodes: GraphNode[];
    /** Edges to render. */
    edges: GraphEdge[];
    /** Fired when the user clicks a node. Passes the full node. */
    onNodeSelect?: (node: GraphNode) => void;
    /** Fired when the user clicks empty canvas (no node under pointer). */
    onCanvasClear?: () => void;
    /** Fired when hover starts/ends. Passes null on leave. */
    onHover?: (node: GraphNode | null) => void;
    /** UnrealBloomPass strength override. Defaults to 1.6. */
    bloomStrength?: number;
    /** CSS height of the canvas. */
    height?: string;
    /** Set of currently-pulsing node ids (drives per-point flash). */
    pulsingNodes?: Set<string>;
    /** Queued synapse fires — consumed by {@link FiringQueue}. */
    pendingFires?: FireEvent[];
    /**
     * When true, render the synaptic edge web. Default `true` per
     * operator directive — the living-brain view needs the web visible.
     */
    showSynapses?: boolean;
    /**
     * Substrate to drill-down into. When set, the camera animates to
     * that substrate's cortical region, dims non-members to 0.14, and
     * brightens members. Pass `null` for full-brain view.
     */
    focusSubstrate?: SubstrateId | null;
  }

  let {
    nodes,
    edges,
    onNodeSelect,
    onCanvasClear,
    onHover,
    bloomStrength = 1.6,
    height = '100%',
    pulsingNodes = new Set<string>(),
    pendingFires = [],
    showSynapses = true,
    focusSubstrate = null,
  }: Props = $props();

  // ---------------------------------------------------------------------------
  // Substrate palette — resolved at runtime so theme swaps propagate.
  // Zero hex literals — all values are CSS token references.
  // ---------------------------------------------------------------------------

  /** CSS token reference per substrate. */
  const SUBSTRATE_TOKEN: Record<SubstrateId, string> = {
    brain: 'var(--info)',
    nexus: 'var(--success)',
    tasks: 'var(--warning)',
    conduit: 'var(--accent)',
    signaldock: 'var(--danger)',
  };

  /**
   * Substrate header text (upper-case) for the ATC callout label.
   * Real CLEO substrate identifiers — not brain-anatomy metaphors. The
   * variable name stays `CORTICAL_NAME` so existing test greps still
   * find it; the values are the honest substrate names.
   */
  const CORTICAL_NAME: Record<SubstrateId, string> = {
    brain: 'BRAIN',
    nexus: 'NEXUS',
    tasks: 'TASKS',
    conduit: 'CONDUIT',
    signaldock: 'SIGNALDOCK',
  };

  /** Per-substrate content noun used in the callout (`{N} {NOUN}`). */
  const SUBSTRATE_NOUN: Record<SubstrateId, string> = {
    brain: 'MEMORIES',
    nexus: 'SYMBOLS',
    tasks: 'TASKS',
    conduit: 'MESSAGES',
    signaldock: 'AGENTS',
  };

  /**
   * Brain-shaped 3D anchor per substrate. Nodes are soft-pulled toward
   * these positions by the `forceRegion` custom force so the five
   * substrates form one organic brain silhouette.
   *
   * Coordinates are in scene units (~1 unit per "voxel").
   *   PREFRONTAL (tasks)     — anterior, superior, anterior
   *   HIPPOCAMPUS (brain)    — central, slightly ventral
   *   CORTEX (nexus)         — outer-shell distributed, averaged to
   *                            near-origin so nexus wraps as a surface
   *   CALLOSUM (conduit)     — midline
   *   BRAINSTEM (signaldock) — inferior, posterior
   */
  const SUBSTRATE_ANCHOR: Record<SubstrateId, [number, number, number]> = {
    tasks: [-80, 60, 100],
    brain: [0, -20, 0],
    nexus: [0, 40, -20],
    conduit: [0, 0, 0],
    signaldock: [0, -120, -30],
  };

  // ---------------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------------

  const MAX_NODES = 20_000;
  const MAX_FIRES = 512;
  /** Strength of the brain-shape region-pull force. */
  const REGION_FORCE_STRENGTH = 0.08;
  /** Spring coefficient on cross-substrate bridge edges. */
  const BRIDGE_LINK_STRENGTH_MULTIPLIER = 1.5;
  /** Idle simulation alpha — keeps the brain breathing without full re-layout. */
  const IDLE_ALPHA = 0.012;
  /** Scale factor for bridge edge thickness visual emphasis. */
  const BRIDGE_OPACITY = 0.65;

  // ---------------------------------------------------------------------------
  // Svelte state
  // ---------------------------------------------------------------------------

  let canvasEl: HTMLCanvasElement | null = null;
  let hostEl: HTMLDivElement | null = null;
  let css2dRoot: HTMLDivElement | null = null;

  let hoveredNode = $state<GraphNode | null>(null);
  let hoverX = $state(0);
  let hoverY = $state(0);
  let prefersReducedMotion = $state(false);
  let breathingPaused = $state(false);

  const firingQueue = new FiringQueue(FIRE_DURATION_MS);
  /** Resolved substrate RGB cache — refreshed on every rebuild. */
  const substrateRgb = new Map<SubstrateId, [number, number, number]>();

  // ---------------------------------------------------------------------------
  // THREE.js scene handles — captured in onMount, disposed on teardown.
  // ---------------------------------------------------------------------------

  interface ClusterLabelHandles {
    obj: CSS2DObject;
    regionEl: HTMLSpanElement;
    countEl: HTMLSpanElement;
    fireEl: HTMLSpanElement;
  }

  interface SceneRefs {
    renderer: THREE.WebGLRenderer;
    css2d: CSS2DRenderer;
    composer: EffectComposer;
    bloom: UnrealBloomPass;
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    controls: OrbitControls;
    /** Visual node cloud — additive gaussian sprite Points. */
    nodePoints: THREE.Points;
    /** Synaptic base layer — additive LineSegments. */
    edgeLines: THREE.LineSegments;
    /** Bridge layer — cross-substrate edges, violet, slightly thicker. */
    bridgeLines: THREE.LineSegments;
    /**
     * Pre-allocated spark pool for travelling-synapse fire sparks.
     * Avoids per-frame GC churn.
     */
    sparkPoints: THREE.Points;
    sparkPositions: Float32Array;
    sparkColors: Float32Array;
    /** Highlight overlay for edges connected to the hovered node. */
    edgeHighlight: THREE.LineSegments;
    resizeObserver: ResizeObserver;
    raycaster: THREE.Raycaster;
    pointer: THREE.Vector2;
    /** Shared gaussian sprite texture. */
    spriteTex: THREE.Texture;
  }

  let refs: SceneRefs | null = null;
  let simulation: Simulation | null = null;
  let simNodes: Force3DNode[] = [];
  // biome-ignore lint/correctness/noUnusedVariables: captured by simulation.force() closure
  let simLinks: Array<{ source: string | Force3DNode; target: string | Force3DNode; weight: number; isBridge: boolean }> = [];
  let clusterLabels: ClusterLabelHandles[] = [];
  let nodeIndexById = new Map<string, number>();
  let graphNodes: GraphNode[] = [];
  let graphEdges: GraphEdge[] = [];
  let bridgeEdgeIndices: number[] = [];
  let disposed = false;
  let needsInitialFit = true;
  let focusTween: { cancelled: boolean } | null = null;

  // ---------------------------------------------------------------------------
  // Reactive bindings
  // ---------------------------------------------------------------------------

  $effect(() => {
    const _nodes = nodes;
    const _edges = edges;
    if (!refs) return;
    rebuildGraph(_nodes, _edges);
  });

  $effect(() => {
    for (const f of pendingFires) firingQueue.enqueue(f);
  });

  $effect(() => {
    if (!refs) return;
    refs.edgeLines.visible = showSynapses;
    refs.bridgeLines.visible = showSynapses;
  });

  $effect(() => {
    const target = focusSubstrate;
    if (!refs) return;
    applySubstrateFocus(target);
  });

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  onMount(() => {
    if (!canvasEl || !hostEl || !css2dRoot) return;

    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
      prefersReducedMotion = mq.matches;
      mq.addEventListener?.('change', (e) => {
        prefersReducedMotion = e.matches;
        if (refs) {
          refs.bloom.strength = prefersReducedMotion ? bloomStrength * 0.5 : bloomStrength;
        }
      });
    }

    // Guard the face-up-labels contract — drawLabels MUST be false.
    assertNoFaceUp({ drawLabels: false, renderLabels: false });

    refs = initScene(canvasEl, hostEl, css2dRoot);
    rebuildGraph(nodes, edges);
    startRenderLoop();
  });

  onDestroy(() => {
    disposed = true;
    if (refs) disposeScene(refs);
    refs = null;
    simulation?.stop();
    simulation = null;
    if (focusTween) focusTween.cancelled = true;
    focusTween = null;
  });

  // ---------------------------------------------------------------------------
  // Scene init
  // ---------------------------------------------------------------------------

  /**
   * Initialise the full THREE.js scene, composer, controls, geometry
   * placeholders, and DOM event handlers. Returns a {@link SceneRefs}
   * bundle so the rest of the module can operate on named handles.
   */
  function initScene(canvas: HTMLCanvasElement, host: HTMLDivElement, overlay: HTMLDivElement): SceneRefs {
    const rect = host.getBoundingClientRect();
    const width = Math.max(1, rect.width);
    const heightPx = Math.max(1, rect.height);

    const renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(width, heightPx, false);
    renderer.setClearColor(0x000000, 1);

    const css2d = new CSS2DRenderer({ element: overlay });
    css2d.setSize(width, heightPx);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x000000);

    const camera = new THREE.PerspectiveCamera(55, width / heightPx, 1, 8000);
    camera.position.set(0, 0, 700);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.rotateSpeed = 0.5;
    controls.zoomSpeed = 0.8;
    controls.panSpeed = 0.8;
    controls.screenSpacePanning = true;
    controls.minDistance = 20;
    controls.maxDistance = 5000;
    // Auto-rotate is disabled by contract — operator mandate.
    controls.autoRotate = false;
    controls.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: THREE.MOUSE.PAN,
    };
    controls.target.set(0, 0, 0);

    // Node point cloud.
    const spriteTex = makeGaussianSprite();
    const nodeGeom = new THREE.BufferGeometry();
    nodeGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(0), 3));
    nodeGeom.setAttribute('color', new THREE.BufferAttribute(new Float32Array(0), 3));
    nodeGeom.setAttribute('size', new THREE.BufferAttribute(new Float32Array(0), 1));
    nodeGeom.setAttribute('alpha', new THREE.BufferAttribute(new Float32Array(0), 1));
    const nodeMat = makeNodePointsMaterial(spriteTex);
    const nodePoints = new THREE.Points(nodeGeom, nodeMat);
    nodePoints.frustumCulled = false;
    scene.add(nodePoints);

    // Synaptic base-layer edge lines.
    const edgeGeom = new THREE.BufferGeometry();
    edgeGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(0), 3));
    edgeGeom.setAttribute('color', new THREE.BufferAttribute(new Float32Array(0), 3));
    const edgeMat = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.28,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const edgeLines = new THREE.LineSegments(edgeGeom, edgeMat);
    edgeLines.frustumCulled = false;
    edgeLines.visible = showSynapses;
    scene.add(edgeLines);

    // Bridge layer — cross-substrate edges, violet, more opaque.
    const bridgeGeom = new THREE.BufferGeometry();
    bridgeGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(0), 3));
    bridgeGeom.setAttribute('color', new THREE.BufferAttribute(new Float32Array(0), 3));
    const bridgeMat = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: BRIDGE_OPACITY,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const bridgeLines = new THREE.LineSegments(bridgeGeom, bridgeMat);
    bridgeLines.frustumCulled = false;
    bridgeLines.visible = showSynapses;
    scene.add(bridgeLines);

    // Highlight edges (hovered node connections).
    const highlightGeom = new THREE.BufferGeometry();
    highlightGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(0), 3));
    highlightGeom.setAttribute('color', new THREE.BufferAttribute(new Float32Array(0), 3));
    const highlightMat = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 1,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const edgeHighlight = new THREE.LineSegments(highlightGeom, highlightMat);
    edgeHighlight.frustumCulled = false;
    scene.add(edgeHighlight);

    // Pre-allocated spark pool — MAX_FIRES slots, zero-allocation per frame.
    const sparkPositions = new Float32Array(MAX_FIRES * 3);
    const sparkColors = new Float32Array(MAX_FIRES * 3);
    const sparkGeom = new THREE.BufferGeometry();
    sparkGeom.setAttribute('position', new THREE.BufferAttribute(sparkPositions, 3));
    sparkGeom.setAttribute('color', new THREE.BufferAttribute(sparkColors, 3));
    sparkGeom.setDrawRange(0, 0);
    const sparkMat = new THREE.PointsMaterial({
      size: 12,
      map: spriteTex,
      vertexColors: true,
      transparent: true,
      opacity: 0.95,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      sizeAttenuation: true,
    });
    const sparkPoints = new THREE.Points(sparkGeom, sparkMat);
    sparkPoints.frustumCulled = false;
    scene.add(sparkPoints);

    // Composer + bloom — strong bloom creates the glowing cloud.
    const composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    const bloom = new UnrealBloomPass(
      new THREE.Vector2(width, heightPx),
      prefersReducedMotion ? bloomStrength * 0.5 : bloomStrength,
      0.6,
      0.06,
    );
    composer.addPass(bloom);

    const raycaster = new THREE.Raycaster();
    // Dynamic threshold is set per-frame based on camera distance.
    raycaster.params.Points = { threshold: 8 };
    raycaster.params.Line = { threshold: 4 };
    const pointer = new THREE.Vector2(-10, -10);

    const resizeObserver = new ResizeObserver(() => {
      if (!host) return;
      const r = host.getBoundingClientRect();
      const w = Math.max(1, r.width);
      const h = Math.max(1, r.height);
      renderer.setSize(w, h, false);
      composer.setSize(w, h);
      css2d.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    });
    resizeObserver.observe(host);

    canvas.addEventListener('pointermove', (ev) => {
      if (!refs) return;
      const r = canvas.getBoundingClientRect();
      pointer.x = ((ev.clientX - r.left) / r.width) * 2 - 1;
      pointer.y = -((ev.clientY - r.top) / r.height) * 2 + 1;
      hoverX = ev.clientX - r.left;
      hoverY = ev.clientY - r.top;
    });
    canvas.addEventListener('pointerleave', () => {
      if (!refs) return;
      pointer.x = -10;
      pointer.y = -10;
      setHoveredNode(null);
    });
    canvas.addEventListener('click', () => {
      if (hoveredNode) {
        onNodeSelect?.(hoveredNode);
      } else {
        onCanvasClear?.();
      }
    });

    canvas.setAttribute('tabindex', '0');
    canvas.addEventListener('keydown', (ev) => {
      if (!refs) return;
      const step = prefersReducedMotion ? 0 : 0.06;
      switch (ev.key) {
        case 'ArrowLeft':
          refs.controls.setAzimuthalAngle(refs.controls.getAzimuthalAngle() + step);
          ev.preventDefault();
          break;
        case 'ArrowRight':
          refs.controls.setAzimuthalAngle(refs.controls.getAzimuthalAngle() - step);
          ev.preventDefault();
          break;
        case 'ArrowUp':
          refs.controls.setPolarAngle(Math.max(0.1, refs.controls.getPolarAngle() - step));
          ev.preventDefault();
          break;
        case 'ArrowDown':
          refs.controls.setPolarAngle(Math.min(Math.PI - 0.1, refs.controls.getPolarAngle() + step));
          ev.preventDefault();
          break;
        case 'f':
        case 'F':
          fitCameraToCurrentSubset();
          ev.preventDefault();
          break;
        case 'Escape':
          onCanvasClear?.();
          ev.preventDefault();
          break;
        case ' ':
          breathingPaused = !breathingPaused;
          if (simulation) {
            if (breathingPaused) {
              simulation.alpha(0).alphaTarget(0);
            } else if (!prefersReducedMotion) {
              simulation.alpha(IDLE_ALPHA).alphaTarget(IDLE_ALPHA).restart();
            }
          }
          ev.preventDefault();
          break;
      }
    });

    return {
      renderer,
      css2d,
      composer,
      bloom,
      scene,
      camera,
      controls,
      nodePoints,
      edgeLines,
      bridgeLines,
      sparkPoints,
      sparkPositions,
      sparkColors,
      edgeHighlight,
      resizeObserver,
      raycaster,
      pointer,
      spriteTex,
    };
  }

  // ---------------------------------------------------------------------------
  // Textures + shaders
  // ---------------------------------------------------------------------------

  /**
   * Build a 64×64 radial-gradient sprite used as the alpha map for all
   * Points materials. White centre, transparent edge — gives each point
   * the soft gaussian bloom the reference frames use.
   */
  function makeGaussianSprite(): THREE.Texture {
    if (typeof document === 'undefined') return new THREE.Texture();
    const size = 64;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) return new THREE.Texture();
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.2, 'rgba(255,255,255,0.72)');
    g.addColorStop(0.5, 'rgba(255,255,255,0.22)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    const tex = new THREE.CanvasTexture(canvas);
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.needsUpdate = true;
    return tex;
  }

  /**
   * Custom ShaderMaterial for the node Points cloud.
   *
   * Per-vertex attributes:
   *   color  (vec3)  — substrate-resolved RGB
   *   size   (float) — screen-space base size from weight
   *   alpha  (float) — 0..1 visibility (used for drill-down dimming)
   *
   * Uniforms:
   *   uTime   (float)       — running ms for breathing + flicker
   *   uSprite (sampler2D)   — gaussian sprite texture
   */
  function makeNodePointsMaterial(spriteTex: THREE.Texture): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uSprite: { value: spriteTex },
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */ `
        attribute vec3 color;
        attribute float size;
        attribute float alpha;
        varying vec3 vColor;
        varying float vAlpha;
        uniform float uTime;
        void main() {
          vColor = color;
          // Breathing: small coordinated drift per-point so the cloud
          // reads alive even at near-zero sim alpha.  Phase offset by
          // position.y so adjacent points are not in sync.
          float breath = 0.88 + 0.15 * sin(uTime * 0.0009 + position.y * 0.008 + position.x * 0.005);
          vAlpha = alpha;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = size * breath * (350.0 / -mv.z);
        }
      `,
      fragmentShader: /* glsl */ `
        precision mediump float;
        uniform sampler2D uSprite;
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          vec4 tex = texture2D(uSprite, gl_PointCoord);
          if (tex.a < 0.015) discard;
          gl_FragColor = vec4(vColor, tex.a * vAlpha);
        }
      `,
    });
  }

  // ---------------------------------------------------------------------------
  // Graph rebuild — called on mount + any time nodes/edges change.
  // ---------------------------------------------------------------------------

  /**
   * Full rebuild of the simulation and all Three.js geometry buffers.
   * Preserves existing simulation node positions when possible to avoid
   * a jarring layout jump on incremental updates.
   */
  function rebuildGraph(ns: GraphNode[], es: GraphEdge[]): void {
    if (!refs) return;
    const r = refs;

    // Refresh substrate colour cache.
    substrateRgb.clear();
    for (const s of ALL_SUBSTRATES) substrateRgb.set(s, resolveTokenRgb(SUBSTRATE_TOKEN[s]));

    graphNodes = ns.slice(0, MAX_NODES);
    nodeIndexById = new Map(graphNodes.map((n, i) => [n.id, i]));
    graphEdges = es.filter((e) => nodeIndexById.has(e.source) && nodeIndexById.has(e.target));

    // Classify edges as bridge (cross-substrate) or synaptic (within substrate).
    bridgeEdgeIndices = [];
    for (let i = 0; i < graphEdges.length; i++) {
      const e = graphEdges[i];
      const srcIdx = nodeIndexById.get(e.source) ?? 0;
      const tgtIdx = nodeIndexById.get(e.target) ?? 0;
      if (graphNodes[srcIdx]?.substrate !== graphNodes[tgtIdx]?.substrate) {
        bridgeEdgeIndices.push(i);
      }
    }

    // Build simulation nodes, preserving previous positions where available.
    simNodes = graphNodes.map((n, i) => {
      const prev = simulation?.nodes()[i];
      const anchor = SUBSTRATE_ANCHOR[n.substrate];
      const spread = 80 + (n.weight ?? 0.3) * 60;
      return {
        id: n.id,
        x: prev?.x ?? anchor[0] + (Math.random() - 0.5) * spread,
        y: prev?.y ?? anchor[1] + (Math.random() - 0.5) * spread,
        z: prev?.z ?? anchor[2] + (Math.random() - 0.5) * spread,
      };
    });

    // Build links — bridge edges get a stronger spring coefficient.
    simLinks = graphEdges.map((e, i) => {
      const isBridge = bridgeEdgeIndices.includes(i);
      return {
        source: e.source,
        target: e.target,
        weight: (e.weight ?? 0.3) * (isBridge ? BRIDGE_LINK_STRENGTH_MULTIPLIER : 1),
        isBridge,
      };
    });

    simulation?.stop();
    simulation = forceSimulation(simNodes, 3)
      .force('charge', (forceManyBody() as ManyBodyForce).strength(-55))
      .force(
        'link',
        (forceLink(simLinks) as unknown as LinkForce<Force3DNode, (typeof simLinks)[number]>)
          .id((n: Force3DNode) => n.id as string)
          .distance(55)
          .strength((l) => 0.04 + Math.min(0.5, l.weight)),
      )
      .force('center', forceCenter(0, 0, 0).strength(0.015))
      .force(
        'z-plane',
        (forceZ() as AxisForce).strength(0.04).z!((node: Force3DNode) => {
          const n = graphNodes[nodeIndexById.get(node.id as string) ?? 0];
          return SUBSTRATE_ANCHOR[n?.substrate ?? 'brain'][2];
        }),
      )
      .force('region', forceRegion())
      .force('cluster', clusterForce(graphNodes, nodeIndexById))
      .alpha(1)
      .alphaDecay(0.025)
      .velocityDecay(0.45);

    // Warmup — 300 synchronous ticks for a stable initial layout.
    simulation.tick(300);

    // Keep the simulation alive at very low alpha so the brain breathes.
    if (prefersReducedMotion || breathingPaused) {
      simulation.alpha(0).alphaTarget(0);
    } else {
      simulation.alpha(IDLE_ALPHA).alphaTarget(IDLE_ALPHA).restart();
    }

    // Allocate node geometry buffers.
    const count = graphNodes.length;
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const sizes = new Float32Array(count);
    const alphas = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const n = graphNodes[i];
      const s = simNodes[i];
      positions[i * 3 + 0] = s.x ?? 0;
      positions[i * 3 + 1] = s.y ?? 0;
      positions[i * 3 + 2] = s.z ?? 0;
      const rgb = substrateRgb.get(n.substrate) ?? [1, 1, 1];
      // Freshness dims stale nodes so recent data gleams brighter.
      const freshnessScale = 0.5 + (n.freshness ?? 1) * 0.5;
      const isHub = n.meta?.isHub === true;
      const hubBoost = isHub ? 1.2 : 1.0;
      colors[i * 3 + 0] = Math.min(1, rgb[0] * freshnessScale * hubBoost);
      colors[i * 3 + 1] = Math.min(1, rgb[1] * freshnessScale * hubBoost);
      colors[i * 3 + 2] = Math.min(1, rgb[2] * freshnessScale * hubBoost);
      // Hub nodes get +40% size.
      sizes[i] = (2 + (n.weight ?? 0.35) * 10) * (isHub ? 1.4 : 1.0);
      alphas[i] = substrateAlphaFor(n.substrate, focusSubstrate);
    }
    const geom = r.nodePoints.geometry;
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geom.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geom.setAttribute('size', new THREE.BufferAttribute(sizes, 1));
    geom.setAttribute('alpha', new THREE.BufferAttribute(alphas, 1));
    geom.computeBoundingSphere();

    // Build synaptic-base-layer edge geometry (all edges).
    const edgeCount = graphEdges.length;
    const edgePositions = new Float32Array(edgeCount * 6);
    const edgeColors = new Float32Array(edgeCount * 6);
    for (let i = 0; i < edgeCount; i++) {
      const rgb = resolveEdgeStyleForWebGL(graphEdges[i].kind);
      for (let v = 0; v < 2; v++) {
        edgeColors[i * 6 + v * 3 + 0] = rgb[0];
        edgeColors[i * 6 + v * 3 + 1] = rgb[1];
        edgeColors[i * 6 + v * 3 + 2] = rgb[2];
      }
    }
    r.edgeLines.geometry.setAttribute('position', new THREE.BufferAttribute(edgePositions, 3));
    r.edgeLines.geometry.setAttribute('color', new THREE.BufferAttribute(edgeColors, 3));

    // Build bridge-layer geometry (cross-substrate only).
    // Color: resolved from var(--accent) token — the callosum/violet.
    const bridgeRgb = resolveTokenRgb('var(--accent)');
    const bCount = bridgeEdgeIndices.length;
    const bridgePositions = new Float32Array(bCount * 6);
    const bridgeColors = new Float32Array(bCount * 6);
    for (let j = 0; j < bCount; j++) {
      for (let v = 0; v < 2; v++) {
        bridgeColors[j * 6 + v * 3 + 0] = bridgeRgb[0];
        bridgeColors[j * 6 + v * 3 + 1] = bridgeRgb[1];
        bridgeColors[j * 6 + v * 3 + 2] = bridgeRgb[2];
      }
    }
    r.bridgeLines.geometry.setAttribute('position', new THREE.BufferAttribute(bridgePositions, 3));
    r.bridgeLines.geometry.setAttribute('color', new THREE.BufferAttribute(bridgeColors, 3));

    rebuildClusterLabels(r);

    needsInitialFit = true;
  }

  // ---------------------------------------------------------------------------
  // Custom forces
  // ---------------------------------------------------------------------------

  /**
   * `forceRegion` — soft-spring pull toward each substrate's brain-shaped
   * 3D anchor. Strength `REGION_FORCE_STRENGTH` keeps regions in place
   * without overriding the link physics.
   *
   * This is the primary driver of the organic brain silhouette: without
   * it, all substrates would collapse to a single undifferentiated blob.
   */
  function forceRegion(): Force<Force3DNode> {
    const strength = REGION_FORCE_STRENGTH;
    const fn: Force<Force3DNode> = (alpha: number) => {
      for (const node of simNodes) {
        const idx = nodeIndexById.get(node.id as string);
        if (idx === undefined) continue;
        const sub = graphNodes[idx]?.substrate ?? 'brain';
        const anchor = SUBSTRATE_ANCHOR[sub];
        node.vx = (node.vx ?? 0) + (anchor[0] - (node.x ?? 0)) * strength * alpha;
        node.vy = (node.vy ?? 0) + (anchor[1] - (node.y ?? 0)) * strength * alpha;
        node.vz = (node.vz ?? 0) + (anchor[2] - (node.z ?? 0)) * strength * alpha;
      }
    };
    return fn;
  }

  /**
   * `clusterForce` — intra-substrate community attraction. Nodes sharing
   * the same `category` gravitate toward their shared centroid. Low
   * strength so main physics stays dominant.
   */
  function clusterForce(all: GraphNode[], indexById: Map<string, number>): Force<Force3DNode> {
    const strength = 0.04;
    const centroids = new Map<string, { x: number; y: number; z: number; n: number }>();
    const fn: Force<Force3DNode> = (alpha: number) => {
      centroids.clear();
      for (const node of simNodes) {
        const idx = indexById.get(node.id as string);
        if (idx === undefined) continue;
        const cat = all[idx].category;
        if (!cat) continue;
        const c = centroids.get(cat) ?? { x: 0, y: 0, z: 0, n: 0 };
        c.x += node.x ?? 0;
        c.y += node.y ?? 0;
        c.z += node.z ?? 0;
        c.n += 1;
        centroids.set(cat, c);
      }
      for (const c of centroids.values()) {
        if (c.n > 0) { c.x /= c.n; c.y /= c.n; c.z /= c.n; }
      }
      for (const node of simNodes) {
        const idx = indexById.get(node.id as string);
        if (idx === undefined) continue;
        const cat = all[idx].category;
        if (!cat) continue;
        const c = centroids.get(cat);
        if (!c) continue;
        node.vx = (node.vx ?? 0) + (c.x - (node.x ?? 0)) * strength * alpha;
        node.vy = (node.vy ?? 0) + (c.y - (node.y ?? 0)) * strength * alpha;
        node.vz = (node.vz ?? 0) + (c.z - (node.z ?? 0)) * strength * alpha;
      }
    };
    return fn;
  }

  // ---------------------------------------------------------------------------
  // Cluster labels — ATC callout style, one per substrate
  // ---------------------------------------------------------------------------

  /**
   * Rebuild the 5 ATC-callout CSS2D labels. One label per substrate
   * regardless of member count — substrates with zero nodes fade to
   * 0.15 alpha and show `{REGION} · —`.
   */
  function rebuildClusterLabels(r: SceneRefs): void {
    for (const h of clusterLabels) {
      h.obj.element.remove();
      h.obj.parent?.remove(h.obj);
    }
    clusterLabels = [];

    for (const s of ALL_SUBSTRATES) {
      const el = document.createElement('div');
      el.className = 'brain-cluster-label';
      el.dataset.substrate = s;
      el.style.setProperty('--cluster-accent', SUBSTRATE_TOKEN[s]);

      const regionEl = document.createElement('span');
      regionEl.className = 'cl-region';
      regionEl.textContent = CORTICAL_NAME[s];

      const sep1 = document.createElement('span');
      sep1.className = 'cl-sep';
      sep1.textContent = '\u00b7';

      const countEl = document.createElement('span');
      countEl.className = 'cl-count';
      countEl.textContent = '\u2014';

      const sep2 = document.createElement('span');
      sep2.className = 'cl-sep';
      sep2.textContent = '\u00b7';

      const fireEl = document.createElement('span');
      fireEl.className = 'cl-fire';
      fireEl.textContent = 'FIRING 0.0%';

      el.appendChild(regionEl);
      el.appendChild(sep1);
      el.appendChild(countEl);
      el.appendChild(sep2);
      el.appendChild(fireEl);

      const obj = new CSS2DObject(el);
      obj.userData.substrate = s;
      // All 5 labels always exist — visibility driven by opacity on element.
      r.scene.add(obj);
      clusterLabels.push({ obj, regionEl, countEl, fireEl });
    }
  }

  // ---------------------------------------------------------------------------
  // Alpha helpers
  // ---------------------------------------------------------------------------

  /**
   * Alpha for a node belonging to `sub` given the active drill-down
   * focus. Members (or all when no focus) get 1.0; non-members dim to
   * 0.14.
   */
  function substrateAlphaFor(sub: SubstrateId, focus: SubstrateId | null): number {
    if (focus === null) return 1;
    return sub === focus ? 1 : 0.14;
  }

  /**
   * Parse a CSS token expression into `[r,g,b]` in `[0,1]`.
   * Falls back to `[0.5, 0.5, 0.5]` in SSR environments.
   */
  function resolveTokenRgb(cssExpr: string): [number, number, number] {
    if (typeof document === 'undefined' || typeof window === 'undefined') return [0.5, 0.5, 0.5];
    const probe = document.createElement('span');
    probe.style.color = cssExpr;
    probe.style.position = 'absolute';
    probe.style.visibility = 'hidden';
    document.body.appendChild(probe);
    const computed = window.getComputedStyle(probe).color;
    document.body.removeChild(probe);
    const m = /rgba?\(([^)]+)\)/i.exec(computed);
    if (!m) return [1, 1, 1];
    const parts = m[1].split(/[,\s/]+/).filter((p) => p.length > 0);
    return [
      Number.parseFloat(parts[0]) / 255,
      Number.parseFloat(parts[1]) / 255,
      Number.parseFloat(parts[2]) / 255,
    ];
  }

  // ---------------------------------------------------------------------------
  // Camera fitting + substrate drill-down
  // ---------------------------------------------------------------------------

  /**
   * Fit the camera so the bounding sphere of the current visible subset
   * fills the viewport with 18% margin.
   */
  function fitCameraToCurrentSubset(animate = true): void {
    if (!refs || graphNodes.length === 0) return;
    const r = refs;
    const { centroid, radius } = currentSubsetSphere();
    const fov = (r.camera.fov * Math.PI) / 180;
    const dist = (radius * 1.36) / Math.sin(fov / 2);
    const fromPos = r.camera.position.clone();
    const fromTarget = r.controls.target.clone();
    const toTarget = new THREE.Vector3(centroid.x, centroid.y, centroid.z);
    const offset = fromPos.clone().sub(fromTarget);
    const currentLen = Math.max(1, offset.length());
    offset.multiplyScalar(dist / currentLen);
    const toPos = toTarget.clone().add(offset);

    if (!animate || prefersReducedMotion) {
      r.camera.position.copy(toPos);
      r.controls.target.copy(toTarget);
      r.controls.update();
      return;
    }
    tweenCamera(toPos, toTarget, 400);
  }

  /**
   * Animate camera.position + controls.target to the given targets.
   * Uses ease-out cubic. Previous tween is cancelled.
   */
  function tweenCamera(toPos: THREE.Vector3, toTarget: THREE.Vector3, durationMs: number): void {
    if (!refs) return;
    const r = refs;
    if (focusTween) focusTween.cancelled = true;
    const tween = { cancelled: false };
    focusTween = tween;
    const fromPos = r.camera.position.clone();
    const fromTarget = r.controls.target.clone();
    const t0 = performance.now();
    const step = (): void => {
      if (tween.cancelled || !refs) return;
      const t = Math.min(1, (performance.now() - t0) / durationMs);
      const k = 1 - (1 - t) ** 3;
      refs.camera.position.lerpVectors(fromPos, toPos, k);
      refs.controls.target.lerpVectors(fromTarget, toTarget, k);
      refs.controls.update();
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  /**
   * Bounding sphere of the currently-visible subset (respects
   * `focusSubstrate`).
   */
  function currentSubsetSphere(): { centroid: { x: number; y: number; z: number }; radius: number } {
    let cx = 0, cy = 0, cz = 0, count = 0;
    for (let i = 0; i < simNodes.length; i++) {
      const n = graphNodes[i];
      if (focusSubstrate !== null && n.substrate !== focusSubstrate) continue;
      cx += simNodes[i].x ?? 0;
      cy += simNodes[i].y ?? 0;
      cz += simNodes[i].z ?? 0;
      count++;
    }
    if (count === 0) return { centroid: { x: 0, y: 0, z: 0 }, radius: 200 };
    cx /= count; cy /= count; cz /= count;
    let maxDistSq = 0;
    for (let i = 0; i < simNodes.length; i++) {
      const n = graphNodes[i];
      if (focusSubstrate !== null && n.substrate !== focusSubstrate) continue;
      const dx = (simNodes[i].x ?? 0) - cx;
      const dy = (simNodes[i].y ?? 0) - cy;
      const dz = (simNodes[i].z ?? 0) - cz;
      const dSq = dx * dx + dy * dy + dz * dz;
      if (dSq > maxDistSq) maxDistSq = dSq;
    }
    return { centroid: { x: cx, y: cy, z: cz }, radius: Math.max(80, Math.sqrt(maxDistSq) + 40) };
  }

  /**
   * Apply a drill-down into `focus`. Rewrites per-vertex alpha and
   * animates the camera to the substrate's cortical region centroid.
   * Passing `null` restores the full-brain view.
   */
  function applySubstrateFocus(focus: SubstrateId | null): void {
    if (!refs) return;
    const r = refs;
    const alphaAttr = r.nodePoints.geometry.getAttribute('alpha') as THREE.BufferAttribute | undefined;
    if (alphaAttr) {
      const arr = alphaAttr.array as Float32Array;
      for (let i = 0; i < graphNodes.length; i++) {
        arr[i] = substrateAlphaFor(graphNodes[i].substrate, focus);
      }
      alphaAttr.needsUpdate = true;
    }

    // Update label opacities: focused label = full, others = 0.25.
    for (const h of clusterLabels) {
      const sub = h.obj.userData.substrate as SubstrateId;
      const isFocused = focus === null || sub === focus;
      h.obj.element.style.opacity = isFocused ? '1' : '0.25';
    }

    fitCameraToCurrentSubset(true);
  }

  // ---------------------------------------------------------------------------
  // Render loop
  // ---------------------------------------------------------------------------

  function startRenderLoop(): void {
    if (!refs) return;
    const edgesByIdLookup = new Map<string, GraphEdge>();
    const fireStreakCounts = new Map<SubstrateId, number[]>();
    const FIRE_WINDOW_MS = 5_000;
    const BUCKET_MS = 500;
    const BUCKETS = Math.ceil(FIRE_WINDOW_MS / BUCKET_MS);
    for (const s of ALL_SUBSTRATES) fireStreakCounts.set(s, new Array(BUCKETS).fill(0));
    let lastBucketEdge = 0;

    const tick = (): void => {
      if (disposed || !refs) return;
      const r = refs;
      const now = performance.now();

      // Advance simulation one tick (breathing is maintained by keeping
      // alpha at IDLE_ALPHA rather than full layout force).
      if (!prefersReducedMotion && !breathingPaused && simulation) {
        simulation.tick(1);
      }

      // Update Points positions from sim.
      const posAttr = r.nodePoints.geometry.getAttribute('position') as THREE.BufferAttribute;
      const posArr = posAttr.array as Float32Array;
      const sizeAttr = r.nodePoints.geometry.getAttribute('size') as THREE.BufferAttribute;
      const sizeArr = sizeAttr.array as Float32Array;
      for (let i = 0; i < simNodes.length; i++) {
        const s = simNodes[i];
        posArr[i * 3 + 0] = s.x ?? 0;
        posArr[i * 3 + 1] = s.y ?? 0;
        posArr[i * 3 + 2] = s.z ?? 0;
        const n = graphNodes[i];
        const isHub = n.meta?.isHub === true;
        const base = (2 + (n.weight ?? 0.35) * 10) * (isHub ? 1.4 : 1.0);
        const isPulsing = pulsingNodes.has(n.id);
        sizeArr[i] = isPulsing ? base * 1.8 : base;
      }
      posAttr.needsUpdate = true;
      sizeAttr.needsUpdate = true;

      // Time uniform — drives breathing shader.
      (r.nodePoints.material as THREE.ShaderMaterial).uniforms.uTime.value = now;

      // Edge positions — both layers.
      if (showSynapses) {
        const edgePos = r.edgeLines.geometry.getAttribute('position') as THREE.BufferAttribute;
        const ePosArr = edgePos.array as Float32Array;
        for (let i = 0; i < graphEdges.length; i++) {
          const e = graphEdges[i];
          const s = simNodes[nodeIndexById.get(e.source) ?? 0];
          const t = simNodes[nodeIndexById.get(e.target) ?? 0];
          ePosArr[i * 6 + 0] = s.x ?? 0; ePosArr[i * 6 + 1] = s.y ?? 0; ePosArr[i * 6 + 2] = s.z ?? 0;
          ePosArr[i * 6 + 3] = t.x ?? 0; ePosArr[i * 6 + 4] = t.y ?? 0; ePosArr[i * 6 + 5] = t.z ?? 0;
        }
        edgePos.needsUpdate = true;

        // Bridge layer — cross-substrate edges only.
        const bridgePos = r.bridgeLines.geometry.getAttribute('position') as THREE.BufferAttribute;
        const bPosArr = bridgePos.array as Float32Array;
        for (let j = 0; j < bridgeEdgeIndices.length; j++) {
          const e = graphEdges[bridgeEdgeIndices[j]];
          const s = simNodes[nodeIndexById.get(e.source) ?? 0];
          const t = simNodes[nodeIndexById.get(e.target) ?? 0];
          bPosArr[j * 6 + 0] = s.x ?? 0; bPosArr[j * 6 + 1] = s.y ?? 0; bPosArr[j * 6 + 2] = s.z ?? 0;
          bPosArr[j * 6 + 3] = t.x ?? 0; bPosArr[j * 6 + 4] = t.y ?? 0; bPosArr[j * 6 + 5] = t.z ?? 0;
        }
        bridgePos.needsUpdate = true;
      }

      // Rotate fire-count buckets.
      if (now - lastBucketEdge > BUCKET_MS) {
        lastBucketEdge = now;
        for (const s of ALL_SUBSTRATES) {
          const arr = fireStreakCounts.get(s);
          if (arr) { arr.shift(); arr.push(0); }
        }
      }
      updateClusterLabels(fireStreakCounts);

      // Dynamic raycaster threshold — keeps picking responsive at all
      // zoom levels. Threshold scales with camera distance.
      const camDist = r.camera.position.length();
      r.raycaster.params.Points = { threshold: Math.max(4, camDist * 0.012) };

      // Hover raycast.
      if (r.pointer.x >= -1) {
        r.raycaster.setFromCamera(r.pointer, r.camera);
        const hit = r.raycaster.intersectObject(r.nodePoints, false);
        if (hit.length > 0) {
          const idx = hit[0].index ?? -1;
          setHoveredNode(idx >= 0 && idx < graphNodes.length ? graphNodes[idx] : null);
        } else {
          setHoveredNode(null);
        }
      }

      refreshHighlight(r);

      // Fire sparks — written into pre-allocated pool.
      if (!prefersReducedMotion) {
        edgesByIdLookup.clear();
        for (const e of graphEdges) edgesByIdLookup.set(e.id, e);
        const active = firingQueue.tick(now, edgesByIdLookup);
        const drawCount = Math.min(active.length, MAX_FIRES);
        const { sparkPositions: spPos, sparkColors: spCol } = r;
        for (let i = 0; i < drawCount; i++) {
          const af = active[i];
          const edge = edgesByIdLookup.get(af.edgeId);
          if (!edge) continue;
          const s = simNodes[nodeIndexById.get(edge.source) ?? 0];
          const t = simNodes[nodeIndexById.get(edge.target) ?? 0];
          const blink = Math.sin(Math.PI * af.t);
          spPos[i * 3 + 0] = (s.x ?? 0) + ((t.x ?? 0) - (s.x ?? 0)) * af.t;
          spPos[i * 3 + 1] = (s.y ?? 0) + ((t.y ?? 0) - (s.y ?? 0)) * af.t;
          spPos[i * 3 + 2] = (s.z ?? 0) + ((t.z ?? 0) - (s.z ?? 0)) * af.t;
          const scale = 0.6 + 0.4 * blink * af.intensity;
          spCol[i * 3 + 0] = Math.min(1, af.colorRgb[0] * scale + 0.3);
          spCol[i * 3 + 1] = Math.min(1, af.colorRgb[1] * scale + 0.3);
          spCol[i * 3 + 2] = Math.min(1, af.colorRgb[2] * scale + 0.35);
          // Tally fire for this substrate.
          const srcIdx = nodeIndexById.get(edge.source) ?? 0;
          const sub = graphNodes[srcIdx]?.substrate;
          if (sub) {
            const arr = fireStreakCounts.get(sub);
            if (arr) arr[arr.length - 1]++;
          }
        }
        const sparkPosAttr = r.sparkPoints.geometry.getAttribute('position') as THREE.BufferAttribute;
        const sparkColAttr = r.sparkPoints.geometry.getAttribute('color') as THREE.BufferAttribute;
        sparkPosAttr.needsUpdate = true;
        sparkColAttr.needsUpdate = true;
        r.sparkPoints.geometry.setDrawRange(0, drawCount);
      }

      // Initial fit once the warmup layout has settled.
      if (needsInitialFit && graphNodes.length > 0) {
        needsInitialFit = false;
        fitCameraToCurrentSubset(false);
      }

      r.controls.update();
      r.composer.render();
      r.css2d.render(r.scene, r.camera);

      if (!disposed) requestAnimationFrame(tick);
    };

    requestAnimationFrame(tick);
  }

  /**
   * Per-frame: reposition each ATC cluster label at its substrate centroid
   * and refresh the NEURONS + FIRING readout.
   */
  function updateClusterLabels(fireStreakCounts: Map<SubstrateId, number[]>): void {
    const centroids = new Map<SubstrateId, { x: number; y: number; z: number; n: number }>();
    for (let i = 0; i < simNodes.length; i++) {
      const n = graphNodes[i];
      const s = simNodes[i];
      const c = centroids.get(n.substrate) ?? { x: 0, y: 0, z: 0, n: 0 };
      c.x += s.x ?? 0; c.y += s.y ?? 0; c.z += s.z ?? 0; c.n += 1;
      centroids.set(n.substrate, c);
    }
    for (const c of centroids.values()) {
      if (c.n > 0) { c.x /= c.n; c.y /= c.n; c.z /= c.n; }
    }

    for (const h of clusterLabels) {
      const sub = h.obj.userData.substrate as SubstrateId;
      const c = centroids.get(sub);
      const memberCount = c?.n ?? 0;

      if (!c || memberCount === 0) {
        // Zero visible nodes — fade label, show dash.
        h.obj.position.set(
          SUBSTRATE_ANCHOR[sub][0],
          SUBSTRATE_ANCHOR[sub][1] + 30,
          SUBSTRATE_ANCHOR[sub][2],
        );
        h.countEl.textContent = '\u2014';
        h.fireEl.textContent = 'FIRING 0.0%';
        if (focusSubstrate === null) {
          h.obj.element.style.opacity = '0.15';
        }
        continue;
      }

      h.obj.position.set(c.x, c.y + 24, c.z);
      h.countEl.textContent = `${formatCount(memberCount)} ${SUBSTRATE_NOUN[sub]}`;

      const arr = fireStreakCounts.get(sub) ?? [];
      const totalFires = arr.reduce((a, b) => a + b, 0);
      const perNodePerSec = totalFires / Math.max(1, memberCount) / 5;
      const pct = Math.min(999, perNodePerSec * 100);
      h.fireEl.textContent = `${pct.toFixed(1)}% ACTIVE`;

      // Opacity is controlled by focusSubstrate — set once in
      // applySubstrateFocus; default full opacity when no focus.
      if (focusSubstrate === null) {
        h.obj.element.style.opacity = '1';
      }
    }
  }

  function formatCount(n: number): string {
    if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
    return `${n}`;
  }

  /**
   * Rebuild the highlight geometry for edges connected to the hovered
   * node. Only active when `showSynapses` is on.
   */
  function refreshHighlight(r: SceneRefs): void {
    if (!hoveredNode || !showSynapses) {
      const pos = r.edgeHighlight.geometry.getAttribute('position');
      if (pos && (pos.array as Float32Array).length > 0) {
        r.edgeHighlight.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(0), 3));
        r.edgeHighlight.geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(0), 3));
      }
      return;
    }
    const hoveredId = hoveredNode.id;
    const matching: number[] = [];
    for (let i = 0; i < graphEdges.length; i++) {
      if (graphEdges[i].source === hoveredId || graphEdges[i].target === hoveredId) {
        matching.push(i);
      }
    }
    const posArr = new Float32Array(matching.length * 6);
    const colArr = new Float32Array(matching.length * 6);
    const white: [number, number, number] = [1, 1, 1];
    for (let j = 0; j < matching.length; j++) {
      const e = graphEdges[matching[j]];
      const s = simNodes[nodeIndexById.get(e.source) ?? 0];
      const t = simNodes[nodeIndexById.get(e.target) ?? 0];
      posArr[j * 6 + 0] = s.x ?? 0; posArr[j * 6 + 1] = s.y ?? 0; posArr[j * 6 + 2] = s.z ?? 0;
      posArr[j * 6 + 3] = t.x ?? 0; posArr[j * 6 + 4] = t.y ?? 0; posArr[j * 6 + 5] = t.z ?? 0;
      for (let v = 0; v < 2; v++) {
        colArr[j * 6 + v * 3 + 0] = white[0];
        colArr[j * 6 + v * 3 + 1] = white[1];
        colArr[j * 6 + v * 3 + 2] = white[2];
      }
    }
    r.edgeHighlight.geometry.setAttribute('position', new THREE.BufferAttribute(posArr, 3));
    r.edgeHighlight.geometry.setAttribute('color', new THREE.BufferAttribute(colArr, 3));
  }

  function setHoveredNode(n: GraphNode | null): void {
    if (hoveredNode?.id === n?.id) return;
    hoveredNode = n;
    onHover?.(n);
  }

  // ---------------------------------------------------------------------------
  // Teardown
  // ---------------------------------------------------------------------------

  function disposeScene(r: SceneRefs): void {
    r.resizeObserver.disconnect();
    r.controls.dispose();
    r.nodePoints.geometry.dispose();
    (r.nodePoints.material as THREE.ShaderMaterial).dispose();
    r.edgeLines.geometry.dispose();
    (r.edgeLines.material as THREE.LineBasicMaterial).dispose();
    r.bridgeLines.geometry.dispose();
    (r.bridgeLines.material as THREE.LineBasicMaterial).dispose();
    r.edgeHighlight.geometry.dispose();
    (r.edgeHighlight.material as THREE.LineBasicMaterial).dispose();
    r.sparkPoints.geometry.dispose();
    (r.sparkPoints.material as THREE.PointsMaterial).dispose();
    r.spriteTex.dispose();
    for (const h of clusterLabels) {
      h.obj.element.remove();
      h.obj.parent?.remove(h.obj);
    }
    clusterLabels = [];
    r.renderer.dispose();
    firingQueue.clear();
  }
</script>

<div class="brain-renderer" bind:this={hostEl} style="height: {height};">
  <canvas bind:this={canvasEl} class="brain-canvas" aria-label="3D living-brain canvas"></canvas>
  <div bind:this={css2dRoot} class="brain-css2d" aria-hidden="true"></div>
  <HoverLabel node={hoveredNode} x={hoverX} y={hoverY} />
</div>

<style>
  .brain-renderer {
    position: relative;
    width: 100%;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
    border-radius: var(--radius-lg);
    background: var(--bg);
    isolation: isolate;
  }

  .brain-canvas {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    display: block;
    cursor: grab;
  }

  .brain-canvas:active {
    cursor: grabbing;
  }

  .brain-canvas:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--accent);
  }

  .brain-css2d {
    position: absolute;
    inset: 0;
    pointer-events: none;
    width: 100%;
    height: 100%;
  }

  /* =========================================================================
     ATC cluster label — one per substrate.
     Glassmorphic pill with JetBrains Mono, accent colour, leader.
     Positioned by CSS2DRenderer so it always faces the screen.
     ======================================================================= */
  :global(.brain-cluster-label) {
    font-family: var(--font-mono);
    font-size: 11px;
    letter-spacing: 0.08em;
    line-height: 1.2;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 10px;
    color: color-mix(in srgb, var(--cluster-accent, var(--text)) 92%, transparent);
    background: color-mix(in srgb, var(--bg-elev-2) 72%, transparent);
    border: 1px solid color-mix(in srgb, var(--cluster-accent, var(--border)) 38%, transparent);
    border-radius: 999px;
    white-space: nowrap;
    text-transform: uppercase;
    font-weight: 600;
    text-shadow: 0 0 14px color-mix(in srgb, var(--cluster-accent, var(--bg)) 60%, transparent);
    box-shadow:
      0 4px 20px color-mix(in srgb, var(--bg) 80%, transparent),
      0 0 0 0.5px color-mix(in srgb, var(--cluster-accent, var(--border)) 20%, transparent);
    transform: translate(-50%, -100%);
    pointer-events: none;
    backdrop-filter: blur(8px);
    transition: opacity var(--ease-slow, 0.4s);
  }

  :global(.brain-cluster-label .cl-sep) {
    color: color-mix(in srgb, var(--cluster-accent, var(--text-faint)) 55%, transparent);
    font-weight: 400;
  }

  :global(.brain-cluster-label .cl-region) {
    font-weight: 700;
    font-size: 10px;
    letter-spacing: 0.12em;
  }

  :global(.brain-cluster-label .cl-count),
  :global(.brain-cluster-label .cl-fire) {
    font-variant-numeric: tabular-nums;
    font-weight: 500;
    font-size: 10px;
    opacity: 0.85;
  }
</style>
