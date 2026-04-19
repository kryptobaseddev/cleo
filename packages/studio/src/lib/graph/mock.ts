/**
 * CLEO Studio — deterministic mock Brain payload.
 *
 * Generates a realistically-shaped graph across all five substrates
 * with a spread of edge kinds so the 3D renderer can be exercised in
 * isolation from the backend. The output is deterministic for a given
 * seed so tests + visual regressions are reproducible.
 *
 * @task T990
 * @wave 1A
 */

import {
  ALL_SUBSTRATES,
  type EdgeKind,
  type GraphCluster,
  type GraphEdge,
  type GraphNode,
  type SubstrateId,
} from './types.js';

/**
 * Result shape returned by {@link mockBrain}.
 */
export interface MockBrainPayload {
  nodes: GraphNode[];
  edges: GraphEdge[];
  clusters: GraphCluster[];
}

/**
 * Tiny xor-shift pseudo-random generator. Seed-stable so snapshots +
 * tests don't flake.
 */
function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  if (state === 0) state = 0x9e3779b1;
  return (): number => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0xffffffff;
  };
}

/**
 * Substrate-to-likely-kinds map. Drives realistic node-kind
 * distribution — a `brain` node is more likely to be an `observation`
 * than a `task`.
 */
const KIND_BY_SUBSTRATE: Record<SubstrateId, string[]> = {
  brain: ['observation', 'decision', 'pattern', 'learning'],
  nexus: ['symbol', 'file', 'community'],
  tasks: ['task', 'session'],
  conduit: ['message'],
  signaldock: ['agent'],
};

/**
 * Candidate edge kinds for each source substrate. Edge selection
 * mixes within-substrate kinds + cross-substrate bridges.
 */
const KINDS_BY_SUBSTRATE: Record<SubstrateId, EdgeKind[]> = {
  brain: ['supersedes', 'contradicts', 'derived_from', 'cites', 'references', 'documents'],
  nexus: [
    'calls',
    'extends',
    'implements',
    'imports',
    'accesses',
    'defines',
    'contains',
    'has_method',
    'has_property',
  ],
  tasks: ['blocks', 'depends', 'parent'],
  conduit: ['messages', 'fires'],
  signaldock: ['messages', 'co_fires'],
};

const CROSS_KINDS: EdgeKind[] = [
  'references',
  'relates_to',
  'documents',
  'informed_by',
  'produced_by',
];

/**
 * Build a deterministic mock Brain payload.
 *
 * @param nodeCount - Target number of nodes (default 400).
 * @param edgeCount - Target number of edges (default 600).
 * @param seed - PRNG seed — identical seed produces identical output.
 */
export function mockBrain(
  nodeCount: number = 400,
  edgeCount: number = 600,
  seed: number = 0xc1e09013,
): MockBrainPayload {
  const rand = makeRng(seed);
  const nodes: GraphNode[] = [];
  const clusters: GraphCluster[] = [];

  // Distribute nodes across substrates with a weighted split:
  //   brain 30%, nexus 35%, tasks 15%, conduit 12%, signaldock 8%.
  const split: Record<SubstrateId, number> = {
    brain: Math.round(nodeCount * 0.3),
    nexus: Math.round(nodeCount * 0.35),
    tasks: Math.round(nodeCount * 0.15),
    conduit: Math.round(nodeCount * 0.12),
    signaldock: 0,
  };
  const assigned = split.brain + split.nexus + split.tasks + split.conduit;
  split.signaldock = Math.max(0, nodeCount - assigned);

  for (const sub of ALL_SUBSTRATES) {
    const count = split[sub];
    const kinds = KIND_BY_SUBSTRATE[sub];
    // Group nodes into 3–5 clusters per substrate for the cluster layer.
    const clusterCount = Math.min(5, Math.max(1, Math.floor(count / 30)));
    const clusterLabels = buildClusterLabels(sub, clusterCount);
    const clusterMembers: Record<string, string[]> = Object.fromEntries(
      clusterLabels.map((lbl) => [lbl.id, [] as string[]]),
    );
    for (let i = 0; i < count; i++) {
      const kind = kinds[Math.floor(rand() * kinds.length)];
      const clusterIdx = Math.floor(rand() * clusterLabels.length);
      const clusterId = clusterLabels[clusterIdx]?.id;
      const id = `${sub}:${kind}-${i.toString(36)}-${seed.toString(36).slice(-3)}`;
      const weight = roundTo(rand() * 0.85 + 0.1, 3);
      const freshness = roundTo(rand(), 3);
      const isHub = i < clusterLabels.length || rand() > 0.95;
      const label = labelFor(sub, kind, i);
      nodes.push({
        id,
        substrate: sub,
        kind,
        label,
        category: clusterId,
        weight: isHub ? Math.max(0.82, weight) : weight,
        freshness,
        meta: { isHub, clusterLabel: clusterLabels[clusterIdx]?.label ?? null },
      });
      if (clusterId) clusterMembers[clusterId]?.push(id);
    }
    for (const cl of clusterLabels) {
      clusters.push({
        id: cl.id,
        label: cl.label,
        substrate: sub,
        memberIds: clusterMembers[cl.id] ?? [],
      });
    }
  }

  // Build edges — mix within-substrate + cross-substrate bridges.
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  const nodesBySub = groupBySubstrate(nodes);
  let attempts = 0;
  const maxAttempts = edgeCount * 4;
  while (edges.length < edgeCount && attempts < maxAttempts) {
    attempts++;
    const source = nodes[Math.floor(rand() * nodes.length)];
    const crossSubstrate = rand() < 0.25;
    let target: GraphNode;
    let kind: EdgeKind;
    if (crossSubstrate) {
      // pick a target from a different substrate
      let otherSub: SubstrateId = source.substrate;
      while (otherSub === source.substrate) {
        otherSub = ALL_SUBSTRATES[Math.floor(rand() * ALL_SUBSTRATES.length)];
      }
      const pool = nodesBySub[otherSub];
      if (!pool || pool.length === 0) continue;
      target = pool[Math.floor(rand() * pool.length)];
      kind = CROSS_KINDS[Math.floor(rand() * CROSS_KINDS.length)];
    } else {
      target = nodes[Math.floor(rand() * nodes.length)];
      if (target.substrate !== source.substrate) {
        kind = CROSS_KINDS[Math.floor(rand() * CROSS_KINDS.length)];
      } else {
        const kinds = KINDS_BY_SUBSTRATE[source.substrate];
        kind = kinds[Math.floor(rand() * kinds.length)];
      }
    }
    if (target.id === source.id) continue;
    const key = `${source.id}>${target.id}:${kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({
      id: `e${edges.length.toString(36)}`,
      source: source.id,
      target: target.id,
      kind,
      weight: roundTo(rand() * 0.7 + 0.15, 3),
      directional: true,
      meta: { crossSubstrate },
    });
  }

  return { nodes, edges, clusters };
}

/**
 * Build cluster labels for a substrate. Small curated list keeps the
 * output human-readable (and visually pleasant in the label layer).
 */
function buildClusterLabels(sub: SubstrateId, count: number): Array<{ id: string; label: string }> {
  const vocab: Record<SubstrateId, string[]> = {
    brain: ['Cortex', 'Hippocampus', 'Reflexes', 'Lineage', 'Atlas'],
    nexus: ['Core', 'Dispatch', 'Memory Bridge', 'Session Runtime', 'Brain Adapter'],
    tasks: ['Epic', 'Backlog', 'In Flight', 'Release'],
    conduit: ['Agent Chatter', 'System Events', 'Broadcast'],
    signaldock: ['Orchestrators', 'Leads', 'Workers'],
  };
  const pool = vocab[sub];
  return Array.from({ length: count }, (_, idx) => ({
    id: `${sub}:cluster:${pool[idx % pool.length]}:${idx}`,
    label: `${pool[idx % pool.length]}`,
  }));
}

/**
 * Shape a realistic-looking node label for a given substrate/kind.
 */
function labelFor(sub: SubstrateId, kind: string, i: number): string {
  const idx = i.toString(36);
  switch (sub) {
    case 'brain':
      return kind === 'decision'
        ? `D-${idx}: canonicalise ${sample(['envelope', 'registry', 'cluster'], i)}`
        : kind === 'pattern'
          ? `P-${idx}: ${sample(['rate-limit', 'cache-warm', 'retry-backoff'], i)}`
          : kind === 'learning'
            ? `L-${idx}: ${sample(['ssoT drift', 'flake source', 'slow path'], i)}`
            : `O-${idx}: ${sample(['observed', 'resolved', 'noted'], i)} ${sample(['fix', 'regression', 'pattern'], i)}`;
    case 'nexus':
      return kind === 'file'
        ? `src/${sample(['dispatch', 'engines', 'adapters', 'stores'], i)}/${sample(['index', 'bridge', 'harness', 'runtime'], i)}.ts`
        : kind === 'community'
          ? `cluster-${idx}`
          : `${sample(['register', 'resolve', 'build', 'spawn', 'emit'], i)}${capitalize(sample(['Provider', 'Engine', 'Adapter', 'Bridge', 'Session'], i))}`;
    case 'tasks':
      return kind === 'session'
        ? `ses_${idx}`
        : `T${(i + 100).toString(10)}: ${sample(['wire', 'ship', 'audit', 'repair'], i)} ${sample(['brain', 'nexus', 'harness', 'payload'], i)}`;
    case 'conduit':
      return `msg_${idx} → ${sample(['orchestrator', 'worker-a', 'worker-b'], i)}`;
    case 'signaldock':
      return `${sample(['orc', 'lead', 'wk'], i)}-${idx}`;
  }
}

function sample<T>(pool: readonly T[], i: number): T {
  return pool[i % pool.length];
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}

function roundTo(n: number, digits: number): number {
  const k = 10 ** digits;
  return Math.round(n * k) / k;
}

function groupBySubstrate(nodes: GraphNode[]): Record<SubstrateId, GraphNode[]> {
  const out: Record<SubstrateId, GraphNode[]> = {
    brain: [],
    nexus: [],
    tasks: [],
    conduit: [],
    signaldock: [],
  };
  for (const n of nodes) out[n.substrate].push(n);
  return out;
}
