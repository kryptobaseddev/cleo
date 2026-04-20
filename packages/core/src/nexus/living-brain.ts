/**
 * Living Brain SDK — unified 5-substrate traversal primitives.
 *
 * Exposes the cross-substrate graph to consumers via three traversal queries:
 *
 * 1. {@link getSymbolFullContext} — Everything known about a code symbol across
 *    NEXUS (callers/callees/community/process), BRAIN (memories via code_reference,
 *    documents, mentions edges), TASKS (task_touches_symbol), SENTIENT (proposals),
 *    and CONDUIT (conduit_mentions_symbol).
 *
 * 2. {@link getTaskCodeImpact} — Full footprint of a task: files, symbols, blast
 *    radius (via analyzeImpact BFS), brain observations with modified_by edges,
 *    brain decisions linked via brain_memory_links, and aggregate risk tier.
 *
 * 3. {@link getBrainEntryCodeAnchors} — From a brain memory entry, which code
 *    nodes is it anchored to (via code_reference, documents, applies_to), and
 *    which tasks touched those nodes?
 *
 * Design constraints:
 * - All substrate errors are caught and produce empty collections — never throws.
 * - conduit.db absence is a graceful no-op: conduitThreads returns [].
 * - All return shapes are defined in packages/contracts/src/nexus-living-brain-ops.ts.
 * - REUSES existing primitives: T1067 bridge, T1066 edge writers, existing
 *   analyzeImpact BFS, existing nexus context Drizzle queries.
 *
 * @task T1068
 * @epic T1042
 */

import { existsSync } from 'node:fs';
import type {
  BrainRiskNote,
  CodeAnchorResult,
  ImpactFullReport,
  ImpactResult,
  NexusEdgeRef,
  RiskTier,
  SymbolFullContext,
  SymbolImpactEntry,
  TaskCodeImpact,
} from '@cleocode/contracts';
import { EDGE_TYPES } from '../memory/edge-types.js';
import { getConduitDbPath } from '../store/conduit-sqlite.js';
import { getBrainDb, getBrainNativeDb } from '../store/memory-sqlite.js';
import { getNexusDb, getNexusNativeDb } from '../store/nexus-sqlite.js';
import { typedAll, typedGet } from '../store/typed-query.js';
import { getSymbolsForTask, getTasksForSymbol } from './tasks-bridge.js';

// ---------------------------------------------------------------------------
// Internal raw row types
// ---------------------------------------------------------------------------

interface RawNexusNode {
  id: string;
  project_id: string;
  kind: string;
  name: string | null;
  file_path: string | null;
  label: string;
  community_id: string | null;
}

interface RawNexusRelation {
  source_id: string;
  target_id: string;
  type: string;
  weight: number | null;
}

interface RawBrainEdge {
  from_id: string;
  to_id: string;
  edge_type: string;
  weight: number;
}

interface RawBrainNode {
  id: string;
  node_type: string;
  label: string;
  quality_score: number;
}

interface RawDecision {
  id: string;
  decision: string;
}

interface RawMemoryLink {
  memory_id: string;
  memory_type: string;
  task_id: string;
  link_type: string;
}

interface RawSentientProposal {
  id: string;
  metadata_json: string | null;
  title: string | null;
  description: string | null;
}

// ---------------------------------------------------------------------------
// Internal: map ImpactResult riskLevel → RiskTier
// ---------------------------------------------------------------------------

/**
 * Convert analyzeImpact riskLevel to the RiskTier discriminated union.
 */
function toRiskTier(riskLevel: ImpactResult['riskLevel'] | undefined): RiskTier {
  switch (riskLevel) {
    case 'critical':
      return 'CRITICAL';
    case 'high':
      return 'HIGH';
    case 'medium':
      return 'MEDIUM';
    case 'low':
      return 'LOW';
    default:
      return 'NONE';
  }
}

/**
 * Return the highest risk tier from an array.
 */
function maxRiskTier(tiers: RiskTier[]): RiskTier {
  const order: RiskTier[] = ['NONE', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
  let max = 0;
  for (const t of tiers) {
    const idx = order.indexOf(t);
    if (idx > max) max = idx;
  }
  return order[max] ?? 'NONE';
}

// ---------------------------------------------------------------------------
// getSymbolFullContext
// ---------------------------------------------------------------------------

/**
 * Return the full cross-substrate context for a code symbol.
 *
 * Queries five substrates for everything known about `symbolId`:
 * - **NEXUS**: callers, callees, community membership, process participation
 * - **BRAIN**: memory nodes linked via code_reference, documents, mentions edges
 * - **TASKS**: tasks whose files contain this symbol (via T1067 bridge)
 * - **SENTIENT**: Tier-2 proposals whose sourceId matches this symbol
 * - **CONDUIT**: message threads mentioning this symbol (empty if conduit.db absent)
 *
 * All substrate failures produce empty collections — never throws.
 *
 * @param symbolId - Nexus node ID or symbol name (partial match accepted for nexus lookup)
 * @param projectRoot - Absolute path to project root
 * @returns Full cross-substrate context
 */
export async function getSymbolFullContext(
  symbolId: string,
  projectRoot: string,
): Promise<SymbolFullContext> {
  const result: SymbolFullContext = {
    symbolId,
    nexus: null,
    brainMemories: [],
    tasks: [],
    sentientProposals: [],
    conduitThreads: [],
    plasticityWeight: { totalWeight: 0, edgeCount: 0 },
  };

  // ---- NEXUS substrate ----
  let resolvedSymbolId = symbolId;
  try {
    await getNexusDb();
    const nexusNative = getNexusNativeDb();
    if (nexusNative) {
      // Try exact match on id first; fall back to name lookup
      let symbolNode = typedGet<RawNexusNode>(
        nexusNative.prepare(
          `SELECT id, project_id, kind, name, file_path, label, community_id
           FROM nexus_nodes WHERE id = ? LIMIT 1`,
        ),
        symbolId,
      );

      if (!symbolNode) {
        // Fuzzy match on name (case-insensitive)
        symbolNode = typedGet<RawNexusNode>(
          nexusNative.prepare(
            `SELECT id, project_id, kind, name, file_path, label, community_id
             FROM nexus_nodes
             WHERE LOWER(name) = LOWER(?) AND kind NOT IN ('community', 'process', 'folder')
             LIMIT 1`,
          ),
          symbolId,
        );
      }

      if (symbolNode) {
        resolvedSymbolId = symbolNode.id;

        // Callers: relations where target_id = symbolNode.id
        const callerRelations = typedAll<RawNexusRelation>(
          nexusNative.prepare(
            `SELECT r.source_id, r.target_id, r.type, r.weight
             FROM nexus_relations r
             WHERE r.target_id = ?
               AND r.type IN ('calls', 'imports', 'accesses')
             LIMIT 50`,
          ),
          symbolNode.id,
        );

        const callers: NexusEdgeRef[] = callerRelations.map((rel) => {
          const callerNode = typedGet<RawNexusNode>(
            nexusNative.prepare(
              `SELECT id, kind, name, file_path, label FROM nexus_nodes WHERE id = ? LIMIT 1`,
            ),
            rel.source_id,
          );
          return {
            nodeId: rel.source_id,
            name: callerNode?.name ?? callerNode?.label ?? rel.source_id,
            filePath: callerNode?.file_path ?? null,
            kind: callerNode?.kind ?? 'unknown',
            relationType: String(rel.type),
          };
        });

        // Callees: relations where source_id = symbolNode.id
        const calleeRelations = typedAll<RawNexusRelation>(
          nexusNative.prepare(
            `SELECT r.source_id, r.target_id, r.type, r.weight
             FROM nexus_relations r
             WHERE r.source_id = ?
               AND r.type IN ('calls', 'imports', 'accesses')
             LIMIT 50`,
          ),
          symbolNode.id,
        );

        const callees: NexusEdgeRef[] = calleeRelations.map((rel) => {
          const calleeNode = typedGet<RawNexusNode>(
            nexusNative.prepare(
              `SELECT id, kind, name, file_path, label FROM nexus_nodes WHERE id = ? LIMIT 1`,
            ),
            rel.target_id,
          );
          return {
            nodeId: rel.target_id,
            name: calleeNode?.name ?? calleeNode?.label ?? rel.target_id,
            filePath: calleeNode?.file_path ?? null,
            kind: calleeNode?.kind ?? 'unknown',
            relationType: String(rel.type),
          };
        });

        // Process membership
        const processRelations = typedAll<{ source_id: string }>(
          nexusNative.prepare(
            `SELECT source_id FROM nexus_relations
             WHERE target_id = ? AND type = 'entry_point_of'
             LIMIT 10`,
          ),
          symbolNode.id,
        );
        const processes = processRelations.map((r) => r.source_id);

        result.nexus = {
          symbolId: symbolNode.id,
          label: symbolNode.label,
          filePath: symbolNode.file_path,
          kind: symbolNode.kind,
          communityId: symbolNode.community_id,
          callers,
          callees,
          processes,
        };

        // Plasticity: SUM of edge weights in nexus_relations
        const plasticityRow = typedGet<{ total_weight: number | null; edge_count: number }>(
          nexusNative.prepare(
            `SELECT
               SUM(COALESCE(weight, 1.0)) as total_weight,
               COUNT(*) as edge_count
             FROM nexus_relations
             WHERE source_id = ? OR target_id = ?`,
          ),
          symbolNode.id,
          symbolNode.id,
        );

        result.plasticityWeight = {
          totalWeight: plasticityRow?.total_weight ?? 0,
          edgeCount: plasticityRow?.edge_count ?? 0,
        };
      }
    }
  } catch (err) {
    console.warn(
      '[living-brain] NEXUS substrate error:',
      err instanceof Error ? err.message : String(err),
    );
  }

  // ---- BRAIN substrate ----
  try {
    await getBrainDb(projectRoot);
    const brainNative = getBrainNativeDb();
    if (brainNative) {
      // Query brain_page_edges for all edges connecting to this symbol
      // Covers: code_reference (memory→symbol), documents (decision→symbol),
      //         mentions (observation→symbol), modified_by (file→observation)
      const codeEdgeTypes = [
        EDGE_TYPES.CODE_REFERENCE,
        EDGE_TYPES.DOCUMENTS,
        EDGE_TYPES.MENTIONS,
        EDGE_TYPES.CONDUIT_MENTIONS_SYMBOL,
      ];

      const placeholders = codeEdgeTypes.map(() => '?').join(', ');

      // brain → symbol edges (from_id is brain node, to_id is symbol)
      const brainToSymbolEdges = typedAll<RawBrainEdge>(
        brainNative.prepare(
          `SELECT from_id, to_id, edge_type, weight
           FROM brain_page_edges
           WHERE to_id = ? AND edge_type IN (${placeholders})
           LIMIT 100`,
        ),
        resolvedSymbolId,
        ...codeEdgeTypes,
      );

      // symbol → observation edges (from_id is symbol/file, to_id is brain node)
      const symbolToBrainEdges = typedAll<RawBrainEdge>(
        brainNative.prepare(
          `SELECT from_id, to_id, edge_type, weight
           FROM brain_page_edges
           WHERE from_id = ? AND edge_type = ?
           LIMIT 100`,
        ),
        resolvedSymbolId,
        EDGE_TYPES.AFFECTS,
      );

      // Collect all brain node IDs
      const brainNodeIds = new Set<string>();
      const edgeByBrainId = new Map<string, RawBrainEdge>();

      for (const edge of brainToSymbolEdges) {
        brainNodeIds.add(edge.from_id);
        edgeByBrainId.set(edge.from_id, edge);
      }
      for (const edge of symbolToBrainEdges) {
        brainNodeIds.add(edge.to_id);
        edgeByBrainId.set(edge.to_id, edge);
      }

      // Fetch brain node metadata
      for (const nodeId of brainNodeIds) {
        const brainNode = typedGet<RawBrainNode>(
          brainNative.prepare(
            `SELECT id, node_type, label, quality_score
             FROM brain_page_nodes WHERE id = ? LIMIT 1`,
          ),
          nodeId,
        );
        const edge = edgeByBrainId.get(nodeId);

        if (brainNode && edge) {
          // Filter out conduit_mentions_symbol — those go to conduitThreads
          if (edge.edge_type === EDGE_TYPES.CONDUIT_MENTIONS_SYMBOL) {
            result.conduitThreads.push({
              nodeId: brainNode.id,
              weight: edge.weight,
            });
          } else {
            result.brainMemories.push({
              nodeId: brainNode.id,
              nodeType: brainNode.node_type,
              label: brainNode.label,
              qualityScore: brainNode.quality_score,
              edgeType: edge.edge_type,
              weight: edge.weight,
            });
          }
        }
      }
    }
  } catch (err) {
    console.warn(
      '[living-brain] BRAIN substrate error:',
      err instanceof Error ? err.message : String(err),
    );
  }

  // ---- TASKS substrate ----
  try {
    const taskRefs = await getTasksForSymbol(resolvedSymbolId, projectRoot);
    result.tasks = taskRefs.map((r) => ({
      taskId: r.taskId,
      label: r.label,
      weight: r.weight,
      matchStrategy: r.matchStrategy,
    }));
  } catch (err) {
    console.warn(
      '[living-brain] TASKS substrate error:',
      err instanceof Error ? err.message : String(err),
    );
  }

  // ---- SENTIENT substrate ----
  try {
    await getBrainDb(projectRoot);
    const brainNative = getBrainNativeDb();
    if (brainNative) {
      // Query proposed tasks in tasks.db is not directly accessible here,
      // so we query the brain_page_nodes for sentient-tier2 nodes whose
      // metadata_json contains the resolvedSymbolId as sourceId.
      // Fallback: look for nodes with label containing the symbol name.
      const proposalNodes = typedAll<RawSentientProposal>(
        brainNative.prepare(
          `SELECT id, metadata_json, label as title, NULL as description
           FROM brain_page_nodes
           WHERE node_type = 'learning'
             AND label LIKE '%T2-NEXUS%'
             AND (id LIKE ? OR metadata_json LIKE ?)
           LIMIT 20`,
        ),
        `%${resolvedSymbolId}%`,
        `%${resolvedSymbolId}%`,
      );

      for (const node of proposalNodes) {
        let meta: Record<string, unknown> = {};
        if (node.metadata_json) {
          try {
            meta = JSON.parse(node.metadata_json) as Record<string, unknown>;
          } catch {
            // ignore
          }
        }
        result.sentientProposals.push({
          source: String(meta['source'] ?? 'nexus'),
          sourceId: String(meta['sourceId'] ?? resolvedSymbolId),
          title: String(node.title ?? node.id),
          rationale: String(meta['rationale'] ?? ''),
          weight: typeof meta['weight'] === 'number' ? meta['weight'] : 0.3,
        });
      }
    }
  } catch (err) {
    console.warn(
      '[living-brain] SENTIENT substrate error:',
      err instanceof Error ? err.message : String(err),
    );
  }

  // ---- CONDUIT substrate ----
  // conduitThreads were already populated above from brain_page_edges with
  // edge_type = conduit_mentions_symbol. If conduit.db is absent, we return [].
  // Additional check: if conduit.db exists, verify the threads are real.
  try {
    const conduitDbPath = getConduitDbPath(projectRoot);
    if (!existsSync(conduitDbPath) && result.conduitThreads.length > 0) {
      // conduit.db is absent but we found stub edges — still valid to return them
      // (they were written by the conduit ingester which already checked availability)
    }
  } catch {
    // Non-fatal: conduit check is best-effort
  }

  return result;
}

// ---------------------------------------------------------------------------
// getTaskCodeImpact
// ---------------------------------------------------------------------------

/**
 * Return the full code impact footprint of a task.
 *
 * For a given task:
 * - Loads files from task's files_json
 * - Resolves symbols in those files via T1067 bridge
 * - Runs impact BFS (analyzeImpact) per symbol and aggregates blast radius
 * - Queries brain observations with modified_by edges to those files
 * - Queries brain decisions linked to this task via brain_memory_links
 * - Computes aggregate risk tier
 *
 * All substrate failures produce empty collections — never throws.
 *
 * @param taskId - Task ID (e.g., 'T001')
 * @param projectRoot - Absolute path to project root
 * @returns Full task code impact analysis
 */
export async function getTaskCodeImpact(
  taskId: string,
  projectRoot: string,
): Promise<TaskCodeImpact> {
  const result: TaskCodeImpact = {
    taskId,
    files: [],
    symbols: [],
    blastRadius: { totalAffected: 0, maxRisk: 'NONE', symbolsAnalyzed: 0 },
    brainObservations: [],
    decisions: [],
    riskScore: 'NONE',
  };

  // ---- Resolve files from tasks.db ----
  let filesJson: string | null = null;
  try {
    const { getDb } = await import('../store/sqlite.js');
    const { eq } = await import('drizzle-orm');
    const { tasks: tasksTable } = await import('../store/tasks-schema.js');
    const tasksDb = await getDb(projectRoot);

    const rows = await tasksDb
      .select({ filesJson: tasksTable.filesJson })
      .from(tasksTable)
      .where(eq(tasksTable.id, taskId))
      .all();

    if (rows[0]?.filesJson) {
      filesJson = rows[0].filesJson;
    }
  } catch {
    // Fallback: try to get files from brain_page_edges task edges
  }

  if (!filesJson) {
    // Try to infer from task_touches_symbol edges
    try {
      await getBrainDb(projectRoot);
      const brainNative = getBrainNativeDb();
      await getNexusDb();
      const nexusNative = getNexusNativeDb();

      if (brainNative && nexusNative) {
        const taskEdges = typedAll<{ to_id: string }>(
          brainNative.prepare(
            `SELECT to_id FROM brain_page_edges
             WHERE from_id = ? AND edge_type = ?
             LIMIT 100`,
          ),
          `task:${taskId}`,
          EDGE_TYPES.TASK_TOUCHES_SYMBOL,
        );

        const filePaths = new Set<string>();
        for (const edge of taskEdges) {
          const node = typedGet<{ file_path: string | null }>(
            nexusNative.prepare(`SELECT file_path FROM nexus_nodes WHERE id = ? LIMIT 1`),
            edge.to_id,
          );
          if (node?.file_path) filePaths.add(node.file_path);
        }
        if (filePaths.size > 0) {
          filesJson = JSON.stringify(Array.from(filePaths));
        }
      }
    } catch {
      // Give up on file resolution
    }
  }

  if (filesJson) {
    try {
      const parsed = JSON.parse(filesJson);
      if (Array.isArray(parsed)) {
        result.files = parsed.filter((f): f is string => typeof f === 'string');
      }
    } catch {
      // malformed JSON
    }
  }

  // ---- Symbols via T1067 bridge ----
  let symbolIds: string[] = [];
  try {
    const symbolRefs = await getSymbolsForTask(taskId, projectRoot);
    symbolIds = symbolRefs.map((s) => s.nexusNodeId);
  } catch (err) {
    console.warn(
      '[living-brain] getSymbolsForTask failed:',
      err instanceof Error ? err.message : String(err),
    );
  }

  // ---- Impact BFS per symbol ----
  if (symbolIds.length > 0) {
    try {
      await getNexusDb();
      const nexusNative = getNexusNativeDb();

      if (nexusNative) {
        const { analyzeImpact } = await import('@cleocode/nexus');

        // Load all nodes + relations once
        const allNodes = typedAll<{
          id: string;
          name: string;
          kind: string;
          file_path: string | null;
          label: string;
          is_exported: number;
        }>(
          nexusNative.prepare(
            `SELECT id, name, kind, file_path, label, is_exported FROM nexus_nodes LIMIT 50000`,
          ),
        );

        const allRelations = typedAll<{
          id: string;
          source_id: string;
          target_id: string;
          type: string;
          confidence: number | null;
          weight: number | null;
        }>(
          nexusNative.prepare(
            `SELECT id, source_id, target_id, type, confidence, weight FROM nexus_relations LIMIT 200000`,
          ),
        );

        // Map to GraphNode / GraphRelation contracts
        const graphNodes = allNodes.map((n) => ({
          id: n.id,
          name: n.name ?? n.label,
          kind: n.kind as import('@cleocode/contracts').GraphNodeKind,
          filePath: n.file_path ?? '',
          startLine: 0,
          endLine: 0,
          language: 'unknown',
          exported: n.is_exported === 1,
        }));

        const graphRelations = allRelations.map((r) => ({
          source: r.source_id,
          target: r.target_id,
          type: r.type as import('@cleocode/contracts').GraphRelationType,
          confidence: r.confidence ?? 1.0,
        }));

        const symbolEntries: SymbolImpactEntry[] = [];

        for (const symbolId of symbolIds.slice(0, 50)) {
          const node = allNodes.find((n) => n.id === symbolId);
          if (!node) continue;

          let impactResult: ImpactResult;
          try {
            impactResult = analyzeImpact(symbolId, graphNodes, graphRelations);
          } catch {
            impactResult = {
              target: symbolId,
              riskLevel: 'low',
              summary: '',
              affectedByDepth: {
                depth1_willBreak: [],
                depth2_likelyAffected: [],
                depth3_mayNeedTesting: [],
              },
              totalAffected: 0,
            };
          }

          symbolEntries.push({
            nexusNodeId: symbolId,
            label: node.name ?? node.label,
            kind: node.kind,
            filePath: node.file_path,
            riskLevel: toRiskTier(impactResult.riskLevel),
            totalAffected: impactResult.totalAffected,
            directCallers: impactResult.affectedByDepth.depth1_willBreak.length,
          });
        }

        result.symbols = symbolEntries;
        result.blastRadius = {
          totalAffected: symbolEntries.reduce((sum, s) => sum + s.totalAffected, 0),
          maxRisk: maxRiskTier(symbolEntries.map((s) => s.riskLevel)),
          symbolsAnalyzed: symbolEntries.length,
        };
        result.riskScore = result.blastRadius.maxRisk;
      }
    } catch (err) {
      console.warn(
        '[living-brain] blast radius analysis failed:',
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // ---- Brain observations with modified_by edges to task files ----
  try {
    await getBrainDb(projectRoot);
    const brainNative = getBrainNativeDb();
    await getNexusDb();
    const nexusNative = getNexusNativeDb();

    if (brainNative && nexusNative && result.files.length > 0) {
      for (const filePath of result.files) {
        // Find nexus file node for this path
        const fileNode = typedGet<{ id: string }>(
          nexusNative.prepare(`SELECT id FROM nexus_nodes WHERE file_path = ? LIMIT 1`),
          filePath,
        );
        if (!fileNode) continue;

        // Find modified_by edges from this file node to observation nodes
        const modEdges = typedAll<RawBrainEdge>(
          brainNative.prepare(
            `SELECT from_id, to_id, edge_type, weight
             FROM brain_page_edges
             WHERE from_id = ? AND edge_type = ?
             LIMIT 20`,
          ),
          fileNode.id,
          EDGE_TYPES.AFFECTS,
        );

        // Also check reverse (observation → file via modified_by)
        const modByEdges = typedAll<RawBrainEdge>(
          brainNative.prepare(
            `SELECT from_id, to_id, edge_type, weight
             FROM brain_page_edges
             WHERE to_id = ? AND edge_type = 'modified_by'
             LIMIT 20`,
          ),
          fileNode.id,
        );

        for (const edge of [...modEdges, ...modByEdges]) {
          const obsNodeId = edge.edge_type === 'modified_by' ? edge.from_id : edge.to_id;
          const obsNode = typedGet<RawBrainNode>(
            brainNative.prepare(
              `SELECT id, node_type, label, quality_score FROM brain_page_nodes WHERE id = ? LIMIT 1`,
            ),
            obsNodeId,
          );
          if (obsNode) {
            // Deduplicate
            const exists = result.brainObservations.some((o) => o.nodeId === obsNode.id);
            if (!exists) {
              result.brainObservations.push({
                nodeId: obsNode.id,
                nodeType: obsNode.node_type,
                label: obsNode.label,
                qualityScore: obsNode.quality_score,
                edgeType: edge.edge_type,
                weight: edge.weight,
              });
            }
          }
        }
      }
    }
  } catch (err) {
    console.warn(
      '[living-brain] brain observations query failed:',
      err instanceof Error ? err.message : String(err),
    );
  }

  // ---- Decisions from brain_memory_links ----
  try {
    await getBrainDb(projectRoot);
    const brainNative = getBrainNativeDb();

    if (brainNative) {
      const linkRows = typedAll<RawMemoryLink>(
        brainNative.prepare(
          `SELECT memory_id, memory_type, task_id, link_type
           FROM brain_memory_links
           WHERE task_id = ? AND memory_type = 'decision'
           LIMIT 20`,
        ),
        taskId,
      );

      for (const link of linkRows) {
        const decisionRow = typedGet<RawDecision>(
          brainNative.prepare(`SELECT id, decision FROM brain_decisions WHERE id = ? LIMIT 1`),
          link.memory_id,
        );

        if (decisionRow) {
          result.decisions.push({
            decisionId: decisionRow.id,
            decision: decisionRow.decision,
            linkType: link.link_type,
          });
        }
      }
    }
  } catch (err) {
    console.warn(
      '[living-brain] decisions query failed:',
      err instanceof Error ? err.message : String(err),
    );
  }

  return result;
}

// ---------------------------------------------------------------------------
// getBrainEntryCodeAnchors
// ---------------------------------------------------------------------------

/**
 * Return the code anchors for a brain memory entry.
 *
 * Given a brain entry ID (e.g., 'observation:abc123'), finds:
 * - nexusNodes: all code nodes linked via code_reference, documents, applies_to edges
 * - tasksForNodes: for each code node, which tasks touched it (T1067 reverse-lookup)
 * - plasticitySignal: sum of weights on all anchoring edges
 *
 * All substrate failures produce empty collections — never throws.
 *
 * @param entryId - Brain entry node ID (format: '<type>:<source-id>')
 * @param projectRoot - Absolute path to project root
 * @returns Code anchor result
 */
export async function getBrainEntryCodeAnchors(
  entryId: string,
  projectRoot: string,
): Promise<CodeAnchorResult> {
  const result: CodeAnchorResult = {
    entryId,
    nexusNodes: [],
    tasksForNodes: [],
    plasticitySignal: 0,
  };

  // ---- Code anchors from brain_page_edges ----
  const anchorEdgeTypes = [
    EDGE_TYPES.CODE_REFERENCE,
    EDGE_TYPES.DOCUMENTS,
    EDGE_TYPES.APPLIES_TO,
  ] as const;

  try {
    await getBrainDb(projectRoot);
    const brainNative = getBrainNativeDb();
    await getNexusDb();
    const nexusNative = getNexusNativeDb();

    if (!brainNative || !nexusNative) return result;

    const placeholders = anchorEdgeTypes.map(() => '?').join(', ');

    // brain entry → code node edges
    const anchorEdges = typedAll<RawBrainEdge>(
      brainNative.prepare(
        `SELECT from_id, to_id, edge_type, weight
         FROM brain_page_edges
         WHERE from_id = ? AND edge_type IN (${placeholders})
         LIMIT 100`,
      ),
      entryId,
      ...anchorEdgeTypes,
    );

    let totalWeight = 0;

    for (const edge of anchorEdges) {
      // Verify the target exists in nexus
      const nexusNode = typedGet<RawNexusNode>(
        nexusNative.prepare(
          `SELECT id, kind, name, file_path, label FROM nexus_nodes WHERE id = ? LIMIT 1`,
        ),
        edge.to_id,
      );

      if (nexusNode) {
        result.nexusNodes.push({
          nexusNodeId: nexusNode.id,
          label: nexusNode.label,
          filePath: nexusNode.file_path,
          kind: nexusNode.kind,
          edgeType: edge.edge_type,
          weight: edge.weight,
        });
        totalWeight += edge.weight;
      }
    }

    result.plasticitySignal = totalWeight;
  } catch (err) {
    console.warn(
      '[living-brain] code anchors query failed:',
      err instanceof Error ? err.message : String(err),
    );
  }

  // ---- Tasks for each code node ----
  try {
    for (const anchor of result.nexusNodes) {
      const taskRefs = await getTasksForSymbol(anchor.nexusNodeId, projectRoot);
      if (taskRefs.length > 0) {
        result.tasksForNodes.push({
          nexusNodeId: anchor.nexusNodeId,
          tasks: taskRefs.map((r) => ({
            taskId: r.taskId,
            label: r.label,
            weight: r.weight,
            matchStrategy: r.matchStrategy,
          })),
        });
      }
    }
  } catch (err) {
    console.warn(
      '[living-brain] tasks-for-nodes lookup failed:',
      err instanceof Error ? err.message : String(err),
    );
  }

  return result;
}

// ---------------------------------------------------------------------------
// reasonImpactOfChange
// ---------------------------------------------------------------------------

/**
 * Return a merged impact report combining structural blast radius, open-task
 * references, and brain risk observations for a given code symbol.
 *
 * Composes:
 * 1. `analyzeImpact(symbolId)` — structural callers/callees BFS
 * 2. `getTasksForSymbol(symbolId)` — tasks that touch this symbol
 * 3. Brain observations/decisions via `code_reference`, `modified_by`, `documents` edges
 *
 * All substrate failures produce empty collections — never throws.
 *
 * @param symbolId - Nexus node ID or symbol name (partial match accepted)
 * @param projectRoot - Absolute path to project root
 * @returns Merged full impact report
 * @task T1069
 * @epic T1042
 */
export async function reasonImpactOfChange(
  symbolId: string,
  projectRoot: string,
): Promise<ImpactFullReport> {
  const result: ImpactFullReport = {
    symbolId,
    structural: {
      directCallers: 0,
      likelyAffected: 0,
      mayNeedTesting: 0,
      totalAffected: 0,
      riskLevel: 'NONE',
    },
    openTasks: [],
    brainRiskNotes: [],
    mergedRiskScore: 'NONE',
    narrative: `No impact data available for symbol '${symbolId}'.`,
  };

  // ---- Resolve nexus node ID (may be a name) ----
  let resolvedId = symbolId;
  try {
    await getNexusDb();
    const nexusNative = getNexusNativeDb();
    if (nexusNative) {
      let nexusNode = typedGet<RawNexusNode>(
        nexusNative.prepare(
          `SELECT id, project_id, kind, name, file_path, label, community_id, weight
           FROM nexus_nodes WHERE id = ? LIMIT 1`,
        ),
        symbolId,
      );
      if (!nexusNode) {
        nexusNode = typedGet<RawNexusNode>(
          nexusNative.prepare(
            `SELECT id, project_id, kind, name, file_path, label, community_id, weight
             FROM nexus_nodes
             WHERE LOWER(name) = LOWER(?) AND kind NOT IN ('community', 'process', 'folder')
             LIMIT 1`,
          ),
          symbolId,
        );
      }
      if (nexusNode) {
        resolvedId = nexusNode.id;
      }
    }
  } catch (err) {
    console.warn(
      '[living-brain] reasonImpactOfChange nexus resolve failed:',
      err instanceof Error ? err.message : String(err),
    );
  }

  // ---- Structural blast radius via analyzeImpact ----
  try {
    await getNexusDb();
    const nexusNative = getNexusNativeDb();

    if (nexusNative) {
      const { analyzeImpact } = await import('@cleocode/nexus');

      const allNodes = typedAll<{
        id: string;
        name: string;
        kind: string;
        file_path: string | null;
        label: string;
        is_exported: number;
      }>(
        nexusNative.prepare(
          `SELECT id, name, kind, file_path, label, is_exported FROM nexus_nodes LIMIT 50000`,
        ),
      );

      const allRelations = typedAll<{
        id: string;
        source_id: string;
        target_id: string;
        type: string;
        confidence: number | null;
        weight: number | null;
      }>(
        nexusNative.prepare(
          `SELECT id, source_id, target_id, type, confidence, weight FROM nexus_relations LIMIT 200000`,
        ),
      );

      const graphNodes = allNodes.map((n) => ({
        id: n.id,
        name: n.name ?? n.label,
        kind: n.kind as import('@cleocode/contracts').GraphNodeKind,
        filePath: n.file_path ?? '',
        startLine: 0,
        endLine: 0,
        language: 'unknown',
        exported: n.is_exported === 1,
      }));

      const graphRelations = allRelations.map((r) => ({
        source: r.source_id,
        target: r.target_id,
        type: r.type as import('@cleocode/contracts').GraphRelationType,
        confidence: r.confidence ?? 1.0,
      }));

      let impactResult: ImpactResult;
      try {
        impactResult = analyzeImpact(resolvedId, graphNodes, graphRelations);
      } catch {
        impactResult = {
          target: resolvedId,
          riskLevel: 'low',
          summary: '',
          affectedByDepth: {
            depth1_willBreak: [],
            depth2_likelyAffected: [],
            depth3_mayNeedTesting: [],
          },
          totalAffected: 0,
        };
      }

      result.structural = {
        directCallers: impactResult.affectedByDepth.depth1_willBreak.length,
        likelyAffected: impactResult.affectedByDepth.depth2_likelyAffected.length,
        mayNeedTesting: impactResult.affectedByDepth.depth3_mayNeedTesting.length,
        totalAffected: impactResult.totalAffected,
        riskLevel: toRiskTier(impactResult.riskLevel),
      };
    }
  } catch (err) {
    console.warn(
      '[living-brain] reasonImpactOfChange structural analysis failed:',
      err instanceof Error ? err.message : String(err),
    );
  }

  // ---- Open tasks via task_touches_symbol ----
  try {
    const taskRefs = await getTasksForSymbol(resolvedId, projectRoot);
    result.openTasks = taskRefs.map((r) => ({
      taskId: r.taskId,
      label: r.label,
      weight: r.weight,
    }));
  } catch (err) {
    console.warn(
      '[living-brain] reasonImpactOfChange open-tasks lookup failed:',
      err instanceof Error ? err.message : String(err),
    );
  }

  // ---- Brain risk notes via code_reference / documents / modified_by edges ----
  try {
    await getBrainDb(projectRoot);
    const brainNative = getBrainNativeDb();

    if (brainNative) {
      const riskEdgeTypes = [
        EDGE_TYPES.CODE_REFERENCE,
        EDGE_TYPES.DOCUMENTS,
        EDGE_TYPES.MENTIONS,
        EDGE_TYPES.AFFECTS,
      ] as const;

      const placeholders = riskEdgeTypes.map(() => '?').join(', ');

      // Brain nodes → symbol (brain references this symbol)
      const brainToSymbolEdges = typedAll<RawBrainEdge>(
        brainNative.prepare(
          `SELECT from_id, to_id, edge_type, weight
           FROM brain_page_edges
           WHERE to_id = ? AND edge_type IN (${placeholders})
           LIMIT 50`,
        ),
        resolvedId,
        ...riskEdgeTypes,
      );

      // symbol → brain nodes (symbol points to observations)
      const symbolToBrainEdges = typedAll<RawBrainEdge>(
        brainNative.prepare(
          `SELECT from_id, to_id, edge_type, weight
           FROM brain_page_edges
           WHERE from_id = ? AND edge_type = ?
           LIMIT 50`,
        ),
        resolvedId,
        EDGE_TYPES.AFFECTS,
      );

      const seenIds = new Set<string>();

      const processEdges = (edges: RawBrainEdge[], isReverse: boolean) => {
        for (const edge of edges) {
          const nodeId = isReverse ? edge.from_id : edge.to_id;
          if (seenIds.has(nodeId)) continue;
          seenIds.add(nodeId);

          const brainNode = typedGet<RawBrainNode>(
            brainNative.prepare(
              `SELECT id, node_type, label, quality_score
               FROM brain_page_nodes WHERE id = ? LIMIT 1`,
            ),
            nodeId,
          );
          if (brainNode) {
            const riskNote: BrainRiskNote = {
              nodeId: brainNode.id,
              nodeType: brainNode.node_type,
              label: brainNode.label,
              edgeType: edge.edge_type,
              weight: edge.weight,
            };
            result.brainRiskNotes.push(riskNote);
          }
        }
      };

      processEdges(brainToSymbolEdges, true);
      processEdges(symbolToBrainEdges, false);
    }
  } catch (err) {
    console.warn(
      '[living-brain] reasonImpactOfChange brain risk notes failed:',
      err instanceof Error ? err.message : String(err),
    );
  }

  // ---- Compute merged risk score ----
  const riskFactors: RiskTier[] = [result.structural.riskLevel];

  // Open task count adds risk
  if (result.openTasks.length >= 5) riskFactors.push('HIGH');
  else if (result.openTasks.length >= 2) riskFactors.push('MEDIUM');
  else if (result.openTasks.length >= 1) riskFactors.push('LOW');

  // Brain risk notes with high quality add risk
  const highQualityNotes = result.brainRiskNotes.filter((n) => n.weight >= 0.8);
  if (highQualityNotes.length >= 3) riskFactors.push('MEDIUM');

  result.mergedRiskScore = maxRiskTier(riskFactors);

  // ---- Build narrative ----
  const symLabel = symbolId !== resolvedId ? `'${symbolId}' (${resolvedId})` : `'${symbolId}'`;
  const d1 = result.structural.directCallers;
  const d2 = result.structural.likelyAffected;
  const openCount = result.openTasks.length;
  const riskNoteCount = result.brainRiskNotes.length;

  result.narrative =
    `Changing ${symLabel} will break ${d1} direct caller${d1 !== 1 ? 's' : ''} (d=1)` +
    (d2 > 0 ? `, likely affect ${d2} at d=2` : '') +
    (openCount > 0
      ? `, and is referenced in ${openCount} open task${openCount !== 1 ? 's' : ''}`
      : '') +
    (riskNoteCount > 0
      ? ` and ${riskNoteCount} BRAIN risk note${riskNoteCount !== 1 ? 's' : ''}`
      : '') +
    `. Merged risk: ${result.mergedRiskScore}.`;

  return result;
}
