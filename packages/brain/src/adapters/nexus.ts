/**
 * NEXUS substrate adapter for the Living Brain API.
 *
 * Queries nexus.db (global) and returns BrainNodes/BrainEdges for code symbols and files.
 * Prioritises high-in-degree nodes (most-called functions, most-imported files)
 * since the full nexus graph can exceed 10k nodes.
 *
 * Node IDs are prefixed with "nexus:" to prevent collisions.
 */

import { allTyped, getNexusDb } from '../db-connections.js';
import type { BrainEdge, BrainNode, BrainNodeKind, BrainQueryOptions } from '../types.js';

/** Raw row from nexus_nodes. */
interface NexusNodeRow {
  id: string;
  kind: string;
  name: string;
  in_degree: number;
  indexed_at: string | null;
}

/** Raw row from nexus_relations. */
interface NexusRelationRow {
  source_id: string;
  target_id: string;
  type: string;
  confidence: number | null;
}

/** Maps nexus node kinds to BrainNodeKind. */
function mapKind(nexusKind: string): BrainNodeKind {
  if (nexusKind === 'file' || nexusKind === 'folder' || nexusKind === 'module') return 'file';
  return 'symbol';
}

/**
 * Returns all BrainNodes and BrainEdges sourced from nexus.db.
 *
 * Fetches the highest in-degree nodes (capped at perSubstrateLimit) and
 * all relations between those nodes.
 *
 * @param options - Query options (limit, minWeight).
 * @returns Nodes and edges from the NEXUS substrate.
 */
export function getNexusSubstrate(options: BrainQueryOptions = {}): {
  nodes: BrainNode[];
  edges: BrainEdge[];
} {
  const db = getNexusDb();
  if (!db) return { nodes: [], edges: [] };

  const perSubstrateLimit = Math.ceil((options.limit ?? 500) / 5);

  const nodes: BrainNode[] = [];
  const edges: BrainEdge[] = [];

  try {
    // Count in-degree for each node to use as weight
    const nodeRows = allTyped<NexusNodeRow>(
      db.prepare(
        `SELECT n.id, n.kind, n.name, n.indexed_at,
                COUNT(r.target_id) AS in_degree
         FROM nexus_nodes n
         LEFT JOIN nexus_relations r ON r.target_id = n.id
         WHERE n.kind IN (
           'file', 'function', 'method', 'class', 'interface',
           'type_alias', 'constant', 'module', 'enum'
         )
         GROUP BY n.id
         ORDER BY in_degree DESC
         LIMIT ?`,
      ),
      perSubstrateLimit,
    );

    for (const row of nodeRows) {
      nodes.push({
        id: `nexus:${row.id}`,
        kind: mapKind(row.kind),
        substrate: 'nexus',
        label: row.name,
        weight: row.in_degree > 0 ? Math.min(1, row.in_degree / 50) : undefined,
        createdAt: row.indexed_at ?? null,
        meta: { nexus_kind: row.kind, in_degree: row.in_degree },
      });
    }

    // Edges between loaded nodes only
    const nodeIds = new Set(nodes.map((n) => n.id));
    const rawIds = new Set([...nodeIds].map((id) => id.replace(/^nexus:/, '')));

    // Fetch all relations touching these nodes (both directions)
    const placeholders = [...rawIds].map(() => '?').join(',');
    if (rawIds.size === 0) return { nodes, edges };

    const relRows = allTyped<NexusRelationRow>(
      db.prepare(
        `SELECT source_id, target_id, type, confidence
         FROM nexus_relations
         WHERE source_id IN (${placeholders})
           AND target_id IN (${placeholders})`,
      ),
      ...rawIds,
      ...rawIds,
    );

    for (const row of relRows) {
      edges.push({
        source: `nexus:${row.source_id}`,
        target: `nexus:${row.target_id}`,
        type: row.type,
        weight: row.confidence ?? 0.5,
        substrate: 'nexus',
      });
    }
  } catch {
    // Return partial results on error
  }

  return { nodes, edges };
}
