/**
 * Nexus layout — initial-position generator.
 *
 * Ported in spirit from the GitNexus `lib/graph-adapter.ts` strategy:
 *   1. Structural nodes (folders / modules / packages / projects) get
 *      HIGH mass so the force simulation blasts them apart.
 *   2. Leaf symbol nodes (function / method / property) follow their
 *      parent via hierarchy edges (`contains`, `defines`, `has_method`,
 *      `has_property`, `member_of`).
 *   3. Symbols that declare a `category` (community id) get a tighter
 *      jitter around their cluster's golden-angle centre.
 *
 * The layout returns two maps so callers can choose between baking the
 * initial positions into a Float32Array (cosmos) or writing them onto
 * a graphology graph (sigma fallback).
 *
 * @task T990
 * @wave 1B
 */

import type { EdgeKind, GraphEdge, GraphNode } from '../types.js';

/**
 * Node-kind categories used to decide mass + structural positioning.
 */
const STRUCTURAL_KINDS: ReadonlySet<string> = new Set([
  'project',
  'package',
  'module',
  'folder',
  'namespace',
  'section',
]);

/**
 * Edge kinds treated as hierarchy — children land near their parents.
 */
const HIERARCHY_EDGE_KINDS: ReadonlySet<EdgeKind> = new Set<EdgeKind>([
  'contains',
  'defines',
  'has_method',
  'has_property',
  'member_of',
  'parent',
]);

/**
 * Per-kind mass used to drive ForceAtlas2 / cosmos repulsion. Higher =
 * more repulsion = the node pushes its neighbours away.
 *
 * @param kind - Node kind as emitted by the nexus adapter.
 * @param nodeCount - Total graph size (scales the whole curve up for
 *   denser graphs so folders can still blast apart).
 */
export function getNodeMass(kind: string, nodeCount: number): number {
  const multiplier = nodeCount > 5_000 ? 2 : nodeCount > 1_000 ? 1.5 : 1;
  switch (kind) {
    case 'project':
      return 50 * multiplier;
    case 'package':
      return 30 * multiplier;
    case 'module':
    case 'namespace':
      return 20 * multiplier;
    case 'folder':
      return 15 * multiplier;
    case 'file':
    case 'section':
      return 8 * multiplier;
    case 'class':
    case 'interface':
    case 'struct':
    case 'enum':
      return 5 * multiplier;
    case 'community':
      return 4 * multiplier;
    case 'function':
    case 'method':
      return 2 * multiplier;
    case 'type_alias':
    case 'typedef':
      return 2 * multiplier;
    case 'property':
    case 'variable':
    case 'const':
      return 1 * multiplier;
    default:
      return 1;
  }
}

/**
 * Options for {@link applyNexusLayout}.
 */
export interface NexusLayoutOptions {
  /** Multiplier over `sqrt(nodeCount) * 40` structural spread. */
  spread?: number;
  /** Multiplier over the default cluster-attraction radius (80%). */
  clusterAttraction?: number;
  /** Deterministic seed for reproducible layouts (Mulberry32 PRNG). */
  seed?: number;
}

/**
 * Compute initial positions + mass for a nexus graph.
 *
 * @param nodes - Normalised kit nodes.
 * @param edges - Normalised kit edges (used only to thread the
 *   parent→child relationship; the caller keeps their own edge list).
 * @param opts - Optional knobs.
 */
export function applyNexusLayout(
  nodes: GraphNode[],
  edges: GraphEdge[],
  opts?: NexusLayoutOptions,
): {
  positions: Map<string, { x: number; y: number }>;
  masses: Map<string, number>;
} {
  const positions = new Map<string, { x: number; y: number }>();
  const masses = new Map<string, number>();

  if (nodes.length === 0) return { positions, masses };

  const rng = makeRng(opts?.seed ?? 0x13579bdf);
  const structuralSpread = Math.sqrt(nodes.length) * 40 * (opts?.spread ?? 1);
  const childJitter = Math.sqrt(nodes.length) * 3;
  const clusterJitter = Math.sqrt(nodes.length) * 1.5;

  // -------------------------------------------------------------
  // 1. Index the graph: parent→child map + cluster membership
  // -------------------------------------------------------------
  const parentToChildren = new Map<string, string[]>();
  const childToParent = new Map<string, string>();
  for (const edge of edges) {
    if (!HIERARCHY_EDGE_KINDS.has(edge.kind)) continue;
    const children = parentToChildren.get(edge.source) ?? [];
    children.push(edge.target);
    parentToChildren.set(edge.source, children);
    // First parent wins — keeps the tree shape deterministic.
    if (!childToParent.has(edge.target)) {
      childToParent.set(edge.target, edge.source);
    }
  }

  // Identify clusters + count members so we can position the centres.
  const clusters = new Map<string, number>();
  for (const node of nodes) {
    const cat = node.category ?? null;
    if (cat) clusters.set(cat, (clusters.get(cat) ?? 0) + 1);
  }

  // Golden-angle cluster centres at 80% of structural spread.
  const clusterSpread = structuralSpread * 0.8 * (opts?.clusterAttraction ?? 1);
  const clusterCenters = new Map<string, { x: number; y: number }>();
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  {
    const total = Math.max(1, clusters.size);
    let idx = 0;
    for (const id of clusters.keys()) {
      const angle = idx * goldenAngle;
      const radius = clusterSpread * Math.sqrt((idx + 1) / total);
      clusterCenters.set(id, {
        x: radius * Math.cos(angle),
        y: radius * Math.sin(angle),
      });
      idx++;
    }
  }

  // -------------------------------------------------------------
  // 2. Position structural nodes first (golden-angle radial layout)
  // -------------------------------------------------------------
  const structuralNodes = nodes.filter(
    (n) => STRUCTURAL_KINDS.has(n.kind) || n.kind === 'community',
  );

  structuralNodes.forEach((node, index) => {
    const angle = index * goldenAngle;
    const radius = structuralSpread * Math.sqrt((index + 1) / Math.max(1, structuralNodes.length));
    const jitter = structuralSpread * 0.15;
    positions.set(node.id, {
      x: radius * Math.cos(angle) + (rng() - 0.5) * jitter,
      y: radius * Math.sin(angle) + (rng() - 0.5) * jitter,
    });
    masses.set(node.id, getNodeMass(node.kind, nodes.length));
  });

  // -------------------------------------------------------------
  // 3. BFS down the parent→child tree, placing each child near its
  //    parent with small jitter; cluster-aware symbols land near
  //    their cluster centre instead.
  // -------------------------------------------------------------
  const SYMBOL_KINDS = new Set([
    'function',
    'method',
    'class',
    'interface',
    'type_alias',
    'struct',
    'trait',
    'enum',
  ]);

  const nodeById = new Map(nodes.map((n) => [n.id, n] as const));

  const queue: string[] = structuralNodes.map((n) => n.id);
  const seen = new Set<string>(queue);

  const place = (node: GraphNode): void => {
    if (positions.has(node.id)) return;
    const clusterCenter = node.category ? clusterCenters.get(node.category) : undefined;

    let x: number;
    let y: number;
    if (clusterCenter && SYMBOL_KINDS.has(node.kind)) {
      x = clusterCenter.x + (rng() - 0.5) * clusterJitter;
      y = clusterCenter.y + (rng() - 0.5) * clusterJitter;
    } else {
      const parentId = childToParent.get(node.id);
      const parentPos = parentId ? positions.get(parentId) : undefined;
      if (parentPos) {
        x = parentPos.x + (rng() - 0.5) * childJitter;
        y = parentPos.y + (rng() - 0.5) * childJitter;
      } else {
        x = (rng() - 0.5) * structuralSpread * 0.5;
        y = (rng() - 0.5) * structuralSpread * 0.5;
      }
    }

    positions.set(node.id, { x, y });
    masses.set(node.id, getNodeMass(node.kind, nodes.length));
  };

  while (queue.length > 0) {
    const id = queue.shift();
    if (id === undefined) continue;
    const children = parentToChildren.get(id) ?? [];
    for (const childId of children) {
      if (seen.has(childId)) continue;
      seen.add(childId);
      const child = nodeById.get(childId);
      if (child) place(child);
      queue.push(childId);
    }
  }

  // Orphans (nodes with no hierarchy edge).
  for (const node of nodes) {
    if (!positions.has(node.id)) place(node);
  }

  return { positions, masses };
}

/**
 * Mulberry32 — tiny, fast, deterministic PRNG.
 *
 * @param seed - 32-bit seed.
 */
function makeRng(seed: number): () => number {
  let t = seed >>> 0;
  return function next(): number {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}
