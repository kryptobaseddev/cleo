/**
 * RPTree — Random Projection Tree for hierarchical memory clustering
 *
 * Implements a simplified Random Projection Tree (RPTree) that partitions
 * a set of observation embeddings into a hierarchical cluster structure.
 * Each leaf node contains a group of semantically-similar observations.
 *
 * Algorithm:
 *   1. Generate a random projection vector
 *   2. Compute dot products of all embeddings with the projection
 *   3. Split at the median (left = below, right = above)
 *   4. Recurse until min_leaf_size or max_depth is reached
 *
 * Trees are rebuilt each dream cycle (brain_memory_trees table is truncated
 * and repopulated). This is intentional — trees are a cache, not a source
 * of truth.
 *
 * Persistence: tree nodes are written to brain_memory_trees. The leaf node
 * id is written back to brain_observations.tree_id.
 *
 * @task T1146
 * @epic T1146
 */

import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { getBrainNativeDb } from '../store/memory-sqlite.js';

// ============================================================================
// Constants
// ============================================================================

/** Maximum tree depth. Prevents infinite recursion on tiny datasets. */
const MAX_DEPTH = 8;

/** Minimum leaf size: stop splitting when a node has this many obs or fewer. */
const MIN_LEAF_SIZE = 3;

/** Embedding dimension. Matches CLEO brain embeddings (OpenAI/Anthropic = 1536 or 768). */
const DEFAULT_EMBEDDING_DIM = 1536;

// ============================================================================
// Types
// ============================================================================>

/** An observation with its embedding for tree construction. */
export interface ObservationForTree {
  id: string;
  embedding: number[];
}

/** A single RPTree node (internal or leaf). */
export interface RPTreeNode {
  /** Internal id (assigned after persistence). */
  dbId?: number;
  /** Depth in the tree (0 = root). */
  depth: number;
  /** Observation IDs in this leaf. Empty for internal nodes. */
  leafIds: string[];
  /** Centroid vector (average of all embeddings in this node's subtree). */
  centroid: number[] | null;
  /** Parent node's dbId. Null for root. */
  parentDbId: number | null;
  /** Child nodes (in-memory only; not stored as rows). */
  children: RPTreeNode[];
}

/** Options for {@link buildSurprisalTree}. */
export interface BuildTreeOptions {
  /** Max depth. Default {@link MAX_DEPTH}. */
  maxDepth?: number;
  /** Min leaf size. Default {@link MIN_LEAF_SIZE}. */
  minLeafSize?: number;
  /** Inject a DatabaseSync for testing. */
  db?: DatabaseSync | null;
}

/** Result of a tree build. */
export interface BuildTreeResult {
  /** Number of tree nodes written to brain_memory_trees. */
  nodesWritten: number;
  /** Number of brain_observations.tree_id values updated. */
  obsAssigned: number;
  /** Max depth actually reached. */
  actualMaxDepth: number;
}

// ============================================================================
// Helpers
// ============================================================================

/** Generate a random unit vector of dimension `dim`. */
function randomProjectionVector(dim: number): number[] {
  const buf = randomBytes(dim * 4);
  const floats = new Float32Array(buf.buffer);
  // Standard normal approximation via Box-Muller
  const result: number[] = [];
  let norm = 0;
  for (let i = 0; i < dim; i++) {
    const v = floats[i] ?? 0;
    // Map [0,1) uniform → normal using inverse CDF approx
    const normal = v * 2 - 1; // rough uniform → [-1, 1]
    result.push(normal);
    norm += normal * normal;
  }
  const normSqrt = Math.sqrt(norm) || 1;
  return result.map((v) => v / normSqrt);
}

/** Dot product of two equal-length arrays. */
function dotProduct(a: number[], b: number[]): number {
  let sum = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    sum += (a[i] ?? 0) * (b[i] ?? 0);
  }
  return sum;
}

/** Compute centroid (mean) of a set of embeddings. */
function computeCentroid(embeddings: number[][]): number[] | null {
  if (embeddings.length === 0) return null;
  const dim = embeddings[0]?.length ?? 0;
  const centroid = new Array<number>(dim).fill(0);
  for (const emb of embeddings) {
    for (let i = 0; i < dim; i++) {
      centroid[i] = (centroid[i] ?? 0) + (emb[i] ?? 0);
    }
  }
  return centroid.map((v) => v / embeddings.length);
}

// ============================================================================
// Tree construction
// ============================================================================

/**
 * Recursively build an RPTree node for the given subset of observations.
 */
function buildNode(
  observations: ObservationForTree[],
  depth: number,
  parentDbId: number | null,
  maxDepth: number,
  minLeafSize: number,
): RPTreeNode {
  const embeddings = observations.map((o) => o.embedding);
  const centroid = computeCentroid(embeddings);

  // Base case: leaf node (too few observations or at max depth)
  if (observations.length <= minLeafSize || depth >= maxDepth) {
    return {
      depth,
      leafIds: observations.map((o) => o.id),
      centroid,
      parentDbId,
      children: [],
    };
  }

  // Split: random projection
  const dim = embeddings[0]?.length ?? DEFAULT_EMBEDDING_DIM;
  const projVector = randomProjectionVector(dim);

  // Project all embeddings
  const projected = observations.map((obs) => ({
    obs,
    proj: dotProduct(obs.embedding, projVector),
  }));

  // Find median split
  const projValues = projected.map((p) => p.proj).sort((a, b) => a - b);
  const medianIdx = Math.floor(projValues.length / 2);
  const median = projValues[medianIdx] ?? 0;

  const left = projected.filter((p) => p.proj <= median).map((p) => p.obs);
  const right = projected.filter((p) => p.proj > median).map((p) => p.obs);

  // Avoid degenerate splits (all observations on one side)
  if (left.length === 0 || right.length === 0) {
    return {
      depth,
      leafIds: observations.map((o) => o.id),
      centroid,
      parentDbId,
      children: [],
    };
  }

  // Internal node: recurse
  const leftChild = buildNode(
    left,
    depth + 1,
    null /* parentDbId set after persist */,
    maxDepth,
    minLeafSize,
  );
  const rightChild = buildNode(right, depth + 1, null, maxDepth, minLeafSize);

  return {
    depth,
    leafIds: [], // internal node has no direct observations
    centroid,
    parentDbId,
    children: [leftChild, rightChild],
  };
}

/**
 * Persist a tree node to the database and return its assigned id.
 * Recursively persists children, updating their parentDbId.
 */
function persistNode(node: RPTreeNode, nativeDb: DatabaseSync, parentDbId: number | null): number {
  const centroidJson = node.centroid ? JSON.stringify(node.centroid) : null;
  const leafIdsJson = JSON.stringify(node.leafIds);
  const now = new Date().toISOString();

  const result = nativeDb
    .prepare(
      `INSERT INTO brain_memory_trees (depth, leaf_ids, centroid, parent_id, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(node.depth, leafIdsJson, centroidJson, parentDbId, now);

  const nodeId = Number(result.lastInsertRowid);

  // Persist children with this node as parent
  for (const child of node.children) {
    persistNode(child, nativeDb, nodeId);
  }

  return nodeId;
}

/**
 * Collect all leaf nodes and their observation IDs for brain_observations update.
 */
function collectLeafAssignments(
  node: RPTreeNode,
  nodeId: number,
  nativeDb: DatabaseSync,
  assignments: Map<string, number>,
): void {
  if (node.leafIds.length > 0) {
    // This is a leaf node — record the dbId for each observation
    for (const obsId of node.leafIds) {
      assignments.set(obsId, nodeId);
    }
  }

  // For children, we need to get their actual DB ids
  // Since we persist depth-first, we can query by parent_id + depth
  if (node.children.length > 0) {
    const children = nativeDb
      .prepare(`SELECT id, leaf_ids FROM brain_memory_trees WHERE parent_id = ?`)
      .all(nodeId) as { id: number; leaf_ids: string }[];

    for (const childRow of children) {
      const childLeafIds: string[] = JSON.parse(childRow.leaf_ids);
      if (childLeafIds.length > 0) {
        for (const obsId of childLeafIds) {
          assignments.set(obsId, childRow.id);
        }
      }
      // Recurse via DB (simple approach for non-deep trees)
    }
  }
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Build a Random Projection Tree from a set of observations and persist it
 * to brain_memory_trees. Updates brain_observations.tree_id for all leaf members.
 *
 * Truncates existing brain_memory_trees rows before writing (trees are
 * rebuilt each dream cycle from scratch).
 *
 * Requires at least 2 observations. Returns early with zero counts if fewer
 * are provided.
 *
 * @param observations - Set of observations with embeddings to cluster.
 * @param options      - Depth/leaf config, db injection for tests.
 * @returns Build result with node/assignment counts.
 *
 * @task T1146
 */
export function buildSurprisalTree(
  observations: ObservationForTree[],
  options: BuildTreeOptions = {},
): BuildTreeResult {
  const { maxDepth = MAX_DEPTH, minLeafSize = MIN_LEAF_SIZE, db: injectedDb } = options;

  const result: BuildTreeResult = {
    nodesWritten: 0,
    obsAssigned: 0,
    actualMaxDepth: 0,
  };

  // Filter to observations that actually have embeddings
  const eligible = observations.filter((o) => o.embedding.length > 0);

  if (eligible.length < 2) {
    return result;
  }

  const nativeDb = injectedDb !== undefined ? injectedDb : getBrainNativeDb();
  if (!nativeDb) {
    console.warn('[surprisal-tree] No database available; skipping tree build.');
    return result;
  }

  try {
    // Truncate existing tree (trees are rebuilt each cycle)
    nativeDb.exec('DELETE FROM brain_memory_trees');

    // Build tree in memory
    const rootNode = buildNode(eligible, 0, null, maxDepth, minLeafSize);

    // Persist root (recursively persists children)
    const rootId = persistNode(rootNode, nativeDb, null);

    // Count persisted nodes
    const nodeCountRow = nativeDb.prepare('SELECT COUNT(*) AS cnt FROM brain_memory_trees').get() as
      | { cnt: number }
      | undefined;
    result.nodesWritten = nodeCountRow?.cnt ?? 0;

    // Determine actual max depth
    const maxDepthRow = nativeDb
      .prepare('SELECT MAX(depth) AS maxd FROM brain_memory_trees')
      .get() as { maxd: number | null } | undefined;
    result.actualMaxDepth = maxDepthRow?.maxd ?? 0;

    // Collect leaf assignments
    const assignments = new Map<string, number>();
    collectLeafAssignments(rootNode, rootId, nativeDb, assignments);

    // Also query leaf nodes directly for safety
    const leafRows = nativeDb
      .prepare(`SELECT id, leaf_ids FROM brain_memory_trees WHERE leaf_ids != '[]'`)
      .all() as { id: number; leaf_ids: string }[];

    for (const leafRow of leafRows) {
      const leafIds: string[] = JSON.parse(leafRow.leaf_ids);
      for (const obsId of leafIds) {
        assignments.set(obsId, leafRow.id);
      }
    }

    // Update brain_observations.tree_id
    for (const [obsId, treeNodeId] of assignments) {
      nativeDb
        .prepare('UPDATE brain_observations SET tree_id = ? WHERE id = ?')
        .run(treeNodeId, obsId);
      result.obsAssigned++;
    }

    return result;
  } catch (err) {
    console.warn('[surprisal-tree] Error building tree:', err);
    return result;
  }
}
