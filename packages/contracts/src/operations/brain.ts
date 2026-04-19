/**
 * BRAIN Super-Domain Operations (8 operations)
 *
 * BRAIN is the **unified cross-substrate graph** wrapping
 * `memory + nexus + tasks + conduit + signaldock` into a single
 * super-graph substrate. It is distinct from (and layered above) the
 * memory-only operations in `./memory.ts` which own observations,
 * patterns, decisions, learnings, tiers, and the PageIndex graph
 * scoped to `brain.db`.
 *
 * These wire-format contracts are the API surface consumed by:
 * - `@cleocode/brain` (T969 — living-brain package extraction)
 * - `packages/studio/src/routes/api/brain/*` HTTP routes (T970 — renamed
 *   from `/api/living-brain` as the canonical unified super-graph surface)
 * - CLI / SDK clients performing cross-substrate graph queries
 *
 * Node IDs are **substrate-prefixed** (`"task:T949"`, `"memory:O-abc"`,
 * `"code:symbol:foo"`) so cross-substrate edges are unambiguous and
 * deduplication is safe by ID equality alone. The substrate-specific
 * payload on `BrainNode.data` / `BrainEdge.data` is the ONE place where
 * `Record<string, unknown>` is legitimate — super-graph callers treat
 * it opaquely; individual substrate adapters own the concrete shape.
 *
 * SYNC: Canonical runtime implementation lives today at
 * `packages/studio/src/lib/server/living-brain/` (LBNode, LBEdge,
 * LBGraph, adapters, SSE stream). T969 extracts it to
 * `@cleocode/brain`; these contracts are that extraction's wire format.
 *
 * @task T962 — Orchestration Coherence v4 (BRAIN super-domain)
 * @task T968 — operations/brain.ts contract authoring (Wave B)
 * @see packages/studio/src/lib/server/living-brain/types.ts
 * @see packages/contracts/src/operations/memory.ts (distinct domain)
 */

// ============================================================================
// Shared BRAIN types (super-graph wire format)
// ============================================================================

/**
 * Substrate name enum — which underlying database a node/edge came from.
 *
 * @remarks
 * Matches `packages/studio/src/lib/server/living-brain/types.ts :: LBSubstrate`
 * (which T969 will extract to `@cleocode/brain`). `memory` here refers to the
 * `brain.db`-backed cognitive-memory substrate (observations/patterns/
 * decisions/learnings/PageIndex), aligning with the rename that produced
 * `./memory.ts` in T965.
 *
 * @task T962 / T968
 */
export type BrainSubstrateName = 'memory' | 'nexus' | 'tasks' | 'conduit' | 'signaldock';

/**
 * Concrete node type within a substrate (e.g. `observation`, `symbol`,
 * `task`, `session`, `agent`, `message`). Not constrained here because the
 * set is substrate-owned and open-ended; each substrate adapter documents
 * its own vocabulary.
 *
 * @task T962 / T968
 */
export type BrainNodeType = string;

/**
 * Substrate-prefixed node identifier.
 *
 * @example
 *   "task:T949"
 *   "memory:O-mo4abc123"
 *   "nexus:packages/core/src/store/sqlite-data-accessor.ts::createSqliteDataAccessor"
 *   "conduit:msg-7f3a2b1c"
 *   "signaldock:agent-cleo-prime"
 *
 * @remarks
 * The substrate prefix (before the first `:`) MUST match one of
 * `BrainSubstrateName`. The remainder is substrate-specific and opaque
 * to super-graph callers.
 *
 * @task T962 / T968
 */
export type BrainNodeId = string;

/**
 * Edge kind taxonomy used across the super-graph.
 *
 * @remarks
 * Concrete built-ins are enumerated for tooling autocompletion; the
 * `string` fallback keeps the type open-ended because substrate
 * adapters may introduce new kinds (e.g. `touches_code`, `authored_by`,
 * `supersedes`, `derived_from`) without a schema migration at this
 * layer.
 *
 * @task T962 / T968
 */
export type BrainEdgeKind =
  | 'parent'
  | 'depends'
  | 'blocks'
  | 'references'
  | 'discusses'
  | 'cites'
  | 'embeds'
  | 'touches_code'
  | 'messages'
  | string;

/**
 * A single node in the BRAIN super-graph.
 *
 * @remarks
 * The `data` field carries substrate-specific metadata (memory-tier info,
 * task status, nexus symbol kind, conduit message preview, etc.). This
 * is the ONE place `Record<string, unknown>` is justified: the
 * super-graph is polymorphic across substrates by definition, and the
 * statically-typed payload belongs inside each substrate adapter.
 *
 * @task T962 / T968
 */
export interface BrainNode {
  /** Substrate-prefixed identifier (see {@link BrainNodeId}). */
  id: BrainNodeId;
  /** Source substrate. */
  substrate: BrainSubstrateName;
  /** Concrete node type within the substrate (e.g. `observation`, `symbol`). */
  type: BrainNodeType;
  /** Human-readable display label. */
  label: string;
  /**
   * Substrate-specific payload. Shape is owned by the substrate adapter;
   * super-graph callers treat it opaquely.
   */
  data: Record<string, unknown>;
  /** ISO 8601 creation timestamp, when exposed by the substrate. */
  createdAt?: string;
  /** ISO 8601 last-update timestamp, when exposed by the substrate. */
  updatedAt?: string;
}

/**
 * A directed edge between two super-graph nodes.
 *
 * @remarks
 * Both endpoints reference {@link BrainNodeId} values. Edges may be
 * in-substrate (both endpoints share the same prefix) or cross-substrate
 * (bridges between e.g. `memory:…` and `nexus:…`).
 *
 * @task T962 / T968
 */
export interface BrainEdge {
  /** Source node id. */
  from: BrainNodeId;
  /** Target node id. */
  to: BrainNodeId;
  /** Semantic edge kind (see {@link BrainEdgeKind}). */
  kind: BrainEdgeKind;
  /**
   * Normalised weight in `[0, 1]`. Higher = stronger/more confident.
   * Produced by Hebbian/STDP training on memory edges, relation
   * confidence on nexus edges, and substrate-specific heuristics
   * elsewhere.
   */
  weight?: number;
  /** Substrate-specific payload (opaque at super-graph level). */
  data?: Record<string, unknown>;
}

/**
 * Per-substrate node and edge counters returned inside query results.
 *
 * @task T962 / T968
 */
export interface BrainSubstrateStats {
  /** Number of nodes contributed by the substrate. */
  nodes: number;
  /** Number of edges contributed by the substrate. */
  edges: number;
}

/**
 * Predicate bag applied per-substrate when filtering graph queries.
 *
 * @remarks
 * Each field is optional; adapters apply them in-substrate and ignore
 * any dimension they don't support. When multiple fields are set the
 * filter is an AND (e.g. `nodeType` ∈ {…} AND `labels` ⊆ node.labels
 * AND `textMatch` matches).
 *
 * @task T962 / T968
 */
export interface BrainGraphFilter {
  /** Restrict to these node types (per-substrate vocabulary). */
  nodeType?: string[];
  /** Restrict to nodes carrying all of these labels. */
  labels?: string[];
  /** Free-text filter applied to the node label (substrate-dependent matcher). */
  textMatch?: string;
}

// ============================================================================
// 1. brain.query — fetch unified graph
// ============================================================================

/**
 * Parameters for `brain.query`.
 *
 * @remarks
 * `limit` is a cross-substrate total cap; adapters share the budget
 * evenly (`limit / substrates.length`). Omitting `substrates`
 * requests all five.
 *
 * @task T962 / T968
 */
export interface BrainQueryParams {
  /** Filter by substrate names. Default: all substrates. */
  substrates?: BrainSubstrateName[];
  /**
   * Maximum total nodes to return across all requested substrates.
   * Per-substrate budget is `limit / substrates.length`. Default `500`.
   */
  limit?: number;
  /** Predicate bag applied per-substrate. */
  filter?: BrainGraphFilter;
}

/**
 * Result of `brain.query`.
 *
 * @task T962 / T968
 */
export interface BrainQueryResult {
  /** Merged, deduplicated nodes across substrates. */
  nodes: BrainNode[];
  /** Edges (may reference stub nodes injected for cross-substrate targets). */
  edges: BrainEdge[];
  /** Aggregate and per-substrate counters. */
  stats: {
    /** Per-substrate node/edge contribution. */
    perSubstrate: Record<BrainSubstrateName, BrainSubstrateStats>;
    /** Deduplicated total node count. */
    totalNodes: number;
    /** Edge count (no dedup — edges are unique by (from,to,kind)). */
    totalEdges: number;
  };
}

// ============================================================================
// 2. brain.node — fetch single node by substrate-prefixed id
// ============================================================================

/**
 * Parameters for `brain.node`.
 *
 * @task T962 / T968
 */
export interface BrainNodeParams {
  /**
   * Substrate-prefixed id to fetch.
   *
   * @example `"task:T949"`, `"memory:O-abc"`, `"code:symbol:foo"`.
   */
  id: BrainNodeId;
}

/**
 * Result of `brain.node`.
 *
 * @task T962 / T968
 */
export interface BrainNodeResult {
  /** The requested node. */
  node: BrainNode;
  /** Neighbour edges partitioned by direction relative to `node.id`. */
  neighbors: {
    /** Edges whose `to` equals the requested node. */
    inbound: BrainEdge[];
    /** Edges whose `from` equals the requested node. */
    outbound: BrainEdge[];
  };
}

// ============================================================================
// 3. brain.substrate — fetch all nodes/edges for one substrate
// ============================================================================

/**
 * Parameters for `brain.substrate`.
 *
 * @remarks
 * Equivalent to `brain.query` with `substrates: [substrate]`, but
 * provides a cleaner URL binding at the HTTP layer and emits a
 * structured 400 error for unknown substrate names.
 *
 * @task T962 / T968
 */
export interface BrainSubstrateParams {
  /** Which substrate to project. */
  substrate: BrainSubstrateName;
  /** Maximum nodes to return. Default `500`. */
  limit?: number;
  /** Predicate bag applied to the substrate. */
  filter?: BrainGraphFilter;
}

/**
 * Result of `brain.substrate`.
 *
 * @task T962 / T968
 */
export interface BrainSubstrateResult {
  /** The substrate that was projected. */
  substrate: BrainSubstrateName;
  /** Nodes contributed by this substrate. */
  nodes: BrainNode[];
  /** Edges contributed by this substrate. */
  edges: BrainEdge[];
  /** True when the result was capped by `limit`. */
  truncated: boolean;
}

// ============================================================================
// 4. brain.stream — SSE stream of graph mutation events
// ============================================================================

/**
 * Discriminated union of BRAIN super-graph mutation events.
 *
 * @remarks
 * Emitted as Server-Sent Events by the `brain.stream` endpoint. Every
 * variant carries an ISO 8601 `ts` field so clients can sequence events
 * even when they arrive out-of-order.
 *
 * - `hello`          — sent immediately on connect; confirms the stream is live.
 * - `heartbeat`      — sent every 30 s to prevent connection timeout.
 * - `node.create`    — a new node appeared in any substrate.
 * - `node.update`    — an existing node's metadata changed.
 * - `edge.strengthen` — an edge weight was updated (Hebbian/STDP or relation).
 * - `edge.create`    — a new edge appeared.
 * - `task.status`    — shortcut for tasks-substrate status changes.
 * - `message.send`   — shortcut for conduit-substrate message inserts.
 *
 * Mirrors `packages/studio/src/lib/server/living-brain/types.ts :: LBStreamEvent`
 * with super-graph-aligned identifiers (ids are substrate-prefixed).
 *
 * @task T962 / T968
 */
export type BrainStreamEvent =
  | { type: 'hello'; ts: string }
  | { type: 'heartbeat'; ts: string }
  | { type: 'node.create'; node: BrainNode; ts: string }
  | { type: 'node.update'; node: BrainNode; ts: string }
  | {
      type: 'edge.strengthen';
      from: BrainNodeId;
      to: BrainNodeId;
      kind: BrainEdgeKind;
      weight: number;
      ts: string;
    }
  | {
      type: 'edge.create';
      from: BrainNodeId;
      to: BrainNodeId;
      kind: BrainEdgeKind;
      weight?: number;
      ts: string;
    }
  | { type: 'task.status'; taskId: string; status: string; ts: string }
  | {
      type: 'message.send';
      messageId: string;
      fromAgentId: string;
      toAgentId: string;
      preview: string;
      ts: string;
    };

/**
 * Parameters for `brain.stream`.
 *
 * @remarks
 * Clients may filter by substrate (only emit events from those DBs) and
 * by event kind (only emit e.g. `node.create`). Both default to "all".
 * `sinceTs` resumes from a prior ISO 8601 cursor when reconnecting.
 *
 * @task T962 / T968
 */
export interface BrainStreamParams {
  /** Restrict events to these substrates. Default: all. */
  substrates?: BrainSubstrateName[];
  /** Restrict to these event kinds (e.g. `['node.create', 'edge.strengthen']`). */
  kinds?: Array<BrainStreamEvent['type']>;
  /**
   * ISO 8601 resume cursor. When set, the server replays events emitted
   * at or after `sinceTs` before tailing the live stream.
   */
  sinceTs?: string;
}

/**
 * Result of `brain.stream`.
 *
 * @remarks
 * The stream is transport-flexible (HTTP SSE in the reference adapter,
 * WebSocket or long-poll in alternates). The `Result` shape describes
 * the **per-frame** payload clients receive; transport framing is an
 * adapter concern.
 *
 * @task T962 / T968
 */
export interface BrainStreamResult {
  /** One decoded SSE frame. */
  event: BrainStreamEvent;
}

// ============================================================================
// 5. brain.bridges — list cross-substrate edges
// ============================================================================

/**
 * Parameters for `brain.bridges`.
 *
 * @remarks
 * Returns edges whose endpoints are in **different** substrates — e.g.
 * `memory:O-abc → nexus:symbol:foo` (cognitive memory citing code) or
 * `task:T949 → memory:D-decision-123` (task grounded in a decision).
 * These are the substrate bridges that let the super-graph behave as a
 * single knowledge surface rather than five isolated databases.
 *
 * @task T962 / T968
 */
export interface BrainBridgesParams {
  /**
   * Restrict to bridges whose endpoints lie in this substrate set.
   * When set, only bridges where **both** endpoints fall inside
   * `substrates` are returned. Default: all substrates.
   */
  substrates?: BrainSubstrateName[];
  /** Restrict to these edge kinds. Default: all kinds. */
  kinds?: BrainEdgeKind[];
  /** Minimum edge weight to include. Default `0`. */
  minWeight?: number;
  /** Max edges to return. Default `500`. */
  limit?: number;
}

/**
 * Result of `brain.bridges`.
 *
 * @task T962 / T968
 */
export interface BrainBridgesResult {
  /** Cross-substrate edges matching the query. */
  bridges: BrainEdge[];
  /** Per-pair counts keyed by `"${fromSubstrate}->${toSubstrate}"`. */
  pairCounts: Record<string, number>;
  /** Total bridges returned. */
  total: number;
}

// ============================================================================
// 6. brain.neighborhood — BFS expand from a seed node, N hops
// ============================================================================

/**
 * Parameters for `brain.neighborhood`.
 *
 * @remarks
 * Breadth-first expansion from `seed` up to `hops` edges. Callers that
 * need only direct neighbours should use `hops: 1`. Deep traversals
 * should pair `hops` with `maxNodes` to bound fan-out.
 *
 * @task T962 / T968
 */
export interface BrainNeighborhoodParams {
  /** Seed node id. */
  seed: BrainNodeId;
  /** Max hops (BFS depth). Default `1`. */
  hops?: number;
  /** Cap on total returned nodes. Default `200`. */
  maxNodes?: number;
  /** Restrict traversal to these edge kinds. Default: all. */
  edgeKinds?: BrainEdgeKind[];
  /** Restrict traversal to these substrates. Default: all. */
  substrates?: BrainSubstrateName[];
  /** Minimum edge weight to traverse. Default `0`. */
  minWeight?: number;
}

/**
 * A single node visited during neighborhood expansion.
 *
 * @task T962 / T968
 */
export interface BrainNeighborhoodNode {
  /** The visited node. */
  node: BrainNode;
  /** BFS distance from the seed (`0` = seed itself). */
  depth: number;
}

/**
 * Result of `brain.neighborhood`.
 *
 * @task T962 / T968
 */
export interface BrainNeighborhoodResult {
  /** Seed node id that was expanded. */
  seed: BrainNodeId;
  /** Nodes visited, annotated with BFS depth. */
  nodes: BrainNeighborhoodNode[];
  /** Edges traversed during expansion. */
  edges: BrainEdge[];
  /** Maximum depth actually reached (≤ requested `hops`). */
  reachedDepth: number;
  /** True when the traversal was capped by `maxNodes`. */
  truncated: boolean;
}

// ============================================================================
// 7. brain.search — text/label search across all substrates
// ============================================================================

/**
 * Parameters for `brain.search`.
 *
 * @remarks
 * Cross-substrate text search. Each adapter picks the best available
 * matcher (FTS5 for memory.db, identifier-substring for nexus, title
 * match for tasks, etc.) and contributes hits scored on a normalised
 * `[0, 1]` relevance axis. Results are fused by relevance desc.
 *
 * @task T962 / T968
 */
export interface BrainSearchParams {
  /** Search query (required, non-empty). */
  query: string;
  /** Restrict to these substrates. Default: all. */
  substrates?: BrainSubstrateName[];
  /** Restrict to these node types. Default: all. */
  nodeTypes?: BrainNodeType[];
  /** Max results. Default `50`. */
  limit?: number;
}

/**
 * A single fused search hit.
 *
 * @task T962 / T968
 */
export interface BrainSearchHit {
  /** The matched node. */
  node: BrainNode;
  /** Normalised relevance in `[0, 1]`. Higher = better. */
  score: number;
  /** Which substrate contributed this hit. */
  substrate: BrainSubstrateName;
  /** Adapter that produced the score (e.g. `fts`, `identifier`, `title`). */
  matcher: string;
}

/**
 * Result of `brain.search`.
 *
 * @task T962 / T968
 */
export interface BrainSearchResult {
  /** Hits ranked by `score` desc. */
  hits: BrainSearchHit[];
  /** Total hit count (may exceed `hits.length` when `limit` applied). */
  total: number;
  /** Estimated token weight of the payload (for JIT retrieval budgeting). */
  tokensEstimated: number;
}

// ============================================================================
// 8. brain.stats — graph statistics per substrate
// ============================================================================

/**
 * Parameters for `brain.stats`.
 *
 * @remarks
 * Zero required params — returns the full super-graph telemetry
 * snapshot. `substrates` narrows the report when only part of the
 * graph matters to the caller.
 *
 * @task T962 / T968
 */
export interface BrainStatsParams {
  /** Restrict the report to these substrates. Default: all. */
  substrates?: BrainSubstrateName[];
}

/**
 * Per-substrate statistics returned inside `BrainStatsResult`.
 *
 * @task T962 / T968
 */
export interface BrainSubstrateReport {
  /** Substrate name. */
  substrate: BrainSubstrateName;
  /** Node count by {@link BrainNodeType}. */
  nodesByType: Array<{ type: BrainNodeType; count: number }>;
  /** Edge count by {@link BrainEdgeKind}. */
  edgesByKind: Array<{ kind: BrainEdgeKind; count: number }>;
  /** Total nodes for the substrate. */
  totalNodes: number;
  /** Total edges for the substrate. */
  totalEdges: number;
  /** ISO 8601 timestamp of the most recent mutation, when known. */
  lastMutationAt: string | null;
}

/**
 * Result of `brain.stats`.
 *
 * @task T962 / T968
 */
export interface BrainStatsResult {
  /** Per-substrate telemetry. */
  perSubstrate: BrainSubstrateReport[];
  /** Total nodes across all reported substrates. */
  totalNodes: number;
  /** Total edges across all reported substrates. */
  totalEdges: number;
  /** Count of cross-substrate bridges included in `totalEdges`. */
  bridgeCount: number;
  /** ISO 8601 timestamp when the report was computed. */
  generatedAt: string;
}
