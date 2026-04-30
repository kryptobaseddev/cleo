/**
 * NEXUS symbol impact (blast radius) analysis.
 *
 * Performs a BFS upstream traversal from a named symbol to identify all
 * direct and transitive callers. Returns a risk classification and
 * per-depth node lists. Used by `cleo nexus impact`.
 *
 * @task T1473
 */

import { type EngineResult, engineError, engineSuccess } from '../engine-result.js';
import { getNexusDb, getNexusNativeDb, nexusSchema } from '../store/nexus-sqlite.js';

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
    allRelations = db.select().from(nexusSchema.nexusRelations).all() as Array<
      Record<string, unknown>
    >;
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
      : layer.map(({ nodeId, name, kind, filePath }) => ({
          nodeId,
          name,
          kind,
          filePath,
          reasons: [],
        })),
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

// ---------------------------------------------------------------------------
// EngineResult-returning wrappers (T1569 / ADR-057 / ADR-058)
// ---------------------------------------------------------------------------

/**
 * Analyze impact of changing a symbol (SQL BFS implementation).
 *
 * Runs BFS from the target symbol to find all symbols that would be affected
 * by changes to it, optionally with detailed reasons.
 *
 * @task T1569
 */
// SSoT-EXEMPT:engine-migration-T1569
export async function nexusImpact(
  symbol: string,
  projectId?: string,
  why?: boolean,
): Promise<
  EngineResult<{
    targetNodeId: string | null;
    why: boolean;
    affected: Array<{ nodeId: string; label: string; kind: string; reasons: string[] }>;
    riskLevel: string;
  }>
> {
  try {
    await getNexusDb();
    const db = getNexusNativeDb();

    if (!db) {
      return engineSuccess({
        targetNodeId: null,
        why: why ?? false,
        affected: [],
        riskLevel: 'NONE',
      });
    }

    const allNodes = db
      .prepare(
        `SELECT id, label, kind, file_path, name, project_id
           FROM nexus_nodes
          WHERE project_id = ?
            AND kind NOT IN ('community','process','file','folder')`,
      )
      .all(projectId || '') as Array<{
      id: string;
      label: string | null;
      kind: string | null;
      file_path: string | null;
      name: string | null;
      project_id: string;
    }>;

    const lowerSymbol = symbol.toLowerCase();
    const candidates = allNodes.filter((n) => {
      const haystack = (n.name ?? n.label ?? '').toLowerCase();
      return haystack.length > 0 && haystack.includes(lowerSymbol);
    });

    candidates.sort((a, b) => {
      const an = (a.name ?? a.label ?? '').toLowerCase();
      const bn = (b.name ?? b.label ?? '').toLowerCase();
      const exactA = an === lowerSymbol ? 0 : 1;
      const exactB = bn === lowerSymbol ? 0 : 1;
      if (exactA !== exactB) return exactA - exactB;
      return an.length - bn.length;
    });

    const target = candidates[0];
    if (!target) {
      return engineSuccess({
        targetNodeId: null,
        why: why ?? false,
        affected: [],
        riskLevel: 'NONE',
      });
    }

    const allRelations = db
      .prepare(
        `SELECT source_id, target_id, type, weight
           FROM nexus_relations
          WHERE project_id = ?
            AND type IN ('calls','imports','accesses')`,
      )
      .all(projectId || '') as Array<{
      source_id: string;
      target_id: string;
      type: string;
      weight: number | null;
    }>;

    const reverseAdj = new Map<string, typeof allRelations>();
    for (const rel of allRelations) {
      const list = reverseAdj.get(rel.target_id);
      if (list) {
        list.push(rel);
      } else {
        reverseAdj.set(rel.target_id, [rel]);
      }
    }

    const incomingCount = new Map<string, number>();
    for (const rel of allRelations) {
      incomingCount.set(rel.target_id, (incomingCount.get(rel.target_id) ?? 0) + 1);
    }

    const nodeById = new Map<string, (typeof allNodes)[0]>();
    for (const n of allNodes) {
      nodeById.set(n.id, n);
    }

    const visited = new Set<string>([target.id]);
    const queue: Array<{ id: string; depth: number }> = [{ id: target.id, depth: 0 }];
    const affected: Array<{ nodeId: string; label: string; kind: string; reasons: string[] }> = [];

    while (queue.length > 0) {
      const item = queue.shift();
      if (!item) break;
      if (item.depth >= 3) continue;

      const callers = reverseAdj.get(item.id) ?? [];
      for (const edge of callers) {
        if (visited.has(edge.source_id)) continue;
        visited.add(edge.source_id);
        const depth = item.depth + 1;
        const callerNode = nodeById.get(edge.source_id);
        const reasons: string[] = [];

        if (why) {
          const calls = incomingCount.get(edge.source_id) ?? 0;
          if (calls > 0) {
            reasons.push(`called by ${calls} place${calls === 1 ? '' : 's'}`);
          }
          if (edge.weight != null && edge.weight > 0) {
            reasons.push(`strength=${edge.weight.toFixed(3)} via ${edge.type}`);
          } else {
            reasons.push(`edge type ${edge.type} (weight=0 — no plasticity yet)`);
          }
          reasons.push(`depth=${depth} hop from target ${target.label ?? target.id}`);
        }

        affected.push({
          nodeId: edge.source_id,
          label: callerNode?.label ?? edge.source_id,
          kind: callerNode?.kind ?? 'unknown',
          reasons,
        });

        queue.push({ id: edge.source_id, depth });
      }
    }

    let riskLevel = 'NONE';
    if (affected.length > 0) {
      if (affected.length > 10) {
        riskLevel = 'CRITICAL';
      } else if (affected.length > 5) {
        riskLevel = 'HIGH';
      } else if (affected.length > 2) {
        riskLevel = 'MEDIUM';
      } else {
        riskLevel = 'LOW';
      }
    }

    return engineSuccess({
      targetNodeId: target.id,
      why: why ?? false,
      affected,
      riskLevel,
    });
  } catch (error) {
    return engineError('E_INTERNAL', error instanceof Error ? error.message : String(error));
  }
}
