<!--
  BrainMonitorPanel — "Brain Monitor" side panel for the Brain canvas.

  Two views:
    - Region Monitor (when no node is selected): 5 RegionMeter cards + Active
      Bridges strip showing last 10 firing events.
    - Node Detail (when a node is selected): identity, cluster context,
      connected neighbors grouped by substrate, explicit bridge list, and a
      source preview dependent on substrate.

  @task T990
  @wave 1A
-->
<script lang="ts">
  import Badge from '$lib/ui/Badge.svelte';
  import Card from '$lib/ui/Card.svelte';
  import IconButton from '$lib/ui/IconButton.svelte';
  import type { GraphEdge, GraphNode, SubstrateId } from '$lib/graph/types.js';

  import RegionMeter from './RegionMeter.svelte';

  /**
   * A recent live bridge firing event shown in the Active Bridges strip.
   */
  export interface BridgeEvent {
    id: string;
    fromSubstrate: SubstrateId;
    toSubstrate: SubstrateId;
    fromLabel: string;
    toLabel: string;
    edgeKind: string;
    timestampMs: number;
  }

  /**
   * Per-region live stats fed by the page shell.
   */
  export interface RegionStats {
    substrate: SubstrateId;
    regionName: string;
    neuronCount: number;
    firingRate: number;
    bridgeCount: number;
    history: number[];
    firing: boolean;
    colorVar: string;
  }

  /**
   * Props for {@link BrainMonitorPanel}.
   */
  interface Props {
    /** Currently selected node, or null for the Region Monitor view. */
    selectedNode: GraphNode | null;
    /** All currently rendered edges — used for neighbor + bridge computation. */
    edges: GraphEdge[];
    /** All currently rendered nodes — used for neighbor label lookup. */
    nodes: GraphNode[];
    /** Live region stats for each of the 5 substrates. */
    regionStats: RegionStats[];
    /** Recent bridge firing events (last 10). */
    bridgeEvents: BridgeEvent[];
    /** Fired when the user clicks a neighbor node. */
    onNodeSelect?: (node: GraphNode) => void;
    /** Fired when the panel is dismissed (close button or Esc). */
    onClose?: () => void;
    /** Fired when a substrate chip in the monitor is clicked (focus substrate). */
    onFocusSubstrate?: (s: SubstrateId) => void;
  }

  let {
    selectedNode,
    edges,
    nodes,
    regionStats,
    bridgeEvents,
    onNodeSelect,
    onClose,
    onFocusSubstrate,
  }: Props = $props();

  // ---------------------------------------------------------------------------
  // Substrate palette (mirrors page shell)
  // ---------------------------------------------------------------------------

  const substratePalette: Record<SubstrateId, string> = {
    brain: 'var(--info)',
    nexus: 'var(--success)',
    tasks: 'var(--warning)',
    conduit: 'var(--accent)',
    signaldock: 'var(--danger)',
  };

  const substrateTone: Record<SubstrateId, 'info' | 'success' | 'warning' | 'accent' | 'danger'> = {
    brain: 'info',
    nexus: 'success',
    tasks: 'warning',
    conduit: 'accent',
    signaldock: 'danger',
  };

  // ---------------------------------------------------------------------------
  // Derived — node detail view
  // ---------------------------------------------------------------------------

  /**
   * Bridge edges originating from or targeting the selected node where
   * `meta.isBridge === true` OR the source/target substrates differ.
   */
  const bridgeEdges = $derived.by<GraphEdge[]>(() => {
    if (!selectedNode) return [];
    const nodeId = selectedNode.id;
    return edges.filter((e) => {
      if (e.source !== nodeId && e.target !== nodeId) return false;
      const isBridgeMeta = (e.meta as { isBridge?: boolean } | undefined)?.isBridge === true;
      if (isBridgeMeta) return true;
      // Fallback: cross-substrate edges are treated as bridges.
      const otherId = e.source === nodeId ? e.target : e.source;
      const otherNode = nodes.find((n) => n.id === otherId);
      return otherNode !== undefined && otherNode.substrate !== selectedNode.substrate;
    });
  });

  /**
   * All edges touching the selected node, grouped by the target substrate.
   * Self-substrate edges and bridge edges are separated.
   */
  const neighborsBySubstrate = $derived.by<Map<SubstrateId, GraphNode[]>>(() => {
    if (!selectedNode) return new Map();
    const nodeId = selectedNode.id;
    const map = new Map<SubstrateId, GraphNode[]>();
    for (const edge of edges) {
      if (edge.source !== nodeId && edge.target !== nodeId) continue;
      const neighborId = edge.source === nodeId ? edge.target : edge.source;
      const neighbor = nodes.find((n) => n.id === neighborId);
      if (!neighbor) continue;
      if (!map.has(neighbor.substrate)) map.set(neighbor.substrate, []);
      map.get(neighbor.substrate)!.push(neighbor);
    }
    return map;
  });

  /**
   * Source preview text for the selected node, derived from substrate type.
   * Returns null when no meaningful preview can be constructed.
   */
  const sourcePreview = $derived.by<{ kind: 'text' | 'file' | 'status'; value: string } | null>(() => {
    if (!selectedNode) return null;
    const meta = selectedNode.meta as Record<string, unknown> | undefined;
    switch (selectedNode.substrate) {
      case 'nexus': {
        const filePath = meta?.file_path ?? meta?.path;
        if (typeof filePath === 'string') {
          const lineRange =
            typeof meta?.line_start === 'number' && typeof meta?.line_end === 'number'
              ? `:${meta.line_start}–${meta.line_end}`
              : '';
          return { kind: 'file', value: `${filePath}${lineRange}` };
        }
        return null;
      }
      case 'brain': {
        const narrative =
          typeof meta?.body === 'string'
            ? meta.body
            : typeof meta?.content === 'string'
              ? meta.content
              : null;
        if (narrative) return { kind: 'text', value: narrative.slice(0, 200) };
        return null;
      }
      case 'tasks': {
        const status = typeof meta?.status === 'string' ? meta.status : '';
        const priority = typeof meta?.priority === 'string' ? meta.priority : '';
        if (status || priority)
          return { kind: 'status', value: [status, priority].filter(Boolean).join(' · ') };
        return null;
      }
      default:
        return null;
    }
  });

  /**
   * Format a millisecond timestamp as a human-readable "Xs ago" / "Xm ago" label.
   */
  function relativeTime(ms: number): string {
    const diff = Math.max(0, Date.now() - ms);
    if (diff < 60_000) return `${Math.round(diff / 1000)}s ago`;
    if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
    return `${Math.round(diff / 3_600_000)}h ago`;
  }
</script>

{#if selectedNode}
  <!-- ============================================================
       Node Detail View
       ============================================================ -->
  {@const node = selectedNode}
  <Card elevation={2} padding="compact">
    {#snippet header()}
      <div class="panel-header-row">
        <div class="panel-header-left">
          <span class="panel-eyebrow">Node detail</span>
          <Badge tone={substrateTone[node.substrate]} pill size="sm">
            {node.substrate} · {node.kind}
          </Badge>
        </div>
        <IconButton aria-label="Close node detail panel" onclick={onClose}>×</IconButton>
      </div>
    {/snippet}

    <div class="detail-body">
      <!-- Identity -->
      <h2 class="node-label">{node.label}</h2>
      <dl class="detail-fields">
        <dt>ID</dt>
        <dd class="mono">{node.id}</dd>
        {#if node.weight !== undefined}
          <dt>Weight</dt>
          <dd class="tabnum">{node.weight.toFixed(3)}</dd>
        {/if}
        {#if node.freshness !== undefined}
          <dt>Freshness</dt>
          <dd class="tabnum">{(node.freshness * 100).toFixed(0)}%</dd>
        {/if}
        {#if node.category}
          <dt>Cluster</dt>
          <dd>{node.category}</dd>
        {/if}
      </dl>

      <!-- Source preview -->
      {#if sourcePreview}
        <div class="source-preview">
          {#if sourcePreview.kind === 'file'}
            <span class="preview-label">File</span>
            <code class="preview-file">{sourcePreview.value}</code>
          {:else if sourcePreview.kind === 'text'}
            <span class="preview-label">Narrative</span>
            <p class="preview-text">{sourcePreview.value}{sourcePreview.value.length === 200 ? '…' : ''}</p>
          {:else if sourcePreview.kind === 'status'}
            <span class="preview-label">Status</span>
            <span class="preview-status">{sourcePreview.value}</span>
          {/if}
        </div>
      {/if}

      <!-- Connected neighbors by substrate -->
      {#if neighborsBySubstrate.size > 0}
        <section class="neighbors-section" aria-label="Connected neighbors">
          <div class="section-eyebrow">Connected neighbors</div>
          {#each [...neighborsBySubstrate.entries()] as [substrate, neighbors] (substrate)}
            <div class="neighbor-group">
              <div
                class="neighbor-substrate-label"
                style="--ng-color: {substratePalette[substrate]};"
              >
                <span class="ng-dot" aria-hidden="true"></span>
                {substrate}
                <span class="ng-count">{neighbors.length}</span>
              </div>
              <ul class="neighbor-list" role="list">
                {#each neighbors.slice(0, 8) as neighbor (neighbor.id)}
                  <li>
                    <button
                      type="button"
                      class="neighbor-btn"
                      onclick={() => onNodeSelect?.(neighbor)}
                    >
                      {neighbor.label}
                    </button>
                  </li>
                {/each}
                {#if neighbors.length > 8}
                  <li class="neighbor-overflow">+{neighbors.length - 8} more</li>
                {/if}
              </ul>
            </div>
          {/each}
        </section>
      {/if}

      <!-- Bridges -->
      {#if bridgeEdges.length > 0}
        <section class="bridges-section" aria-label="Cross-substrate bridges">
          <div class="section-eyebrow">Bridges</div>
          <ul class="bridge-list" role="list">
            {#each bridgeEdges as edge (edge.id)}
              {@const isSource = edge.source === node.id}
              {@const otherId = isSource ? edge.target : edge.source}
              {@const otherNode = nodes.find((n) => n.id === otherId)}
              {@const otherSubstrate = otherNode?.substrate ?? ('brain' as SubstrateId)}
              <li class="bridge-item">
                <div
                  class="bridge-direction"
                  style="--bridge-color: {substratePalette[otherSubstrate]};"
                  aria-label="{isSource ? 'to' : 'from'} {otherSubstrate}"
                >
                  <span class="bridge-arrow" aria-hidden="true">{isSource ? '→' : '←'}</span>
                  <span class="bridge-substrate">{otherSubstrate}</span>
                </div>
                <Badge tone="neutral" size="sm">{edge.kind}</Badge>
                {#if otherNode}
                  <button
                    type="button"
                    class="bridge-target-btn"
                    onclick={() => otherNode && onNodeSelect?.(otherNode)}
                  >
                    {otherNode.label}
                  </button>
                {:else}
                  <span class="bridge-unknown">{otherId}</span>
                {/if}
              </li>
            {/each}
          </ul>
        </section>
      {/if}

      <!-- Metadata collapsible -->
      {#if node.meta && Object.keys(node.meta).length > 0}
        <details class="meta-details">
          <summary>Raw metadata</summary>
          <pre class="meta-pre">{JSON.stringify(node.meta, null, 2)}</pre>
        </details>
      {/if}
    </div>
  </Card>

{:else}
  <!-- ============================================================
       Region Monitor View (nothing selected)
       ============================================================ -->
  <Card elevation={1} padding="compact">
    {#snippet header()}
      <div class="monitor-header">
        <span class="panel-eyebrow">Brain Monitor</span>
        <span class="monitor-live-dot" aria-hidden="true"></span>
        <span class="monitor-label">LIVE</span>
      </div>
    {/snippet}

    <!-- 5 RegionMeter cards -->
    <div class="region-meters" role="list" aria-label="Substrate region monitors">
      {#each regionStats as stats (stats.substrate)}
        <div role="listitem">
          <RegionMeter
            substrate={stats.substrate}
            regionName={stats.regionName}
            neuronCount={stats.neuronCount}
            firingRate={stats.firingRate}
            bridgeCount={stats.bridgeCount}
            history={stats.history}
            colorVar={stats.colorVar}
            firing={stats.firing}
            onclick={() => onFocusSubstrate?.(stats.substrate)}
          />
        </div>
      {/each}
    </div>

    <!-- Active bridges strip -->
    {#if bridgeEvents.length > 0}
      <div class="active-bridges" aria-label="Recent bridge firing events">
        <div class="section-eyebrow bridges-eyebrow">Active bridges</div>
        <ul class="bridge-events-list" role="list">
          {#each bridgeEvents.slice(0, 10) as ev (ev.id)}
            <li class="bridge-event-row">
              <span
                class="bridge-from-dot"
                style="--dot-color: {substratePalette[ev.fromSubstrate]};"
                aria-hidden="true"
              ></span>
              <span class="bridge-event-text">
                <span class="bridge-region-label">{ev.fromSubstrate.toUpperCase()}</span>
                <span class="bridge-arrow-icon" aria-hidden="true">→</span>
                <span class="bridge-region-label">{ev.toSubstrate.toUpperCase()}</span>
              </span>
              <span class="bridge-kind-chip">{ev.edgeKind}</span>
              <span class="bridge-time">{relativeTime(ev.timestampMs)}</span>
            </li>
          {/each}
        </ul>
      </div>
    {/if}
  </Card>
{/if}

<style>
  /* =========================================================================
     Shared panel utilities
     ========================================================================= */
  .panel-header-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
  }

  .panel-header-left {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
  }

  .panel-eyebrow {
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    text-transform: uppercase;
    letter-spacing: 0.16em;
    color: var(--text-faint);
  }

  .section-eyebrow {
    font-family: var(--font-mono);
    font-size: 0.6rem;
    text-transform: uppercase;
    letter-spacing: 0.16em;
    color: var(--text-faint);
    margin-bottom: var(--space-2);
  }

  /* =========================================================================
     Node Detail
     ========================================================================= */
  .detail-body {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .node-label {
    font-family: var(--font-mono);
    font-size: var(--text-base);
    font-weight: 600;
    color: var(--text);
    word-break: break-word;
    margin: 0;
    line-height: var(--leading-tight);
  }

  .detail-fields {
    display: grid;
    grid-template-columns: max-content 1fr;
    column-gap: var(--space-3);
    row-gap: var(--space-1);
    font-size: var(--text-xs);
    margin: 0;
  }

  .detail-fields dt {
    color: var(--text-faint);
    font-family: var(--font-mono);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-size: var(--text-2xs);
  }

  .detail-fields dd {
    color: var(--text-dim);
    margin: 0;
    word-break: break-all;
  }

  .detail-fields dd.mono {
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
  }

  .detail-fields dd.tabnum {
    font-variant-numeric: tabular-nums;
  }

  /* Source preview */
  .source-preview {
    padding: var(--space-2) var(--space-3);
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  .preview-label {
    font-family: var(--font-mono);
    font-size: 0.6rem;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--text-faint);
  }

  .preview-file {
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    color: var(--success);
    word-break: break-all;
  }

  .preview-text {
    font-size: var(--text-xs);
    color: var(--text-dim);
    margin: 0;
    line-height: var(--leading-normal);
    display: -webkit-box;
    -webkit-line-clamp: 4;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .preview-status {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--text-dim);
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }

  /* Neighbors */
  .neighbors-section {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .neighbor-group {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  .neighbor-substrate-label {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    font-family: var(--font-mono);
    font-size: 0.6rem;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: color-mix(in srgb, var(--ng-color) 80%, var(--text));
  }

  .ng-dot {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--ng-color);
    flex-shrink: 0;
  }

  .ng-count {
    color: var(--text-faint);
    font-size: 0.6rem;
  }

  .neighbor-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .neighbor-btn {
    display: block;
    width: 100%;
    background: transparent;
    border: none;
    padding: 3px var(--space-2);
    text-align: left;
    font-size: var(--text-xs);
    color: var(--text-dim);
    border-radius: var(--radius-xs);
    cursor: pointer;
    transition: background var(--ease), color var(--ease);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .neighbor-btn:hover,
  .neighbor-btn:focus-visible {
    background: var(--bg-elev-2);
    color: var(--text);
    outline: none;
  }

  .neighbor-overflow {
    font-size: var(--text-2xs);
    color: var(--text-faint);
    padding: 2px var(--space-2);
    font-family: var(--font-mono);
  }

  /* Bridges */
  .bridges-section {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .bridge-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .bridge-item {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
  }

  .bridge-direction {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    color: color-mix(in srgb, var(--bridge-color) 90%, var(--text));
    flex-shrink: 0;
  }

  .bridge-arrow {
    opacity: 0.7;
  }

  .bridge-substrate {
    text-transform: uppercase;
    letter-spacing: 0.08em;
    font-size: 0.6rem;
  }

  .bridge-target-btn {
    flex: 1;
    min-width: 0;
    background: transparent;
    border: none;
    padding: 0;
    font-size: var(--text-xs);
    color: var(--text-dim);
    cursor: pointer;
    text-align: left;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    transition: color var(--ease);
  }

  .bridge-target-btn:hover,
  .bridge-target-btn:focus-visible {
    color: var(--text);
    outline: none;
  }

  .bridge-unknown {
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    color: var(--text-faint);
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* Metadata */
  .meta-details summary {
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    color: var(--text-dim);
    cursor: pointer;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    padding: var(--space-1) 0;
  }

  .meta-pre {
    margin-top: var(--space-2);
    padding: var(--space-3);
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    font-size: 0.6rem;
    color: var(--text-dim);
    font-family: var(--font-mono);
    overflow-x: auto;
    max-height: 180px;
    line-height: var(--leading-normal);
  }

  /* =========================================================================
     Region Monitor
     ========================================================================= */
  .monitor-header {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  .monitor-live-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--success);
    animation: live-pulse 2s ease-in-out infinite;
    margin-left: auto;
  }

  @keyframes live-pulse {
    0%, 100% { opacity: 1; }
    50%       { opacity: 0.3; }
  }

  .monitor-label {
    font-family: var(--font-mono);
    font-size: 0.6rem;
    text-transform: uppercase;
    letter-spacing: 0.14em;
    color: var(--success);
  }

  .region-meters {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  /* Active bridges strip */
  .active-bridges {
    margin-top: var(--space-3);
    padding-top: var(--space-3);
    border-top: 1px solid var(--border);
  }

  .bridges-eyebrow {
    margin-bottom: var(--space-2);
  }

  .bridge-events-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  .bridge-event-row {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: 3px var(--space-2);
    background: transparent;
    border-radius: var(--radius-xs);
    transition: background var(--ease);
  }

  .bridge-event-row:hover {
    background: var(--bg-elev-2);
  }

  .bridge-from-dot {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--dot-color, var(--border-strong));
    flex-shrink: 0;
    box-shadow: 0 0 4px var(--dot-color, transparent);
  }

  .bridge-event-text {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 3px;
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    color: var(--text-dim);
    overflow: hidden;
  }

  .bridge-region-label {
    font-size: 0.6rem;
    letter-spacing: 0.1em;
    white-space: nowrap;
  }

  .bridge-arrow-icon {
    color: var(--text-faint);
    flex-shrink: 0;
  }

  .bridge-kind-chip {
    font-family: var(--font-mono);
    font-size: 0.55rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-faint);
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--radius-xs);
    padding: 0 4px;
    white-space: nowrap;
    flex-shrink: 0;
  }

  .bridge-time {
    font-family: var(--font-mono);
    font-size: 0.55rem;
    color: var(--text-faint);
    white-space: nowrap;
    flex-shrink: 0;
    font-variant-numeric: tabular-nums;
  }

  /* Reduced motion */
  @media (prefers-reduced-motion: reduce) {
    .monitor-live-dot {
      animation: none;
    }
  }
</style>
