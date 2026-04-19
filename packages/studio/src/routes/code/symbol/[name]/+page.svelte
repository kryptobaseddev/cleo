<!--
  /code/symbol/[name] — ego network (2-hop).

  Two color modes:
    1. Hop — center amber, hop-1 blue, hop-2 slate (default)
    2. Kind — substrate-native palette (kit default)

  Edge styling is always kind-driven; node colour is the toggle.

  @task T990
  @wave 1B
-->
<script lang="ts">
  import type { PageData } from './$types';
  import { goto } from '$app/navigation';

  import CosmosRenderer from '$lib/graph/renderers/CosmosRenderer.svelte';
  import {
    mapNexusRelationToEdgeKind,
    type NexusNodeRow,
  } from '$lib/graph/adapters/nexus-adapter.js';
  import { EDGE_STYLE, describeEdgeKind } from '$lib/graph/edge-kinds.js';
  import type { EdgeKind, GraphEdge, GraphNode } from '$lib/graph/types.js';
  import { Breadcrumb, Card, Tabs, TabPanel } from '$lib/ui';

  interface Props {
    data: PageData;
  }
  let { data }: Props = $props();

  // ---------------------------------------------------------------
  // Color modes
  // ---------------------------------------------------------------

  type ColorMode = 'hop' | 'kind';
  let colorMode = $state<ColorMode>('hop');

  /**
   * Hop colour → semantic CSS token.
   *    hop 0 — amber  (self)
   *    hop 1 — info   (direct neighbours)
   *    hop 2 — faint  (two-hop ring)
   */
  const HOP_TOKEN: Record<number, string> = {
    0: 'var(--warning)',
    1: 'var(--info)',
    2: 'var(--text-faint)',
  };

  // ---------------------------------------------------------------
  // Adapt the server payload into the kit shape — we do this
  // manually (rather than calling adaptNexusRows) because hop
  // information is first-class here.
  // ---------------------------------------------------------------

  const graphModel = $derived.by(() => {
    const nodes: GraphNode[] = data.nodes.map((n) => {
      const tint = colorMode === 'hop' ? HOP_TOKEN[n.hop] : undefined;
      const meta: Record<string, unknown> = {
        hop: n.hop,
        filePath: n.filePath,
        callerCount: n.callerCount,
      };
      if (tint) meta.colorOverride = tint;
      return {
        id: n.id,
        substrate: 'nexus' as const,
        kind: n.kind || 'symbol',
        label: n.label,
        category: n.communityId ?? null,
        weight: Math.min(1, Math.log10(n.callerCount + 1) / 3),
        meta,
      };
    });

    const validIds = new Set(nodes.map((n) => n.id));
    const edges: GraphEdge[] = data.edges
      .filter((e) => validIds.has(e.source) && validIds.has(e.target) && e.source !== e.target)
      .map((e, idx) => {
        const kind = mapNexusRelationToEdgeKind(e.type);
        return {
          id: `ego-${idx}-${e.source}-${e.target}-${kind}`,
          source: e.source,
          target: e.target,
          kind,
          directional: true,
        };
      });
    return { nodes, edges };
  });

  const graphNodes = $derived(graphModel.nodes);
  const graphEdges = $derived(graphModel.edges);

  // ---------------------------------------------------------------
  // Edge-kind filter
  // ---------------------------------------------------------------
  const EGO_EDGE_KINDS: readonly EdgeKind[] = [
    'calls',
    'extends',
    'implements',
    'defines',
    'imports',
    'has_method',
    'has_property',
    'accesses',
    'references',
  ];

  let visibleEdgeKinds = $state<Set<EdgeKind>>(new Set(EGO_EDGE_KINDS));

  function toggleEdge(kind: EdgeKind): void {
    const next = new Set(visibleEdgeKinds);
    if (next.has(kind)) next.delete(kind);
    else next.add(kind);
    visibleEdgeKinds = next;
  }

  // ---------------------------------------------------------------
  // Derived categories for the side panel
  // ---------------------------------------------------------------

  const callerNodes = $derived(
    data.nodes.filter((n) => {
      if (n.hop !== 1) return false;
      return data.edges.some((e) => e.target === data.center?.id && e.source === n.id);
    }),
  );

  const calleeNodes = $derived(
    data.nodes.filter((n) => {
      if (n.hop !== 1) return false;
      return data.edges.some((e) => e.source === data.center?.id && e.target === n.id);
    }),
  );

  const hop2Count = $derived(data.nodes.filter((n) => n.hop === 2).length);

  function onNodeClick(node: GraphNode): void {
    if (node.id !== data.center?.id) {
      void goto(`/code/symbol/${encodeURIComponent(node.label)}`);
    }
  }

  const edgeKindCounts = $derived.by(() => {
    const counts = new Map<EdgeKind, number>();
    for (const e of graphEdges) counts.set(e.kind, (counts.get(e.kind) ?? 0) + 1);
    return counts;
  });

  function shortPath(filePath: string): string {
    const parts = filePath.split('/');
    return parts.slice(-2).join('/');
  }

  const breadcrumbs = $derived([
    { label: 'Studio', href: '/' },
    { label: 'Code', href: '/code' },
    ...(data.center?.communityId && data.communityLabel
      ? [
          {
            label: data.communityLabel,
            href: `/code/community/${encodeURIComponent(data.center.communityId)}`,
          },
        ]
      : []),
    { label: data.symbolName },
  ]);
</script>

<svelte:head>
  <title>{data.symbolName} — Code — CLEO Studio</title>
</svelte:head>

<section class="symbol-view" aria-labelledby="symbol-title">
  <header class="page-head">
    <Breadcrumb items={breadcrumbs} />
    <div class="title-row">
      <div>
        <span class="eyebrow">NEXUS · Ego</span>
        <h1 id="symbol-title" class="sym-title">{data.symbolName}</h1>
        <p class="subtitle">
          {#if data.center}
            <span class="kind-badge">{data.center.kind}</span>
            {#if data.center.filePath}
              <span class="sep" aria-hidden="true">·</span>
              <span class="path">{data.center.filePath}</span>
            {/if}
          {/if}
        </p>
      </div>
      <div class="stat-row">
        <div class="stat callers-stat">
          <span class="stat-num">{callerNodes.length}</span>
          <span class="stat-lbl">Callers</span>
        </div>
        <div class="stat callees-stat">
          <span class="stat-num">{calleeNodes.length}</span>
          <span class="stat-lbl">Callees</span>
        </div>
        <div class="stat">
          <span class="stat-num">{hop2Count}</span>
          <span class="stat-lbl">Hop-2</span>
        </div>
      </div>
    </div>
  </header>

  <div class="workbench">
    <div class="stage" class:mode-hop={colorMode === 'hop'}>
      <div class="stage-scanlines" aria-hidden="true"></div>

      {#if colorMode === 'hop'}
        <div class="hop-rings" aria-hidden="true">
          <span class="ring ring-1"></span>
          <span class="ring ring-2"></span>
        </div>
      {/if}

      <CosmosRenderer
        nodes={graphNodes}
        edges={graphEdges}
        visibleEdgeKinds={visibleEdgeKinds}
        onNodeClick={onNodeClick}
        showClusterLabels={false}
        height="calc(100vh - 220px)"
        baseAlpha={0.94}
      />

      <footer class="legend-dock" aria-label="Edge legend">
        <span class="legend-eyebrow">EDGES</span>
        <ul>
          {#each EGO_EDGE_KINDS as kind (kind)}
            {@const style = EDGE_STYLE[kind]}
            {@const active = visibleEdgeKinds.has(kind)}
            {@const count = edgeKindCounts.get(kind) ?? 0}
            <li>
              <button
                type="button"
                class="legend-item"
                class:active
                class:disabled={count === 0}
                disabled={count === 0}
                aria-pressed={active}
                onclick={() => toggleEdge(kind)}
                title={describeEdgeKind(kind)}
              >
                <span
                  class="swatch"
                  style:background={style.color}
                  class:dashed={Boolean(style.dash)}
                  aria-hidden="true"
                ></span>
                <span>{kind}</span>
                <span class="legend-count">{count}</span>
              </button>
            </li>
          {/each}
        </ul>
      </footer>
    </div>

    <aside class="side-panel" aria-label="Ego network details">
      <Card elevation={1} padding="cozy">
        {#snippet children()}
          <div class="panel-stack">
            <Tabs
              items={[
                { value: 'hop', label: 'Hop coloring' },
                { value: 'kind', label: 'Kind coloring' },
              ]}
              value={colorMode}
              onchange={(v) => { colorMode = v === 'kind' ? 'kind' : 'hop'; }}
            />
            <TabPanel value="hop" active={colorMode}>
              {#snippet children()}
                <p class="panel-hint">
                  Center = amber · hop-1 = blue · hop-2 = slate.
                </p>
              {/snippet}
            </TabPanel>
            <TabPanel value="kind" active={colorMode}>
              {#snippet children()}
                <p class="panel-hint">
                  Substrate-native palette — matches macro + community views.
                </p>
              {/snippet}
            </TabPanel>

            {#if callerNodes.length > 0}
              <div class="panel-section">
                <h2 class="panel-head">
                  <span class="dot dot-caller" aria-hidden="true"></span>
                  Callers ({callerNodes.length})
                </h2>
                <ul class="chip-list">
                  {#each callerNodes as node (node.id)}
                    <li>
                      <a href={`/code/symbol/${encodeURIComponent(node.label)}`} class="chip chip-caller">
                        <span class="chip-label">{node.label}</span>
                        <span class="chip-kind">{node.kind}</span>
                      </a>
                    </li>
                  {/each}
                </ul>
              </div>
            {/if}

            {#if calleeNodes.length > 0}
              <div class="panel-section">
                <h2 class="panel-head">
                  <span class="dot dot-callee" aria-hidden="true"></span>
                  Callees ({calleeNodes.length})
                </h2>
                <ul class="chip-list">
                  {#each calleeNodes as node (node.id)}
                    <li>
                      <a href={`/code/symbol/${encodeURIComponent(node.label)}`} class="chip chip-callee">
                        <span class="chip-label">{node.label}</span>
                        <span class="chip-kind">{node.kind}</span>
                      </a>
                    </li>
                  {/each}
                </ul>
              </div>
            {/if}

            {#if data.center?.filePath}
              <div class="panel-section">
                <h2 class="panel-head">File</h2>
                <p class="file-path" title={data.center.filePath}>
                  {shortPath(data.center.filePath)}
                </p>
              </div>
            {/if}
          </div>
        {/snippet}
      </Card>
    </aside>
  </div>
</section>

<style>
  .symbol-view {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    padding-bottom: var(--space-8);
  }

  .page-head {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .title-row {
    display: flex;
    justify-content: space-between;
    gap: var(--space-5);
    flex-wrap: wrap;
    align-items: flex-end;
  }

  .eyebrow {
    display: inline-block;
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--warning);
    padding: 2px var(--space-2);
    border-radius: var(--radius-xs);
    background: var(--warning-soft);
  }

  .sym-title {
    font-family: var(--font-mono);
    font-size: var(--text-2xl);
    font-weight: 700;
    letter-spacing: -0.01em;
    color: var(--text);
    margin: var(--space-2) 0;
    word-break: break-all;
  }

  .subtitle {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--text-dim);
  }

  .subtitle .sep {
    color: var(--text-faint);
  }

  .kind-badge {
    color: var(--accent);
    font-weight: 600;
  }

  .path {
    color: var(--text-faint);
  }

  .stat-row {
    display: inline-flex;
    gap: var(--space-3);
  }

  .stat {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 2px;
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--bg-elev-1);
    min-width: 84px;
  }

  .stat-num {
    font-family: var(--font-mono);
    font-size: var(--text-lg);
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    color: var(--text);
  }

  .stat-lbl {
    font-size: var(--text-2xs);
    color: var(--text-dim);
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }

  .callers-stat .stat-num {
    color: var(--warning);
  }

  .callees-stat .stat-num {
    color: var(--info);
  }

  .workbench {
    display: grid;
    grid-template-columns: minmax(0, 72fr) minmax(0, 28fr);
    gap: var(--space-4);
  }

  @media (max-width: 960px) {
    .workbench {
      grid-template-columns: 1fr;
    }
  }

  .stage {
    position: relative;
    overflow: hidden;
    border-radius: var(--radius-lg);
  }

  .stage-scanlines {
    position: absolute;
    inset: 0;
    pointer-events: none;
    background-image: repeating-linear-gradient(
      180deg,
      transparent 0,
      transparent 2px,
      color-mix(in srgb, var(--border) 22%, transparent) 2px,
      color-mix(in srgb, var(--border) 22%, transparent) 3px
    );
    mix-blend-mode: overlay;
    opacity: 0.3;
    z-index: 2;
  }

  /* Concentric rings overlay — only in hop mode */
  .hop-rings {
    position: absolute;
    inset: 0;
    pointer-events: none;
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 2;
  }

  .ring {
    position: absolute;
    border: 1px dashed color-mix(in srgb, var(--info) 35%, transparent);
    border-radius: 50%;
  }

  .ring-1 {
    width: 34%;
    aspect-ratio: 1;
  }

  .ring-2 {
    width: 68%;
    aspect-ratio: 1;
    border-color: color-mix(in srgb, var(--text-faint) 30%, transparent);
  }

  /* Legend dock */
  .legend-dock {
    position: absolute;
    left: var(--space-3);
    right: var(--space-3);
    bottom: var(--space-3);
    display: flex;
    align-items: center;
    gap: var(--space-4);
    padding: var(--space-2) var(--space-3);
    background: color-mix(in srgb, var(--bg-elev-2) 88%, transparent);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-md);
    backdrop-filter: blur(10px);
    z-index: 3;
    overflow-x: auto;
  }

  .legend-eyebrow {
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    text-transform: uppercase;
    letter-spacing: 0.12em;
    color: var(--text-dim);
    white-space: nowrap;
  }

  .legend-dock ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: inline-flex;
    gap: var(--space-1);
  }

  .legend-item {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px var(--space-2);
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    color: var(--text-dim);
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    cursor: pointer;
    white-space: nowrap;
  }

  .legend-item:hover:not(:disabled) {
    color: var(--text);
    background: color-mix(in srgb, var(--bg-elev-2) 75%, transparent);
  }

  .legend-item:focus-visible {
    outline: none;
    box-shadow: var(--shadow-focus);
  }

  .legend-item.active {
    color: var(--text);
    border-color: var(--border);
    background: color-mix(in srgb, var(--bg) 70%, transparent);
  }

  .legend-item:not(.active) .swatch {
    opacity: 0.3;
  }

  .legend-item.disabled {
    opacity: 0.35;
    cursor: not-allowed;
  }

  .swatch {
    width: 18px;
    height: 2px;
    display: inline-block;
    border-radius: 1px;
  }

  .swatch.dashed {
    background-image: repeating-linear-gradient(
      90deg,
      currentColor 0,
      currentColor 3px,
      transparent 3px,
      transparent 6px
    );
  }

  .legend-count {
    font-size: 0.625rem;
    color: var(--text-faint);
    font-variant-numeric: tabular-nums;
  }

  .side-panel {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    min-width: 0;
  }

  .panel-stack {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  .panel-section {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .panel-head {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    font-weight: 700;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--text-dim);
    margin: 0;
  }

  .panel-hint {
    font-size: var(--text-xs);
    color: var(--text-faint);
    margin: 0;
    line-height: var(--leading-normal);
  }

  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
  }

  .dot-caller {
    background: var(--warning);
    box-shadow: 0 0 10px var(--warning);
  }

  .dot-callee {
    background: var(--info);
    box-shadow: 0 0 10px var(--info);
  }

  .chip-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1);
  }

  .chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px var(--space-2);
    border: 1px solid var(--border);
    border-left-width: 2px;
    border-radius: var(--radius-sm);
    background: var(--bg-elev-1);
    color: var(--text);
    text-decoration: none;
    transition: background var(--ease), border-color var(--ease);
  }

  .chip:hover,
  .chip:focus-visible {
    background: var(--bg-elev-2);
    border-color: var(--accent);
    outline: none;
  }

  .chip-caller {
    border-left-color: var(--warning);
  }

  .chip-callee {
    border-left-color: var(--info);
  }

  .chip-label {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--text);
  }

  .chip-kind {
    font-size: 0.625rem;
    color: var(--text-faint);
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }

  .file-path {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--text-dim);
    margin: 0;
    padding: var(--space-2) var(--space-3);
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    overflow: hidden;
    text-overflow: ellipsis;
  }
</style>
