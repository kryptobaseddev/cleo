<!--
  BrainGraph — THIN SHIM (T990 integration cleanup).

  Historically a 2D d3-force SVG renderer over the raw SQL-row shape
  returned by `/api/memory/graph`. Every live Brain surface now routes
  through `ThreeBrainRenderer` via the `LivingBrainGraph` / `LivingBrain3D`
  shims Wave 1A shipped — this file preserves the legacy default-export
  signature so `routes/brain/graph/+page.svelte` (and any future
  pre-T990 caller) keeps compiling, but delegates every render to the
  canonical renderer.

  The legacy prop shape (`node_type`, `quality_score`, `metadata_json`,
  `from_id`, `to_id`, `edge_type`) is translated into `GraphNode` /
  `GraphEdge` inline — the existing `$lib/graph/brain-adapter.ts` expects
  the `@cleocode/brain` runtime shape (different keys), so a small local
  projection is the cheapest legal bridge here.

  @deprecated since T990; delegates to ThreeBrainRenderer. Slated for removal.
  @task T990
  @wave integration-cleanup
-->
<script lang="ts">
  import ThreeBrainRenderer from '$lib/graph/renderers/ThreeBrainRenderer.svelte';
  import { ALL_EDGE_KINDS } from '$lib/graph/edge-kinds.js';
  import type { EdgeKind, GraphEdge, GraphNode } from '$lib/graph/types.js';

  /**
   * Legacy node row shape — matches the SQL row returned by
   * `/api/memory/graph` (see `routes/api/memory/graph/+server.ts`).
   */
  export interface BrainNode {
    id: string;
    node_type: string;
    label: string;
    quality_score: number;
    metadata_json: string | null;
    created_at: string;
  }

  /** Legacy edge row shape — see {@link BrainNode}. */
  export interface BrainEdge {
    from_id: string;
    to_id: string;
    edge_type: string;
    weight: number;
    created_at: string;
  }

  /** Props preserved verbatim from the pre-T990 component signature. */
  interface Props {
    nodes: BrainNode[];
    edges: BrainEdge[];
    /** ISO date string — only show nodes created on or before this date. */
    filterDate?: string | null;
  }

  let { nodes, edges, filterDate = null }: Props = $props();

  const VALID_EDGE_KINDS: ReadonlySet<string> = new Set<string>(ALL_EDGE_KINDS);

  /** Filter legacy nodes by the pre-T990 `created_at <= filterDate` rule. */
  const visibleNodes = $derived<BrainNode[]>(
    filterDate ? nodes.filter((n) => n.created_at <= filterDate) : nodes,
  );

  /** Project the legacy SQL shape onto the canonical {@link GraphNode}. */
  const adaptedNodes = $derived<GraphNode[]>(
    visibleNodes.map((n) => ({
      id: n.id,
      substrate: 'brain' as const,
      kind: n.node_type,
      label: n.label,
      weight: n.quality_score,
      freshness: 0.6,
      meta: { createdAt: n.created_at, raw: n.metadata_json },
    })),
  );

  /** Project the legacy edge shape onto {@link GraphEdge}. */
  const adaptedEdges = $derived.by<GraphEdge[]>(() => {
    const ids = new Set(adaptedNodes.map((n) => n.id));
    return edges
      .filter((e) => ids.has(e.from_id) && ids.has(e.to_id))
      .map((e, i): GraphEdge => {
        const kind: EdgeKind = VALID_EDGE_KINDS.has(e.edge_type)
          ? (e.edge_type as EdgeKind)
          : 'relates_to';
        return {
          id: `bg-${i}:${e.from_id}>${e.to_id}:${e.edge_type}`,
          source: e.from_id,
          target: e.to_id,
          kind,
          weight: e.weight,
          directional: true,
        };
      });
  });
</script>

<ThreeBrainRenderer nodes={adaptedNodes} edges={adaptedEdges} height="100%" />
