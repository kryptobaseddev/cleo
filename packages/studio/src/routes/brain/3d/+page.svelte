<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import LivingBrain3D from '$lib/components/LivingBrain3D.svelte';
  import type { LBGraph, LBNode, LBSubstrate, LBConnectionStatus, LBStreamEvent } from '$lib/server/living-brain/types.js';

  // ---------------------------------------------------------------------------
  // Server-loaded data
  // ---------------------------------------------------------------------------

  interface PageData {
    graph: LBGraph;
  }

  let { data }: { data: PageData } = $props();

  // ---------------------------------------------------------------------------
  // Runtime state
  // ---------------------------------------------------------------------------

  let graph = $state<LBGraph>(data.graph);
  let loading = $state(false);
  let error = $state<string | null>(null);

  // ---------------------------------------------------------------------------
  // SSE live synapses
  // ---------------------------------------------------------------------------

  /** Current state of the SSE connection. */
  let connectionStatus = $state<LBConnectionStatus>('connecting');

  /** Node IDs currently pulsing (cleared after pulse duration). */
  let pulsingNodes = $state<Set<string>>(new Set<string>());

  /** Edge keys (`${source}|${target}`) currently pulsing. */
  let pulsingEdges = $state<Set<string>>(new Set<string>());

  /** How long (ms) a pulse animation lasts — must match LivingBrain3D. */
  const PULSE_DURATION_MS = 1_500;

  /** Current EventSource instance (null when disconnected). */
  let eventSource: EventSource | null = null;

  /** Current reconnect delay in ms (exponential backoff). */
  let reconnectDelay = 2_000;

  /** Maximum reconnect delay in ms. */
  const MAX_RECONNECT_DELAY = 30_000;

  /** Whether the component is still mounted (prevents reconnect after destroy). */
  let mounted = false;

  /** Reconnect timer handle. */
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Adds a node ID to the pulsing set, then removes it after PULSE_DURATION_MS.
   *
   * @param nodeId - Substrate-prefixed node ID.
   */
  function pulseNode(nodeId: string): void {
    pulsingNodes = new Set([...pulsingNodes, nodeId]);
    setTimeout(() => {
      const next = new Set(pulsingNodes);
      next.delete(nodeId);
      pulsingNodes = next;
    }, PULSE_DURATION_MS);
  }

  /**
   * Adds an edge key to the pulsing set, then removes it after PULSE_DURATION_MS.
   *
   * @param edgeKey - `${source}|${target}` edge key.
   */
  function pulseEdge(edgeKey: string): void {
    pulsingEdges = new Set([...pulsingEdges, edgeKey]);
    setTimeout(() => {
      const next = new Set(pulsingEdges);
      next.delete(edgeKey);
      pulsingEdges = next;
    }, PULSE_DURATION_MS);
  }

  /**
   * Handles a parsed `LBStreamEvent` from the SSE stream.
   * Mutates graph state and triggers pulse animations as appropriate.
   *
   * @param event - The parsed stream event.
   */
  function handleStreamEvent(event: LBStreamEvent): void {
    switch (event.type) {
      case 'hello':
      case 'heartbeat':
        // No graph mutation needed
        break;

      case 'node.create': {
        // Add the new node to the graph if not already present
        const exists = graph.nodes.some((n) => n.id === event.node.id);
        if (!exists) {
          graph = {
            ...graph,
            nodes: [...graph.nodes, event.node],
            counts: {
              ...graph.counts,
              nodes: {
                ...graph.counts.nodes,
                [event.node.substrate]: (graph.counts.nodes[event.node.substrate] ?? 0) + 1,
              },
            },
          };
        }
        pulseNode(event.node.id);
        break;
      }

      case 'edge.strengthen': {
        pulseEdge(`${event.fromId}|${event.toId}`);
        break;
      }

      case 'task.status': {
        // Update the status in the node's meta (if the task node is loaded)
        const nodeId = `tasks:${event.taskId}`;
        const idx = graph.nodes.findIndex((n) => n.id === nodeId);
        if (idx !== -1) {
          const updatedNode: LBNode = {
            ...graph.nodes[idx],
            meta: { ...graph.nodes[idx].meta, status: event.status },
          };
          const updatedNodes = [...graph.nodes];
          updatedNodes[idx] = updatedNode;
          graph = { ...graph, nodes: updatedNodes };
          pulseNode(nodeId);
        }
        break;
      }

      case 'message.send': {
        // No graph mutation — just pulse if the message node is already in the graph
        const nodeId = `conduit:${event.messageId}`;
        pulseNode(nodeId);
        break;
      }
    }
  }

  /**
   * Opens a new EventSource and wires all SSE event handlers.
   * On error, schedules an exponential-backoff reconnect.
   */
  function openStream(): void {
    if (!mounted) return;
    connectionStatus = 'connecting';

    const es = new EventSource('/api/living-brain/stream');
    eventSource = es;

    es.onopen = () => {
      if (!mounted) {
        es.close();
        return;
      }
      connectionStatus = 'connected';
      reconnectDelay = 2_000; // reset backoff on successful connect
    };

    es.onmessage = (msgEvent: MessageEvent<string>) => {
      if (!mounted) return;
      try {
        const parsed = JSON.parse(msgEvent.data) as LBStreamEvent;
        handleStreamEvent(parsed);
      } catch {
        // Malformed event — ignore
      }
    };

    es.onerror = () => {
      es.close();
      eventSource = null;
      if (!mounted) return;
      connectionStatus = 'error';
      scheduleReconnect();
    };
  }

  /**
   * Schedules a reconnection attempt with exponential backoff.
   * Backoff starts at 2 s and caps at 30 s.
   */
  function scheduleReconnect(): void {
    if (!mounted) return;
    reconnectTimer = setTimeout(() => {
      reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
      openStream();
    }, reconnectDelay);
  }

  onMount(() => {
    mounted = true;
    openStream();
  });

  onDestroy(() => {
    mounted = false;
    eventSource?.close();
    eventSource = null;
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    connectionStatus = 'disconnected';
  });

  /** Active substrate filter set (all enabled by default). */
  let enabledSubstrates = $state<Set<LBSubstrate>>(
    new Set(['brain', 'nexus', 'tasks', 'conduit', 'signaldock'] as LBSubstrate[]),
  );

  /** Minimum weight threshold [0,1]. */
  let minWeight = $state(0);

  // ---------------------------------------------------------------------------
  // Derived filtered graph
  // ---------------------------------------------------------------------------

  let filteredGraph = $derived<LBGraph>({
    nodes: graph.nodes.filter((n) => {
      if (!enabledSubstrates.has(n.substrate)) return false;
      if ((n.weight ?? 1) < minWeight) return false;
      return true;
    }),
    edges: graph.edges.filter((e) => {
      const srcOk =
        e.substrate === 'cross' ||
        enabledSubstrates.has(e.substrate as LBSubstrate);
      return srcOk;
    }),
    counts: graph.counts,
    truncated: graph.truncated,
  });

  // ---------------------------------------------------------------------------
  // Substrate toggle
  // ---------------------------------------------------------------------------

  function toggleSubstrate(s: LBSubstrate): void {
    const next = new Set(enabledSubstrates);
    if (next.has(s)) {
      next.delete(s);
    } else {
      next.add(s);
    }
    enabledSubstrates = next;
  }

  // ---------------------------------------------------------------------------
  // Derived stats
  // ---------------------------------------------------------------------------

  const ALL_SUBSTRATES: LBSubstrate[] = ['brain', 'nexus', 'tasks', 'conduit', 'signaldock'];

  const SUBSTRATE_COLOR: Record<LBSubstrate, string> = {
    brain: '#3b82f6',
    nexus: '#22c55e',
    tasks: '#f97316',
    conduit: '#a855f7',
    signaldock: '#ef4444',
  };

  let totalNodes = $derived(filteredGraph.nodes.length);
  let totalEdges = $derived(filteredGraph.edges.length);

  // ---------------------------------------------------------------------------
  // Node click → side panel
  // ---------------------------------------------------------------------------

  let selectedNode = $state<LBNode | null>(null);
  let sideLoading = $state(false);
  let sideError = $state<string | null>(null);

  async function handleNodeClick(id: string): Promise<void> {
    sideLoading = true;
    sideError = null;
    selectedNode = null;
    try {
      const res = await fetch(`/api/living-brain/node/${encodeURIComponent(id)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { node: LBNode };
      selectedNode = body.node;
    } catch (e) {
      sideError = e instanceof Error ? e.message : 'Failed to load node';
    } finally {
      sideLoading = false;
    }
  }

  function closePanel(): void {
    selectedNode = null;
    sideError = null;
  }
</script>

<svelte:head>
  <title>Brain 3D — CLEO Studio</title>
</svelte:head>

<div class="lb-page">
  <!-- ====================================================================== -->
  <!-- Header -->
  <!-- ====================================================================== -->
  <div class="lb-header">
    <div class="header-left">
      <h1 class="page-title">Brain 3D Canvas</h1>
      <span class="node-count">
        {totalNodes} nodes · {totalEdges} edges
        {#if graph.truncated}
          <span class="truncated-badge">truncated</span>
        {/if}
      </span>
      <!-- SSE connection status indicator -->
      <span class="sse-status sse-status--{connectionStatus}" title="Live stream: {connectionStatus}">
        {#if connectionStatus === 'connected'}
          live
        {:else if connectionStatus === 'connecting'}
          connecting…
        {:else if connectionStatus === 'error'}
          reconnecting…
        {:else}
          offline
        {/if}
      </span>
    </div>

    <div class="header-controls">
      <!-- Substrate toggles -->
      <div class="substrate-filters">
        {#each ALL_SUBSTRATES as s}
          <button
            class="substrate-btn"
            class:active={enabledSubstrates.has(s)}
            style="--s-color: {SUBSTRATE_COLOR[s]}"
            onclick={() => toggleSubstrate(s)}
            title="Toggle {s} substrate"
          >
            {s}
          </button>
        {/each}
      </div>

      <!-- Weight threshold -->
      <div class="weight-wrap">
        <label class="weight-label" for="weight-slider">
          min weight: <span class="weight-val">{minWeight.toFixed(2)}</span>
        </label>
        <input
          id="weight-slider"
          type="range"
          min="0"
          max="1"
          step="0.05"
          bind:value={minWeight}
          class="weight-slider"
        />
      </div>

      {#if loading}
        <span class="full-graph-label">Loading…</span>
      {/if}
    </div>
  </div>

  <!-- Error banner -->
  {#if error}
    <div class="error-banner">{error}</div>
  {/if}

  <!-- ====================================================================== -->
  <!-- Main canvas + optional side panel -->
  <!-- ====================================================================== -->
  <div class="lb-body" class:has-panel={selectedNode !== null || sideLoading || sideError !== null}>
    <div class="lb-canvas">
      <LivingBrain3D
        nodes={filteredGraph.nodes}
        edges={filteredGraph.edges}
        onNodeClick={handleNodeClick}
        height="100%"
        {pulsingNodes}
        {pulsingEdges}
      />
    </div>

    <!-- Side panel -->
    {#if selectedNode !== null || sideLoading || sideError !== null}
      <div class="lb-panel">
        <div class="panel-header">
          <span class="panel-title">Node Detail</span>
          <button class="panel-close" onclick={closePanel} aria-label="Close panel">×</button>
        </div>

        {#if sideLoading}
          <div class="panel-loading">Loading…</div>
        {:else if sideError}
          <div class="panel-error">{sideError}</div>
        {:else if selectedNode}
          <div class="panel-body">
            <div
              class="panel-kind-badge"
              style="background: {SUBSTRATE_COLOR[selectedNode.substrate]}22; color: {SUBSTRATE_COLOR[selectedNode.substrate]}; border-color: {SUBSTRATE_COLOR[selectedNode.substrate]}44"
            >
              {selectedNode.substrate} / {selectedNode.kind}
            </div>

            <p class="panel-label">{selectedNode.label}</p>

            <div class="panel-id">
              <span class="field-key">id</span>
              <span class="field-val mono">{selectedNode.id}</span>
            </div>

            {#if selectedNode.weight !== undefined}
              <div class="panel-field">
                <span class="field-key">weight</span>
                <span class="field-val">{selectedNode.weight.toFixed(3)}</span>
              </div>
            {/if}

            {#if Object.keys(selectedNode.meta).length > 0}
              <details class="panel-meta">
                <summary class="meta-summary">Metadata</summary>
                <pre class="meta-pre">{JSON.stringify(selectedNode.meta, null, 2)}</pre>
              </details>
            {/if}

            <div class="panel-links">
              {#if selectedNode.substrate === 'brain'}
                {#if selectedNode.kind === 'observation'}
                  <a href="/brain/observations" class="panel-link">View as table &rarr;</a>
                {:else if selectedNode.kind === 'decision'}
                  <a href="/brain/decisions" class="panel-link">View as table &rarr;</a>
                {:else if selectedNode.kind === 'pattern' || selectedNode.kind === 'learning'}
                  <a href="/brain/observations" class="panel-link">View as table &rarr;</a>
                {/if}
                <a href="/brain/overview" class="panel-link">Overview &rarr;</a>
              {:else if selectedNode.substrate === 'nexus'}
                {#if selectedNode.kind === 'community'}
                  <a
                    href="/code/community/{encodeURIComponent(selectedNode.id)}"
                    class="panel-link"
                  >View community &rarr;</a>
                {:else}
                  <a
                    href="/code/symbol/{encodeURIComponent(selectedNode.label)}"
                    class="panel-link"
                  >View symbol &rarr;</a>
                {/if}
              {/if}
            </div>
          </div>
        {/if}
      </div>
    {/if}
  </div>
</div>

<style>
  .lb-page {
    display: flex;
    flex-direction: column;
    height: calc(100vh - 3rem - 4rem);
    gap: 0.625rem;
  }

  /* ---- Header ------------------------------------------------------------ */
  .lb-header {
    display: flex;
    align-items: center;
    gap: 1rem;
    flex-wrap: wrap;
  }

  .header-left {
    display: flex;
    align-items: center;
    gap: 0.875rem;
    flex: 1;
    min-width: 0;
  }

  .page-title {
    font-size: 1.125rem;
    font-weight: 700;
    color: #f1f5f9;
    white-space: nowrap;
  }

  .node-count {
    font-size: 0.75rem;
    color: #64748b;
    display: flex;
    align-items: center;
    gap: 0.375rem;
  }

  .truncated-badge {
    padding: 0.1rem 0.4rem;
    border-radius: 4px;
    background: rgba(245, 158, 11, 0.15);
    color: #f59e0b;
    font-size: 0.6875rem;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  /* SSE connection status badge */
  .sse-status {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.15rem 0.5rem;
    border-radius: 999px;
    font-size: 0.6875rem;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    border: 1px solid;
  }

  .sse-status--connected {
    color: #22c55e;
    border-color: rgba(34, 197, 94, 0.4);
    background: rgba(34, 197, 94, 0.1);
  }

  .sse-status--connected::before {
    content: '';
    display: inline-block;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #22c55e;
    animation: pulse-dot 2s ease-in-out infinite;
  }

  .sse-status--connecting {
    color: #f59e0b;
    border-color: rgba(245, 158, 11, 0.4);
    background: rgba(245, 158, 11, 0.1);
  }

  .sse-status--error {
    color: #ef4444;
    border-color: rgba(239, 68, 68, 0.4);
    background: rgba(239, 68, 68, 0.1);
  }

  .sse-status--disconnected {
    color: #64748b;
    border-color: rgba(100, 116, 139, 0.4);
    background: rgba(100, 116, 139, 0.1);
  }

  @keyframes pulse-dot {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.3;
    }
  }

  .header-controls {
    display: flex;
    align-items: center;
    gap: 0.875rem;
    flex-wrap: wrap;
  }

  /* Substrate filter buttons */
  .substrate-filters {
    display: flex;
    gap: 0.25rem;
  }

  .substrate-btn {
    padding: 0.2rem 0.55rem;
    border-radius: 999px;
    font-size: 0.6875rem;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    background: none;
    border: 1px solid #2d3748;
    color: #64748b;
    cursor: pointer;
    transition: color 0.15s, border-color 0.15s, background 0.15s;
  }

  .substrate-btn.active {
    color: var(--s-color);
    border-color: var(--s-color);
    background: color-mix(in srgb, var(--s-color) 12%, transparent);
  }

  .substrate-btn:hover {
    border-color: var(--s-color);
    color: var(--s-color);
  }

  /* Weight slider */
  .weight-wrap {
    display: flex;
    align-items: center;
    gap: 0.375rem;
  }

  .weight-label {
    font-size: 0.75rem;
    color: #64748b;
    white-space: nowrap;
  }

  .weight-val {
    color: #94a3b8;
    font-variant-numeric: tabular-nums;
  }

  .weight-slider {
    width: 100px;
    accent-color: #3b82f6;
  }

  .full-graph-label {
    font-size: 0.6875rem;
    color: #22c55e;
  }

  /* Error banner */
  .error-banner {
    padding: 0.375rem 0.75rem;
    background: rgba(239, 68, 68, 0.1);
    border: 1px solid rgba(239, 68, 68, 0.35);
    border-radius: 6px;
    font-size: 0.8125rem;
    color: #ef4444;
  }

  /* ---- Body (canvas + side panel) --------------------------------------- */
  .lb-body {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: 1fr;
    gap: 0.625rem;
    overflow: hidden;
  }

  .lb-body.has-panel {
    grid-template-columns: 1fr 280px;
  }

  .lb-canvas {
    min-width: 0;
    min-height: 0;
    border-radius: 8px;
    overflow: hidden;
    display: flex;
  }

  /* Side panel */
  .lb-panel {
    background: #1a1f2e;
    border: 1px solid #2d3748;
    border-radius: 8px;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.5rem 0.875rem;
    border-bottom: 1px solid #2d3748;
  }

  .panel-title {
    font-size: 0.75rem;
    font-weight: 600;
    color: #64748b;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }

  .panel-close {
    background: none;
    border: none;
    color: #64748b;
    cursor: pointer;
    font-size: 1.125rem;
    line-height: 1;
    padding: 0 0.25rem;
    transition: color 0.15s;
  }

  .panel-close:hover {
    color: #f1f5f9;
  }

  .panel-loading,
  .panel-error {
    padding: 1rem;
    font-size: 0.8125rem;
    color: #64748b;
  }

  .panel-error {
    color: #ef4444;
  }

  .panel-body {
    padding: 0.875rem;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 0.625rem;
    flex: 1;
  }

  .panel-kind-badge {
    display: inline-block;
    padding: 0.2rem 0.5rem;
    border-radius: 4px;
    font-size: 0.6875rem;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    border: 1px solid;
    align-self: flex-start;
  }

  .panel-label {
    font-size: 0.875rem;
    font-weight: 600;
    color: #f1f5f9;
    word-break: break-word;
  }

  .panel-id,
  .panel-field {
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
  }

  .field-key {
    font-size: 0.6875rem;
    color: #475569;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .field-val {
    font-size: 0.8125rem;
    color: #94a3b8;
    word-break: break-all;
  }

  .field-val.mono {
    font-family: monospace;
    font-size: 0.75rem;
  }

  .panel-meta {
    margin-top: 0.25rem;
  }

  .meta-summary {
    font-size: 0.75rem;
    color: #64748b;
    cursor: pointer;
    user-select: none;
  }

  .meta-pre {
    margin-top: 0.375rem;
    padding: 0.5rem;
    background: #0f1117;
    border-radius: 4px;
    font-size: 0.6875rem;
    color: #94a3b8;
    overflow-x: auto;
    white-space: pre-wrap;
    word-break: break-all;
    line-height: 1.5;
    max-height: 260px;
  }

  .panel-links {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    padding-top: 0.5rem;
    border-top: 1px solid #2d3748;
    margin-top: 0.25rem;
  }

  .panel-link {
    font-size: 0.75rem;
    color: #3b82f6;
    text-decoration: none;
    padding: 0.2rem 0.5rem;
    border-radius: 4px;
    border: 1px solid rgba(59, 130, 246, 0.3);
    background: rgba(59, 130, 246, 0.08);
    transition: background 0.15s;
  }

  .panel-link:hover {
    background: rgba(59, 130, 246, 0.18);
  }
</style>
