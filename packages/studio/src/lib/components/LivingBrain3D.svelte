<!--
  LivingBrain3D — THIN SHIM.

  Wave 1A of T990 retired the legacy `3d-force-graph`-based renderer in
  favour of the `ThreeBrainRenderer` kit component. This file preserves
  its historical prop signature so callers outside `/brain` keep
  working, but internally delegates every draw to the new renderer.

  DO NOT add rendering logic here — extend `$lib/graph/renderers/*`
  instead. Everything below is an adapter layer.

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
    /** Set of node ids currently pulsing (new/updated). */
    pulsingNodes?: Set<string>;
    /** Set of edge keys (`${source}|${target}`) currently pulsing. */
    pulsingEdges?: Set<string>;
    /** UnrealBloomPass intensity — forwarded to the kit renderer. */
    bloomIntensity?: number;
  }

  let {
    nodes,
    edges,
    onNodeClick,
    height = '100%',
    pulsingNodes = new Set<string>(),
    pulsingEdges = new Set<string>(),
    bloomIntensity = 1.2,
  }: Props = $props();

  // Adapt to the kit contract (memoised on input identity).
  let adapted = $derived(adaptBrainGraph(nodes, edges));

  // Translate `pulsingEdges` (source|target keys) into FireEvent objects
  // so the kit renderer's firing queue can spark them.
  let pendingFires = $derived.by<FireEvent[]>(() => {
    const out: FireEvent[] = [];
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    for (const key of pulsingEdges) {
      const [source, target] = key.split('|');
      if (!source || !target) continue;
      const match = adapted.edges.find((e) => e.source === source && e.target === target);
      if (match) {
        out.push({ id: `legacy:${key}`, edgeId: match.id, intensity: 0.9, emittedAt: now });
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
  bloomStrength={bloomIntensity}
  {height}
/>
