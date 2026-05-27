<!--
  /code — macro view.

  GitNexus-caliber code intelligence canvas. Communities render as
  mass-weighted points on a WebGL graph; inter-community edges are
  coloured by their dominant relation kind; a keyboard-accessible side
  panel exposes search, visible-label chips, visible-edge chips, and
  the selected-node detail view.

  @task T990
  @wave 1B
-->
<script lang="ts">
  import type { PageData } from './$types';
  import { goto } from '$app/navigation';

  import CosmosRenderer from '$lib/graph/renderers/CosmosRenderer.svelte';
  import { adaptNexusMacro } from '$lib/graph/adapters/nexus-adapter.js';
  import { mapNexusRelationToEdgeKind } from '$lib/graph/adapters/nexus-adapter.js';
  import { EDGE_STYLE, describeEdgeKind } from '$lib/graph/edge-kinds.js';
  import type { EdgeKind, GraphNode } from '$lib/graph/types.js';

  import { Breadcrumb, Card, Chip, ChipGroup, Input, EmptyState } from '$lib/ui';

  interface Props {
    data: PageData;
  }
  let { data }: Props = $props();

  // ---------------------------------------------------------------
  // Graph data
  // ---------------------------------------------------------------

  const macroModel = $derived.by(() =>
    adaptNexusMacro(
      data.communities.map((c) => ({
        id: c.id,
        label: c.rawLabel,
        memberCount: c.size,
        topKind: c.topKind,
      })),
      data.edges.map((e) => ({
        source: e.source,
        target: e.target,
        kind: mapNexusRelationToEdgeKind(e.dominantType),
        weight: e.weight,
      })),
    ),
  );

  const graphNodes = $derived(macroModel.nodes);
  const graphEdges = $derived(macroModel.edges);
  const graphClusters = $derived(macroModel.clusters);

  // ---------------------------------------------------------------
  // Visible-edge / visible-label filter state
  // ---------------------------------------------------------------

  const CALL_EDGE_KINDS: readonly EdgeKind[] = [
    'contains',
    'defines',
    'imports',
    'calls',
    'extends',
    'implements',
    'has_method',
    'has_property',
    'member_of',
    'accesses',
    'references',
    'relates_to',
  ];

  const LABEL_KINDS = [
    'community',
    'folder',
    'file',
    'class',
    'function',
    'method',
    'interface',
    'enum',
    'type_alias',
  ];

  let visibleEdgeKinds = $state<Set<EdgeKind>>(new Set(CALL_EDGE_KINDS));
  let visibleNodeKinds = $state<Set<string>>(new Set(LABEL_KINDS));
  let showClusterLabels = $state(true);
  let highlightedNodeId = $state<string | null>(null);
  let selectedNode = $state<GraphNode | null>(null);

  function toggleEdge(kind: EdgeKind): void {
    const next = new Set(visibleEdgeKinds);
    if (next.has(kind)) next.delete(kind);
    else next.add(kind);
    visibleEdgeKinds = next;
  }

  function toggleLabel(kind: string): void {
    const next = new Set(visibleNodeKinds);
    if (next.has(kind)) next.delete(kind);
    else next.add(kind);
    visibleNodeKinds = next;
  }

  // ---------------------------------------------------------------
  // Search — debounced `/api/nexus/search`
  // ---------------------------------------------------------------

  interface SearchHit {
    id: string;
    label: string;
    kind: string;
    filePath: string;
    communityId: string | null;
  }

  let searchQuery = $state('');
  let searchResults = $state<SearchHit[]>([]);
  let searchDebounce: ReturnType<typeof setTimeout> | null = null;

  function onSearchInput(): void {
    if (searchDebounce) clearTimeout(searchDebounce);
    const q = searchQuery.trim();
    if (q.length < 2) {
      searchResults = [];
      return;
    }
    searchDebounce = setTimeout(async () => {
      try {
        const resp = await fetch(`/api/nexus/search?q=${encodeURIComponent(q)}`);
        if (!resp.ok) {
          searchResults = [];
          return;
        }
        searchResults = (await resp.json()) as SearchHit[];
      } catch {
        searchResults = [];
      }
    }, 180);
  }

  function onSearchPick(hit: SearchHit): void {
    void goto(`/code/symbol/${encodeURIComponent(hit.label)}`);
  }

  // ---------------------------------------------------------------
  // Node interaction
  // ---------------------------------------------------------------

  function onNodeClick(node: GraphNode): void {
    selectedNode = node;
    // Macro = community nodes → drill down.
    if (node.kind === 'community') {
      void goto(`/code/community/${encodeURIComponent(node.id)}`);
    }
  }

  // ---------------------------------------------------------------
  // Derived display
  // ---------------------------------------------------------------

  const topCommunities = $derived(data.communities.slice(0, 12));

  function formatCount(n: number): string {
    if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
    return String(n);
  }

  const totalEdgeWeight = $derived(data.edges.reduce((s, e) => s + e.weight, 0));
</script>

<svelte:head>
  <title>Code Intelligence — CLEO Studio</title>
</svelte:head>

<section class="code-macro" aria-labelledby="code-title">
  <header class="page-head">
    <Breadcrumb items={[{ label: 'Studio', href: '/' }, { label: 'Code' }]} />
    <div class="title-row">
      <div class="title-block">
        <span class="eyebrow">NEXUS · Macro</span>
        <h1 id="code-title">Code Intelligence</h1>
        <p class="subtitle">
          <span class="stat-inline">{formatCount(data.totalNodes)} symbols</span>
          <span class="sep" aria-hidden="true">·</span>
          <span class="stat-inline">{formatCount(data.totalRelations)} relations</span>
          <span class="sep" aria-hidden="true">·</span>
          <span class="stat-inline">{data.communities.length} communities</span>
        </p>
      </div>
      <div class="title-stats" role="list" aria-label="Graph summary">
        <div class="stat-card" role="listitem">
          <span class="stat-num">{formatCount(data.totalNodes)}</span>
          <span class="stat-lbl">Symbols</span>
        </div>
        <div class="stat-card" role="listitem">
          <span class="stat-num">{formatCount(data.totalRelations)}</span>
          <span class="stat-lbl">Relations</span>
        </div>
        <div class="stat-card" role="listitem">
          <span class="stat-num">{data.communities.length}</span>
          <span class="stat-lbl">Communities</span>
        </div>
      </div>
    </div>
  </header>

  {#if data.empty}
    <EmptyState
      title="No code graph yet"
      subtitle={data.emptyReason ?? 'Run cleo nexus analyze to populate nexus.db.'}
    />

  {:else}
    <div class="workbench">
      <div class="stage">
        <div class="stage-scanlines" aria-hidden="true"></div>
        <CosmosRenderer
          nodes={graphNodes}
          edges={graphEdges}
          clusters={graphClusters}
          visibleEdgeKinds={visibleEdgeKinds}
          visibleNodeKinds={visibleNodeKinds}
          highlightNodeId={highlightedNodeId}
          showClusterLabels={showClusterLabels}
          onNodeClick={onNodeClick}
          height="calc(100vh - 220px)"
          baseAlpha={0.92}
        />

        <!-- Legend dock — sits at the bottom of the canvas -->
        <footer class="legend-dock" aria-label="Edge legend">
          <span class="legend-eyebrow">EDGE KINDS</span>
          <ul>
            {#each CALL_EDGE_KINDS as kind (kind)}
              {@const style = EDGE_STYLE[kind]}
              {@const active = visibleEdgeKinds.has(kind)}
              <li>
                <button
                  type="button"
                  class="legend-item"
                  class:active
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
                  <span class="legend-label">{kind}</span>
                  {#if style.arrow}<span class="arrow-mark" aria-hidden="true">›</span>{/if}
                </button>
              </li>
            {/each}
          </ul>
        </footer>
      </div>

      <aside class="side-panel" aria-label="Graph controls and details">
        <Card elevation={1} padding="cozy">
          {#snippet children()}
            <div class="panel-stack">
              <Input
                type="search"
                label="Search symbols"
                placeholder="Search symbols, classes, functions…"
                bind:value={searchQuery}
                oninput={onSearchInput}
              />
              {#if searchResults.length > 0}
                <ul class="search-results" role="listbox" aria-label="Search results">
                  {#each searchResults as hit (hit.id)}
                    <li>
                      <button type="button" class="search-hit" onclick={() => onSearchPick(hit)}>
                        <span class="hit-label">{hit.label}</span>
                        <span class="hit-meta">
                          <span class="hit-kind">{hit.kind}</span>
                          {#if hit.filePath}
                            <span class="hit-path">{hit.filePath.split('/').slice(-2).join('/')}</span>
                          {/if}
                        </span>
                      </button>
                    </li>
                  {/each}
                </ul>
              {:else if searchQuery.trim().length >= 2}
                <p class="search-empty">No matches for "{searchQuery}"</p>
              {/if}

              <div class="panel-section">
                <h2 class="panel-head">Visible Labels</h2>
                <p class="panel-hint">Toggles WHICH kinds may render a cluster caption — never leaf labels.</p>
                <ChipGroup>
                  {#snippet children()}
                    {#each LABEL_KINDS as kind (kind)}
                      <Chip
                        active={visibleNodeKinds.has(kind)}
                        onclick={() => toggleLabel(kind)}
                      >
                        {#snippet children()}{kind}{/snippet}
                      </Chip>
                    {/each}
                  {/snippet}
                </ChipGroup>
                <label class="toggle-row">
                  <input
                    type="checkbox"
                    bind:checked={showClusterLabels}
                  />
                  <span>Show cluster captions</span>
                </label>
              </div>

              <div class="panel-section">
                <h2 class="panel-head">Visible Edges</h2>
                <p class="panel-hint">Hides the kind entirely from the canvas.</p>
                <ChipGroup>
                  {#snippet children()}
                    {#each CALL_EDGE_KINDS as kind (kind)}
                      <Chip
                        active={visibleEdgeKinds.has(kind)}
                        onclick={() => toggleEdge(kind)}
                      >
                        {#snippet children()}{kind}{/snippet}
                      </Chip>
                    {/each}
                  {/snippet}
                </ChipGroup>
              </div>

              <div class="panel-section">
                <h2 class="panel-head">Top Communities</h2>
                <ul class="community-list">
                  {#each topCommunities as comm (comm.id)}
                    <li>
                      <a
                        href={`/code/community/${encodeURIComponent(comm.id)}`}
                        class="community-row"
                        onmouseenter={() => { highlightedNodeId = comm.id; }}
                        onfocus={() => { highlightedNodeId = comm.id; }}
                        onmouseleave={() => { highlightedNodeId = null; }}
                        onblur={() => { highlightedNodeId = null; }}
                        style:--tint={comm.color}
                      >
                        <span class="tick" aria-hidden="true"></span>
                        <span class="row-body">
                          <span class="row-label">{comm.rawLabel}</span>
                          <span class="row-meta">{comm.size} symbols · {comm.topKind}</span>
                        </span>
                        <span class="row-chev" aria-hidden="true">→</span>
                      </a>
                    </li>
                  {/each}
                </ul>
              </div>

              <div class="panel-section">
                <a href="/code/flows" class="flow-link">
                  <span class="flow-arrow" aria-hidden="true">▸</span>
                  <span class="flow-body">
                    <span class="flow-title">Execution Flows</span>
                    <span class="flow-sub">Trace entry-points through the call graph</span>
                  </span>
                </a>
              </div>

              {#if selectedNode}
                <div class="panel-section selected">
                  <h2 class="panel-head">Selected</h2>
                  <div class="selected-card">
                    <span class="selected-label">{selectedNode.label}</span>
                    <span class="selected-kind">{selectedNode.kind}</span>
                    {#if typeof selectedNode.meta?.memberCount === 'number'}
                      <span class="selected-meta">
                        {selectedNode.meta.memberCount} members
                      </span>
                    {/if}
                  </div>
                </div>
              {/if}
            </div>
          {/snippet}
        </Card>

        <div class="keyboard-list" aria-label="Keyboard-accessible community list">
          <h2 class="panel-head sr-subhead">All Communities</h2>
          <p class="panel-hint">Keyboard-accessible mirror of the graph for screen readers and focus nav.</p>
          <ol>
            {#each data.communities as comm (comm.id)}
              <li>
                <a href={`/code/community/${encodeURIComponent(comm.id)}`}>
                  <span class="kb-label">{comm.rawLabel}</span>
                  <span class="kb-meta">{comm.size} symbols · {comm.topKind}</span>
                </a>
              </li>
            {/each}
          </ol>
        </div>
      </aside>
    </div>

    <p class="telemetry" aria-hidden="true">
      Aggregate cross-community relations: {formatCount(totalEdgeWeight)} · Top-600 shown ·
      Dominant-type preserved
    </p>
  {/if}
</section>

<style>
  .code-macro {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    padding-bottom: var(--space-8);
    --stage-accent: var(--accent);
  }

  /* ---------------------------------------------------------------
     Page head
     --------------------------------------------------------------- */
  .page-head {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .title-row {
    display: flex;
    justify-content: space-between;
    align-items: flex-end;
    gap: var(--space-5);
    flex-wrap: wrap;
  }

  .eyebrow {
    display: inline-block;
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--accent);
    padding: 2px var(--space-2);
    border-radius: var(--radius-xs);
    background: var(--accent-halo);
  }

  h1 {
    font-family: var(--font-sans);
    font-size: var(--text-3xl);
    font-weight: 700;
    letter-spacing: -0.02em;
    color: var(--text);
    line-height: 1;
    margin: var(--space-2) 0 var(--space-2) 0;
  }

  .subtitle {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--text-dim);
  }

  .stat-inline {
    white-space: nowrap;
  }

  .subtitle .sep {
    color: var(--text-faint);
  }

  .title-stats {
    display: inline-flex;
    gap: var(--space-3);
  }

  .stat-card {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 2px;
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--bg-elev-1);
    min-width: 96px;
  }

  .stat-card .stat-num {
    font-family: var(--font-mono);
    font-size: var(--text-lg);
    font-weight: 700;
    color: var(--text);
    font-variant-numeric: tabular-nums;
  }

  .stat-card .stat-lbl {
    font-size: var(--text-2xs);
    color: var(--text-dim);
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }

  /* ---------------------------------------------------------------
     Workbench — 72 / 28 grid
     --------------------------------------------------------------- */
  .workbench {
    display: grid;
    grid-template-columns: minmax(0, 72fr) minmax(0, 28fr);
    gap: var(--space-4);
    align-items: stretch;
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
      color-mix(in srgb, var(--border) 25%, transparent) 2px,
      color-mix(in srgb, var(--border) 25%, transparent) 3px
    );
    mix-blend-mode: overlay;
    opacity: 0.35;
    z-index: 2;
  }

  /* ---------------------------------------------------------------
     Legend dock
     --------------------------------------------------------------- */
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
    flex-wrap: nowrap;
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
    transition: background var(--ease), border-color var(--ease), color var(--ease);
  }

  .legend-item:hover {
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

  .arrow-mark {
    font-size: 12px;
    color: var(--text-faint);
    line-height: 1;
  }

  /* ---------------------------------------------------------------
     Side panel
     --------------------------------------------------------------- */
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

  .toggle-row {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    font-size: var(--text-xs);
    color: var(--text-dim);
    padding: var(--space-1) 0;
    cursor: pointer;
  }

  .toggle-row input[type='checkbox'] {
    accent-color: var(--accent);
    width: 14px;
    height: 14px;
  }

  /* ---------------------------------------------------------------
     Search
     --------------------------------------------------------------- */
  .search-results {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    max-height: 260px;
    overflow-y: auto;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--bg);
  }

  .search-hit {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: var(--space-2) var(--space-3);
    background: transparent;
    border: none;
    border-left: 2px solid transparent;
    text-align: left;
    width: 100%;
    color: var(--text);
    cursor: pointer;
    transition: background var(--ease), border-color var(--ease);
  }

  .search-hit:hover,
  .search-hit:focus-visible {
    background: var(--bg-elev-2);
    border-left-color: var(--accent);
    outline: none;
  }

  .hit-label {
    font-family: var(--font-mono);
    font-size: var(--text-sm);
    color: var(--text);
  }

  .hit-meta {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    font-size: var(--text-2xs);
    color: var(--text-dim);
  }

  .hit-kind {
    color: var(--accent);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-weight: 600;
  }

  .hit-path {
    color: var(--text-faint);
    font-family: var(--font-mono);
  }

  .search-empty {
    font-size: var(--text-xs);
    color: var(--text-faint);
    font-style: italic;
    margin: 0;
  }

  /* ---------------------------------------------------------------
     Community list
     --------------------------------------------------------------- */
  .community-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .community-row {
    display: grid;
    grid-template-columns: 4px 1fr auto;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-sm);
    border: 1px solid transparent;
    text-decoration: none;
    color: var(--text);
    transition: background var(--ease), border-color var(--ease), transform var(--ease);
    --tint: var(--accent);
  }

  .community-row:hover,
  .community-row:focus-visible {
    background: color-mix(in srgb, var(--bg-elev-2) 65%, transparent);
    border-color: var(--border);
    transform: translateX(2px);
    outline: none;
  }

  .community-row .tick {
    width: 4px;
    height: 28px;
    background: var(--tint);
    border-radius: 2px;
    box-shadow: 0 0 10px var(--tint);
  }

  .row-body {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  .row-label {
    font-size: var(--text-sm);
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .row-meta {
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    color: var(--text-dim);
  }

  .row-chev {
    color: var(--text-faint);
    font-family: var(--font-mono);
    font-size: var(--text-sm);
  }

  .community-row:hover .row-chev {
    color: var(--accent);
  }

  /* ---------------------------------------------------------------
     Flow link (calls out execution-flow tracer)
     --------------------------------------------------------------- */
  .flow-link {
    display: inline-flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-3);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background:
      radial-gradient(
        120% 100% at 100% 0%,
        color-mix(in srgb, var(--accent-halo) 90%, transparent) 0%,
        transparent 60%
      ),
      var(--bg-elev-1);
    color: var(--text);
    text-decoration: none;
    transition: border-color var(--ease), transform var(--ease);
  }

  .flow-link:hover,
  .flow-link:focus-visible {
    border-color: var(--accent);
    transform: translateY(-1px);
    outline: none;
  }

  .flow-arrow {
    font-size: 18px;
    color: var(--accent);
  }

  .flow-body {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .flow-title {
    font-family: var(--font-mono);
    font-size: var(--text-sm);
    font-weight: 600;
    letter-spacing: 0.02em;
  }

  .flow-sub {
    font-size: var(--text-xs);
    color: var(--text-dim);
  }

  /* ---------------------------------------------------------------
     Selected node
     --------------------------------------------------------------- */
  .selected-card {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: var(--space-2) var(--space-3);
    border-left: 2px solid var(--accent);
    background: var(--accent-halo);
    border-radius: var(--radius-sm);
  }

  .selected-label {
    font-family: var(--font-mono);
    font-size: var(--text-sm);
    color: var(--text);
  }

  .selected-kind {
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    text-transform: uppercase;
    color: var(--accent);
    letter-spacing: 0.08em;
  }

  .selected-meta {
    font-size: var(--text-2xs);
    color: var(--text-dim);
  }

  /* ---------------------------------------------------------------
     Keyboard-accessible community list (screen-reader mirror)
     --------------------------------------------------------------- */
  .keyboard-list {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    padding: var(--space-3);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--bg-elev-1);
  }

  .keyboard-list ol {
    list-style: none;
    margin: 0;
    padding: 0;
    max-height: 260px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .keyboard-list a {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-1) var(--space-2);
    text-decoration: none;
    color: var(--text);
    font-size: var(--text-xs);
    border-radius: var(--radius-xs);
    border: 1px solid transparent;
  }

  .keyboard-list a:hover,
  .keyboard-list a:focus-visible {
    background: var(--bg-elev-2);
    border-color: var(--border);
    outline: none;
  }

  .kb-label {
    color: var(--text);
  }

  .kb-meta {
    font-family: var(--font-mono);
    color: var(--text-dim);
  }

  .sr-subhead {
    margin-bottom: 0;
  }

  /* ---------------------------------------------------------------
     Telemetry footer
     --------------------------------------------------------------- */
  .telemetry {
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    color: var(--text-faint);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    margin: 0;
    text-align: right;
  }
</style>
