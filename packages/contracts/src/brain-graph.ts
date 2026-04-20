/**
 * Canonical Brain unified-graph types.
 *
 * These are the **single source of truth** for `BrainNode`, `BrainEdge`,
 * `BrainGraph`, and their supporting types across the entire CLEO monorepo.
 *
 * All other packages MUST import these types from `@cleocode/contracts`
 * (or a relative path into this file) rather than defining their own copies.
 * Runtime packages such as `@cleocode/brain` re-export these types directly
 * so downstream consumers do not need to change their import path.
 *
 * ## Shape rationale
 *
 * The types here are the **runtime** shapes produced by the substrate
 * adapters in `@cleocode/brain` and consumed by every graph renderer,
 * SSE stream, and API route in `@cleocode/studio`. The wire-format
 * operation contracts in `./operations/brain.ts` are intentionally distinct
 * (they use `from`/`to`/`kind` field names and a separate `BrainSubstrateName`
 * vocabulary) and are namespaced under `ops.*` to avoid collisions.
 *
 * @task T989 — canonical type unification (was split across packages/brain
 *   and packages/contracts/operations/brain)
 * @task T973 — LB* → Brain* rename
 * @task T969 — `@cleocode/brain` package extraction
 * @see packages/brain/src/types.ts (re-exports from here for backwards compat)
 * @see packages/contracts/src/operations/brain.ts (wire-format / ops contracts)
 * @see docs/plans/brain-synaptic-visualization-research.md §5.2
 */

// ---------------------------------------------------------------------------
// Supporting enum types
// ---------------------------------------------------------------------------

/**
 * All possible node kinds across the five CLEO substrates.
 *
 * - `observation` / `decision` / `pattern` / `learning` → BRAIN typed tables
 * - `task` / `session` → TASKS
 * - `symbol` / `file` → NEXUS
 * - `agent` → SIGNALDOCK
 * - `message` → CONDUIT
 */
export type BrainNodeKind =
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

/**
 * Which database a node or edge originates from.
 *
 * @remarks
 * Uses the literal `'brain'` to match the on-disk `brain.db` filename.
 * This differs from `BrainSubstrateName` in `./operations/brain.ts` which
 * uses `'memory'` to align with the cognitive-memory domain rename. Callers
 * that bridge runtime output to the wire format translate between the two
 * naming planes at the adapter boundary.
 */
export type BrainSubstrate = 'brain' | 'nexus' | 'tasks' | 'conduit' | 'signaldock';

// ---------------------------------------------------------------------------
// Canonical graph node
// ---------------------------------------------------------------------------

/**
 * A single node in the unified CLEO Brain graph.
 *
 * The `id` field is always substrate-prefixed so nodes from different
 * substrates can be merged without collisions:
 * - `"brain:O-abc"` — a brain observation
 * - `"nexus:sym-123"` — a nexus code symbol
 * - `"tasks:T949"` — a CLEO task
 * - `"conduit:msg-7f3a2b1c"` — a conduit message
 * - `"signaldock:agent-cleo-prime"` — a SignalDock agent
 *
 * @remarks
 * This is the shape produced by all substrate adapters in `@cleocode/brain`
 * and consumed by graph renderers and SSE streams. It differs from the
 * `BrainNodeWire` wire-format type in `./operations/brain.ts` which uses
 * `type`/`data` instead of `kind`/`meta`.
 */
export interface BrainNode {
  /** Substrate-prefixed identifier, e.g. `"brain:O-abc"`, `"nexus:sym-123"`. */
  id: string;
  /** Semantic category of this node. */
  kind: BrainNodeKind;
  /** Source database. */
  substrate: BrainSubstrate;
  /** Human-readable display label. */
  label: string;
  /**
   * Optional numeric weight in `[0, 1]`.
   *
   * - BRAIN: `quality_score` (0.0–1.0)
   * - NEXUS: in-degree / caller count (normalised)
   * - TASKS: priority rank (critical=4 → 1.0, low=1 → 0.25)
   * - CONDUIT / SIGNALDOCK: omitted
   */
  weight?: number;
  /**
   * ISO-8601 creation timestamp, or `null` when the substrate does not
   * expose a timestamp for this node type.
   *
   * - BRAIN: `brain_*` tables `created_at` column (ISO text)
   * - NEXUS: `nexus_nodes.indexed_at` column (ISO text)
   * - TASKS: `tasks.created_at` / `sessions.started_at` column (ISO text)
   * - CONDUIT: `messages.created_at` converted from UNIX epoch (INTEGER)
   * - SIGNALDOCK: `agents.created_at` converted from UNIX epoch (INTEGER), or null
   */
  createdAt: string | null;
  /** Substrate-specific metadata (source row fields, opaque to super-graph callers). */
  meta: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Canonical graph edge
// ---------------------------------------------------------------------------

/**
 * A directed edge between two nodes in the unified CLEO Brain graph.
 *
 * Both `source` and `target` reference `BrainNode.id` values
 * (substrate-prefixed). Cross-substrate edges use `substrate: 'cross'`.
 *
 * @remarks
 * This type uses `source`/`target`/`type` field names (matching D3/Cosmograph
 * conventions). The wire-format type `BrainEdgeWire` in `./operations/brain.ts`
 * uses `from`/`to`/`kind` and is a separate concern.
 */
export interface BrainEdge {
  /** Source node ID (substrate-prefixed, references {@link BrainNode.id}). */
  source: string;
  /** Target node ID (substrate-prefixed, references {@link BrainNode.id}). */
  target: string;
  /**
   * Semantic edge type.
   *
   * In-substrate examples: `'supersedes'` | `'derived_from'` | `'calls'` | `'imports'`
   * Cross-substrate examples: `'mentions'` | `'applies_to'` | `'authored_by'` | `'modified'`
   */
  type: string;
  /**
   * Edge weight in `[0, 1]`. Higher = stronger / more confident.
   *
   * - BRAIN: `brain_page_edges.weight` (Hebbian/STDP-trained)
   * - NEXUS: relation `confidence`
   * - Others: `0.5` default
   */
  weight: number;
  /** Which substrate produced this edge, or `'cross'` for synthesized cross-substrate edges. */
  substrate: BrainSubstrate | 'cross';
}

// ---------------------------------------------------------------------------
// Canonical graph response
// ---------------------------------------------------------------------------

/**
 * Unified graph response returned by the Brain unified-graph API and the
 * `getAllSubstrates` adapter in `@cleocode/brain`.
 *
 * - `nodes` / `edges`: combined projection across all requested substrates.
 * - `counts`: per-substrate contribution breakdown.
 * - `truncated`: `true` when results were capped by the `limit` parameter.
 */
export interface BrainGraph {
  /** Merged, deduplicated nodes across all requested substrates. */
  nodes: BrainNode[];
  /** Directed edges (may reference stub nodes for cross-substrate targets). */
  edges: BrainEdge[];
  /** Per-substrate node/edge contribution counts. */
  counts: {
    /** Nodes contributed per substrate. */
    nodes: Record<BrainSubstrate, number>;
    /** Edges contributed per substrate (including `'cross'`). */
    edges: Record<BrainSubstrate | 'cross', number>;
  };
  /** `true` when the response was capped by the node limit. */
  truncated: boolean;
}

// ---------------------------------------------------------------------------
// Project context (minimal, used for path resolution in adapters)
// ---------------------------------------------------------------------------

/**
 * Minimum project context required by Brain substrate adapters to resolve
 * per-project database paths.
 *
 * The studio's richer `ProjectContext` type carries additional fields
 * (`projectId`, `name`, `brainDbExists`, etc.) and satisfies this interface
 * via TypeScript structural typing.
 *
 * @remarks
 * Defined here (rather than in `@cleocode/brain`) so that `BrainQueryOptions`
 * can reference it without creating a circular dependency.
 */
export interface BrainProjectContext {
  /** Absolute path to the project root. */
  projectPath: string;
  /** Absolute path to `brain.db` for this project. */
  brainDbPath: string;
  /** Absolute path to `tasks.db` for this project. */
  tasksDbPath: string;
}

// ---------------------------------------------------------------------------
// Query options
// ---------------------------------------------------------------------------

/**
 * Query options forwarded from API route query parameters to substrate adapters.
 *
 * - `substrates`: filter to specific databases; omit for all five.
 * - `limit`: cap on total node count (default 500, max 2000).
 * - `minWeight`: excludes nodes/edges below this quality threshold.
 * - `projectCtx`: resolves per-project DB paths; required for correct
 *   multi-project routing.
 */
export interface BrainQueryOptions {
  /** Which substrates to include. Defaults to all five. */
  substrates?: BrainSubstrate[];
  /** Maximum number of nodes to return across all substrates. Default `500`. */
  limit?: number;
  /** Minimum quality/weight threshold for nodes and edges (0.0–1.0). Default `0`. */
  minWeight?: number;
  /**
   * Active project context from `event.locals.projectCtx`.
   * Per-project substrates (brain, tasks, conduit) use this to resolve DB paths.
   * When absent, adapters fall back to the process-default paths.
   */
  projectCtx?: BrainProjectContext;
}

// ---------------------------------------------------------------------------
// SSE stream event union
// ---------------------------------------------------------------------------

/**
 * Discriminated union of all SSE event payloads emitted by
 * `GET /api/brain/stream`.
 *
 * Every variant carries a top-level `ts` field (ISO-8601 timestamp) so
 * clients can sequence events even when they arrive out-of-order.
 *
 * - `hello`            — sent immediately on connect; confirms the stream is live.
 * - `heartbeat`        — sent every 30 s to prevent connection timeout.
 * - `node.create`      — a new row was inserted into `brain_observations`.
 * - `edge.strengthen`  — a `brain_page_edges` row had its `weight` updated.
 * - `task.status`      — a `tasks` row changed its `status` column.
 * - `message.send`     — a new row was inserted into conduit messages.
 */
export type BrainStreamEvent =
  | { type: 'hello'; ts: string }
  | { type: 'heartbeat'; ts: string }
  | { type: 'node.create'; node: BrainNode; ts: string }
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

/** Connection state for the SSE client subscription in the studio brain viewer. */
export type BrainConnectionStatus = 'connecting' | 'connected' | 'error' | 'disconnected';
