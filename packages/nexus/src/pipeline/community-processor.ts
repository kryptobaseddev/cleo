/**
 * Community Detection Processor — Phase 5
 *
 * Uses the Louvain algorithm (via graphology-communities-louvain) to detect
 * communities/clusters in the code graph based on CALLS, EXTENDS, and
 * IMPLEMENTS relationships.
 *
 * Communities represent groups of code that work together frequently,
 * helping agents navigate the codebase by functional area rather than by
 * file structure.
 *
 * Ported and adapted from GitNexus
 * `src/core/ingestion/community-processor.ts` (uses Louvain not Leiden,
 * per cross-validation recommendation RR2).
 *
 * @task T538
 * @module pipeline/community-processor
 */

import { createRequire } from 'node:module';
import type { GraphRelationType } from '@cleocode/contracts';
import type { KnowledgeGraph } from './knowledge-graph.js';

// ============================================================================
// GRAPHOLOGY INTEROP
// ============================================================================
// graphology-communities-louvain is CJS (module.exports = fn) so we load
// it via createRequire to avoid ESM interop issues with NodeNext resolution.
const _require = createRequire(import.meta.url);

// eslint-disable-next-line @typescript-eslint/no-require-imports
const GraphCtor = _require('graphology') as {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  new (options: { type: string; allowSelfLoops: boolean }): GraphInstance;
};

/** Louvain detailed result shape. */
interface LouvainDetailedResult {
  communities: Record<string, number>;
  count: number;
  modularity: number;
  deltaComputations: number;
  dendrogram: unknown[];
  moves: unknown[];
  nodesVisited: number;
  resolution: number;
}

/** Louvain callable type loaded from CJS require. */
interface LouvainFn {
  detailed(
    graph: GraphInstance,
    options?: { resolution?: number; randomWalk?: boolean },
  ): LouvainDetailedResult;
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const louvain = _require('graphology-communities-louvain') as LouvainFn;

// ============================================================================
// GRAPHOLOGY GRAPH INTERFACE
// ============================================================================
// We define a minimal interface for the graphology Graph so we don't import
// the type namespace (which causes "Cannot use namespace as type" under
// NodeNext + skipLibCheck:false combos).

/** Minimal interface for a graphology Graph instance. */
interface GraphInstance {
  order: number;
  size: number;
  addNode(id: string, attributes?: Record<string, unknown>): void;
  addEdge(source: string, target: string): void;
  hasNode(id: string): boolean;
  hasEdge(source: string, target: string): boolean;
  forEachNode(callback: (nodeId: string) => void): void;
  forEachNeighbor(nodeId: string, callback: (neighbour: string) => void): void;
  getNodeAttribute(nodeId: string, attribute: string): unknown;
}

// ============================================================================
// TYPES
// ============================================================================

/** A single detected community node. */
export interface CommunityInfo {
  /** Stable ID, format: `comm_<n>`. */
  id: string;
  /** Human-readable label derived from the dominant folder in the community. */
  heuristicLabel: string;
  /** Number of member symbols. */
  symbolCount: number;
  /** Internal edge density (0 – 1). Higher = more cohesive. */
  cohesion: number;
}

/** Mapping of a single graph node to its community. */
export interface CommunityMembership {
  /** Node ID of the member symbol. */
  nodeId: string;
  /** Community ID this node belongs to, format: `comm_<n>`. */
  communityId: string;
}

/** Result returned by `detectCommunities`. */
export interface CommunityDetectionResult {
  /** All detected communities (singletons excluded). */
  communities: CommunityInfo[];
  /** One entry per node that was assigned to a community. */
  memberships: CommunityMembership[];
  stats: {
    /** Total number of non-singleton communities. */
    totalCommunities: number;
    /** Louvain modularity score (quality indicator, 0 – 1). */
    modularity: number;
    /** Number of graph nodes included in the Louvain run. */
    nodesProcessed: number;
  };
}

// ============================================================================
// CONSTANTS
// ============================================================================

/** Edge types used to build the clustering graph. */
const CLUSTERING_EDGE_TYPES = new Set<GraphRelationType>(['calls', 'extends', 'implements']);

/** Symbol node kinds eligible for community membership. */
const SYMBOL_KINDS = new Set(['function', 'method', 'class', 'interface']);

/** Minimum edge confidence used when the graph is in large-graph mode. */
const MIN_CONFIDENCE_LARGE = 0.5;

/** Louvain resolution parameter — 2.0 tuned for monorepos (per RR2). */
const LOUVAIN_RESOLUTION = 2.0;

// ============================================================================
// MAIN ENTRY POINT
// ============================================================================

/**
 * Detect communities in the knowledge graph using the Louvain algorithm.
 *
 * This runs AFTER all relationships (CALLS, EXTENDS, IMPLEMENTS) have been
 * built. It writes Community nodes and MEMBER_OF edges directly into `graph`.
 *
 * Handles empty graphs (no CALLS edges) gracefully — returns empty results.
 *
 * @param graph - The in-memory KnowledgeGraph to read edges from and write to
 * @returns Detection result with community nodes, memberships, and stats
 */
export async function detectCommunities(graph: KnowledgeGraph): Promise<CommunityDetectionResult> {
  // Count symbol nodes to decide whether to enable large-graph mode
  let symbolCount = 0;
  for (const node of graph.nodes.values()) {
    if (SYMBOL_KINDS.has(node.kind)) {
      symbolCount++;
    }
  }
  const isLarge = symbolCount > 10_000;

  // Build the undirected graphology graph for Louvain
  const gGraph = buildGraphologyGraph(graph, isLarge);

  if (gGraph.order === 0) {
    process.stderr.write('[nexus] Phase 5: No eligible nodes — skipping community detection\n');
    return {
      communities: [],
      memberships: [],
      stats: { totalCommunities: 0, modularity: 0, nodesProcessed: 0 },
    };
  }

  process.stderr.write(
    `[nexus] Phase 5: Running Louvain on ${gGraph.order} nodes, ${gGraph.size} edges` +
      `${isLarge ? ` (large-graph mode, filtered from ${symbolCount} symbols)` : ''}\n`,
  );

  // Run Louvain with a 60-second timeout guard
  const LOUVAIN_TIMEOUT_MS = 60_000;
  let details: LouvainDetailedResult;

  try {
    details = await Promise.race([
      Promise.resolve(louvain.detailed(gGraph, { resolution: LOUVAIN_RESOLUTION })),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Louvain timeout')), LOUVAIN_TIMEOUT_MS),
      ),
    ]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === 'Louvain timeout') {
      process.stderr.write('[nexus] Phase 5: Louvain timed out — falling back to single cluster\n');
      const fallback: Record<string, number> = {};
      gGraph.forEachNode((nodeId: string) => {
        fallback[nodeId] = 0;
      });
      details = {
        communities: fallback,
        count: 1,
        modularity: 0,
        deltaComputations: 0,
        dendrogram: [],
        moves: [],
        nodesVisited: 0,
        resolution: LOUVAIN_RESOLUTION,
      };
    } else {
      throw err;
    }
  }

  process.stderr.write(`[nexus] Phase 5: Louvain found ${details.count} raw communities\n`);

  // Build community info nodes (skip singletons)
  const communities = buildCommunityInfos(details.communities, gGraph, graph);

  // Build membership list
  const memberships: CommunityMembership[] = [];
  for (const [nodeId, commNum] of Object.entries(details.communities)) {
    memberships.push({ nodeId, communityId: `comm_${commNum}` });
  }

  // Write Community nodes into the KnowledgeGraph
  for (const comm of communities) {
    graph.addNode({
      id: comm.id,
      kind: 'community',
      name: comm.heuristicLabel,
      filePath: '',
      startLine: 0,
      endLine: 0,
      language: '',
      exported: false,
      meta: {
        symbolCount: comm.symbolCount,
        cohesion: comm.cohesion,
      },
    });
  }

  // Write MEMBER_OF edges + update communityId on symbol nodes
  for (const m of memberships) {
    const memberNode = graph.nodes.get(m.nodeId);
    if (!memberNode) continue;

    // Only create MEMBER_OF if the community node exists (non-singleton)
    if (graph.nodes.has(m.communityId)) {
      graph.addRelation({
        source: m.nodeId,
        target: m.communityId,
        type: 'member_of',
        confidence: 1.0,
        reason: 'louvain-community',
      });
      // Update the node's communityId in-place (Map holds a reference)
      memberNode.communityId = m.communityId;
    }
  }

  return {
    communities,
    memberships,
    stats: {
      totalCommunities: communities.length,
      modularity: details.modularity,
      nodesProcessed: gGraph.order,
    },
  };
}

// ============================================================================
// HELPER: Build graphology undirected graph from KnowledgeGraph
// ============================================================================

/**
 * Build the graphology graph used for Louvain community detection.
 *
 * In large-graph mode (> 10 K symbol nodes):
 * - Filters out edges with confidence < 0.5
 * - Skips degree-1 nodes (they add noise without benefiting clustering)
 */
function buildGraphologyGraph(kg: KnowledgeGraph, isLarge: boolean): GraphInstance {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-call
  const gGraph = new GraphCtor({ type: 'undirected', allowSelfLoops: false });

  // First pass: determine which nodes are connected (have qualifying edges)
  const connectedNodes = new Set<string>();
  const nodeDegree = new Map<string, number>();

  for (const rel of kg.relations) {
    if (!CLUSTERING_EDGE_TYPES.has(rel.type)) continue;
    if (rel.source === rel.target) continue;
    if (isLarge && rel.confidence < MIN_CONFIDENCE_LARGE) continue;

    connectedNodes.add(rel.source);
    connectedNodes.add(rel.target);
    nodeDegree.set(rel.source, (nodeDegree.get(rel.source) ?? 0) + 1);
    nodeDegree.set(rel.target, (nodeDegree.get(rel.target) ?? 0) + 1);
  }

  // Second pass: add eligible symbol nodes to the graphology graph
  for (const node of kg.nodes.values()) {
    if (!SYMBOL_KINDS.has(node.kind)) continue;
    if (!connectedNodes.has(node.id)) continue;
    if (isLarge && (nodeDegree.get(node.id) ?? 0) < 2) continue;

    gGraph.addNode(node.id, {
      name: node.name,
      filePath: node.filePath,
      kind: node.kind,
    });
  }

  // Third pass: add edges between nodes that made it into the graph
  for (const rel of kg.relations) {
    if (!CLUSTERING_EDGE_TYPES.has(rel.type)) continue;
    if (isLarge && rel.confidence < MIN_CONFIDENCE_LARGE) continue;
    if (!gGraph.hasNode(rel.source) || !gGraph.hasNode(rel.target)) continue;
    if (rel.source === rel.target) continue;

    // Guard against duplicate edges (undirected graph rejects them)
    if (!gGraph.hasEdge(rel.source, rel.target)) {
      gGraph.addEdge(rel.source, rel.target);
    }
  }

  return gGraph;
}

// ============================================================================
// HELPER: Build CommunityInfo nodes from Louvain results
// ============================================================================

/**
 * Convert raw Louvain community numbers into `CommunityInfo` objects.
 * Singleton communities (single member) are skipped.
 */
function buildCommunityInfos(
  communities: Record<string, number>,
  gGraph: GraphInstance,
  kg: KnowledgeGraph,
): CommunityInfo[] {
  // Group node IDs by community number
  const byComm = new Map<number, string[]>();
  for (const [nodeId, commNum] of Object.entries(communities)) {
    if (!byComm.has(commNum)) byComm.set(commNum, []);
    byComm.get(commNum)!.push(nodeId);
  }

  // Build a filePath lookup from the original KnowledgeGraph
  const nodeFilePaths = new Map<string, string>();
  for (const node of kg.nodes.values()) {
    if (node.filePath) nodeFilePaths.set(node.id, node.filePath);
  }

  const result: CommunityInfo[] = [];

  for (const [commNum, memberIds] of byComm.entries()) {
    // Skip singletons — isolated nodes are noise
    if (memberIds.length < 2) continue;

    const heuristicLabel = generateHeuristicLabel(memberIds, nodeFilePaths, gGraph, commNum);
    const cohesion = calculateCohesion(memberIds, gGraph);

    result.push({
      id: `comm_${commNum}`,
      heuristicLabel,
      symbolCount: memberIds.length,
      cohesion,
    });
  }

  // Largest communities first
  result.sort((a, b) => b.symbolCount - a.symbolCount);

  return result;
}

// ============================================================================
// HELPER: Heuristic label generation
// ============================================================================

/**
 * Generate a human-readable label from the most common parent folder among
 * community members' file paths.
 *
 * Skips generic folder names (src, lib, core, utils, common, shared, helpers).
 * Falls back to a common name prefix, then `Cluster_<n>`.
 */
function generateHeuristicLabel(
  memberIds: string[],
  nodeFilePaths: Map<string, string>,
  gGraph: GraphInstance,
  commNum: number,
): string {
  const GENERIC_FOLDERS = new Set(['src', 'lib', 'core', 'utils', 'common', 'shared', 'helpers']);
  const folderCounts = new Map<string, number>();

  for (const nodeId of memberIds) {
    const filePath = nodeFilePaths.get(nodeId) ?? '';
    const parts = filePath.split('/').filter(Boolean);

    if (parts.length >= 2) {
      const folder = parts[parts.length - 2];
      if (!GENERIC_FOLDERS.has(folder.toLowerCase())) {
        folderCounts.set(folder, (folderCounts.get(folder) ?? 0) + 1);
      }
    }
  }

  // Find the most common folder
  let bestFolder = '';
  let maxCount = 0;
  for (const [folder, count] of folderCounts.entries()) {
    if (count > maxCount) {
      maxCount = count;
      bestFolder = folder;
    }
  }

  if (bestFolder) {
    return bestFolder.charAt(0).toUpperCase() + bestFolder.slice(1);
  }

  // Fallback: look for a common prefix in function names
  const names: string[] = [];
  for (const nodeId of memberIds) {
    const name = gGraph.getNodeAttribute(nodeId, 'name');
    if (typeof name === 'string' && name) names.push(name);
  }

  if (names.length > 2) {
    const prefix = findCommonPrefix(names);
    if (prefix.length > 2) {
      return prefix.charAt(0).toUpperCase() + prefix.slice(1);
    }
  }

  return `Cluster_${commNum}`;
}

/**
 * Find the common string prefix of an array of strings.
 */
function findCommonPrefix(strings: string[]): string {
  if (strings.length === 0) return '';
  const sorted = [...strings].sort();
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  let i = 0;
  while (i < first.length && first[i] === last[i]) i++;
  return first.substring(0, i);
}

// ============================================================================
// HELPER: Community cohesion score
// ============================================================================

/**
 * Estimate the cohesion of a community as the fraction of neighbour edges
 * that remain internal to the community.
 *
 * Uses sampling (up to 50 members) to keep the computation bounded for large
 * communities.
 */
function calculateCohesion(memberIds: string[], gGraph: GraphInstance): number {
  if (memberIds.length <= 1) return 1.0;

  const memberSet = new Set(memberIds);
  const SAMPLE_SIZE = 50;
  const sample = memberIds.length <= SAMPLE_SIZE ? memberIds : memberIds.slice(0, SAMPLE_SIZE);

  let internalEdges = 0;
  let totalEdges = 0;

  for (const nodeId of sample) {
    if (!gGraph.hasNode(nodeId)) continue;
    gGraph.forEachNeighbor(nodeId, (neighbour: string) => {
      totalEdges++;
      if (memberSet.has(neighbour)) internalEdges++;
    });
  }

  if (totalEdges === 0) return 1.0;
  return Math.min(1.0, internalEdges / totalEdges);
}
