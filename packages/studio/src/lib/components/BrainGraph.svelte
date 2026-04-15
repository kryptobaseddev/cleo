<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import * as d3 from 'd3';

  interface BrainNode {
    id: string;
    node_type: string;
    label: string;
    quality_score: number;
    metadata_json: string | null;
    created_at: string;
    // d3 simulation adds these at runtime
    x?: number;
    y?: number;
    fx?: number | null;
    fy?: number | null;
    vx?: number;
    vy?: number;
  }

  interface BrainEdge {
    from_id: string;
    to_id: string;
    edge_type: string;
    weight: number;
    created_at: string;
    // d3 link simulation resolves these
    source?: BrainNode | string;
    target?: BrainNode | string;
  }

  interface DetailPanel {
    node: BrainNode;
    x: number;
    y: number;
  }

  interface Props {
    nodes: BrainNode[];
    edges: BrainEdge[];
    /** ISO date string — only show nodes created on or before this date */
    filterDate?: string | null;
  }

  let { nodes, edges, filterDate = null }: Props = $props();

  let svgEl: SVGSVGElement | undefined = $state();
  let detail: DetailPanel | null = $state(null);
  let simulation: d3.Simulation<BrainNode, BrainEdge> | null = null;

  // Color by node_type
  const NODE_COLORS: Record<string, string> = {
    observation: '#3b82f6', // blue
    decision: '#22c55e',    // green
    pattern: '#a855f7',     // purple
    learning: '#f97316',    // orange
    task: '#6b7280',        // grey
    session: '#64748b',
    epic: '#f59e0b',
    sticky: '#ec4899',
  };

  // Edge colors by type
  const EDGE_COLORS: Record<string, string> = {
    supersedes: '#ef4444',    // red
    applies_to: '#3b82f6',    // blue
    derived_from: '#22c55e',  // green
    part_of: '#a855f7',
    produced_by: '#f97316',
    references: '#94a3b8',
  };

  function nodeColor(type: string): string {
    return NODE_COLORS[type] ?? '#94a3b8';
  }

  function edgeColor(type: string): string {
    return EDGE_COLORS[type] ?? '#475569';
  }

  function nodeRadius(quality: number): number {
    const q = quality ?? 0.5;
    return 4 + q * 12; // 4–16px range
  }

  /** Returns filtered nodes based on filterDate */
  function filteredNodes(allNodes: BrainNode[], date: string | null): BrainNode[] {
    if (!date) return allNodes;
    return allNodes.filter((n) => n.created_at <= date);
  }

  function filteredEdges(allEdges: BrainEdge[], nodeSet: Set<string>): BrainEdge[] {
    return allEdges.filter((e) => {
      const sid = typeof e.source === 'string' ? e.source : (e.source as BrainNode | undefined)?.id ?? e.from_id;
      const tid = typeof e.target === 'string' ? e.target : (e.target as BrainNode | undefined)?.id ?? e.to_id;
      return nodeSet.has(sid) && nodeSet.has(tid);
    });
  }

  function tierStroke(node: BrainNode): { dasharray: string; strokeWidth: number } {
    let meta: Record<string, unknown> = {};
    try {
      if (node.metadata_json) meta = JSON.parse(node.metadata_json) as Record<string, unknown>;
    } catch {
      // ignore
    }
    const tier = (meta['memory_tier'] as string | undefined) ?? 'short';
    if (tier === 'long') return { dasharray: '', strokeWidth: 2.5 };
    if (tier === 'medium') return { dasharray: '4 2', strokeWidth: 1.5 };
    return { dasharray: '', strokeWidth: 0.75 };
  }

  function buildGraph(): void {
    if (!svgEl) return;

    const visibleNodes = filteredNodes(nodes, filterDate);
    const nodeSet = new Set(visibleNodes.map((n) => n.id));
    const visibleEdges = filteredEdges(edges, nodeSet);

    // Deep-copy nodes for d3 mutation
    const simNodes: BrainNode[] = visibleNodes.map((n) => ({ ...n }));

    // Map edges to use id references
    const simEdges: BrainEdge[] = visibleEdges.map((e) => ({
      ...e,
      source: e.from_id,
      target: e.to_id,
    }));

    const svg = d3.select(svgEl);
    svg.selectAll('*').remove();

    const width = svgEl.clientWidth || 900;
    const height = svgEl.clientHeight || 600;

    // Arrow markers
    const defs = svg.append('defs');
    const arrowTypes = Object.keys(EDGE_COLORS);
    for (const et of arrowTypes) {
      defs
        .append('marker')
        .attr('id', `arrow-${et}`)
        .attr('viewBox', '0 -5 10 10')
        .attr('refX', 18)
        .attr('refY', 0)
        .attr('markerWidth', 6)
        .attr('markerHeight', 6)
        .attr('orient', 'auto')
        .append('path')
        .attr('d', 'M0,-5L10,0L0,5')
        .attr('fill', edgeColor(et));
    }

    const container = svg.append('g').attr('class', 'graph-container');

    // Zoom behaviour
    const zoom = d3
      .zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.1, 8])
      .on('zoom', (event: d3.D3ZoomEvent<SVGSVGElement, unknown>) => {
        container.attr('transform', event.transform.toString());
      });

    svg.call(zoom);

    // Stop simulation if running
    if (simulation) simulation.stop();

    simulation = d3
      .forceSimulation<BrainNode>(simNodes)
      .force(
        'link',
        d3
          .forceLink<BrainNode, BrainEdge>(simEdges)
          .id((d) => d.id)
          .distance(60)
          .strength(0.3),
      )
      .force('charge', d3.forceManyBody<BrainNode>().strength(-80))
      .force('center', d3.forceCenter(width / 2, height / 2))
      .force('collision', d3.forceCollide<BrainNode>().radius((d) => nodeRadius(d.quality_score) + 2))
      .alphaDecay(0.02);

    // Edges
    const link = container
      .append('g')
      .attr('class', 'links')
      .selectAll('line')
      .data(simEdges)
      .join('line')
      .attr('stroke', (d) => edgeColor(d.edge_type))
      .attr('stroke-opacity', 0.6)
      .attr('stroke-width', (d) => Math.max(0.5, d.weight * 1.5))
      .attr('marker-end', (d) => `url(#arrow-${d.edge_type})`);

    // Node groups
    const node = container
      .append('g')
      .attr('class', 'nodes')
      .selectAll<SVGGElement, BrainNode>('g')
      .data(simNodes)
      .join('g')
      .attr('class', 'node-group')
      .style('cursor', 'pointer')
      .call(
        d3
          .drag<SVGGElement, BrainNode>()
          .on('start', (event: d3.D3DragEvent<SVGGElement, BrainNode, BrainNode>) => {
            if (!event.active && simulation) simulation.alphaTarget(0.3).restart();
            event.subject.fx = event.subject.x;
            event.subject.fy = event.subject.y;
          })
          .on('drag', (event: d3.D3DragEvent<SVGGElement, BrainNode, BrainNode>) => {
            event.subject.fx = event.x;
            event.subject.fy = event.y;
          })
          .on('end', (event: d3.D3DragEvent<SVGGElement, BrainNode, BrainNode>) => {
            if (!event.active && simulation) simulation.alphaTarget(0);
            event.subject.fx = null;
            event.subject.fy = null;
          }),
      );

    // Background circles for tier ring
    node
      .append('circle')
      .attr('r', (d) => nodeRadius(d.quality_score) + 3)
      .attr('fill', 'none')
      .attr('stroke', (d) => nodeColor(d.node_type))
      .attr('stroke-opacity', 0.3)
      .attr('stroke-width', (d) => tierStroke(d).strokeWidth)
      .attr('stroke-dasharray', (d) => tierStroke(d).dasharray);

    // Main node circle
    node
      .append('circle')
      .attr('r', (d) => nodeRadius(d.quality_score))
      .attr('fill', (d) => nodeColor(d.node_type))
      .attr('fill-opacity', (d) => {
        let meta: Record<string, unknown> = {};
        try {
          if (d.metadata_json) meta = JSON.parse(d.metadata_json) as Record<string, unknown>;
        } catch {
          // ignore
        }
        const isInvalidated = typeof meta['invalid_at'] === 'string' && meta['invalid_at'];
        const isPrune = meta['prune_candidate'] === 1 || meta['prune_candidate'] === true;
        if (isInvalidated) return 0.2;
        if (isPrune) return 0.35;
        return 0.85;
      })
      .attr('stroke', (d) => nodeColor(d.node_type))
      .attr('stroke-width', 1)
      .on('click', (event: MouseEvent, d: BrainNode) => {
        event.stopPropagation();
        const rect = svgEl?.getBoundingClientRect();
        if (!rect) return;
        detail = {
          node: d,
          x: event.clientX - rect.left,
          y: event.clientY - rect.top,
        };
      });

    // Labels on larger nodes
    node
      .filter((d) => nodeRadius(d.quality_score) >= 8)
      .append('text')
      .text((d) => (d.label.length > 18 ? `${d.label.slice(0, 16)}…` : d.label))
      .attr('x', (d) => nodeRadius(d.quality_score) + 4)
      .attr('y', 4)
      .attr('font-size', '9px')
      .attr('fill', '#94a3b8')
      .style('pointer-events', 'none');

    simulation.on('tick', () => {
      link
        .attr('x1', (d) => (d.source as BrainNode).x ?? 0)
        .attr('y1', (d) => (d.source as BrainNode).y ?? 0)
        .attr('x2', (d) => (d.target as BrainNode).x ?? 0)
        .attr('y2', (d) => (d.target as BrainNode).y ?? 0);

      node.attr('transform', (d) => `translate(${d.x ?? 0},${d.y ?? 0})`);
    });

    // Click background to dismiss detail
    svg.on('click', () => {
      detail = null;
    });
  }

  onMount(() => {
    buildGraph();
  });

  onDestroy(() => {
    if (simulation) simulation.stop();
  });

  // Rebuild when data or filter changes
  $effect(() => {
    // Access reactive values
    const _ = { nodes, edges, filterDate };
    if (svgEl) buildGraph();
  });
</script>

<div class="graph-wrapper">
  <svg bind:this={svgEl} class="brain-graph" width="100%" height="100%"></svg>

  {#if detail}
    <div
      class="detail-panel"
      style="left:{Math.min(detail.x + 12, 680)}px; top:{Math.min(detail.y + 12, 500)}px"
    >
      <div class="detail-header">
        <span class="detail-type" style="color:{nodeColor(detail.node.node_type)}"
          >{detail.node.node_type}</span
        >
        <button class="detail-close" onclick={() => (detail = null)}>x</button>
      </div>
      <div class="detail-label">{detail.node.label}</div>
      <div class="detail-meta">
        <span>Quality: {(detail.node.quality_score ?? 0).toFixed(2)}</span>
        <span>Created: {detail.node.created_at.slice(0, 10)}</span>
      </div>
      {#if detail.node.metadata_json}
        {@const meta = (() => {
          try {
            return JSON.parse(detail.node.metadata_json) as Record<string, unknown>;
          } catch {
            return null;
          }
        })()}
        {#if meta}
          <div class="detail-extra">
            {#if meta['memory_tier']}
              <span class="badge">tier:{meta['memory_tier']}</span>
            {/if}
            {#if meta['memory_type']}
              <span class="badge">type:{meta['memory_type']}</span>
            {/if}
            {#if meta['verified']}
              <span class="badge verified">verified</span>
            {/if}
            {#if meta['prune_candidate']}
              <span class="badge prune">prune</span>
            {/if}
            {#if meta['invalid_at']}
              <span class="badge invalid">invalidated</span>
            {/if}
          </div>
        {/if}
      {/if}
    </div>
  {/if}
</div>

<style>
  .graph-wrapper {
    position: relative;
    width: 100%;
    height: 100%;
    background: #0d111a;
    border-radius: 8px;
    overflow: hidden;
  }

  .brain-graph {
    display: block;
    width: 100%;
    height: 100%;
  }

  .detail-panel {
    position: absolute;
    background: #1a1f2e;
    border: 1px solid #2d3748;
    border-radius: 8px;
    padding: 0.75rem 1rem;
    min-width: 220px;
    max-width: 300px;
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
    z-index: 10;
    pointer-events: all;
  }

  .detail-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 0.5rem;
  }

  .detail-type {
    font-size: 0.6875rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }

  .detail-close {
    background: none;
    border: none;
    color: #64748b;
    cursor: pointer;
    font-size: 0.875rem;
    line-height: 1;
    padding: 0;
  }

  .detail-close:hover {
    color: #e2e8f0;
  }

  .detail-label {
    font-size: 0.875rem;
    color: #e2e8f0;
    font-weight: 600;
    margin-bottom: 0.5rem;
    word-break: break-word;
  }

  .detail-meta {
    display: flex;
    gap: 0.75rem;
    font-size: 0.75rem;
    color: #64748b;
    margin-bottom: 0.5rem;
  }

  .detail-extra {
    display: flex;
    flex-wrap: wrap;
    gap: 0.375rem;
    margin-top: 0.5rem;
  }

  .badge {
    font-size: 0.6875rem;
    padding: 0.125rem 0.4rem;
    border-radius: 4px;
    background: #2d3748;
    color: #94a3b8;
  }

  .badge.verified {
    background: rgba(34, 197, 94, 0.15);
    color: #22c55e;
  }

  .badge.prune {
    background: rgba(245, 158, 11, 0.15);
    color: #f59e0b;
  }

  .badge.invalid {
    background: rgba(239, 68, 68, 0.15);
    color: #ef4444;
  }
</style>
