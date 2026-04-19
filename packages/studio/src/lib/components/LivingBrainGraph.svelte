<!--
  LivingBrainGraph — THIN SHIM.

  Historically the sigma.js 2D renderer. Wave 1A of T990 unifies every
  Brain canvas on a single 3D renderer; this file preserves its
  historical prop signature so routes outside `/brain` keep working,
  but internally delegates to the new `ThreeBrainRenderer` kit
  component.

  Callers that genuinely need a flat 2D view should use
  `LivingBrainCosmograph.svelte` (the GPU renderer, kept unchanged).

  @task T990
  @wave 1A
-->
<script lang="ts">
  import type { BrainEdge, BrainNode } from '@cleocode/brain';
  import ThreeBrainRenderer from '$lib/graph/renderers/ThreeBrainRenderer.svelte';
  import { adaptBrainGraph } from '$lib/graph/brain-adapter.js';
  import type { FireEvent, GraphNode } from '$lib/graph/types.js';

  /**
   * Historical props. Preserved verbatim so no downstream call-site
   * breaks while the new kit takes over.
   */
  interface Props {
    nodes: BrainNode[];
    edges: BrainEdge[];
    /** Fired when the user clicks a node. Passes the node id. */
    onNodeClick?: (id: string) => void;
    height?: string;
    /** Set of node ids that are currently pulsing (new/updated). */
    pulsingNodes?: Set<string>;
    /** Set of edge keys (`${source}|${target}`) that are currently pulsing. */
    pulsingEdges?: Set<string>;
  }

  let {
    nodes,
    edges,
    onNodeClick,
    height = '100%',
    pulsingNodes = new Set<string>(),
    pulsingEdges = new Set<string>(),
  }: Props = $props();

  let adapted = $derived(adaptBrainGraph(nodes, edges));

  let pendingFires = $derived.by<FireEvent[]>(() => {
    const out: FireEvent[] = [];
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    for (const key of pulsingEdges) {
      const [source, target] = key.split('|');
      if (!source || !target) continue;
      const match = adapted.edges.find((e) => e.source === source && e.target === target);
      if (match) {
        out.push({ id: `legacy:${key}`, edgeId: match.id, intensity: 0.8, emittedAt: now });
      }
    }
    return out;
  });

  function forwardSelect(node: GraphNode): void {
    onNodeClick?.(node.id);
  }
</script>

<ThreeBrainRenderer
  nodes={adapted.nodes}
  edges={adapted.edges}
  onNodeSelect={forwardSelect}
  {pulsingNodes}
  {pendingFires}
  {height}
/>
