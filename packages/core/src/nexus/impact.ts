/**
 * NEXUS symbol impact (blast radius) analysis.
 *
 * Performs a BFS upstream traversal from a named symbol to identify all
 * direct and transitive callers. Returns a risk classification and
 * per-depth node lists. Used by `cleo nexus impact`.
 *
 * @task T1473
 */

import type {
  NexusImpactResult as ImpactOperationResult,
  KnowledgeCoverage,
  RiskTier,
} from '@cleocode/contracts';
import { eq, notInArray } from 'drizzle-orm';
import { type EngineResult, engineError, engineSuccess } from '../engine-result.js';
import { getNexusDb, nexusSchema } from '../store/nexus-sqlite.js';
import {
  assessKnowledgeCoverage,
  KnowledgeSymbolAmbiguityError,
  recordKnowledgeGap,
  resolveKnowledgeSymbol,
} from './knowledge.js';

/** Risk level classification for an impacted symbol. */
export type NexusRiskLevel = RiskTier;

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
  /** Coverage assessed independently of detected impact. */
  coverage: KnowledgeCoverage;
  /** Project ID. */
  projectId: string;
  /** ID of the target node analyzed. */
  targetNodeId: string | null;
  /** Name of the target node. */
  targetName: string | null;
  /** Kind of the target node. */
  targetKind: string | null;
  /** File path of the target node. */
  targetFilePath: string | null;
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
 * Missing coverage returns UNKNOWN; ambiguous names return qualified candidates.
 *
 * @param symbolName - Symbol name to analyse (partial match).
 * @param projectId  - Nexus project ID.
 * @param repoPath   - Absolute repository root path used for freshness checks.
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
  repoPath: string,
  opts: NexusImpactOptions = {},
): Promise<NexusImpactResult> {
  const maxDepth = Math.max(
    1,
    Math.min(Number.isFinite(opts.maxDepth) ? (opts.maxDepth ?? 3) : 3, 5),
  );
  const whyFlag = opts.why ?? false;
  const coverage = await assessKnowledgeCoverage(repoPath, projectId);
  const emptyResult: NexusImpactResult = {
    query: symbolName,
    projectId,
    coverage,
    targetNodeId: null,
    targetName: null,
    targetKind: null,
    targetFilePath: null,
    riskLevel: 'UNKNOWN',
    totalImpactedNodes: 0,
    maxDepth,
    why: whyFlag,
    impactByDepth: [],
  };
  if (coverage.status === 'failed' || coverage.status === 'missing') return emptyResult;
  const db = await getNexusDb(repoPath);
  const projectSymbolNodes = db
    .select()
    .from(nexusSchema.nexusNodes)
    .where(notInArray(nexusSchema.nexusNodes.kind, ['community', 'process']))
    .all();
  const targetNode = resolveKnowledgeSymbol(symbolName, projectSymbolNodes);
  if (!targetNode) {
    recordKnowledgeGap(coverage, 'missing', `No indexed symbol matches '${symbolName}'.`);
    return emptyResult;
  }
  const joined = db
    .select()
    .from(nexusSchema.nexusRelations)
    .leftJoin(
      nexusSchema.nexusRelationWeights,
      eq(nexusSchema.nexusRelationWeights.relationId, nexusSchema.nexusRelations.id),
    )
    .all();
  const allRelations = joined.map((row) => ({
    ...row.nexus_relations,
    weight: row.nexus_relation_weights?.weight ?? null,
  }));
  const nodeById = new Map(projectSymbolNodes.map((node) => [node.id, node]));
  const targetId = targetNode.id;
  const targetLabel = targetNode.name ?? targetNode.label;

  // Build reverse adjacency: targetId → [{ sourceId, type, weight }]
  const reverseAdj = new Map<
    string,
    Array<{ sourceId: string; type: string; weight: number | null }>
  >();
  const incomingCount = new Map<string, number>();
  for (const r of allRelations) {
    if (r['type'] === 'calls' || r['type'] === 'imports' || r['type'] === 'accesses') {
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
    coverage.status !== 'current'
      ? 'UNKNOWN'
      : totalImpact === 0
        ? 'NONE'
        : totalImpact <= 3
          ? 'LOW'
          : totalImpact <= 10
            ? 'MEDIUM'
            : totalImpact <= 25
              ? 'HIGH'
              : 'CRITICAL';

  const depthLabels = [
    'DIRECT CALLERS (potentially affected)',
    'LIKELY AFFECTED',
    'MAY NEED TESTING',
  ];
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
    coverage,
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
export async function nexusImpact(
  symbol: string,
  projectId?: string,
  why?: boolean,
  maxDepth?: number,
  projectRoot = process.cwd(),
): Promise<EngineResult<ImpactOperationResult>> {
  try {
    const coverage = await assessKnowledgeCoverage(projectRoot, projectId);
    const impact = await getSymbolImpact(symbol, coverage.projectId, projectRoot, {
      why,
      maxDepth,
    });
    return engineSuccess({
      query: symbol,
      projectId: impact.projectId,
      coverage: impact.coverage,
      targetNodeId: impact.targetNodeId,
      targetLabel: impact.targetName,
      why: impact.why,
      riskLevel: impact.riskLevel,
      totalImpact: impact.totalImpactedNodes,
      maxDepth: impact.maxDepth,
      affected: impact.impactByDepth.flatMap((layer) =>
        layer.nodes.map((node) => ({
          nodeId: node.nodeId,
          label: node.name,
          kind: node.kind,
          filePath: node.filePath,
          depth: layer.depth,
          reasons: node.reasons,
        })),
      ),
    });
  } catch (error) {
    if (error instanceof KnowledgeSymbolAmbiguityError) {
      return engineError(error.code, error.message, { details: { candidates: error.candidates } });
    }
    return engineError('E_INTERNAL', error instanceof Error ? error.message : String(error));
  }
}
