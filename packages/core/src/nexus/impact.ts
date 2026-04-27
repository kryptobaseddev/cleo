/**
 * NEXUS symbol impact (blast radius) analysis.
 *
 * Performs a BFS upstream traversal from a named symbol to identify all
 * direct and transitive callers. Returns a risk classification and
 * per-depth node lists. Used by `cleo nexus impact`.
 *
 * @task T1473
 */

import { getNexusDb, nexusSchema } from '../store/nexus-sqlite.js';

/** Risk level classification for an impacted symbol. */
export type NexusRiskLevel = 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

/** A single impacted node at a given BFS depth. */
export interface NexusImpactNode {
  /** Node ID. */
  nodeId: string;
  /** Symbol name. */
  name: string;
  /** Node kind. */
  kind: string;
  /** Relative file path, or null. */
  filePath: string | null;
  /** Reason strings (populated when opts.why is true). */
  reasons: string[];
}

/** One BFS depth layer. */
export interface NexusImpactLayer {
  /** BFS depth (1 = direct callers, 2 = indirect, 3 = transitive). */
  depth: number;
  /** Human-readable depth label. */
  label: string;
  /** Impacted nodes at this depth. */
  nodes: NexusImpactNode[];
}

/** Options for {@link getSymbolImpact}. */
export interface NexusImpactOptions {
  /** Maximum BFS traversal depth (default: 3, max: 5). */
  maxDepth?: number;
  /** When true, populate `reasons` on each node. */
  why?: boolean;
}

/** Result envelope for {@link getSymbolImpact}. */
export interface NexusImpactResult {
  /** Original symbol query. */
  query: string;
  /** Project ID. */
  projectId: string;
  /** ID of the target node analyzed. */
  targetNodeId: string;
  /** Name of the target node. */
  targetName: unknown;
  /** Kind of the target node. */
  targetKind: unknown;
  /** File path of the target node. */
  targetFilePath: unknown;
  /** Risk level classification. */
  riskLevel: NexusRiskLevel;
  /** Total impacted nodes (all depths). */
  totalImpactedNodes: number;
  /** Maximum depth used for the traversal. */
  maxDepth: number;
  /** Whether why-reasons are populated. */
  why: boolean;
  /** Per-depth layer results. */
  impactByDepth: NexusImpactLayer[];
}

/**
 * Analyse the blast radius for a named code symbol via BFS upstream traversal.
 *
 * Loads all nodes and relations from the nexus DB, builds a reverse adjacency
 * map (calls/imports/accesses edges pointing TO the target), and traverses
 * breadth-first up to `maxDepth` levels. Returns per-depth layers with risk
 * classification.
 *
 * Throws with code `E_NOT_FOUND` when no symbol matches the query.
 *
 * @param symbolName - Symbol name to analyse (partial match).
 * @param projectId  - Nexus project ID.
 * @param _repoPath  - Absolute repository root path (reserved for future use).
 * @param opts       - Traversal options.
 * @returns Impact analysis result.
 *
 * @example
 * const impact = await getSymbolImpact('dispatchFromCli', projectId, repoPath);
 * console.log(impact.riskLevel, impact.totalImpactedNodes);
 */
export async function getSymbolImpact(
  symbolName: string,
  projectId: string,
  _repoPath: string,
  opts: NexusImpactOptions = {},
): Promise<NexusImpactResult> {
  const maxDepth = Math.min(opts.maxDepth ?? 3, 5);
  const whyFlag = opts.why ?? false;

  const { sortMatchingNodes } = await import('./symbol-ranking.js');
  const db = await getNexusDb();

  let allNodes: Array<Record<string, unknown>> = [];
  try {
    allNodes = db.select().from(nexusSchema.nexusNodes).all() as Array<Record<string, unknown>>;
  } catch {
    allNodes = [];
  }

  const lowerSymbol = symbolName.toLowerCase();
  const rawMatchingNodes = allNodes.filter(
    (n) =>
      n['projectId'] === projectId &&
      n['name'] != null &&
      String(n['name']).toLowerCase().includes(lowerSymbol) &&
      n['kind'] !== 'community' &&
      n['kind'] !== 'process',
  );
  const matchingNodes = sortMatchingNodes(rawMatchingNodes, symbolName);

  if (matchingNodes.length === 0) {
    const err = new Error(`No symbol found matching '${symbolName}' in project ${projectId}`);
    (err as NodeJS.ErrnoException).code = 'E_NOT_FOUND';
    throw err;
  }

  let allRelations: Array<Record<string, unknown>> = [];
  try {
    allRelations = db
      .select()
      .from(nexusSchema.nexusRelations)
      .all() as Array<Record<string, unknown>>;
  } catch {
    allRelations = [];
  }

  const nodeById = new Map<string, Record<string, unknown>>();
  for (const n of allNodes) {
    nodeById.set(String(n['id']), n);
  }

  const targetNode = matchingNodes[0];
  const targetId = String(targetNode['id']);
  const targetLabel = String(targetNode['name'] ?? targetNode['label'] ?? targetId);

  // Build reverse adjacency: targetId → [{ sourceId, type, weight }]
  const reverseAdj = new Map<
    string,
    Array<{ sourceId: string; type: string; weight: number | null }>
  >();
  const incomingCount = new Map<string, number>();
  for (const r of allRelations) {
    if (
      r['projectId'] === projectId &&
      (r['type'] === 'calls' || r['type'] === 'imports' || r['type'] === 'accesses')
    ) {
      const tid = String(r['targetId']);
      const sid = String(r['sourceId']);
      const typ = String(r['type']);
      const wRaw = r['weight'];
      const weight = typeof wRaw === 'number' ? wRaw : wRaw != null ? Number(wRaw) : null;
      if (!reverseAdj.has(tid)) reverseAdj.set(tid, []);
      reverseAdj.get(tid)!.push({ sourceId: sid, type: typ, weight });
      incomingCount.set(tid, (incomingCount.get(tid) ?? 0) + 1);
    }
  }

  // BFS traversal
  const visited = new Set<string>([targetId]);
  const queue: Array<{ id: string; depth: number }> = [{ id: targetId, depth: 0 }];
  const impactByDepth: NexusImpactNode[][] = [];

  while (queue.length > 0) {
    const item = queue.shift()!;
    if (item.depth >= maxDepth) continue;

    const callers = reverseAdj.get(item.id) ?? [];
    for (const edge of callers) {
      const callerId = edge.sourceId;
      if (visited.has(callerId)) continue;
      visited.add(callerId);
      const depth = item.depth + 1;
      const callerNode = nodeById.get(callerId);
      const reasons: string[] = [];
      if (whyFlag) {
        const calls = incomingCount.get(callerId) ?? 0;
        if (calls > 0) {
          reasons.push(`called by ${calls} place${calls === 1 ? '' : 's'}`);
        }
        if (edge.weight != null && edge.weight > 0) {
          reasons.push(`strength=${edge.weight.toFixed(3)} via ${edge.type}`);
        } else {
          reasons.push(`edge type ${edge.type} (weight=0 — no plasticity yet)`);
        }
        reasons.push(`depth=${depth} hop from target ${targetLabel}`);
      }
      if (!impactByDepth[depth - 1]) impactByDepth[depth - 1] = [];
      impactByDepth[depth - 1].push({
        nodeId: callerId,
        name: String(callerNode?.['name'] ?? callerId),
        kind: String(callerNode?.['kind'] ?? 'unknown'),
        filePath: callerNode?.['filePath'] ? String(callerNode['filePath']) : null,
        reasons,
      });
      queue.push({ id: callerId, depth });
    }
  }

  const totalImpact = visited.size - 1;
  const riskLevel: NexusRiskLevel =
    totalImpact === 0
      ? 'NONE'
      : totalImpact <= 3
        ? 'LOW'
        : totalImpact <= 10
          ? 'MEDIUM'
          : totalImpact <= 25
            ? 'HIGH'
            : 'CRITICAL';

  const depthLabels = ['WILL BREAK (direct callers)', 'LIKELY AFFECTED', 'MAY NEED TESTING'];
  const layers: NexusImpactLayer[] = impactByDepth.map((layer, i) => ({
    depth: i + 1,
    label: depthLabels[i] ?? `depth ${i + 1}`,
    nodes: whyFlag
      ? layer
      : layer.map(({ nodeId, name, kind, filePath }) => ({ nodeId, name, kind, filePath, reasons: [] })),
  }));

  return {
    query: symbolName,
    projectId,
    targetNodeId: targetId,
    targetName: targetNode['name'],
    targetKind: targetNode['kind'],
    targetFilePath: targetNode['filePath'],
    riskLevel,
    totalImpactedNodes: totalImpact,
    maxDepth,
    why: whyFlag,
    impactByDepth: layers,
  };
}
