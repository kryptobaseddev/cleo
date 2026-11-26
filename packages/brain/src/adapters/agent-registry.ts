/**
 * AGENT-REGISTRY substrate adapter for the Living Brain API.
 *
 * Read-only visualization path. Queries `agent_registry_agents` in the global
 * `cleo.db` and returns one BrainNode per active agent. The retired standalone
 * `signaldock.db` is never read (T14583).
 *
 * The consolidated store has no declared agent-to-agent social graph
 * (`agent_registry_agent_connections` records transport connections, not
 * pairs), so this adapter emits no edges; agent→agent edges come from the
 * CONDUIT substrate's message pairs.
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
 * @task T14583 (read the global cleo.db)
 */

import { allTyped, readGlobalStore, substrateResult, tryQuery } from '../db-connections.js';
import type { BrainEdge, BrainNode, BrainQueryOptions, BrainSubstrateResult } from '../types.js';

/** Raw row from `agent_registry_agents`. */
interface AgentRow {
  agent_id: string;
  name: string;
  status: string;
  /** ISO-8601 timestamp, normalised by the query; null when unparseable. */
  created_at: string | null;
}

/**
 * Returns all BrainNodes and BrainEdges sourced from the Agent Registry.
 *
 * Fetches the most recently registered active agents. Agent nodes serve as
 * the cross-substrate identity anchors.
 *
 * @param options - Query options (limit).
 * @returns Nodes (and no edges) from the AGENT-REGISTRY substrate.
 */
export function getAgentRegistrySubstrate(options: BrainQueryOptions = {}): BrainSubstrateResult {
  const perSubstrateLimit = Math.ceil((options.limit ?? 500) / 5);

  const nodes: BrainNode[] = [];
  const edges: BrainEdge[] = [];
  const errors: string[] = [];

  readGlobalStore(
    (db) => {
      // created_at is ISO text; a legacy epoch-seconds integer is converted too.
      const agentRows = tryQuery(errors, 'agent_registry_agents', () =>
        allTyped<AgentRow>(
          db.prepare(
            `SELECT agent_id, name, status,
                  CASE WHEN typeof(created_at) = 'integer'
                    THEN strftime('%Y-%m-%dT%H:%M:%S', created_at, 'unixepoch')
                    ELSE strftime('%Y-%m-%dT%H:%M:%S', created_at)
                  END AS created_at
           FROM main.agent_registry_agents
           WHERE is_active = 1
           ORDER BY created_at DESC
           LIMIT ?`,
          ),
          perSubstrateLimit,
        ),
      );

      for (const row of agentRows) {
        nodes.push({
          id: `agent-registry:${row.agent_id}`,
          kind: 'agent',
          substrate: 'agent-registry',
          label: row.name,
          weight: row.status === 'online' ? 1.0 : 0.5,
          createdAt: row.created_at,
          meta: {
            status: row.status,
            created_at: row.created_at,
          },
        });
      }
    },
    (message) => errors.push(message),
  );

  return substrateResult(nodes, edges, errors);
}
