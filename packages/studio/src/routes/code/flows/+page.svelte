<!--
  /code/flows — execution-flow tracer.

  Left:  scrollable list of entry-point flows.
  Right: CosmosRenderer scoped to the selected flow's reach set.
  Below: step timeline when the selected flow has ordered
         `step_in_process` edges.

  @task T990
  @wave 1B
-->
<script lang="ts">
  import type { PageData } from './$types';
  import { goto } from '$app/navigation';

  import CosmosRenderer from '$lib/graph/renderers/CosmosRenderer.svelte';
  import { mapNexusRelationToEdgeKind } from '$lib/graph/adapters/nexus-adapter.js';
  import type { EdgeKind, GraphEdge, GraphNode } from '$lib/graph/types.js';
  import { Breadcrumb, Card, EmptyState } from '$lib/ui';

  interface Props {
    data: PageData;
  }
  let { data }: Props = $props();

  // ---------------------------------------------------------------
  // Flow selection
  // ---------------------------------------------------------------

  let selectedFlowId = $state<string | null>(null);

  const selectedFlow = $derived.by(() => {
    const flows = data.flows;
    if (flows.length === 0) return null;
    const id = selectedFlowId ?? flows[0].id;
    return flows.find((f) => f.id === id) ?? flows[0];
  });

  const reachSet = $derived.by(() => new Set(selectedFlow?.reachIds ?? []));

  // Build the scoped graph model for the selected flow.
  const graphModel = $derived.by(() => {
    if (!selectedFlow) return { nodes: [], edges: [] as GraphEdge[] };
    const nodes: GraphNode[] = data.nodes
      .filter((n) => reachSet.has(n.id))
      .map((n) => ({
        id: n.id,
        substrate: 'nexus' as const,
        kind: n.kind || 'symbol',
        label: n.label,
        category: n.id === selectedFlow.id ? 'entry' : 'reached',
        weight: n.id === selectedFlow.id ? 1 : 0.35,
        meta: { filePath: n.filePath },
      }));
    const edges: GraphEdge[] = data.edges
      .filter((e) => reachSet.has(e.source) && reachSet.has(e.target) && e.source !== e.target)
      .map((e, idx) => ({
        id: `flow-${idx}-${e.source}-${e.target}`,
        source: e.source,
        target: e.target,
        kind: mapNexusRelationToEdgeKind(e.type),
        directional: true,
      }));
    return { nodes, edges };
  });

  // Derive the step timeline.
  const stepEntries = $derived.by(() => {
    if (!selectedFlow) return [];
    const steps = data.edges
      .filter(
        (e) =>
          reachSet.has(e.source) &&
          reachSet.has(e.target) &&
          typeof e.stepIndex === 'number',
      )
      .sort((a, b) => (a.stepIndex ?? 0) - (b.stepIndex ?? 0));
    const lookupLabel = (id: string): string =>
      data.nodes.find((n) => n.id === id)?.label ?? id;
    return steps.map((s) => ({
      source: lookupLabel(s.source),
      target: lookupLabel(s.target),
      type: s.type,
      stepIndex: s.stepIndex ?? 0,
    }));
  });

  // Kind grouping for the flow list.
  const flowsByKind = $derived.by(() => {
    const groups = new Map<string, typeof data.flows>();
    for (const flow of data.flows) {
      const k = flow.kind || 'other';
      const bucket = groups.get(k) ?? [];
      bucket.push(flow);
      groups.set(k, bucket);
    }
    return [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
  });

  function onNodeClick(node: GraphNode): void {
    if (node.id === selectedFlow?.id) return;
    void goto(`/code/symbol/${encodeURIComponent(node.label)}`);
  }

  const MACRO_EDGES: readonly EdgeKind[] = [
    'calls',
    'defines',
    'imports',
    'extends',
    'implements',
    'references',
    'has_method',
  ];
  const visibleEdgeKinds = new Set<EdgeKind>(MACRO_EDGES);
</script>

<svelte:head>
  <title>Execution Flows — Code — CLEO Studio</title>
</svelte:head>

<section class="flows-view" aria-labelledby="flows-title">
  <header class="page-head">
    <Breadcrumb
      items={[
        { label: 'Studio', href: '/' },
        { label: 'Code', href: '/code' },
        { label: 'Flows' },
      ]}
    />
    <div class="title-row">
      <div>
        <span class="eyebrow">NEXUS · Flows</span>
        <h1 id="flows-title">Execution Flows</h1>
        <p class="subtitle">
          {data.flows.length} entry-points · {data.hasProcesses ? 'process-annotated' : 'call-graph derived'}
        </p>
      </div>
    </div>
  </header>

  {#if data.empty}
    <EmptyState
      title="No flows yet"
      subtitle="Nexus hasn't captured any entry-points. Run cleo nexus analyze and ensure your project exposes entry-point symbols (functions with entry_point_of edges or high-out-degree call roots)."
    />

  {:else}
    <div class="workbench">
      <aside class="flow-list" aria-label="Entry-point list">
        <Card elevation={1} padding="compact">
          {#snippet children()}
            <div class="list-stack">
              {#each flowsByKind as [kind, flows] (kind)}
                <div class="group">
                  <h2 class="group-head">
                    <span class="kind-mark" aria-hidden="true"></span>
                    {kind}
                    <span class="group-count">{flows.length}</span>
                  </h2>
                  <ul>
                    {#each flows as flow (flow.id)}
                      <li>
                        <button
                          type="button"
                          class="flow-item"
                          class:active={selectedFlowId === flow.id}
                          onclick={() => { selectedFlowId = flow.id; }}
                        >
                          <span class="flow-label">{flow.label}</span>
                          <span class="flow-sub">
                            <span>{flow.reachIds.length - 1} fanout</span>
                            {#if flow.filePath}
                              <span class="sep" aria-hidden="true">·</span>
                              <span class="flow-path">
                                {flow.filePath.split('/').slice(-2).join('/')}
                              </span>
                            {/if}
                          </span>
                        </button>
                      </li>
                    {/each}
                  </ul>
                </div>
              {/each}
            </div>
          {/snippet}
        </Card>
      </aside>

      <div class="flow-stage">
        <div class="stage" aria-label="Selected flow canvas">
          <div class="stage-scanlines" aria-hidden="true"></div>
          {#if selectedFlow}
            <CosmosRenderer
              nodes={graphModel.nodes}
              edges={graphModel.edges}
              visibleEdgeKinds={visibleEdgeKinds}
              showClusterLabels={false}
              onNodeClick={onNodeClick}
              highlightNodeId={selectedFlow.id}
              height="calc(100vh - 440px)"
              baseAlpha={0.92}
            />
          {:else}
            <div class="placeholder">Select an entry-point to trace.</div>
          {/if}
        </div>

        <div class="timeline" aria-label="Step timeline">
          <h2 class="group-head">
            <span class="kind-mark kind-mark-timeline" aria-hidden="true"></span>
            Timeline
            {#if stepEntries.length > 0}
              <span class="group-count">{stepEntries.length}</span>
            {/if}
          </h2>
          {#if stepEntries.length === 0}
            <p class="timeline-empty">
              This flow has no explicit `step_in_process` ordering — the canvas above shows the BFS reach set instead.
            </p>
          {:else}
            <ol class="timeline-list">
              {#each stepEntries as step, i (i)}
                <li class="timeline-step">
                  <span class="step-idx">{step.stepIndex}</span>
                  <span class="step-arrow" aria-hidden="true">→</span>
                  <span class="step-body">
                    <span class="step-src">{step.source}</span>
                    <span class="step-sep" aria-hidden="true">⟶</span>
                    <span class="step-dst">{step.target}</span>
                    <span class="step-type">{step.type}</span>
                  </span>
                </li>
              {/each}
            </ol>
          {/if}
        </div>
      </div>
    </div>
  {/if}
</section>

<style>
  .flows-view {
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
  }

  .eyebrow {
    display: inline-block;
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--priority-critical);
    padding: 2px var(--space-2);
    border-radius: var(--radius-xs);
    background: color-mix(in srgb, var(--priority-critical) 18%, transparent);
  }

  h1 {
    font-family: var(--font-sans);
    font-size: var(--text-2xl);
    font-weight: 700;
    letter-spacing: -0.02em;
    color: var(--text);
    margin: var(--space-2) 0;
  }

  .subtitle {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--text-dim);
    margin: 0;
  }

  .workbench {
    display: grid;
    grid-template-columns: minmax(0, 30fr) minmax(0, 70fr);
    gap: var(--space-4);
  }

  @media (max-width: 960px) {
    .workbench {
      grid-template-columns: 1fr;
    }
  }

  .flow-list {
    display: flex;
    flex-direction: column;
    min-width: 0;
    max-height: calc(100vh - 200px);
  }

  .list-stack {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    max-height: 70vh;
    overflow-y: auto;
  }

  .group {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  .group-head {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    text-transform: uppercase;
    letter-spacing: 0.12em;
    color: var(--text-dim);
    margin: 0;
    padding: 0 var(--space-2);
  }

  .kind-mark {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--priority-critical);
    box-shadow: 0 0 10px var(--priority-critical);
  }

  .kind-mark-timeline {
    background: var(--accent);
    box-shadow: 0 0 10px var(--accent);
  }

  .group-count {
    margin-left: auto;
    font-variant-numeric: tabular-nums;
    color: var(--text-faint);
  }

  .group ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .flow-item {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: var(--space-2) var(--space-3);
    border: 1px solid transparent;
    border-left: 2px solid var(--border);
    border-radius: var(--radius-xs);
    background: transparent;
    text-align: left;
    color: var(--text);
    cursor: pointer;
    transition: background var(--ease), border-color var(--ease), transform var(--ease);
  }

  .flow-item:hover,
  .flow-item:focus-visible {
    background: var(--bg-elev-2);
    border-left-color: var(--accent);
    outline: none;
    transform: translateX(2px);
  }

  .flow-item.active {
    background: var(--accent-halo);
    border-left-color: var(--accent);
    border-color: var(--border);
  }

  .flow-label {
    font-family: var(--font-mono);
    font-size: var(--text-sm);
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .flow-sub {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    font-size: var(--text-2xs);
    color: var(--text-dim);
  }

  .sep {
    color: var(--text-faint);
  }

  .flow-path {
    color: var(--text-faint);
    font-family: var(--font-mono);
  }

  /* Stage + timeline */
  .flow-stage {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    min-width: 0;
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

  .placeholder {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 300px;
    font-size: var(--text-sm);
    color: var(--text-faint);
  }

  .timeline {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-3) var(--space-4);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--bg-elev-1);
  }

  .timeline-empty {
    margin: 0;
    font-size: var(--text-xs);
    color: var(--text-faint);
    font-style: italic;
  }

  .timeline-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    max-height: 240px;
    overflow-y: auto;
  }

  .timeline-step {
    display: grid;
    grid-template-columns: auto auto 1fr;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-1) var(--space-2);
    border-left: 2px solid var(--accent);
    background: var(--bg);
    border-radius: var(--radius-xs);
  }

  .step-idx {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    font-weight: 700;
    color: var(--accent);
    font-variant-numeric: tabular-nums;
  }

  .step-arrow {
    color: var(--text-faint);
    font-family: var(--font-mono);
  }

  .step-body {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--text);
    flex-wrap: wrap;
  }

  .step-src {
    color: var(--warning);
  }

  .step-dst {
    color: var(--info);
  }

  .step-sep {
    color: var(--text-faint);
  }

  .step-type {
    margin-left: var(--space-2);
    color: var(--text-dim);
    font-size: 0.625rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
</style>
