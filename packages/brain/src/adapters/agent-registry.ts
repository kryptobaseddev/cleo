/**
 * AGENT-REGISTRY substrate adapter for the Living Brain API.
 *
 * Read-only visualization path. Queries the LEGACY standalone `signaldock.db`
 * (resolved by `getAgentRegistryDbPath`) and returns BrainNodes/BrainEdges for
 * agents and agent-to-agent social connections. The legacy standalone file still
 * carries the BARE table names (`agents`, `agent_connections`); the brain-package
 * read path is migrated to the consolidated `cleo.db` separately in E6 (T11249),
 * so the SQL below intentionally still targets the bare names.
 *
 * The substrate identifier + node-id prefix were renamed `signaldock` →
 * `agent-registry` under T11622 (display identifiers, decoupled from the physical
 * table names).
 *
 * Node IDs are prefixed with "agent-registry:" to prevent collisions.
 * Agents are the cross-substrate identity bridge — they appear in TASKS
 * (assignee), CONDUIT (from/to), and BRAIN (source agent).
 *
 * @task T11622 (Signaldock → Agent Registry rename; folds T11578 AC2)
 */

import { allTyped, getAgentRegistryDb } from '../db-connections.js';
import type { BrainEdge, BrainNode, BrainQueryOptions } from '../types.js';

/** Raw row from the legacy standalone `signaldock.db` `agents` table. */
interface AgentRow {
  agent_id: string;
  name: string;
  status: string;
  /** UNIX epoch seconds (INTEGER column in the legacy `signaldock.db`). May be null on legacy rows. */
  created_at: number | null;
}

/**
 * Converts a UNIX epoch seconds value to an ISO-8601 string.
 * Returns null when the value is not a finite positive number.
 *
 * @param epoch - UNIX timestamp in seconds, or null.
 * @returns ISO-8601 string or null.
 */
function epochToIso(epoch: number | null): string | null {
  if (epoch === null || !Number.isFinite(epoch) || epoch <= 0) return null;
  return new Date(epoch * 1000).toISOString();
}

/** Raw row from agent_connections table. */
interface AgentConnectionRow {
  from_agent_id: string;
  to_agent_id: string;
  connection_type: string;
  strength: number | null;
}

/**
 * Returns all BrainNodes and BrainEdges sourced from the Agent Registry.
 *
 * Fetches all active agents plus their declared connections.
 * Agent nodes serve as the cross-substrate identity anchors.
 *
 * @param options - Query options (limit).
 * @returns Nodes and edges from the AGENT-REGISTRY substrate.
 */
export function getAgentRegistrySubstrate(options: BrainQueryOptions = {}): {
  nodes: BrainNode[];
  edges: BrainEdge[];
} {
  const db = getAgentRegistryDb();
  if (!db) return { nodes: [], edges: [] };

  const perSubstrateLimit = Math.ceil((options.limit ?? 500) / 5);

  const nodes: BrainNode[] = [];
  const edges: BrainEdge[] = [];

  try {
    // Active agents (legacy standalone signaldock.db bare table)
    const agentRows = allTyped<AgentRow>(
      db.prepare(
        `SELECT agent_id, name, status, created_at
         FROM agents
         WHERE status != 'deleted'
         ORDER BY created_at DESC
         LIMIT ?`,
      ),
      perSubstrateLimit,
    );

    const agentIds = new Set<string>();
    for (const row of agentRows) {
      agentIds.add(row.agent_id);
      nodes.push({
        id: `agent-registry:${row.agent_id}`,
        kind: 'agent',
        substrate: 'agent-registry',
        label: row.name,
        weight: row.status === 'active' ? 1.0 : 0.5,
        createdAt: epochToIso(row.created_at),
        meta: {
          status: row.status,
          created_at: row.created_at,
        },
      });
    }

    // Agent connections (declared social graph)
    if (agentIds.size > 0) {
      const placeholders = [...agentIds].map(() => '?').join(',');
      const connRows = allTyped<AgentConnectionRow>(
        db.prepare(
          `SELECT from_agent_id, to_agent_id, connection_type, strength
           FROM agent_connections
           WHERE from_agent_id IN (${placeholders})
             AND to_agent_id IN (${placeholders})`,
        ),
        ...agentIds,
        ...agentIds,
      );

      for (const row of connRows) {
        edges.push({
          source: `agent-registry:${row.from_agent_id}`,
          target: `agent-registry:${row.to_agent_id}`,
          type: row.connection_type,
          weight: row.strength ?? 0.5,
          substrate: 'agent-registry',
        });
      }
    }
  } catch {
    // Return partial results on error
  }

  return { nodes, edges };
}
