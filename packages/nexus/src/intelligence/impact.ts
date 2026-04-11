/**
 * BFS-based impact analysis for the code intelligence graph.
 *
 * Given a target symbol name (or node ID), performs a breadth-first traversal
 * of the graph relations to find all nodes that depend on the target — i.e.,
 * the upstream impact of a change.
 *
 * Results are grouped into three depth tiers that reflect urgency:
 *
 * - **d=1** (`depth1_willBreak`): Direct callers/importers — WILL BREAK.
 * - **d=2** (`depth2_likelyAffected`): Indirect dependants — LIKELY AFFECTED.
 * - **d=3** (`depth3_mayNeedTesting`): Transitive dependants — MAY NEED TESTING.
 *
 * Risk classification follows GitNexus conventions:
 * - `low` — 0–3 direct dependants, no cross-module spread
 * - `medium` — 4–9 direct dependants, or limited cross-module spread
 * - `high` — 10+ direct dependants, or significant cross-module spread
 * - `critical` — exported symbol with high cross-module usage
 *
 * Ported and adapted from GitNexus local-backend impact implementation for
 * CLEO's in-process, graph-in-memory use case (no LadybugDB required).
 *
 * @task T512
 * @module intelligence/impact
 */

import type {
  GraphNode,
  GraphRelation,
  GraphRelationType,
  ImpactResult,
} from '@cleocode/contracts';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/**
 * Options for {@link analyzeImpact}.
 */
export interface ImpactOptions {
  /**
   * Maximum BFS traversal depth.
   * Nodes beyond this depth are not included in results.
   *
   * @default 3
   */
  maxDepth?: number;
  /**
   * Traversal direction:
   * - `upstream` — find nodes that depend on the target (callers, importers)
   * - `downstream` — find nodes that the target depends on (callees, imports)
   *
   * @default "upstream"
   */
  direction?: 'upstream' | 'downstream';
  /**
   * Minimum relation confidence threshold (0.0–1.0).
   * Relations with confidence below this value are excluded from traversal.
   *
   * @default 0
   */
  minConfidence?: number;
  /**
   * Relation types to traverse. When not set, uses the default set:
   * `calls`, `imports`, `extends`, `implements`, `method_overrides`, `method_implements`.
   */
  relationTypes?: GraphRelationType[];
}

// ---------------------------------------------------------------------------
// Risk assessment
// ---------------------------------------------------------------------------

/**
 * Relation types that indicate cross-module usage (IMPORTS between different files).
 * Used to detect cross-module spread for `critical` risk classification.
 */
const CROSS_MODULE_TYPES: ReadonlySet<GraphRelationType> = new Set<GraphRelationType>([
  'imports',
  'extends',
  'implements',
]);

/**
 * Default relation types included in upstream impact traversal.
 */
const DEFAULT_UPSTREAM_TYPES: GraphRelationType[] = [
  'calls',
  'imports',
  'extends',
  'implements',
  'method_overrides',
  'method_implements',
];

/**
 * Classify risk level from the BFS result set.
 *
 * Risk is determined by:
 * 1. The number of direct (d=1) dependants
 * 2. Whether there is significant cross-module spread
 * 3. Whether the target is exported (exported + cross-module → critical)
 *
 * @param targetNode - The analyzed symbol node
 * @param depth1 - Direct dependants (d=1)
 * @param depth2 - Indirect dependants (d=2)
 * @param depth3 - Transitive dependants (d=3)
 * @param relations - All graph relations (used to check cross-module spread)
 * @returns Risk level string
 */
function classifyRisk(
  targetNode: GraphNode,
  depth1: GraphNode[],
  depth2: GraphNode[],
  depth3: GraphNode[],
  relations: GraphRelation[],
): ImpactResult['riskLevel'] {
  const directCount = depth1.length;
  const total = directCount + depth2.length + depth3.length;

  // Check for cross-module usage: relations that cross file boundaries
  const targetFilePath = targetNode.filePath;
  const crossModuleRelations = relations.filter(
    (r) =>
      CROSS_MODULE_TYPES.has(r.type) && r.source !== targetFilePath && r.target !== targetFilePath,
  );
  const crossModuleCount = crossModuleRelations.length;

  // Critical: exported symbol used across many modules
  if (targetNode.exported && crossModuleCount >= 5 && total >= 10) return 'critical';
  if (targetNode.exported && directCount >= 10) return 'critical';

  // High: many direct dependants or significant cross-module spread
  if (directCount >= 10 || (directCount >= 5 && crossModuleCount >= 3)) return 'high';

  // Medium: moderate dependants or some cross-module spread
  if (directCount >= 4 || crossModuleCount >= 2) return 'medium';

  // Low: few or no dependants
  return 'low';
}

/**
 * Compose a human-readable summary of the impact result.
 *
 * @param target - Target symbol name
 * @param riskLevel - Assessed risk level
 * @param depth1Count - Number of direct dependants
 * @param totalCount - Total affected nodes
 * @returns Summary string suitable for display
 */
function composeSummary(
  target: string,
  riskLevel: ImpactResult['riskLevel'],
  depth1Count: number,
  totalCount: number,
): string {
  const riskLabel = riskLevel.toUpperCase();
  if (totalCount === 0) {
    return `${target}: no dependants found — risk ${riskLabel}`;
  }
  return (
    `${target}: ${depth1Count} direct dependant(s), ` +
    `${totalCount} total affected node(s) — risk ${riskLabel}`
  );
}

// ---------------------------------------------------------------------------
// BFS traversal
// ---------------------------------------------------------------------------

/**
 * Build an adjacency map for fast BFS traversal.
 *
 * For upstream analysis (callers): maps target node ID → set of source node IDs.
 * For downstream analysis (callees): maps source node ID → set of target node IDs.
 *
 * @param relations - All graph relations
 * @param allowedTypes - Set of relation types to include
 * @param direction - Traversal direction
 * @param minConfidence - Minimum confidence threshold
 * @returns Map from node ID → adjacent node IDs
 */
function buildAdjacency(
  relations: GraphRelation[],
  allowedTypes: ReadonlySet<GraphRelationType>,
  direction: 'upstream' | 'downstream',
  minConfidence: number,
): Map<string, Set<string>> {
  const adj = new Map<string, Set<string>>();

  for (const rel of relations) {
    if (!allowedTypes.has(rel.type)) continue;
    if (rel.confidence < minConfidence) continue;

    // upstream: follow relations backward (callee → callers)
    // downstream: follow relations forward (caller → callees)
    const from = direction === 'upstream' ? rel.target : rel.source;
    const to = direction === 'upstream' ? rel.source : rel.target;

    let neighbors = adj.get(from);
    if (!neighbors) {
      neighbors = new Set<string>();
      adj.set(from, neighbors);
    }
    neighbors.add(to);
  }

  return adj;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Perform BFS-based impact analysis starting from a target symbol.
 *
 * Finds the target node by name or ID in `nodes`, then traverses the
 * relations graph up to `maxDepth` hops to discover all dependants (upstream)
 * or dependencies (downstream).
 *
 * Results are grouped into three depth tiers matching the GitNexus convention
 * used by the GitNexus CLAUDE.md impact risk table:
 *
 * | Depth | Meaning                     | Action required     |
 * |-------|-----------------------------|---------------------|
 * | d=1   | WILL BREAK — direct callers | MUST update         |
 * | d=2   | LIKELY AFFECTED             | Should test         |
 * | d=3   | MAY NEED TESTING            | Test if critical    |
 *
 * @param target - Symbol name or node ID to analyze (matched by `name` first,
 *   then by `id` if no name match is found)
 * @param nodes - All graph nodes in the codebase
 * @param relations - All graph relations in the codebase
 * @param options - Optional BFS configuration
 * @returns Structured impact result with depth-grouped nodes and risk level,
 *   or an impact result with empty arrays if the target is not found
 */
export function analyzeImpact(
  target: string,
  nodes: GraphNode[],
  relations: GraphRelation[],
  options?: ImpactOptions,
): ImpactResult {
  const maxDepth = options?.maxDepth ?? 3;
  const direction = options?.direction ?? 'upstream';
  const minConfidence = options?.minConfidence ?? 0;
  const allowedTypes: ReadonlySet<GraphRelationType> = options?.relationTypes
    ? new Set(options.relationTypes)
    : new Set<GraphRelationType>(DEFAULT_UPSTREAM_TYPES);

  // Build a fast lookup map for nodes
  const nodeById = new Map<string, GraphNode>();
  const nodeByName = new Map<string, GraphNode>();
  for (const node of nodes) {
    nodeById.set(node.id, node);
    // First occurrence wins for name lookup (class beats method of same name)
    if (!nodeByName.has(node.name)) {
      nodeByName.set(node.name, node);
    }
  }

  // Resolve target — name first, then ID
  const targetNode = nodeByName.get(target) ?? nodeById.get(target);

  // Return a zero-impact result if the target is not found
  if (!targetNode) {
    return {
      target,
      riskLevel: 'low',
      summary: `${target}: not found in graph`,
      affectedByDepth: {
        depth1_willBreak: [],
        depth2_likelyAffected: [],
        depth3_mayNeedTesting: [],
      },
      totalAffected: 0,
    };
  }

  // Build adjacency map for BFS
  const adj = buildAdjacency(relations, allowedTypes, direction, minConfidence);

  // BFS traversal — collect nodes by depth
  const visited = new Set<string>([targetNode.id]);
  const depth1: GraphNode[] = [];
  const depth2: GraphNode[] = [];
  const depth3: GraphNode[] = [];

  let frontier: string[] = [targetNode.id];

  for (let depth = 1; depth <= Math.min(maxDepth, 3); depth++) {
    const nextFrontier: string[] = [];

    for (const nodeId of frontier) {
      const neighbors = adj.get(nodeId);
      if (!neighbors) continue;

      for (const neighborId of neighbors) {
        if (visited.has(neighborId)) continue;
        visited.add(neighborId);

        const neighborNode = nodeById.get(neighborId);
        if (!neighborNode) continue;

        nextFrontier.push(neighborId);

        if (depth === 1) depth1.push(neighborNode);
        else if (depth === 2) depth2.push(neighborNode);
        else if (depth === 3) depth3.push(neighborNode);
      }
    }

    frontier = nextFrontier;
    if (frontier.length === 0) break;
  }

  const totalAffected = depth1.length + depth2.length + depth3.length;
  const riskLevel = classifyRisk(targetNode, depth1, depth2, depth3, relations);
  const summary = composeSummary(target, riskLevel, depth1.length, totalAffected);

  return {
    target,
    riskLevel,
    summary,
    affectedByDepth: {
      depth1_willBreak: depth1,
      depth2_likelyAffected: depth2,
      depth3_mayNeedTesting: depth3,
    },
    totalAffected,
  };
}
