/**
 * CLEO Studio — graph API client helpers.
 *
 * Provides typed wrappers around the `/api/v1/graph` endpoint for use in
 * SvelteKit load functions, components, and stores.
 *
 * All functions are async and return their result shapes directly. Network
 * errors are surfaced as thrown `Error` instances — callers should wrap in
 * try/catch when used in non-critical display paths.
 *
 * Design notes:
 * - Uses the browser `fetch` API; compatible with SvelteKit's load context
 *   `fetch` via dependency injection.
 * - Response types mirror the SDK types from `brain-page-nodes.ts` but are
 *   re-declared here to avoid a hard dependency on `@cleocode/core` in the
 *   Studio client bundle.
 *
 * @task T945
 * @epic T1056
 */

// ---------------------------------------------------------------------------
// Response types (mirrors brain-page-nodes.ts SDK types)
// ---------------------------------------------------------------------------

/**
 * Sentience-layer node type strings as returned by the API.
 *
 * `msg` internal type is exposed as `conduit_message` for self-documentation.
 */
export type SentienceNodeType =
  | 'task'
  | 'decision'
  | 'observation'
  | 'symbol'
  | 'conduit_message'
  | 'llmtxt';

/**
 * A single brain graph node returned by `GET /api/v1/graph`.
 */
export interface GraphApiNode {
  /** Stable composite ID: `'<type>:<source-id>'`. */
  id: string;
  /** API-facing node type. */
  type: SentienceNodeType;
  /** Human-readable label. */
  label: string;
  /** Quality score 0.0–1.0. */
  qualityScore: number;
  /** Optional type-specific metadata JSON string. */
  metadataJson: string | null;
  /** ISO timestamp of creation. */
  createdAt: string;
}

/**
 * A single edge returned by `GET /api/v1/graph`.
 */
export interface GraphApiEdge {
  /** Source node ID. */
  fromId: string;
  /** Target node ID. */
  toId: string;
  /** Edge type (canonical brain edge vocabulary). */
  edgeType: string;
  /** Edge weight 0.0–1.0. */
  weight: number;
  /** ISO timestamp of creation. */
  createdAt: string;
}

/**
 * Full response shape from `GET /api/v1/graph`.
 */
export interface GraphApiResponse {
  /** Nodes of the sentience types (task, decision, observation, symbol, conduit_message, llmtxt). */
  nodes: GraphApiNode[];
  /** Edges where both endpoints are within the returned node set. */
  edges: GraphApiEdge[];
  /** Total node count (before limit was applied). */
  totalNodes: number;
  /** Total edge count (before filtering). */
  totalEdges: number;
}

// ---------------------------------------------------------------------------
// Client helpers
// ---------------------------------------------------------------------------

/**
 * Fetch the sentience-layer graph from the Studio server.
 *
 * Calls `GET /api/v1/graph?limit=<limit>` and returns the typed response.
 *
 * @param fetchFn - The `fetch` function to use (browser or SvelteKit load context).
 * @param limit - Maximum number of nodes to return. Defaults to 500.
 * @returns Full graph API response.
 *
 * @example
 * ```typescript
 * // In a SvelteKit +page.ts load function:
 * import { fetchGraph } from '$lib/graph-api.js';
 * export const load = async ({ fetch }) => ({
 *   graph: await fetchGraph(fetch),
 * });
 *
 * // In a browser script:
 * import { fetchGraph } from '$lib/graph-api.js';
 * const graph = await fetchGraph(window.fetch.bind(window));
 * ```
 *
 * @task T945
 */
export async function fetchGraph(fetchFn: typeof fetch, limit = 500): Promise<GraphApiResponse> {
  const url = `/api/v1/graph?limit=${limit}`;
  const res = await fetchFn(url);
  if (!res.ok) {
    throw new Error(`[graph-api] GET ${url} returned ${res.status}: ${res.statusText}`);
  }
  return (await res.json()) as GraphApiResponse;
}

/**
 * Fetch graph nodes filtered to a specific sentience node type.
 *
 * Convenience wrapper around {@link fetchGraph} that filters the response
 * to nodes of the requested type. Edges are re-filtered to only those where
 * both endpoints are within the filtered node set.
 *
 * @param fetchFn - The `fetch` function to use.
 * @param type - Node type to filter to.
 * @param limit - Maximum nodes to fetch from the server before filtering.
 * @returns Filtered graph response.
 *
 * @task T945
 */
export async function fetchGraphByType(
  fetchFn: typeof fetch,
  type: SentienceNodeType,
  limit = 500,
): Promise<GraphApiResponse> {
  const full = await fetchGraph(fetchFn, limit);
  const filtered = full.nodes.filter((n) => n.type === type);
  const ids = new Set(filtered.map((n) => n.id));
  const edges = full.edges.filter((e) => ids.has(e.fromId) && ids.has(e.toId));
  return {
    nodes: filtered,
    edges,
    totalNodes: full.totalNodes,
    totalEdges: full.totalEdges,
  };
}

/**
 * Return the count of nodes of each sentience type from the graph response.
 *
 * Useful for display in the Studio graph overview panel.
 *
 * @param graph - A graph API response (from {@link fetchGraph}).
 * @returns Object mapping each node type to its count in the response.
 *
 * @task T945
 */
export function countByType(graph: GraphApiResponse): Record<SentienceNodeType, number> {
  const counts: Record<SentienceNodeType, number> = {
    task: 0,
    decision: 0,
    observation: 0,
    symbol: 0,
    conduit_message: 0,
    llmtxt: 0,
  };
  for (const node of graph.nodes) {
    counts[node.type] = (counts[node.type] ?? 0) + 1;
  }
  return counts;
}
