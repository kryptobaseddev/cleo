/**
 * Unified node and edge model for the Living Brain API.
 *
 * Provides a substrate-agnostic projection across all five CLEO databases:
 * BRAIN, NEXUS, TASKS, CONDUIT, SIGNALDOCK.
 *
 * Every node carries a substrate-prefixed ID so cross-substrate edges
 * can reference nodes unambiguously, e.g. "brain:O-abc" vs "nexus:sym-123".
 *
 * @see docs/plans/brain-synaptic-visualization-research.md §5.2
 */

/**
 * All possible node kinds across the five substrates.
 *
 * - observation / decision / pattern / learning → BRAIN typed tables
 * - task / session → TASKS
 * - symbol / file → NEXUS
 * - agent → SIGNALDOCK
 * - message → CONDUIT
 */
export type LBNodeKind =
  | 'observation'
  | 'decision'
  | 'pattern'
  | 'learning'
  | 'task'
  | 'session'
  | 'symbol'
  | 'file'
  | 'agent'
  | 'message';

/** Which database a node or edge originates from. */
export type LBSubstrate = 'brain' | 'nexus' | 'tasks' | 'conduit' | 'signaldock';

/**
 * A single node in the unified Living Brain graph.
 *
 * `id` is always substrate-prefixed: `"brain:O-abc"`, `"nexus:sym-123"`, etc.
 * This prevents collisions when merging results from multiple databases.
 */
export interface LBNode {
  /** Substrate-prefixed identifier, e.g. "brain:O-abc", "nexus:sym-123". */
  id: string;
  /** Semantic category of this node. */
  kind: LBNodeKind;
  /** Source database. */
  substrate: LBSubstrate;
  /** Human-readable display label. */
  label: string;
  /**
   * Optional numeric weight.
   * - BRAIN: `quality_score` (0.0–1.0)
   * - NEXUS: in-degree / caller count
   * - TASKS: priority rank (critical=4, high=3, medium=2, low=1)
   * - CONDUIT/SIGNALDOCK: omitted
   */
  weight?: number;
  /**
   * ISO-8601 creation timestamp, or `null` when the substrate does not
   * expose a timestamp for this node type.
   *
   * - BRAIN: `brain_*` tables `created_at` column (ISO text)
   * - NEXUS: `nexus_nodes.indexed_at` column (ISO text)
   * - TASKS: `tasks.created_at` / `sessions.started_at` column (ISO text)
   * - CONDUIT: `messages.created_at` column converted from UNIX epoch (INTEGER)
   * - SIGNALDOCK: `agents.created_at` column converted from UNIX epoch (INTEGER), or null
   */
  createdAt: string | null;
  /** Substrate-specific metadata (source row fields). */
  meta: Record<string, unknown>;
}

/**
 * A directed edge between two nodes in the unified Living Brain graph.
 *
 * Both `source` and `target` reference `LBNode.id` values (substrate-prefixed).
 * Cross-substrate edges use `substrate: 'cross'`.
 */
export interface LBEdge {
  /** Source node ID (substrate-prefixed). */
  source: string;
  /** Target node ID (substrate-prefixed). */
  target: string;
  /**
   * Semantic edge type.
   *
   * In-substrate examples: 'supersedes' | 'derived_from' | 'calls' | 'imports'
   * Cross-substrate examples: 'mentions' | 'applies_to' | 'authored_by' | 'modified'
   */
  type: string;
  /**
   * Edge weight in [0, 1].
   * - BRAIN: `brain_page_edges.weight` (Hebbian/STDP-trained)
   * - NEXUS: relation `confidence`
   * - Others: 0.5 default
   */
  weight: number;
  /** Which substrate produced this edge, or 'cross' for synthesized edges. */
  substrate: LBSubstrate | 'cross';
}

/**
 * Unified graph response returned by the Living Brain API.
 *
 * `nodes` and `edges` are the combined projection.
 * `counts` breaks down how many nodes/edges each substrate contributed.
 * `truncated` is true when results were capped by the limit parameter.
 */
export interface LBGraph {
  nodes: LBNode[];
  edges: LBEdge[];
  counts: {
    nodes: Record<LBSubstrate, number>;
    edges: Record<LBSubstrate | 'cross', number>;
  };
  truncated: boolean;
}

/**
 * Query options forwarded from API route query params to substrate adapters.
 *
 * `substrates` filters to specific databases; omit for all five.
 * `limit` caps total node count (default 500, max 2000).
 * `minWeight` excludes nodes/edges below this quality threshold.
 * `projectCtx` resolves per-project DB paths; required for correct multi-project routing.
 */
export interface LBQueryOptions {
  /** Which substrates to include. Defaults to all. */
  substrates?: LBSubstrate[];
  /** Maximum number of nodes to return across all substrates. Default 500. */
  limit?: number;
  /** Minimum quality/weight to include (0.0–1.0). Default 0. */
  minWeight?: number;
  /**
   * Active project context from `event.locals.projectCtx`.
   * Per-project substrates (brain, tasks, conduit) use this to resolve DB paths.
   * When absent, adapters fall back to the process-default paths.
   */
  projectCtx?: import('../project-context.js').ProjectContext;
}

/**
 * Discriminated union of all SSE event payloads emitted by
 * `GET /api/living-brain/stream`.
 *
 * Every variant carries a top-level `ts` field (ISO-8601 timestamp) so
 * clients can sequence events even when they arrive out-of-order.
 *
 * - `hello`           — sent immediately on connect; confirms the stream is live.
 * - `heartbeat`       — sent every 30 s to prevent connection timeout.
 * - `node.create`     — a new row was inserted into `brain_observations`.
 * - `edge.strengthen` — a `brain_page_edges` row had its `weight` column updated.
 * - `task.status`     — a `tasks` row changed its `status` column.
 * - `message.send`    — a new row was inserted into `conduit messages`.
 */
export type LBStreamEvent =
  | { type: 'hello'; ts: string }
  | { type: 'heartbeat'; ts: string }
  | { type: 'node.create'; node: LBNode; ts: string }
  | {
      type: 'edge.strengthen';
      fromId: string;
      toId: string;
      edgeType: string;
      weight: number;
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

/** Connection state for the SSE client subscription. */
export type LBConnectionStatus = 'connecting' | 'connected' | 'error' | 'disconnected';
