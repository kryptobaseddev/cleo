/**
 * SIGNALDOCK substrate adapter for the Living Brain API.
 *
 * Queries signaldock.db (global) and returns LBNodes/LBEdges for agents
 * and agent-to-agent social connections.
 *
 * Node IDs are prefixed with "signaldock:" to prevent collisions.
 * Agents are the cross-substrate identity bridge — they appear in TASKS
 * (assignee), CONDUIT (from/to), and BRAIN (source agent).
 */

import { getSignaldockDb } from '../../db/connections.js';
import type { LBEdge, LBNode, LBQueryOptions } from '../types.js';

/** Raw row from agents table. */
interface AgentRow {
  agent_id: string;
  name: string;
  status: string;
  /** UNIX epoch seconds (INTEGER column in signaldock.db). May be null on legacy rows. */
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
 * Returns all LBNodes and LBEdges sourced from signaldock.db.
 *
 * Fetches all active agents plus their declared connections.
 * Agent nodes serve as the cross-substrate identity anchors.
 *
 * @param options - Query options (limit).
 * @returns Nodes and edges from the SIGNALDOCK substrate.
 */
export function getSignaldockSubstrate(options: LBQueryOptions = {}): {
  nodes: LBNode[];
  edges: LBEdge[];
} {
  const db = getSignaldockDb();
  if (!db) return { nodes: [], edges: [] };

  const perSubstrateLimit = Math.ceil((options.limit ?? 500) / 5);

  const nodes: LBNode[] = [];
  const edges: LBEdge[] = [];

  try {
    // Active agents
    const agentRows = db
      .prepare(
        `SELECT agent_id, name, status, created_at
         FROM agents
         WHERE status != 'deleted'
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(perSubstrateLimit) as AgentRow[];

    const agentIds = new Set<string>();
    for (const row of agentRows) {
      agentIds.add(row.agent_id);
      nodes.push({
        id: `signaldock:${row.agent_id}`,
        kind: 'agent',
        substrate: 'signaldock',
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
      const connRows = db
        .prepare(
          `SELECT from_agent_id, to_agent_id, connection_type, strength
           FROM agent_connections
           WHERE from_agent_id IN (${placeholders})
             AND to_agent_id IN (${placeholders})`,
        )
        .all(...agentIds, ...agentIds) as AgentConnectionRow[];

      for (const row of connRows) {
        edges.push({
          source: `signaldock:${row.from_agent_id}`,
          target: `signaldock:${row.to_agent_id}`,
          type: row.connection_type,
          weight: row.strength ?? 0.5,
          substrate: 'signaldock',
        });
      }
    }
  } catch {
    // Return partial results on error
  }

  return { nodes, edges };
}
