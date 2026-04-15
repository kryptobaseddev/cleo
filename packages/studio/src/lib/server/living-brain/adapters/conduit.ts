/**
 * CONDUIT substrate adapter for the Living Brain API.
 *
 * Queries conduit.db and returns LBNodes/LBEdges for agent-to-agent messages.
 * Each message becomes a node; `from_agent_id → to_agent_id` becomes an edge.
 * Co-authoring agent pairs produce cross-substrate edges to SIGNALDOCK.
 *
 * Node IDs are prefixed with "conduit:" to prevent collisions.
 */

import { getConduitDb } from '../../db/connections.js';
import { resolveDefaultProjectContext } from '../../project-context.js';
import type { LBEdge, LBNode, LBQueryOptions } from '../types.js';

/** Raw row from conduit messages table. */
interface MessageRow {
  id: string;
  content: string;
  from_agent_id: string | null;
  to_agent_id: string | null;
  /** UNIX epoch seconds (INTEGER column in conduit.db). */
  created_at: number;
  conversation_id: string | null;
}

/**
 * Converts a UNIX epoch seconds value to an ISO-8601 string.
 * Returns null when the value is not a finite positive number.
 *
 * @param epoch - UNIX timestamp in seconds.
 * @returns ISO-8601 string or null.
 */
function epochToIso(epoch: number): string | null {
  if (!Number.isFinite(epoch) || epoch <= 0) return null;
  return new Date(epoch * 1000).toISOString();
}

/**
 * Returns all LBNodes and LBEdges sourced from conduit.db.
 *
 * Fetches the most recent messages (capped at perSubstrateLimit).
 * Synthesizes agent→agent edges and cross-substrate agent references
 * pointing to signaldock.
 *
 * @param options - Query options (limit).
 * @returns Nodes and edges from the CONDUIT substrate.
 */
export function getConduitSubstrate(options: LBQueryOptions = {}): {
  nodes: LBNode[];
  edges: LBEdge[];
} {
  const ctx = options.projectCtx ?? resolveDefaultProjectContext();
  const db = getConduitDb(ctx);
  if (!db) return { nodes: [], edges: [] };

  const perSubstrateLimit = Math.ceil((options.limit ?? 500) / 5);

  const nodes: LBNode[] = [];
  const edges: LBEdge[] = [];

  try {
    // Most recent messages
    const msgRows = db
      .prepare(
        `SELECT id, content, from_agent_id, to_agent_id, created_at, conversation_id
         FROM messages
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(perSubstrateLimit) as MessageRow[];

    const agentPairs = new Map<string, { count: number; from: string; to: string }>();

    for (const row of msgRows) {
      // Message node — truncate content for label
      const label = row.content.length > 80 ? `${row.content.slice(0, 80)}…` : row.content;
      nodes.push({
        id: `conduit:${row.id}`,
        kind: 'message',
        substrate: 'conduit',
        label,
        createdAt: epochToIso(row.created_at),
        meta: {
          from_agent_id: row.from_agent_id,
          to_agent_id: row.to_agent_id,
          conversation_id: row.conversation_id,
          created_at: row.created_at,
        },
      });

      // Aggregate agent pairs for social-graph edges
      if (row.from_agent_id && row.to_agent_id) {
        const key = `${row.from_agent_id}→${row.to_agent_id}`;
        const existing = agentPairs.get(key);
        if (existing) {
          existing.count++;
        } else {
          agentPairs.set(key, { count: 1, from: row.from_agent_id, to: row.to_agent_id });
        }
      }
    }

    // Cross-substrate: agent social graph edges pointing to signaldock agent nodes
    for (const [, pair] of agentPairs) {
      const weight = Math.min(1.0, pair.count / 10);
      edges.push({
        source: `signaldock:${pair.from}`,
        target: `signaldock:${pair.to}`,
        type: 'messages',
        weight,
        substrate: 'cross',
      });
    }
  } catch {
    // Return partial results on error
  }

  return { nodes, edges };
}
