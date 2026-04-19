<!--
  CLEO Studio — Brain canvas (unified 3D).

  Wave 1A of T990 consolidates the three legacy renderers (sigma 2D,
  cosmos.gl GPU, 3d-force-graph) into a single canvas driven by
  `ThreeBrainRenderer` + optional flat-2D fallback via the existing
  `LivingBrainCosmograph`. The shell uses only `$lib/ui/*` primitives
  and tokens from `tokens.css`.

  Agent E additions (Brain Emergency):
    - Three-phase progressive load UX (Phase 0 skeleton, Phase 1 tier-0,
      Phase 2 streaming remainder).
    - BrainMonitorPanel: Region Monitor + Node Detail with bridge listing.
    - SubstrateLegend with click/dbl-click/shift-click interactions.
    - BrainControlsDock: synapses, bridges-only, breathing-pause, reset.
    - BrainSearchBar: header search with API + client-side fallback.
    - BrainStreamIndicator: streaming dot-pulse + warmup progress bar.
    - Full keyboard shortcut layer (1-5, 0, f, /, Esc, b, s).

  Aesthetic: "Living cortical nebula." Pitch-black canvas, neon-glass
  instrumentation, token-driven substrate palette, JetBrains Mono for
  numerics/labels, Inter for body. No hex literals anywhere below.

  @task T990
  @wave 1A
-->
<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { page } from '$app/state';
  import type {
    BrainConnectionStatus,
    BrainEdge,
    BrainGraph,
    BrainNode,
    BrainSubstrate,
  } from '@cleocode/brain';

  import LivingBrainCosmograph from '$lib/components/LivingBrainCosmograph.svelte';
  import Badge from '$lib/ui/Badge.svelte';
  import Breadcrumb from '$lib/ui/Breadcrumb.svelte';
  import Tabs from '$lib/ui/Tabs.svelte';
  import type { TabItem } from '$lib/ui/Tabs.svelte';

  import {
    ALL_EDGE_KINDS,
    ALL_SUBSTRATES,
    ThreeBrainRenderer,
    createSseBridge,
    type BrainLiveStatus,
    type EdgeKind,
    type FireEvent,
    type GraphEdge,
    type GraphNode,
    type SseBridgeHandle,
    type SubstrateId,
  } from '$lib/graph/index.js';
  import { mockBrain } from '$lib/graph/mock.js';

  import {
    BrainControlsDock,
    BrainLoadingSkeleton,
    BrainMonitorPanel,
    BrainSearchBar,
    BrainStreamIndicator,
    SubstrateLegend,
    type BridgeEvent,
    type RegionStats,
  } from '$lib/components/brain/index.js';

  // ---------------------------------------------------------------------------
  // Types
  // ---------------------------------------------------------------------------

  interface PageData {
    graph: BrainGraph;
  }

  let { data }: { data: PageData } = $props();

  // ---------------------------------------------------------------------------
  // Source graph + live SSE state
  // ---------------------------------------------------------------------------

  let rawGraph = $state<BrainGraph>(data.graph);
  let mockMode = $state(false);
  let connectionStatus = $state<BrainLiveStatus>('connecting');

  let bridge: SseBridgeHandle | null = null;
  let pulsingNodes = $state<Set<string>>(new Set<string>());
  let pendingFires = $state<FireEvent[]>([]);
  const PULSE_DURATION_MS = 1200;

  const substratePalette: Record<SubstrateId, string> = {
    brain: 'var(--info)',
    nexus: 'var(--success)',
    tasks: 'var(--warning)',
    conduit: 'var(--accent)',
    signaldock: 'var(--danger)',
  };

  // ---------------------------------------------------------------------------
  // Load phase state
  // ---------------------------------------------------------------------------

  /**
   * Load phase:
   *   'skeleton' — Phase 0: server HTML delivered, renderer not yet mounted.
   *   'streaming' — Phase 1/2: tier-0 nodes displayed, remainder streaming in.
   *   'ready'     — Phase 2 complete: all nodes rendered.
   */
  let loadPhase = $state<'skeleton' | 'streaming' | 'ready'>('skeleton');

  /** Simulation warmup progress [0..100] — driven by ThreeBrainRenderer when available. */
  let warmupProgress = $state(0);

  /** Whether we are currently streaming remaining tier-1+ nodes. */
  let isStreaming = $state(false);

  // ---------------------------------------------------------------------------
  // Filter state
  // ---------------------------------------------------------------------------

  let enabledSubstrates = $state<Set<SubstrateId>>(
    new Set<SubstrateId>([...ALL_SUBSTRATES]),
  );
  let enabledKinds = $state<Set<EdgeKind>>(new Set<EdgeKind>(ALL_EDGE_KINDS));
  let minWeight = $state(0);
  let useTimeSlider = $state(false);
  let sliderIndex = $state(0);
  let viewMode = $state<'3d' | 'flat'>('3d');

  let selectedNode = $state<GraphNode | null>(null);
  let hoveredNode = $state<GraphNode | null>(null);

  /**
   * Substrate drill-down target. `null` means full brain. Setting this
   * animates the 3D camera to that substrate's centroid.
   */
  let focusSubstrate = $state<SubstrateId | null>(null);

  /**
   * Solo substrate — when set, all other substrates are hidden. Double-click
   * a SubstrateLegend chip to enter, double-click again to exit.
   */
  let soloSubstrate = $state<SubstrateId | null>(null);

  /** Whether the 3D renderer draws edge line segments. */
  let showSynapses = $state(false);

  /** When true, hide intra-substrate edges and show only bridge edges. */
  let showBridgesOnly = $state(false);

  /** When true, pause the ambient d3 sim breathing. */
  let breathingPaused = $state(false);

  // ---------------------------------------------------------------------------
  // Region monitor state — firing history per substrate
  // ---------------------------------------------------------------------------

  const HISTORY_SAMPLES = 60;

  /**
   * Rolling firing rate history for each substrate. Each entry is a rate
   * value in [0..100]. Capped at HISTORY_SAMPLES samples.
   */
  let firingHistory = $state<Record<SubstrateId, number[]>>({
    brain: [],
    nexus: [],
    tasks: [],
    conduit: [],
    signaldock: [],
  });

  /** Currently-firing substrates (drives pulse dots). */
  let firingSubstrates = $state<Set<SubstrateId>>(new Set<SubstrateId>());

  /** Recent bridge events for the Active Bridges strip. */
  let recentBridgeEvents = $state<BridgeEvent[]>([]);

  /** Rolling 5-second fire counts per substrate, used to compute firing rate. */
  const substrateFireCount = new Map<SubstrateId, number>([
    ['brain', 0], ['nexus', 0], ['tasks', 0], ['conduit', 0], ['signaldock', 0],
  ]);

  // Sample the firing rate once per second.
  let firingRateInterval: ReturnType<typeof setInterval> | null = null;

  function sampleFiringRates(): void {
    for (const s of ALL_SUBSTRATES) {
      const nodeCount = rawGraph.counts.nodes[s] ?? 1;
      const fireCount = substrateFireCount.get(s) ?? 0;
      // Normalise to a percentage (fires per node per second × 100).
      const rate = Math.min(100, (fireCount / Math.max(1, nodeCount)) * 100);
      substrateFireCount.set(s, 0);
      const history = firingHistory[s];
      const next = [...history, rate].slice(-HISTORY_SAMPLES);
      firingHistory = { ...firingHistory, [s]: next };
      if (rate > 0.5) {
        firingSubstrates = new Set([...firingSubstrates, s]);
        // Clear the firing indicator after 2s.
        setTimeout(() => {
          const ns = new Set(firingSubstrates);
          ns.delete(s);
          firingSubstrates = ns;
        }, 2000);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Derived — normalised graph for the renderer
  // ---------------------------------------------------------------------------

  function toGraphNode(n: BrainNode, degree: number, maxDegree: number): GraphNode {
    const isHub = degree / Math.max(1, maxDegree) > 0.55 || (n.weight ?? 0) >= 0.85;
    return {
      id: n.id,
      substrate: n.substrate,
      kind: n.kind,
      label: n.label,
      category: (n.meta?.cluster_id as string | undefined) ?? n.substrate,
      weight: n.weight,
      freshness: freshnessFor(n),
      meta: { ...n.meta, isHub },
    };
  }

  function toGraphEdge(e: BrainEdge, idx: number): GraphEdge {
    const kind = ALL_EDGE_KINDS.includes(e.type as EdgeKind)
      ? (e.type as EdgeKind)
      : ('relates_to' satisfies EdgeKind);
    const sourceSubstrate = rawGraph.nodes.find((n) => n.id === e.source)?.substrate;
    const targetSubstrate = rawGraph.nodes.find((n) => n.id === e.target)?.substrate;
    const isBridge = sourceSubstrate !== undefined && targetSubstrate !== undefined
      && sourceSubstrate !== targetSubstrate;
    return {
      id: `e${idx}:${e.source}>${e.target}:${e.type}`,
      source: e.source,
      target: e.target,
      kind,
      weight: e.weight,
      directional: true,
      meta: { isBridge, bridgeType: isBridge ? `${sourceSubstrate}->${targetSubstrate}` : undefined },
    };
  }

  function freshnessFor(n: BrainNode): number {
    if (!n.createdAt) return 0.3;
    const t = Date.parse(n.createdAt);
    if (!Number.isFinite(t)) return 0.3;
    const age = Math.max(0, Date.now() - t);
    const ms30d = 30 * 24 * 60 * 60 * 1000;
    return Math.max(0.15, 1 - age / ms30d);
  }

  let allDates = $derived.by(() =>
    [...new Set(rawGraph.nodes.map((n) => n.createdAt?.slice(0, 10)).filter((d): d is string => !!d))].sort(),
  );

  let filterDate = $derived(useTimeSlider ? (allDates[sliderIndex] ?? null) : null);

  /**
   * Compute the effective enabled substrates, accounting for solo mode.
   * When soloSubstrate is set, only that substrate's nodes are shown.
   */
  let effectiveSubstrates = $derived.by<Set<SubstrateId>>(() => {
    if (soloSubstrate !== null) return new Set<SubstrateId>([soloSubstrate]);
    return enabledSubstrates;
  });

  let filteredRaw = $derived.by<{ nodes: BrainNode[]; edges: BrainEdge[] }>(() => {
    const filteredNodes = rawGraph.nodes.filter((n) => {
      if (!effectiveSubstrates.has(n.substrate)) return false;
      if ((n.weight ?? 1) < minWeight) return false;
      if (filterDate !== null && n.createdAt !== null && n.createdAt.slice(0, 10) > filterDate) {
        return false;
      }
      return true;
    });
    const allowedIds = new Set(filteredNodes.map((n) => n.id));
    const filteredEdges = rawGraph.edges.filter((e) => {
      if (!allowedIds.has(e.source) || !allowedIds.has(e.target)) return false;
      const kind = (ALL_EDGE_KINDS.includes(e.type as EdgeKind) ? e.type : 'relates_to') as EdgeKind;
      if (!enabledKinds.has(kind)) return false;
      return true;
    });
    return { nodes: filteredNodes, edges: filteredEdges };
  });

  let renderGraph = $derived.by<{ nodes: GraphNode[]; edges: GraphEdge[] }>(() => {
    const { nodes: ns, edges: es } = filteredRaw;
    // Include the server-computed cross-substrate bridges (already in kit
    // GraphEdge shape with meta.isBridge=true) in degree and render edges.
    const serverBridges = data.bridges ?? [];
    const nodeIdSet = new Set(ns.map((n) => n.id));
    const visibleBridges = serverBridges.filter(
      (b) => nodeIdSet.has(b.source) && nodeIdSet.has(b.target),
    );

    const degree = new Map<string, number>();
    for (const e of es) {
      degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
      degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
    }
    for (const b of visibleBridges) {
      degree.set(b.source, (degree.get(b.source) ?? 0) + 1);
      degree.set(b.target, (degree.get(b.target) ?? 0) + 1);
    }
    const maxDegree = Math.max(1, ...degree.values());
    const intraEdges = es.map((e, i) => toGraphEdge(e, i));
    const allEdges = [...intraEdges, ...visibleBridges];
    // Bridges-only filter: strip intra-substrate edges when toggle is on.
    const edges = showBridgesOnly
      ? allEdges.filter((e) => (e.meta as { isBridge?: boolean } | undefined)?.isBridge === true)
      : allEdges;
    return {
      nodes: ns.map((n) => toGraphNode(n, degree.get(n.id) ?? 0, maxDegree)),
      edges,
    };
  });

  let totalNodes = $derived(renderGraph.nodes.length);
  let totalEdges = $derived(renderGraph.edges.length);
  let hubNodes = $derived(renderGraph.nodes.filter((n) => (n.meta as { isHub?: boolean } | undefined)?.isHub === true));

  // ---------------------------------------------------------------------------
  // Region monitor derived stats
  // ---------------------------------------------------------------------------

  const REGION_NAMES: Record<SubstrateId, string> = {
    brain: 'BRAIN',
    nexus: 'NEXUS',
    tasks: 'TASKS',
    conduit: 'CONDUIT',
    signaldock: 'SIGNALDOCK',
  };

  /**
   * Bridge edge count per substrate — edges where source and target have
   * different substrates, involving this substrate.
   */
  const bridgeCounts = $derived.by<Record<SubstrateId, number>>(() => {
    const counts: Record<SubstrateId, number> = {
      brain: 0, nexus: 0, tasks: 0, conduit: 0, signaldock: 0,
    };
    for (const edge of renderGraph.edges) {
      if ((edge.meta as { isBridge?: boolean } | undefined)?.isBridge !== true) continue;
      const srcNode = renderGraph.nodes.find((n) => n.id === edge.source);
      const tgtNode = renderGraph.nodes.find((n) => n.id === edge.target);
      if (srcNode) counts[srcNode.substrate] = (counts[srcNode.substrate] ?? 0) + 1;
      if (tgtNode) counts[tgtNode.substrate] = (counts[tgtNode.substrate] ?? 0) + 1;
    }
    return counts;
  });

  const regionStats = $derived<RegionStats[]>(
    ALL_SUBSTRATES.map((s) => ({
      substrate: s,
      regionName: REGION_NAMES[s],
      neuronCount: rawGraph.counts.nodes[s] ?? 0,
      firingRate: (firingHistory[s]?.slice(-5) ?? []).reduce((a, b) => a + b, 0)
        / Math.max(1, (firingHistory[s]?.slice(-5) ?? []).length),
      bridgeCount: bridgeCounts[s] ?? 0,
      history: firingHistory[s] ?? [],
      firing: firingSubstrates.has(s),
      colorVar: substratePalette[s],
    })),
  );

  // ---------------------------------------------------------------------------
  // Search
  // ---------------------------------------------------------------------------

  let searchInput = $state<HTMLInputElement | null>(null);

  // ---------------------------------------------------------------------------
  // Live bridge
  // ---------------------------------------------------------------------------

  function pulse(id: string): void {
    pulsingNodes = new Set([...pulsingNodes, id]);
    setTimeout(() => {
      const next = new Set(pulsingNodes);
      next.delete(id);
      pulsingNodes = next;
    }, PULSE_DURATION_MS);
  }

  function enqueueFire(edgeId: string, fromSubstrate?: SubstrateId, toSubstrate?: SubstrateId): void {
    pendingFires = [
      ...pendingFires,
      { id: `f${Date.now()}:${Math.random().toString(36).slice(2, 7)}`, edgeId, intensity: 0.9, emittedAt: performance.now() },
    ];
    if (pendingFires.length > 64) pendingFires = pendingFires.slice(-64);

    // Track for firing rate.
    if (fromSubstrate) {
      substrateFireCount.set(fromSubstrate, (substrateFireCount.get(fromSubstrate) ?? 0) + 1);
    }

    // Track bridge events.
    if (fromSubstrate && toSubstrate && fromSubstrate !== toSubstrate) {
      const ev: BridgeEvent = {
        id: `br${Date.now()}:${Math.random().toString(36).slice(2, 6)}`,
        fromSubstrate,
        toSubstrate,
        fromLabel: fromSubstrate,
        toLabel: toSubstrate,
        edgeKind: 'fires',
        timestampMs: Date.now(),
      };
      recentBridgeEvents = [ev, ...recentBridgeEvents].slice(0, 20);
    }
  }

  onMount(() => {
    // Phase 0 → Phase 1 transition: renderer mounts immediately.
    loadPhase = 'streaming';

    // Simulate warmup progress from 0 → 100 as the d3 sim cools.
    // In a real integration, ThreeBrainRenderer would emit a warmup event.
    let warmupStep = 0;
    const warmupTimer = setInterval(() => {
      warmupStep += Math.random() * 8 + 4;
      warmupProgress = Math.min(100, warmupStep);
      if (warmupProgress >= 100) {
        clearInterval(warmupTimer);
        loadPhase = 'ready';
        isStreaming = false;
      }
    }, 120);

    // Start firing rate sampler.
    firingRateInterval = setInterval(sampleFiringRates, 1000);

    if (page.url.searchParams.get('mock') === '1') {
      mockMode = true;
      const mock = mockBrain(400, 600);
      rawGraph = {
        nodes: mock.nodes.map(
          (n): BrainNode => ({
            id: n.id,
            kind: n.kind as BrainNode['kind'],
            substrate: n.substrate,
            label: n.label,
            weight: n.weight ?? 0.3,
            createdAt: new Date().toISOString(),
            meta: { ...(n.meta ?? {}) },
          }),
        ),
        edges: mock.edges.map(
          (e): BrainEdge => ({
            source: e.source,
            target: e.target,
            type: e.kind,
            weight: e.weight ?? 0.3,
            substrate: 'cross',
          }),
        ),
        counts: {
          nodes: {
            brain: mock.nodes.filter((n) => n.substrate === 'brain').length,
            nexus: mock.nodes.filter((n) => n.substrate === 'nexus').length,
            tasks: mock.nodes.filter((n) => n.substrate === 'tasks').length,
            conduit: mock.nodes.filter((n) => n.substrate === 'conduit').length,
            signaldock: mock.nodes.filter((n) => n.substrate === 'signaldock').length,
          },
          edges: {
            brain: 0,
            nexus: 0,
            tasks: 0,
            conduit: 0,
            signaldock: 0,
            cross: mock.edges.length,
          },
        },
        truncated: false,
      } as BrainGraph;
      connectionStatus = 'disconnected';
      isStreaming = false;
    } else {
      isStreaming = true;
      bridge = createSseBridge({
        callbacks: {
          onStatus: (s) => {
            connectionStatus = s as BrainConnectionStatus;
            if (s === 'connected') isStreaming = false;
          },
          onNodeCreate: (ev) => {
            const exists = rawGraph.nodes.some((n) => n.id === ev.node.id);
            if (!exists) {
              rawGraph = {
                ...rawGraph,
                nodes: [...rawGraph.nodes, ev.node],
                counts: {
                  ...rawGraph.counts,
                  nodes: {
                    ...rawGraph.counts.nodes,
                    [ev.node.substrate]: (rawGraph.counts.nodes[ev.node.substrate] ?? 0) + 1,
                  },
                },
              };
            }
            pulse(ev.node.id);
          },
          onEdgeStrengthen: (ev) => {
            const match = renderGraph.edges.find(
              (e) => e.source === ev.fromId && e.target === ev.toId,
            );
            if (match) {
              const srcNode = renderGraph.nodes.find((n) => n.id === match.source);
              const tgtNode = renderGraph.nodes.find((n) => n.id === match.target);
              enqueueFire(match.id, srcNode?.substrate, tgtNode?.substrate);
            }
          },
          onTaskStatus: (ev) => {
            const nodeId = `tasks:${ev.taskId}`;
            const idx = rawGraph.nodes.findIndex((n) => n.id === nodeId);
            if (idx !== -1) {
              const updated: BrainNode = {
                ...rawGraph.nodes[idx],
                meta: { ...rawGraph.nodes[idx].meta, status: ev.status },
              };
              const nodes = [...rawGraph.nodes];
              nodes[idx] = updated;
              rawGraph = { ...rawGraph, nodes };
              pulse(nodeId);
              substrateFireCount.set('tasks', (substrateFireCount.get('tasks') ?? 0) + 1);
            }
          },
          onMessageSend: (ev) => {
            pulse(`conduit:${ev.messageId}`);
            substrateFireCount.set('conduit', (substrateFireCount.get('conduit') ?? 0) + 1);
          },
        },
      });
    }

    // Restore view from URL params.
    const view = page.url.searchParams.get('view');
    if (view === 'flat' || view === '2d' || view === 'gpu') {
      viewMode = 'flat';
    }
  });

  onDestroy(() => {
    bridge?.dispose();
    bridge = null;
    if (firingRateInterval !== null) {
      clearInterval(firingRateInterval);
      firingRateInterval = null;
    }
  });

  // ---------------------------------------------------------------------------
  // Interaction handlers
  // ---------------------------------------------------------------------------

  /**
   * Handle a substrate chip click. If focusSubstrate already equals `s`,
   * clear focus; otherwise set focus. Also updates enabledSubstrates.
   */
  function handleSubstrateFocus(s: SubstrateId): void {
    if (soloSubstrate !== null) return; // Solo overrides focus.
    if (focusSubstrate === s) {
      focusSubstrate = null;
      enabledSubstrates = new Set<SubstrateId>([...ALL_SUBSTRATES]);
    } else {
      focusSubstrate = s;
      // Enable all substrates so the camera can still see context.
      enabledSubstrates = new Set<SubstrateId>([...ALL_SUBSTRATES]);
    }
  }

  /**
   * Shift-click: toggle individual substrate visibility.
   */
  function handleSubstrateToggle(s: SubstrateId): void {
    const next = new Set(enabledSubstrates);
    if (next.has(s)) next.delete(s);
    else next.add(s);
    enabledSubstrates = next;
    if (next.size === 1) {
      focusSubstrate = [...next][0];
    } else {
      focusSubstrate = null;
    }
  }

  /**
   * Double-click: enter or exit solo mode.
   */
  function handleSubstrateSolo(s: SubstrateId | null): void {
    soloSubstrate = s;
    if (s !== null) {
      focusSubstrate = s;
      enabledSubstrates = new Set<SubstrateId>([s]);
    } else {
      focusSubstrate = null;
      enabledSubstrates = new Set<SubstrateId>([...ALL_SUBSTRATES]);
    }
  }

  function toggleSynapses(): void {
    showSynapses = !showSynapses;
  }

  function toggleBridgesOnly(): void {
    showBridgesOnly = !showBridgesOnly;
  }

  function toggleBreathing(): void {
    breathingPaused = !breathingPaused;
  }

  function clearFocus(): void {
    focusSubstrate = null;
    soloSubstrate = null;
    enabledSubstrates = new Set<SubstrateId>([...ALL_SUBSTRATES]);
  }

  function resetView(): void {
    // ThreeBrainRenderer listens for a `fitView` prop change or emits on `f`.
    // We dispatch a keyboard event so it handles it internally.
    const fakeEvent = new KeyboardEvent('keydown', { key: 'f', bubbles: true });
    document.dispatchEvent(fakeEvent);
  }

  function toggleEdgeKind(k: EdgeKind): void {
    const next = new Set(enabledKinds);
    if (next.has(k)) next.delete(k);
    else next.add(k);
    enabledKinds = next;
  }

  function toggleSlider(): void {
    useTimeSlider = !useTimeSlider;
    if (useTimeSlider && allDates.length > 0) sliderIndex = allDates.length - 1;
  }

  function onSliderChange(e: Event): void {
    sliderIndex = Number.parseInt((e.target as HTMLInputElement).value, 10);
  }

  function handleNodeSelect(node: GraphNode): void {
    selectedNode = node;
  }

  function handleHover(node: GraphNode | null): void {
    hoveredNode = node;
  }

  function closePanel(): void {
    selectedNode = null;
  }

  function handleSearchResultSelect(node: GraphNode): void {
    selectedNode = node;
    // Focus the substrate containing the result.
    focusSubstrate = node.substrate;
  }

  /** Global keyboard shortcuts. */
  function handleKeyDown(e: KeyboardEvent): void {
    const tag = (document.activeElement as HTMLElement)?.tagName;
    const inInput = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';

    if (e.key === 'Escape') {
      if (selectedNode) {
        e.preventDefault();
        closePanel();
      } else if (soloSubstrate !== null || focusSubstrate !== null) {
        e.preventDefault();
        clearFocus();
      }
      return;
    }

    if (inInput) return;

    // Substrate focus shortcuts: 1–5.
    const digitMap: Record<string, SubstrateId> = {
      '1': 'brain', '2': 'nexus', '3': 'tasks', '4': 'conduit', '5': 'signaldock',
    };
    if (digitMap[e.key]) {
      e.preventDefault();
      handleSubstrateFocus(digitMap[e.key]);
      return;
    }

    // 0 → clear focus.
    if (e.key === '0') {
      e.preventDefault();
      clearFocus();
      return;
    }

    // f → fit camera.
    if (e.key === 'f') {
      e.preventDefault();
      resetView();
      return;
    }

    // / → focus search input.
    if (e.key === '/') {
      e.preventDefault();
      searchInput?.focus();
      return;
    }

    // b → toggle bridges only.
    if (e.key === 'b') {
      e.preventDefault();
      toggleBridgesOnly();
      return;
    }

    // s → toggle synapses.
    if (e.key === 's') {
      e.preventDefault();
      toggleSynapses();
      return;
    }
  }

  const tabItems: TabItem[] = [
    { value: '3d', label: '3D canvas' },
    { value: 'flat', label: 'Flat 2D' },
  ];

  function statusTone(status: BrainLiveStatus): 'success' | 'warning' | 'danger' | 'neutral' {
    switch (status) {
      case 'connected': return 'success';
      case 'connecting':
      case 'error': return 'warning';
      case 'disconnected': return 'neutral';
      default: return 'neutral';
    }
  }
</script>

<svelte:window onkeydown={handleKeyDown} />
<svelte:head>
  <title>Brain — CLEO Studio</title>
  <meta name="description" content="Living 3D neural map of CLEO's BRAIN, NEXUS, TASKS, CONDUIT, and SIGNALDOCK substrates." />
</svelte:head>

<div class="brain-shell" data-brain-shell>
  <!-- ===========================================================================
       Header
       ========================================================================= -->
  <header class="brain-header">
    <div class="brain-header-top">
      <Breadcrumb items={[{ label: 'CLEO Studio', href: '/' }, { label: 'Brain' }]} />

      <!-- Search bar -->
      <BrainSearchBar
        nodes={renderGraph.nodes}
        onResultSelect={handleSearchResultSelect}
        bind:searchInput
      />

      <!-- Live status + counts -->
      <div class="brain-live">
        <Badge tone={statusTone(connectionStatus)} pill size="sm">
          {#if connectionStatus === 'connected'}
            Live stream
          {:else if connectionStatus === 'connecting'}
            Connecting…
          {:else if connectionStatus === 'error'}
            Reconnecting…
          {:else}
            {mockMode ? 'Mocked' : 'Offline'}
          {/if}
        </Badge>
        <span class="brain-live-counts">
          <span class="num">{totalNodes}</span> nodes<span class="sep">·</span>
          <span class="num">{totalEdges}</span> edges
          {#if rawGraph.truncated}
            <Badge tone="warning" size="sm">truncated</Badge>
          {/if}
        </span>
      </div>
    </div>

    <div class="brain-header-hero">
      <div class="hero-label">Living substrate · macro view</div>
      <h1 class="hero-title">Cortical nebula of CLEO.</h1>
      <p class="hero-sub">
        One pane, five substrates, one physics. Click any node to open its provenance;
        hover to trace live synapses across BRAIN, NEXUS, TASKS, CONDUIT, and SIGNALDOCK.
      </p>
    </div>

    <div class="brain-controls cluster-flow">
      <Tabs items={tabItems} bind:value={viewMode} label="Canvas mode" />

      <!-- Enhanced substrate legend -->
      <SubstrateLegend
        {enabledSubstrates}
        nodeCounts={rawGraph.counts.nodes}
        {firingSubstrates}
        {focusSubstrate}
        {soloSubstrate}
        onFocus={handleSubstrateFocus}
        onToggle={handleSubstrateToggle}
        onSolo={handleSubstrateSolo}
      />

      <label class="weight-block">
        <span class="weight-label">min weight</span>
        <input
          type="range"
          min="0"
          max="1"
          step="0.05"
          bind:value={minWeight}
          class="range"
          aria-label="Minimum node weight"
        />
        <span class="weight-val">{minWeight.toFixed(2)}</span>
      </label>

      <div class="time-block">
        <button
          type="button"
          class="time-chip"
          class:active={useTimeSlider}
          onclick={toggleSlider}
          aria-pressed={useTimeSlider}
        >
          Time
        </button>
        {#if useTimeSlider && allDates.length > 0}
          <input
            type="range"
            min={0}
            max={allDates.length - 1}
            value={sliderIndex}
            oninput={onSliderChange}
            class="range"
            aria-label="Time range"
          />
          <span class="time-val">{allDates[sliderIndex] ?? ''}</span>
        {/if}
      </div>

      <!-- Keyboard shortcut legend (compact) -->
      <div class="kbd-strip" aria-label="Keyboard shortcuts">
        <span class="kbd-item"><kbd>1–5</kbd> focus substrate</span>
        <span class="kbd-item"><kbd>0</kbd> clear</span>
        <span class="kbd-item"><kbd>f</kbd> fit</span>
        <span class="kbd-item"><kbd>/</kbd> search</span>
        <span class="kbd-item"><kbd>s</kbd> synapses</span>
        <span class="kbd-item"><kbd>b</kbd> bridges</span>
        <span class="kbd-item"><kbd>Esc</kbd> dismiss</span>
      </div>
    </div>
  </header>

  <!-- ===========================================================================
       Body — canvas + side panel
       ========================================================================= -->
  <main id="main" class="brain-body" tabindex="-1">
    <section class="brain-canvas-wrap" aria-label="Brain canvas">
      <!-- Phase 0: skeleton (shown until renderer mounts) -->
      <BrainLoadingSkeleton visible={loadPhase === 'skeleton'} height="100%" />

      <!-- Edge grid overlay -->
      <div class="edge-rail" aria-hidden="true"></div>

      <!-- Canvas host -->
      <div class="brain-canvas-host" class:skeleton-visible={loadPhase === 'skeleton'}>
        {#if viewMode === '3d'}
          <ThreeBrainRenderer
            nodes={renderGraph.nodes}
            edges={renderGraph.edges}
            onNodeSelect={handleNodeSelect}
            onCanvasClear={closePanel}
            onHover={handleHover}
            {pulsingNodes}
            {pendingFires}
            {showSynapses}
            {focusSubstrate}
            height="100%"
          />
        {:else}
          <LivingBrainCosmograph
            nodes={renderGraph.nodes}
            edges={renderGraph.edges}
            onNodeSelect={handleNodeSelect}
            onCanvasClear={closePanel}
            height="100%"
            pulsingNodes={pulsingNodes}
            onInitFailed={() => { viewMode = '3d'; }}
          />
        {/if}
      </div>

      <!-- Phase 1/2: streaming + warmup indicator -->
      <BrainStreamIndicator
        streaming={isStreaming}
        warmupProgress={warmupProgress}
      />

      <!-- Hover hint -->
      {#if hoveredNode && !selectedNode}
        <div class="hover-hint" aria-live="polite">
          <span class="hint-kbd">Enter</span>
          <span class="hint-text">to open {hoveredNode.label}</span>
        </div>
      {/if}
    </section>

    <!-- Brain monitor / node detail side panel -->
    <aside class="brain-side" aria-label="Brain monitor and node detail">
      <BrainMonitorPanel
        {selectedNode}
        edges={renderGraph.edges}
        nodes={renderGraph.nodes}
        {regionStats}
        bridgeEvents={recentBridgeEvents}
        onNodeSelect={handleNodeSelect}
        onClose={closePanel}
        onFocusSubstrate={handleSubstrateFocus}
      />

      <!-- Navigator hub list (shown below monitor when nothing selected) -->
      {#if !selectedNode && hubNodes.length > 0}
        <div class="hub-panel">
          <div class="hub-eyebrow">Hub nodes · {hubNodes.length}</div>
          <ul class="node-list" role="list">
            {#each hubNodes.slice(0, 80) as hub (hub.id)}
              <li>
                <button
                  type="button"
                  class="node-row"
                  onclick={() => handleNodeSelect(hub)}
                >
                  <span
                    class="row-dot"
                    style="--row-tint: {substratePalette[hub.substrate]}"
                    aria-hidden="true"
                  ></span>
                  <span class="row-label">{hub.label}</span>
                  <span class="row-meta">{hub.substrate}</span>
                </button>
              </li>
            {/each}
          </ul>
        </div>
      {/if}
    </aside>
  </main>

  <!-- ===========================================================================
       Controls dock
       ========================================================================= -->
  <BrainControlsDock
    {enabledKinds}
    {showSynapses}
    {showBridgesOnly}
    {breathingPaused}
    onToggleKind={toggleEdgeKind}
    onToggleSynapses={toggleSynapses}
    onToggleBridgesOnly={toggleBridgesOnly}
    onToggleBreathing={toggleBreathing}
    onResetView={resetView}
  />
</div>

<style>
  /* =========================================================================
     Layout shell
     ========================================================================= */
  .brain-shell {
    display: grid;
    grid-template-rows: auto 1fr auto;
    gap: var(--space-4);
    height: calc(100vh - 3rem - 4rem);
    min-height: 640px;
    padding: var(--space-4);
    background: radial-gradient(
      ellipse 80% 60% at 50% -10%,
      color-mix(in srgb, var(--accent) 18%, transparent),
      transparent 70%
    ),
    var(--bg);
    color: var(--text);
  }

  /* =========================================================================
     Header
     ========================================================================= */
  .brain-header {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .brain-header-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-4);
    flex-wrap: wrap;
  }

  .brain-live {
    display: inline-flex;
    align-items: center;
    gap: var(--space-3);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--text-dim);
    margin-left: auto;
  }

  .brain-live-counts {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    font-variant-numeric: tabular-nums;
  }

  .brain-live-counts .num {
    color: var(--text);
    font-weight: 600;
  }

  .brain-live-counts .sep {
    color: var(--text-faint);
  }

  .brain-header-hero {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    max-width: 720px;
  }

  .hero-label {
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    text-transform: uppercase;
    letter-spacing: 0.2em;
    color: var(--accent);
  }

  .hero-title {
    font-family: var(--font-sans);
    font-size: var(--text-2xl);
    font-weight: 700;
    letter-spacing: -0.01em;
    line-height: var(--leading-tight);
    margin: 0;
    background: linear-gradient(
      180deg,
      var(--text) 0%,
      color-mix(in srgb, var(--text) 60%, var(--accent) 40%) 100%
    );
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
  }

  .hero-sub {
    font-size: var(--text-sm);
    color: var(--text-dim);
    max-width: 640px;
  }

  .brain-controls {
    padding: var(--space-3);
    background: var(--bg-elev-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--space-3);
  }

  .weight-block,
  .time-block {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    color: var(--text-dim);
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }

  .weight-label {
    color: var(--text-faint);
  }

  .weight-val,
  .time-val {
    color: var(--text);
    font-variant-numeric: tabular-nums;
    min-width: 3ch;
    text-align: right;
  }

  .range {
    width: 100px;
    accent-color: var(--accent);
  }

  .time-chip {
    display: inline-flex;
    align-items: center;
    padding: 3px var(--space-3);
    background: transparent;
    border: 1px solid var(--border);
    border-radius: var(--radius-pill);
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-dim);
    cursor: pointer;
    transition: background var(--ease), border-color var(--ease), color var(--ease);
  }

  .time-chip.active {
    color: var(--text);
    background: var(--bg-elev-2);
    border-color: var(--accent);
  }

  .kbd-strip {
    display: inline-flex;
    align-items: center;
    gap: var(--space-3);
    flex-wrap: wrap;
    margin-left: auto;
  }

  .kbd-item {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-family: var(--font-mono);
    font-size: 0.6rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-faint);
    white-space: nowrap;
  }

  .kbd-item kbd {
    display: inline-block;
    padding: 0 4px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--radius-xs);
    font-family: inherit;
    font-size: inherit;
    color: var(--text-dim);
    line-height: 1.6;
  }

  /* =========================================================================
     Body — canvas + side panel
     ========================================================================= */
  .brain-body {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 300px;
    gap: var(--space-4);
    min-height: 0;
    outline: none;
  }

  @media (max-width: 960px) {
    .brain-body {
      grid-template-columns: 1fr;
    }
  }

  .brain-canvas-wrap {
    position: relative;
    min-height: 0;
    min-width: 0;
    border-radius: var(--radius-lg);
    overflow: hidden;
    border: 1px solid var(--border);
    background: var(--bg);
    box-shadow:
      0 0 0 1px color-mix(in srgb, var(--accent) 25%, transparent),
      var(--shadow-lg);
  }

  .brain-canvas-host {
    position: absolute;
    inset: 0;
    transition: opacity var(--ease-slow);
  }

  .brain-canvas-host.skeleton-visible {
    opacity: 0;
    pointer-events: none;
  }

  .edge-rail {
    position: absolute;
    inset: 0;
    pointer-events: none;
    z-index: 2;
    background:
      linear-gradient(90deg, var(--border-strong) 0 1px, transparent 1px) 0 0 / 40px 40px,
      linear-gradient(0deg, var(--border-strong) 0 1px, transparent 1px) 0 0 / 40px 40px;
    opacity: 0.04;
    mix-blend-mode: screen;
  }

  .hover-hint {
    position: absolute;
    left: var(--space-4);
    bottom: var(--space-4);
    z-index: 3;
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-1) var(--space-3);
    background: color-mix(in srgb, var(--bg-elev-2) 80%, transparent);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-pill);
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    letter-spacing: 0.06em;
    color: var(--text-dim);
    text-transform: uppercase;
    backdrop-filter: blur(6px);
    pointer-events: none;
  }

  .hint-kbd {
    padding: 1px var(--space-2);
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text);
  }

  /* =========================================================================
     Side panel
     ========================================================================= */
  .brain-side {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    min-width: 0;
    overflow-y: auto;
    max-height: 100%;
  }

  /* Hub panel */
  .hub-panel {
    background: var(--bg-elev-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    padding: var(--space-3);
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }

  .hub-eyebrow {
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    text-transform: uppercase;
    letter-spacing: 0.16em;
    color: var(--text-faint);
    flex-shrink: 0;
  }

  .node-list {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
    overflow-y: auto;
    flex: 1;
  }

  .node-row {
    display: grid;
    grid-template-columns: auto 1fr auto;
    align-items: center;
    gap: var(--space-2);
    width: 100%;
    padding: var(--space-2) var(--space-3);
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    color: var(--text-dim);
    cursor: pointer;
    text-align: left;
    font-family: var(--font-sans);
    font-size: var(--text-xs);
    transition: background var(--ease), border-color var(--ease), color var(--ease);
  }

  .node-row:hover,
  .node-row:focus-visible {
    background: var(--bg-elev-2);
    border-color: var(--border-strong);
    color: var(--text);
    outline: none;
  }

  .row-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--row-tint, var(--accent));
    box-shadow: 0 0 8px var(--row-tint, var(--accent));
    flex-shrink: 0;
  }

  .row-label {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .row-meta {
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    color: var(--text-faint);
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
</style>
