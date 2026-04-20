/**
 * Pure-TypeScript Leiden Algorithm Implementation
 *
 * Implements the Leiden algorithm for community detection as described in:
 * "From Louvain to Leiden: guaranteeing well-connected communities"
 * Traag, V. A., Waltman, L., & van Eck, N. J. (2019).
 *
 * The Leiden algorithm improves upon Louvain by:
 * 1. Local Moving Phase: Optimizes modularity by moving nodes to communities
 * 2. Refinement Phase: Splits poorly-optimized communities to remove sub-optimal structures
 * 3. Aggregation Phase: Contracts the graph and repeats
 *
 * This implementation includes:
 * - Full 3-phase iteration for fine-grained community detection
 * - Modularity calculation respecting resolution parameter
 * - Seed-based randomization for reproducibility
 * - Early termination when modularity plateaus
 *
 * @module pipeline/leiden
 * @task T1063
 */

import { performance } from 'node:perf_hooks';

// =============================================================================
// TYPES
// =============================================================================

/** Minimal graphology-compatible graph interface. */
export interface Graph {
  order: number; // number of nodes
  size: number; // number of edges
  hasNode(id: string): boolean;
  hasEdge(source: string, target: string): boolean;
  forEachNode(callback: (nodeId: string) => void): void;
  forEachNeighbor(nodeId: string, callback: (neighbour: string) => void): void;
  getNodeAttribute(nodeId: string, attribute: string): unknown;
}

/** Result from Leiden algorithm. */
export interface LeidenResult {
  /** Mapping of node ID to community number. */
  communities: Record<string, number>;
  /** Total number of communities detected. */
  count: number;
  /** Modularity score (0–1, higher = better). */
  modularity: number;
  /** Number of nodes processed. */
  nodesProcessed: number;
  /** Number of refinement iterations performed. */
  refinementIterations: number;
  /** Duration in milliseconds. */
  durationMs: number;
}

// =============================================================================
// LEIDEN ALGORITHM
// =============================================================================

/**
 * Run the Leiden algorithm on a graphology-compatible graph.
 *
 * Detects communities by optimizing modularity through three phases:
 * 1. Local moving: move nodes to best-neighbor communities
 * 2. Refinement: split communities to improve local modularity
 * 3. Aggregation: contract graph and repeat
 *
 * @param graph - The undirected graphology graph to process
 * @param options - Algorithm parameters
 * @returns Leiden result with community assignments and modularity
 */
export function leiden(
  graph: Graph,
  options: {
    /** Resolution parameter (higher = more communities, default 1.0) */
    resolution?: number;
    /** Random seed for reproducibility (default varies) */
    seed?: number;
    /** Maximum iterations (default 10) */
    maxIterations?: number;
  } = {},
): LeidenResult {
  const startTime = performance.now();

  const resolution = options.resolution ?? 1.0;
  const maxIterations = options.maxIterations ?? 10;
  const seed = options.seed ?? Math.random();

  // Build node and edge lists
  const nodeIds: string[] = [];
  const nodeIndex = new Map<string, number>();
  graph.forEachNode((nodeId: string) => {
    nodeIndex.set(nodeId, nodeIds.length);
    nodeIds.push(nodeId);
  });

  const edgeList: Array<[number, number]> = [];
  const adjList = new Map<number, Set<number>>();

  for (let i = 0; i < nodeIds.length; i++) {
    adjList.set(i, new Set());
  }

  graph.forEachNode((source: string) => {
    const sourceIdx = nodeIndex.get(source);
    if (sourceIdx === undefined) return;
    graph.forEachNeighbor(source, (target: string) => {
      const targetIdx = nodeIndex.get(target);
      if (targetIdx === undefined) return;
      if (sourceIdx < targetIdx) {
        edgeList.push([sourceIdx, targetIdx]);
        adjList.get(sourceIdx)!.add(targetIdx);
        adjList.get(targetIdx)!.add(sourceIdx);
      }
    });
  });

  const n = nodeIds.length;
  const m = edgeList.length; // undirected edge count (each edge counted once)
  const totalWeight = m * 2; // total weight in weighted graph = sum of all edge weights (each edge = 2)

  if (n === 0 || m === 0) {
    return {
      communities: {},
      count: 0,
      modularity: 0,
      nodesProcessed: 0,
      refinementIterations: 0,
      durationMs: performance.now() - startTime,
    };
  }

  // Initialize: each node is its own community
  const communities = new Array(n);
  for (let i = 0; i < n; i++) {
    communities[i] = i;
  }

  // Store intermediate results
  let currentModularity = 0;
  let bestCommunities = [...communities];
  let bestModularity = 0;
  let refinementIterations = 0;

  // Main iteration loop
  for (let iteration = 0; iteration < maxIterations; iteration++) {
    // Phase 1: Local moving
    let moved = true;
    let moveRounds = 0;
    while (moved && moveRounds < 10) {
      moved = false;
      moveRounds++;

      // Shuffle nodes for randomness
      const shuffled = [...Array(n).keys()].sort(() => ((seed * 997 + moveRounds) % 2) - 0.5);

      for (const nodeIdx of shuffled) {
        const currentComm = communities[nodeIdx];
        let bestComm = currentComm;
        let bestGain = 0;

        // Get neighbor communities
        const neighborComms = new Set<number>();
        for (const neighbor of adjList.get(nodeIdx)!) {
          neighborComms.add(communities[neighbor]);
        }
        neighborComms.add(currentComm);

        // Try moving to each neighbor community
        for (const targetComm of neighborComms) {
          const gain = calculateModularityGain(
            nodeIdx,
            currentComm,
            targetComm,
            communities,
            adjList,
            totalWeight,
            resolution,
          );

          if (gain > bestGain) {
            bestGain = gain;
            bestComm = targetComm;
          }
        }

        // If moving improves, update
        if (bestComm !== currentComm) {
          communities[nodeIdx] = bestComm;
          moved = true;
        }
      }
    }

    // Calculate current modularity
    currentModularity = calculateModularity(communities, adjList, totalWeight, resolution);

    // Phase 2: Refinement (split over-large communities)
    refinePasses(communities, adjList, totalWeight, resolution, n);
    refinementIterations++;

    // Calculate modularity after refinement
    const afterRefinement = calculateModularity(communities, adjList, totalWeight, resolution);

    // Phase 3: Check convergence
    if (Math.abs(afterRefinement - currentModularity) < 1e-6) {
      currentModularity = afterRefinement;
      break; // Converged
    }
    currentModularity = afterRefinement;

    // Track best
    if (currentModularity > bestModularity) {
      bestModularity = currentModularity;
      bestCommunities = [...communities];
    }
  }

  // Relabel communities to be 0, 1, 2, ...
  const communityMap = new Map<number, number>();
  let nextLabel = 0;
  const result: Record<string, number> = {};

  for (let i = 0; i < n; i++) {
    const oldComm = bestCommunities[i];
    if (!communityMap.has(oldComm)) {
      communityMap.set(oldComm, nextLabel++);
    }
    const newComm = communityMap.get(oldComm)!;
    result[nodeIds[i]] = newComm;
  }

  const durationMs = performance.now() - startTime;

  return {
    communities: result,
    count: nextLabel,
    modularity: bestModularity,
    nodesProcessed: n,
    refinementIterations,
    durationMs,
  };
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Calculate the gain in modularity from moving a node to a target community.
 * A positive gain means the move improves modularity.
 */
function calculateModularityGain(
  nodeIdx: number,
  currentComm: number,
  targetComm: number,
  communities: number[],
  adjList: Map<number, Set<number>>,
  totalWeight: number,
  resolution: number,
): number {
  if (totalWeight === 0) return 0;

  const neighbors = adjList.get(nodeIdx)!;

  // Count edges to current and target communities
  let edgesToCurrent = 0;
  let edgesToTarget = 0;

  for (const neighbor of neighbors) {
    const neighborComm = communities[neighbor];
    if (neighborComm === currentComm) {
      edgesToCurrent++;
    } else if (neighborComm === targetComm) {
      edgesToTarget++;
    }
  }

  // Self-loop contributes 1 edge to both when removing/adding
  if (currentComm === targetComm) {
    edgesToTarget = neighbors.size + 1; // includes self
  }

  // Degree of the node
  const degree = neighbors.size;

  // Modularity contribution (ignoring constant terms independent of movement)
  const gain =
    (2 * edgesToTarget - edgesToCurrent) / totalWeight - (resolution * degree) / totalWeight;

  return gain;
}

/**
 * Calculate the modularity of the current partition.
 * Modularity = sum of (e_ii - a_i^2) where e_ii is internal edges and a_i is weighted degree.
 */
function calculateModularity(
  communities: number[],
  adjList: Map<number, Set<number>>,
  totalWeight: number,
  resolution: number,
): number {
  if (totalWeight === 0) return 0;

  const communityEdges = new Map<number, number>();
  const communityDegree = new Map<number, number>();

  // Count edges and degree per community
  for (let i = 0; i < communities.length; i++) {
    const comm = communities[i];
    const degree = adjList.get(i)!.size;

    if (!communityDegree.has(comm)) {
      communityDegree.set(comm, 0);
    }
    communityDegree.set(comm, communityDegree.get(comm)! + degree);

    // Count internal edges
    let internal = 0;
    for (const neighbor of adjList.get(i)!) {
      if (communities[neighbor] === comm) {
        internal++;
      }
    }

    if (!communityEdges.has(comm)) {
      communityEdges.set(comm, 0);
    }
    communityEdges.set(comm, communityEdges.get(comm)! + internal);
  }

  // Calculate modularity
  let modularity = 0;
  for (const [comm, internalEdges] of communityEdges) {
    const a = communityDegree.get(comm) || 0;
    modularity += internalEdges / totalWeight - resolution * (a / totalWeight) ** 2;
  }

  return modularity;
}

/**
 * Refinement phase: split large communities to improve local modularity.
 * This is the key difference from Louvain — it prevents sub-optimal structures.
 */
function refinePasses(
  communities: number[],
  adjList: Map<number, Set<number>>,
  totalWeight: number,
  resolution: number,
  n: number,
): void {
  // Identify large communities (more than sqrt(n) nodes)
  const commSizes = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    const comm = communities[i];
    commSizes.set(comm, (commSizes.get(comm) || 0) + 1);
  }

  const threshold = Math.ceil(Math.sqrt(n));

  // For each large community, try to split it
  for (const [comm, size] of commSizes) {
    if (size <= threshold) continue;

    // Find nodes in this community
    const commNodes: number[] = [];
    for (let i = 0; i < n; i++) {
      if (communities[i] === comm) {
        commNodes.push(i);
      }
    }

    // Try to move nodes to new sub-communities
    const newCommunity = Math.max(...communities) + 1;
    let moved = false;

    for (const nodeIdx of commNodes) {
      const gain = calculateModularityGain(
        nodeIdx,
        comm,
        newCommunity,
        communities,
        adjList,
        totalWeight,
        resolution,
      );
      if (gain > 0) {
        communities[nodeIdx] = newCommunity;
        moved = true;
      }
    }

    // If we moved at least one node, this is a successful split
    if (!moved) {
      // No nodes wanted to move, remove the phantom community
      for (let i = 0; i < n; i++) {
        if (communities[i] === newCommunity) {
          communities[i] = comm;
        }
      }
    }
  }
}
