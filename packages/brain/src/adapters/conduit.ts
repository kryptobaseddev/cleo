/**
 * CONDUIT substrate adapter for the Living Brain API.
 *
 * Queries the project `cleo.db` (`conduit_messages`) and returns
 * BrainNodes/BrainEdges for agent-to-agent messages.
 * Each message becomes a node; `from_agent_id → to_agent_id` becomes an edge.
 * Co-authoring agent pairs produce cross-substrate edges to AGENT-REGISTRY.
 *
 * Node IDs are prefixed with "conduit:" to prevent collisions.
 */

import { allTyped, readProjectStore, substrateResult, tryNodeQuery } from '../db-connections.js';
import { resolveDefaultProjectContext } from '../project-context.js';
import type {
  BrainEdge,
  BrainNode,
  BrainNodeKind,
  BrainQueryOptions,
  BrainSubstrateResult,
} from '../types.js';

/** Raw row from `conduit_messages`. */
interface MessageRow {
  id: string;
  content: string;
  from_agent_id: string | null;
  to_agent_id: string | null;
  /** ISO-8601 timestamp, normalised by the query; null when unparseable. */
  created_at: string | null;
  conversation_id: string | null;
}

/**
 * Returns all BrainNodes and BrainEdges sourced from `conduit_messages`.
 *
 * Fetches the most recent messages (capped at perSubstrateLimit).
 * Synthesizes agent→agent edges and cross-substrate agent references
 * pointing to the agent registry.
 *
 * @param options - Query options (limit).
 * @returns Nodes and edges from the CONDUIT substrate.
 */
export function getConduitSubstrate(options: BrainQueryOptions = {}): BrainSubstrateResult {
  const ctx = options.projectCtx ?? resolveDefaultProjectContext();
  const perSubstrateLimit = Math.ceil((options.limit ?? 500) / 5);

  const nodes: BrainNode[] = [];
  const edges: BrainEdge[] = [];
  const errors: string[] = [];
  const failedKinds = new Set<BrainNodeKind>();

  readProjectStore(
    ctx,
    (db) => {
      // Most recent messages
      const msgRows = tryNodeQuery(errors, failedKinds, 'message', 'conduit_messages', () =>
        allTyped<MessageRow>(
          db.prepare(
            `SELECT id, content, from_agent_id, to_agent_id,
                strftime('%Y-%m-%dT%H:%M:%S', created_at) AS created_at, conversation_id
         FROM main.conduit_messages
         ORDER BY created_at DESC
         LIMIT ?`,
          ),
          perSubstrateLimit,
        ),
      );

      const agentPairs = new Map<string, { count: number; from: string; to: string }>();

      for (const row of msgRows) {
        // Message node — truncate content for label
        const label = row.content.length > 80 ? `${row.content.slice(0, 80)}…` : row.content;
        nodes.push({
          id: `conduit:${row.id}`,
          kind: 'message',
          substrate: 'conduit',
          label,
          createdAt: row.created_at,
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

      // Cross-substrate: agent social graph edges pointing to agent-registry nodes
      for (const [, pair] of agentPairs) {
        const weight = Math.min(1.0, pair.count / 10);
        edges.push({
          source: `agent-registry:${pair.from}`,
          target: `agent-registry:${pair.to}`,
          type: 'messages',
          weight,
          substrate: 'cross',
        });
      }
    },
    (message) => errors.push(message),
  );

  return substrateResult(nodes, edges, errors, failedKinds);
}
