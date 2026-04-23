/**
 * Memory Domain Operations (31 operations)
 *
 * Query operations: 21
 * Mutate operations: 10
 *
 * memory is the cognitive memory subsystem backed by `brain.db` (SQLite + FTS5
 * + vector + graph). It surfaces observations, decisions, patterns, learnings,
 * a PageIndex graph, RRF hybrid search, causal reasoning, and quality/health
 * telemetry. CLI identifiers start with `memory.*` and are routed through the
 * `memory` domain handler.
 *
 * Distinct from BRAIN (super-domain) — a NEW `operations/brain.ts` will be
 * authored in T962 Wave B for the unified cross-substrate graph operations
 * (wraps memory + nexus + tasks + conduit + signaldock).
 *
 * SYNC: Canonical implementations at packages/core/src/memory/*.
 * Wire-format types live here; they are the contract for CLI + HTTP dispatch.
 *
 * @task T910 — Orchestration Coherence v4 (contract surface completion)
 * @task T965 — operations/brain.ts → operations/memory.ts rename
 * @see packages/cleo/src/dispatch/domains/memory.ts
 * @see packages/contracts/src/brain.ts
 */

import type { BrainCognitiveType, BrainMemoryTier, BrainSourceConfidence } from '../brain.js';
import type { LAFSPage } from '../lafs.js';

// ============================================================================
// Shared Memory types (API wire format)
// ============================================================================

/**
 * Cognitive type of a memory entry.
 *
 * @remarks
 * Mirrors the CLI-facing taxonomy accepted by `memory.observe`. Distinct from
 * `BrainCognitiveType` from `../brain.js` which carries the 3-axis
 * semantic/episodic/procedural cognitive model used internally.
 */
export type MemoryEntryType = 'observation' | 'decision' | 'pattern' | 'learning' | 'reference';

/** Memory observation subtype categories (from `brain_observations.type`). */
export type MemoryObservationKind =
  | 'discovery'
  | 'change'
  | 'feature'
  | 'bugfix'
  | 'decision'
  | 'refactor';

/** Origin tag distinguishing where an observation was captured. */
export type MemoryObservationSourceType =
  | 'manual'
  | 'session-debrief'
  | 'observer'
  | 'reflector'
  | 'transcript';

/** Pattern taxonomy (from `brain_patterns.type`). */
export type MemoryPatternType = 'workflow' | 'blocker' | 'success' | 'failure' | 'optimization';

/** Severity/impact level for a stored pattern. */
export type MemoryPatternImpact = 'low' | 'medium' | 'high';

/** Compact hit returned from `memory.find` / `memory.search.hybrid` layer-0 search. */
export interface MemoryCompactHit {
  /** Memory entry identifier (e.g. `O-abc123`, `D-def456`). */
  id: string;
  /** Table this hit was drawn from. */
  type: 'decision' | 'pattern' | 'learning' | 'observation';
  /** Normalized display title for the entry. */
  title: string;
  /** ISO 8601 timestamp of entry creation. */
  date: string;
  /** Relevance score (table-specific; higher = better). */
  relevance?: number;
  /** Reciprocal Rank Fusion score (only when RRF path engaged). */
  rrfScore?: number;
  /** BM25 normalized score from FTS path (0..1). */
  bm25Score?: number;
}

/** Full memory entry body returned by `memory.fetch` (layer-2 retrieval). */
export interface MemoryFetchedEntry {
  /** Memory entry identifier. */
  id: string;
  /** Table the entry was drawn from. */
  type: string;
  /** Raw entry payload — columns vary by table. */
  data: unknown;
}

/** Timeline neighbor tuple returned by `memory.timeline`. */
export interface MemoryTimelineNeighbor {
  /** Memory entry identifier. */
  id: string;
  /** Entry table type. */
  type: string;
  /** ISO 8601 timestamp. */
  date: string;
}

/** Anchor entry (shape is table-dependent). */
export type MemoryAnchor = Record<string, unknown>;

/** PageIndex graph node (projection of `brain_page_nodes`). */
export interface MemoryGraphNode {
  /** Node identifier. */
  id: string;
  /** Node type classification (e.g. `symbol`, `file`, `concept`). */
  nodeType: string;
  /** Human-readable label. */
  label: string;
  /** Quality score [0..1] used by PageIndex ranking. */
  qualityScore: number;
  /** SHA-256 hash of the referenced content (if applicable). */
  contentHash: string | null;
  /** ISO 8601 timestamp of last activity touching this node. */
  lastActivityAt: string;
  /** Optional JSON-encoded metadata string. */
  metadataJson: string | null;
  /** ISO 8601 timestamp of creation. */
  createdAt: string;
  /** ISO 8601 timestamp of last update (nullable). */
  updatedAt: string | null;
}

/** PageIndex graph edge (projection of `brain_page_edges`). */
export interface MemoryGraphEdge {
  /** Source node id. */
  fromId: string;
  /** Target node id. */
  toId: string;
  /** Edge type classification. */
  edgeType: string;
  /** Edge weight/confidence [0..1]. */
  weight: number;
  /** Optional JSON-encoded metadata string. */
  metadataJson: string | null;
  /** ISO 8601 creation timestamp. */
  createdAt: string;
}

/** Decision node returned by reasoning queries. */
export interface MemoryDecisionNode {
  /** Decision entry identifier (`D-...`). */
  id: string;
  /** The decision statement. */
  title: string;
  /** Rationale for the decision. */
  rationale: string;
}

// ============================================================================
// Query Operations
// ============================================================================

// --------------------------------------------------------------------------
// memory.find → cross-table FTS5 / RRF search (handler: memory.find)
// --------------------------------------------------------------------------

/**
 * Parameters for `memory.find`.
 *
 * @remarks
 * Preconditions: `query` must be non-empty. Returns compact hits suitable for
 * follow-up `memory.fetch` batching (3-layer retrieval: find → filter → fetch).
 */
export interface MemoryFindParams {
  /** Full-text query string (required). */
  query: string;
  /** Max results to return. */
  limit?: number;
  /** Tables to search (defaults to all four). */
  tables?: Array<'decisions' | 'patterns' | 'learnings' | 'observations'>;
  /** ISO 8601 lower bound on entry date. */
  dateStart?: string;
  /** ISO 8601 upper bound on entry date. */
  dateEnd?: string;
  /** Filter to observations produced by a specific agent (T418 mental models). */
  agent?: string;
  /** When true (default), apply Reciprocal Rank Fusion across FTS + vector sources. */
  useRRF?: boolean;
}
/** Result of `memory.find`. */
export interface MemoryFindResult {
  /** Ranked matches. */
  results: MemoryCompactHit[];
  /** Total match count (may exceed `results.length` when limit applied). */
  total: number;
  /** Estimated token weight of the payload. */
  tokensEstimated: number;
}

// --------------------------------------------------------------------------
// memory.timeline → chronological context around anchor
// --------------------------------------------------------------------------

/** Parameters for `memory.timeline`. */
export interface MemoryTimelineParams {
  /** Anchor entry id (required). */
  anchor: string;
  /** Number of entries to retrieve before the anchor. */
  depthBefore?: number;
  /** Number of entries to retrieve after the anchor. */
  depthAfter?: number;
}
/** Result of `memory.timeline`. */
export interface MemoryTimelineResult {
  /** The anchor entry (or null if not found). */
  anchor: MemoryAnchor | null;
  /** Entries preceding the anchor (chronological). */
  before: MemoryTimelineNeighbor[];
  /** Entries following the anchor (chronological). */
  after: MemoryTimelineNeighbor[];
}

// --------------------------------------------------------------------------
// memory.fetch → batch fetch by IDs (layer-2 retrieval)
// --------------------------------------------------------------------------

/** Parameters for `memory.fetch`. */
export interface MemoryFetchParams {
  /** One or more memory entry IDs to retrieve. Must be non-empty. */
  ids: string[];
}
/** Result of `memory.fetch`. */
export interface MemoryFetchResult {
  /** Full entry bodies. */
  results: MemoryFetchedEntry[];
  /** IDs that could not be located. */
  notFound: string[];
  /** Estimated token weight of the payload. */
  tokensEstimated: number;
}

// --------------------------------------------------------------------------
// memory.decision.find → decision memory search
// --------------------------------------------------------------------------

/** Parameters for `memory.decision.find`. */
export interface MemoryDecisionFindParams {
  /** Optional free-text filter. */
  query?: string;
  /** Filter decisions linked to a specific task. */
  taskId?: string;
  /** Max results. */
  limit?: number;
}
/** A single decision entry returned by the API. */
export interface MemoryDecisionEntry {
  /** Decision id (`D-...`). */
  id: string;
  /** Decision statement. */
  decision: string;
  /** Rationale body. */
  rationale: string;
  /** Alternatives considered at decision time. */
  alternatives?: string[];
  /** ISO 8601 creation timestamp. */
  createdAt: string;
  /** Epic context, if captured. */
  contextEpicId?: string;
  /** Task context, if captured. */
  contextTaskId?: string;
  /** Phase context, if captured. */
  contextPhase?: string;
  /** Source confidence (T549). */
  sourceConfidence?: BrainSourceConfidence;
}
/** Result of `memory.decision.find`. */
export type MemoryDecisionFindResult = MemoryDecisionEntry[];

// --------------------------------------------------------------------------
// memory.pattern.find → pattern memory search
// --------------------------------------------------------------------------

/** Parameters for `memory.pattern.find`. */
export interface MemoryPatternFindParams {
  /** Filter by pattern type. */
  type?: MemoryPatternType;
  /** Filter by pattern impact. */
  impact?: MemoryPatternImpact;
  /** Optional free-text query. */
  query?: string;
  /** Minimum reinforcement frequency. */
  minFrequency?: number;
  /** Max results. */
  limit?: number;
}
/** A single pattern entry returned by the API. */
export interface MemoryPatternEntry {
  /** Pattern id (`P-...`). */
  id: string;
  /** Pattern classification. */
  type: MemoryPatternType;
  /** Pattern description. */
  pattern: string;
  /** Surrounding context. */
  context: string;
  /** Impact level. */
  impact: MemoryPatternImpact;
  /** Anti-pattern counter-example (if applicable). */
  antiPattern?: string;
  /** Mitigation guidance (if applicable). */
  mitigation?: string;
  /** Concrete examples. */
  examples?: string[];
  /** Empirical success rate [0..1]. */
  successRate?: number;
  /** How often this pattern has been observed. */
  frequency: number;
  /** ISO 8601 creation timestamp. */
  createdAt: string;
}
/** Result of `memory.pattern.find`. */
export interface MemoryPatternFindResult {
  /** Matching pattern entries. */
  patterns: MemoryPatternEntry[];
  /** Count of matches. */
  total: number;
}

// --------------------------------------------------------------------------
// memory.learning.find → learning memory search
// --------------------------------------------------------------------------

/** Parameters for `memory.learning.find`. */
export interface MemoryLearningFindParams {
  /** Optional free-text query. */
  query?: string;
  /** Minimum confidence threshold [0..1]. */
  minConfidence?: number;
  /** Restrict to learnings marked actionable. */
  actionableOnly?: boolean;
  /** Filter by applicable task/entry type. */
  applicableType?: string;
  /** Max results. */
  limit?: number;
}
/** A single learning entry returned by the API. */
export interface MemoryLearningEntry {
  /** Learning id (`L-...`). */
  id: string;
  /** Insight statement. */
  insight: string;
  /** Source reference for the insight. */
  source: string;
  /** Confidence score [0..1]. */
  confidence: number;
  /** Whether the learning is actionable. */
  actionable: boolean;
  /** How to apply the insight. */
  application?: string;
  /** Types this insight applies to. */
  applicableTypes?: string[];
  /** ISO 8601 creation timestamp. */
  createdAt: string;
}
/** Result of `memory.learning.find`. */
export type MemoryLearningFindResult = MemoryLearningEntry[];

// --------------------------------------------------------------------------
// memory.graph.* → PageIndex graph queries
// --------------------------------------------------------------------------

/** Parameters for `memory.graph.show`. */
export interface MemoryGraphShowParams {
  /** Node identifier. */
  nodeId: string;
}
/** Result of `memory.graph.show`. */
export interface MemoryGraphShowResult {
  /** The node, if found. */
  node: MemoryGraphNode | null;
  /** In-edges (node is target). */
  inEdges: MemoryGraphEdge[];
  /** Out-edges (node is source). */
  outEdges: MemoryGraphEdge[];
}

/** Parameters for `memory.graph.neighbors`. */
export interface MemoryGraphNeighborsParams {
  /** Node identifier. */
  nodeId: string;
  /** Optional filter to a single edge type. */
  edgeType?: string;
}
/** Result of `memory.graph.neighbors`. */
export interface MemoryGraphNeighbor {
  /** The neighbor node. */
  node: MemoryGraphNode;
  /** Edge type connecting the query node to this neighbor. */
  edgeType: string;
  /** Relative to the queried node: `out` = outbound, `in` = inbound. */
  direction: 'out' | 'in';
  /** Edge weight/confidence. */
  weight: number;
}
/** Result payload for `memory.graph.neighbors`. */
export type MemoryGraphNeighborsResult = MemoryGraphNeighbor[];

/** Parameters for `memory.graph.trace` (BFS traversal). */
export interface MemoryGraphTraceParams {
  /** Seed node identifier. */
  nodeId: string;
  /** Max traversal depth. */
  maxDepth?: number;
}
/** A node visited during BFS traversal. */
export interface MemoryGraphTraceNode extends MemoryGraphNode {
  /** Distance from the seed (0 = seed itself). */
  depth: number;
}
/** Result of `memory.graph.trace`. */
export type MemoryGraphTraceResult = MemoryGraphTraceNode[];

/** Parameters for `memory.graph.related` (1-hop typed neighbors). */
export interface MemoryGraphRelatedParams {
  /** Node identifier. */
  nodeId: string;
  /** Optional filter to a single edge type. */
  edgeType?: string;
}
/** Result of `memory.graph.related`. */
export type MemoryGraphRelatedResult = MemoryGraphNeighbor[];

/** Parameters for `memory.graph.context` (360-degree view). */
export interface MemoryGraphContextParams {
  /** Node identifier. */
  nodeId: string;
}
/** Result of `memory.graph.context`. */
export interface MemoryGraphContextResult {
  /** The node itself. */
  node: MemoryGraphNode;
  /** In-edges (this node is target). */
  inEdges: MemoryGraphEdge[];
  /** Out-edges (this node is source). */
  outEdges: MemoryGraphEdge[];
  /** Deduplicated neighbour list with direction + edge metadata. */
  neighbors: MemoryGraphNeighbor[];
}

/** Parameters for `memory.graph.stats` — none. */
export type MemoryGraphStatsParams = Record<string, never>;
/** Result of `memory.graph.stats`. */
export interface MemoryGraphStatsResult {
  /** Per-type node counts. */
  nodesByType: Array<{ nodeType: string; count: number }>;
  /** Per-type edge counts. */
  edgesByType: Array<{ edgeType: string; count: number }>;
  /** Total node count. */
  totalNodes: number;
  /** Total edge count. */
  totalEdges: number;
}

// --------------------------------------------------------------------------
// memory.reason.* → causal / similarity reasoning
// --------------------------------------------------------------------------

/** Parameters for `memory.reason.why` (causal trace). */
export interface MemoryReasonWhyParams {
  /** Task identifier whose blocker chain should be traced. */
  taskId: string;
}
/** A single blocker in a causal trace. */
export interface MemoryBlockerNode {
  /** Blocking task identifier. */
  taskId: string;
  /** Task status at time of trace. */
  status: string;
  /** Free-text reason (if captured). */
  reason?: string;
  /** Decisions linked to this blocker. */
  decisions: MemoryDecisionNode[];
}
/** Result of `memory.reason.why`. */
export interface MemoryReasonWhyResult {
  /** Root task ID that triggered the trace. */
  taskId: string;
  /** Walk of unresolved blockers (depth-ordered). */
  blockers: MemoryBlockerNode[];
  /** Leaf blocker IDs flagged as root causes. */
  rootCauses: string[];
  /** Maximum traversal depth reached. */
  depth: number;
}

/** Parameters for `memory.reason.similar`. */
export interface MemoryReasonSimilarParams {
  /** Source entry id to compare against. */
  entryId: string;
  /** Maximum results to return. */
  limit?: number;
}
/** A similar entry with a distance score. */
export interface MemorySimilarEntry {
  /** Matched entry id. */
  id: string;
  /** Cosine / vector distance (lower = more similar). */
  distance: number;
  /** Entry type/table. */
  type: string;
  /** Display title. */
  title: string;
  /** Truncated text preview. */
  text: string;
}
/** Result of `memory.reason.similar`. */
export type MemoryReasonSimilarResult = MemorySimilarEntry[];

// --------------------------------------------------------------------------
// memory.search.hybrid → FTS + vector + graph fusion (RRF)
// --------------------------------------------------------------------------

/** Parameters for `memory.search.hybrid`. */
export interface MemorySearchHybridParams {
  /** Query string (required). */
  query: string;
  /** RRF weight for FTS results [0..1]. */
  ftsWeight?: number;
  /** RRF weight for vector results [0..1]. */
  vecWeight?: number;
  /** RRF weight for graph-expansion results [0..1]. */
  graphWeight?: number;
  /** Max results to return. */
  limit?: number;
}
/** A fused result from hybrid search. */
export interface MemoryHybridHit {
  /** Memory entry id. */
  id: string;
  /** Fused RRF score. */
  score: number;
  /** Entry type/table. */
  type: string;
  /** Display title. */
  title: string;
  /** Truncated text preview. */
  text: string;
  /** Retrieval sources that contributed. */
  sources: Array<'fts' | 'vec' | 'graph'>;
  /** Rank from FTS source (0-based; undefined if absent). */
  ftsRank?: number;
  /** Rank from vector source (0-based; undefined if absent). */
  vecRank?: number;
}
/** Result of `memory.search.hybrid`. */
export type MemorySearchHybridResult = MemoryHybridHit[];

// --------------------------------------------------------------------------
// memory.quality → memory quality report
// --------------------------------------------------------------------------

/** Parameters for `memory.quality` — none. */
export type MemoryQualityParams = Record<string, never>;
/** Result of `memory.quality`. */
export interface MemoryQualityResult {
  /** Per-tier entry counts. */
  tierDistribution: Record<BrainMemoryTier, number>;
  /** Per-cognitive-type counts. */
  cognitiveDistribution: Record<BrainCognitiveType, number>;
  /** Fraction of entries classified as noise [0..1]. */
  noiseRatio: number;
  /** Retrieval hit-rate stats for the last sampling window. */
  retrievalStats: {
    /** Count of retrieval requests. */
    totalQueries: number;
    /** Fraction returning at least one hit [0..1]. */
    hitRate: number;
  };
  /** ISO 8601 timestamp when the report was computed. */
  generatedAt: string;
}

// --------------------------------------------------------------------------
// memory.code.* → code_reference edges between memory & nexus
// --------------------------------------------------------------------------

/** Parameters for `memory.code.links` — none. */
export type MemoryCodeLinksParams = Record<string, never>;
/** A single code_reference edge. */
export interface MemoryCodeLink {
  /** Memory entry id. */
  memoryId: string;
  /** Nexus code symbol identifier. */
  codeSymbol: string;
  /** ISO 8601 creation timestamp. */
  createdAt: string;
}
/** Result of `memory.code.links`. */
export type MemoryCodeLinksResult = MemoryCodeLink[];

/** Parameters for `memory.code.memories-for-code`. */
export interface MemoryCodeMemoriesForCodeParams {
  /** Code symbol identifier. */
  symbol: string;
}
/** Result of `memory.code.memories-for-code`. */
export interface MemoryCodeMemoriesForCodeResult {
  /** Code symbol that was queried. */
  symbol: string;
  /** Memory entries referencing this symbol. */
  memories: Array<{ id: string; type: string; title: string }>;
}

/** Parameters for `memory.code.for-memory`. */
export interface MemoryCodeForMemoryParams {
  /** Memory entry id. */
  memoryId: string;
}
/** Result of `memory.code.for-memory`. */
export interface MemoryCodeForMemoryResult {
  /** Memory entry id that was queried. */
  memoryId: string;
  /** Code symbols referenced by this memory. */
  codeSymbols: string[];
}

// --------------------------------------------------------------------------
// memory.llm-status → LLM extraction backend status
// --------------------------------------------------------------------------

/** Parameters for `memory.llm-status` — none. */
export type MemoryLlmStatusParams = Record<string, never>;
/** Result of `memory.llm-status`. */
export interface MemoryLlmStatusResult {
  /** Where the Anthropic API key was resolved from (env, config, keychain, etc.). */
  resolvedSource: string;
  /** True when LLM-assisted extraction is wired and key is present. */
  extractionEnabled: boolean;
  /** ISO 8601 timestamp of the most recent extraction run; null if none. */
  lastExtractionRun: string | null;
  /** Suggested CLI command to trigger a test extraction. */
  testCommand: string;
}

// --------------------------------------------------------------------------
// memory.pending-verify → unverified-but-cited entries queue
// --------------------------------------------------------------------------

/** Parameters for `memory.pending-verify`. */
export interface MemoryPendingVerifyParams {
  /** Minimum citation count to surface an entry (default 5). */
  minCitations?: number;
  /** Max entries to return (default 50). */
  limit?: number;
}
/** A single pending-verify row. */
export interface MemoryPendingEntry {
  /** Entry id (prefix varies by table). */
  id: string;
  /** Normalized display title. */
  title: string | null;
  /** Source confidence (nullable when never scored). */
  sourceConfidence: string | null;
  /** Times this entry has been cited by retrieval/reasoning. */
  citationCount: number;
  /** Memory tier (nullable when never assigned). */
  memoryTier: string | null;
  /** ISO 8601 creation timestamp. */
  createdAt: string;
  /** Source table name (e.g. `observations`, `decisions`). */
  table: string;
}
/** Result of `memory.pending-verify`. */
export interface MemoryPendingVerifyResult {
  /** Count of entries returned. */
  count: number;
  /** Minimum citation threshold applied. */
  minCitations: number;
  /** Pending entries ordered by citation count desc. */
  items: MemoryPendingEntry[];
  /** Human-readable next-step hint. */
  hint: string;
}

// ============================================================================
// Mutate Operations
// ============================================================================

// --------------------------------------------------------------------------
// memory.observe → save observation
// --------------------------------------------------------------------------

/** Parameters for `memory.observe`. */
export interface MemoryObserveParams {
  /** Observation text body (required). */
  text: string;
  /** Short display title. */
  title?: string;
  /** Observation kind (default inferred from content). */
  type?: MemoryObservationKind;
  /** Project context override. */
  project?: string;
  /** Originating session id. */
  sourceSessionId?: string;
  /** Observation source classification. */
  sourceType?: MemoryObservationSourceType;
  /** Agent that captured this observation (T417 mental models). */
  agent?: string;
  /** Source confidence override (T549). */
  sourceConfidence?: BrainSourceConfidence;
  /** Attachment SHA-256 refs to link to this observation (T799). */
  attachmentRefs?: string[];
  /** Cross-reference to other memory or external IDs (T794). */
  crossRef?: string[];
}
/** Result of `memory.observe`. */
export interface MemoryObserveResult {
  /** Newly-created observation id (`O-...`). */
  id: string;
  /** Entry table this was written to. */
  type: string;
  /** ISO 8601 creation timestamp. */
  createdAt: string;
}

// --------------------------------------------------------------------------
// memory.decision.store → store a decision
// --------------------------------------------------------------------------

/** Parameters for `memory.decision.store`. */
export interface MemoryDecisionStoreParams {
  /** Decision statement (required). */
  decision: string;
  /** Rationale for the decision (required). */
  rationale: string;
  /** Alternatives considered at decision time. */
  alternatives?: string[];
  /** Task ID providing decision context. */
  taskId?: string;
  /** Session ID providing decision context. */
  sessionId?: string;
  /** Epic context. */
  contextEpicId?: string;
  /** Phase context. */
  contextPhase?: string;
}
/** Result of `memory.decision.store`. */
export interface MemoryDecisionStoreResult {
  /** New decision id (`D-...` or sequential `D001`). */
  id: string;
  /** ISO 8601 creation timestamp. */
  createdAt: string;
}

// --------------------------------------------------------------------------
// memory.pattern.store → store a pattern
// --------------------------------------------------------------------------

/** Parameters for `memory.pattern.store`. */
export interface MemoryPatternStoreParams {
  /** Pattern description (required). */
  pattern: string;
  /** Surrounding context (required). */
  context: string;
  /** Pattern classification (default `workflow`). */
  type?: MemoryPatternType;
  /** Pattern impact level. */
  impact?: MemoryPatternImpact;
  /** Counter-example anti-pattern. */
  antiPattern?: string;
  /** Mitigation guidance. */
  mitigation?: string;
  /** Concrete examples. */
  examples?: string[];
  /** Empirical success rate [0..1]. */
  successRate?: number;
  /** Origin tag (e.g. `auto`, `agent`). Routes source confidence. */
  source?: string;
}
/** Result of `memory.pattern.store`. */
export interface MemoryPatternStoreResult {
  /** New pattern id (`P-...`). */
  id: string;
  /** True when this store call incremented frequency on a duplicate match. */
  deduplicated: boolean;
  /** ISO 8601 creation timestamp. */
  createdAt: string;
}

// --------------------------------------------------------------------------
// memory.learning.store → store a learning
// --------------------------------------------------------------------------

/** Parameters for `memory.learning.store`. */
export interface MemoryLearningStoreParams {
  /** Insight statement (required). */
  insight: string;
  /** Source reference for the insight (required). */
  source: string;
  /** Confidence [0..1] (default 0.5). */
  confidence?: number;
  /** Marks the learning as actionable. */
  actionable?: boolean;
  /** How to apply the insight. */
  application?: string;
  /** Types/domains this learning applies to. */
  applicableTypes?: string[];
}
/** Result of `memory.learning.store`. */
export interface MemoryLearningStoreResult {
  /** New learning id (`L-...`). */
  id: string;
  /** True when this store call updated an existing duplicate. */
  deduplicated: boolean;
  /** ISO 8601 creation timestamp. */
  createdAt: string;
}

// --------------------------------------------------------------------------
// memory.link → link memory entry to a task
// --------------------------------------------------------------------------

/** Parameters for `memory.link`. */
export interface MemoryLinkParams {
  /** Task id to link. */
  taskId: string;
  /** Memory entry id to link. */
  entryId: string;
}
/** Result of `memory.link`. */
export interface MemoryLinkResult {
  /** Task id that was linked. */
  taskId: string;
  /** Entry id that was linked. */
  entryId: string;
  /** True when the edge was newly created (false if already present). */
  linked: boolean;
}

// --------------------------------------------------------------------------
// memory.graph.add / memory.graph.remove → PageIndex graph mutations
// --------------------------------------------------------------------------

/**
 * Parameters for `memory.graph.add`.
 *
 * @remarks
 * Either a node-insert shape (`nodeId` + `nodeType` + `label`) or an
 * edge-insert shape (`fromId` + `toId` + `edgeType`). Caller MUST supply
 * exactly one of those two variants.
 */
export interface MemoryGraphAddParams {
  /** Node id (node-insert mode). */
  nodeId?: string;
  /** Node type classification (node-insert mode). */
  nodeType?: string;
  /** Display label (node-insert mode). */
  label?: string;
  /** JSON-encoded metadata string. */
  metadataJson?: string;
  /** Source node id (edge-insert mode). */
  fromId?: string;
  /** Target node id (edge-insert mode). */
  toId?: string;
  /** Edge type (edge-insert mode). */
  edgeType?: string;
  /** Edge weight [0..1] (edge-insert mode). */
  weight?: number;
}
/** Result of `memory.graph.add`. */
export interface MemoryGraphAddResult {
  /** Variant applied. */
  mode: 'node' | 'edge';
  /** Id of the node or `fromId:toId:edgeType` edge key. */
  id: string;
  /** ISO 8601 creation timestamp. */
  createdAt: string;
}

/** Parameters for `memory.graph.remove`. */
export interface MemoryGraphRemoveParams {
  /** Node id (node-remove mode). */
  nodeId?: string;
  /** Source node id (edge-remove mode). */
  fromId?: string;
  /** Target node id (edge-remove mode). */
  toId?: string;
  /** Edge type (edge-remove mode). */
  edgeType?: string;
}
/** Result of `memory.graph.remove`. */
export interface MemoryGraphRemoveResult {
  /** Variant applied. */
  mode: 'node' | 'edge';
  /** Number of rows deleted. */
  removed: number;
}

// --------------------------------------------------------------------------
// memory.code.link / memory.code.auto-link → code_reference edges
// --------------------------------------------------------------------------

/** Parameters for `memory.code.link`. */
export interface MemoryCodeLinkParams {
  /** Memory entry id. */
  memoryId: string;
  /** Nexus code symbol identifier. */
  codeSymbol: string;
}
/** Result of `memory.code.link`. */
export interface MemoryCodeLinkResult {
  /** True when the edge was newly created (false when it already existed). */
  linked: boolean;
}

/** Parameters for `memory.code.auto-link` — none. */
export type MemoryCodeAutoLinkParams = Record<string, never>;
/** Result of `memory.code.auto-link`. */
export interface MemoryCodeAutoLinkResult {
  /** Count of memory entries scanned. */
  scanned: number;
  /** Count of new edges created by the scan. */
  linked: number;
  /** Count of edges skipped because they already existed. */
  skipped: number;
}

// --------------------------------------------------------------------------
// memory.verify → ground-truth promote (owner / cleo-prime only)
// --------------------------------------------------------------------------

/** Parameters for `memory.verify`. */
export interface MemoryVerifyParams {
  /** Memory entry id to promote to verified=1. */
  id: string;
  /** Caller identity (`cleo-prime` or `owner`). Omit for terminal invocation. */
  agent?: string;
}
/** Result of `memory.verify`. */
export interface MemoryVerifyResult {
  /** Entry id that was verified. */
  id: string;
  /** Table the entry lives in. */
  table: string;
  /** True when verified=0 → 1 transition occurred. False when already verified. */
  promoted: boolean;
  /** ISO 8601 timestamp of the verify attempt. */
  verifiedAt: string;
}

// --------------------------------------------------------------------------
// memory.promote-explain → read-only view over STDP + retrieval + citation
// --------------------------------------------------------------------------

/**
 * Parameters for `memory.promote-explain`.
 *
 * @remarks
 * Read-only. Accepts the `id` of any typed brain entry (`O-*`, `D-*`, `P-*`,
 * `L-*`) and returns a score breakdown explaining why the entry was (or was
 * not) promoted to a higher memory tier.
 *
 * @task T997
 */
export interface MemoryPromoteExplainParams {
  /** Brain entry identifier (e.g. `O-abc123`, `D-def456`). */
  id: string;
}

/**
 * A single STDP edge weight record relevant to this entry.
 *
 * @task T997
 */
export interface MemoryStdpWeight {
  /** Source node id. */
  fromId: string;
  /** Target node id. */
  toId: string;
  /** Edge type (e.g. `co_retrieved`, `semantic`). */
  edgeType: string;
  /** Edge weight [0..1]. */
  weight: number;
  /** Number of LTP reinforcement events applied to this edge. */
  reinforcementCount: number;
  /** ISO 8601 timestamp of last reinforcement (or null if never reinforced). */
  lastReinforcedAt: string | null;
}

/**
 * Breakdown of factors that determine promotion eligibility.
 *
 * @task T997
 */
export interface MemoryPromoteScoreBreakdown {
  /** Aggregate STDP weight (max edge weight across all co-retrieved edges; 0 if none). */
  stdpWeightMax: number;
  /** Number of retrieval log entries that included this entry. */
  retrievalCount: number;
  /** ISO 8601 timestamp of the most recent retrieval (or null if never retrieved). */
  lastAccessedAt: string | null;
  /** Number of citations (from `citation_count` column). */
  citationCount: number;
  /** Content quality score [0..1] from the typed table. */
  qualityScore: number | null;
  /** Whether this entry has been flagged as a prune candidate. */
  pruneCandidate: boolean;
  /** Whether this entry has been manually verified (ground-truth promoted). */
  verified: boolean;
}

/**
 * Promotion tier decision.
 *
 * - `promoted` — entry has been elevated to a longer-lived memory tier.
 * - `rejected`  — entry is flagged for pruning (prune_candidate=1).
 * - `pending`   — entry has not yet been promoted or rejected.
 *
 * @task T997
 */
export type MemoryPromotionTier = 'promoted' | 'rejected' | 'pending';

/**
 * Result of `memory.promote-explain`.
 *
 * @task T997
 */
export interface MemoryPromoteExplainResult {
  /** Brain entry identifier queried. */
  id: string;
  /** Table the entry lives in (without `brain_` prefix). */
  table: string;
  /** Promotion tier decision. */
  tier: MemoryPromotionTier;
  /** Human-readable explanation of the tier decision. */
  explanation: string;
  /** ISO 8601 timestamp when tier was promoted (null if never promoted or rejected). */
  promotedAt: string | null;
  /** STDP edge weights involving this entry's page-node (may be empty). */
  stdpWeights: MemoryStdpWeight[];
  /** Score breakdown used to determine promotion eligibility. */
  scoreBreakdown: MemoryPromoteScoreBreakdown;
}

// ============================================================================
// Multi-Pass Retrieval Bundle (PSYCHE Wave 4 · T1090)
// ============================================================================

/**
 * Controls which passes are executed in `buildRetrievalBundle`.
 *
 * When all fields are `true` (the default), all three passes run in parallel.
 * Set individual passes to `false` to skip them for token-budget optimisation.
 */
export interface PassMask {
  /** Cold pass: user-profile traits + peer instructions from NEXUS. */
  cold: boolean;
  /** Warm pass: peer-scoped learnings, patterns, and decisions from BRAIN. */
  warm: boolean;
  /** Hot pass: session narrative + recent observations + active tasks. */
  hot: boolean;
}

/**
 * Input to `buildRetrievalBundle`.
 *
 * All four fields are required; pass an empty string for `query` when no
 * user-provided search term is available.
 */
export interface RetrievalRequest {
  /** CANT peer identifier, e.g. `"cleo-prime"` or `"global"`. */
  peerId: string;
  /** Active session identifier. */
  sessionId: string;
  /** Optional user-query used to scope warm-pass memory search. */
  query?: string;
  /**
   * Which passes to execute.  Defaults to `{ cold: true, warm: true, hot: true }`.
   */
  passMask?: PassMask;
  /**
   * Token budget for the bundle (default: 4000).
   * Split 20 / 50 / 30 across cold / warm / hot.
   * When total exceeds budget, hot pass is trimmed first.
   */
  tokenBudget?: number;
}

/**
 * Compact task record returned by the hot pass.
 *
 * A narrow projection of the full `Task` type — only the fields needed for
 * briefing context are included to keep token cost low.
 */
export interface RetrievalActiveTask {
  /** Task identifier (e.g. `"T1090"`). */
  id: string;
  /** Task title. */
  title: string;
  /** Current lifecycle status. */
  status: string;
}

/**
 * Compact observation record returned by the hot pass.
 *
 * A narrow projection of a `brain_observations` row — only the display fields.
 */
export interface RetrievalObservation {
  /** Observation identifier (e.g. `"O-abc123"`). */
  id: string;
  /** Short display title. */
  title: string;
  /** Full narrative text. */
  narrative: string;
  /** ISO 8601 creation timestamp. */
  createdAt: string;
}

/**
 * Compact learning record returned by the warm pass.
 */
export interface RetrievalLearning {
  /** Learning identifier (e.g. `"L-def456"`). */
  id: string;
  /** Insight text. */
  insight: string;
  /** ISO 8601 creation timestamp. */
  createdAt: string;
}

/**
 * Compact pattern record returned by the warm pass.
 */
export interface RetrievalPattern {
  /** Pattern identifier (e.g. `"P-ghi789"`). */
  id: string;
  /** Pattern text. */
  pattern: string;
  /** ISO 8601 extraction timestamp. */
  extractedAt: string;
}

/**
 * Compact decision record returned by the warm pass.
 */
export interface RetrievalDecision {
  /** Decision identifier (e.g. `"D-jkl012"`). */
  id: string;
  /** Decision statement. */
  decision: string;
  /** ISO 8601 creation timestamp. */
  createdAt: string;
}

/**
 * Token-budget accounting for the three retrieval passes.
 */
export interface RetrievalTokenCounts {
  /** Estimated tokens consumed by the cold pass. */
  cold: number;
  /** Estimated tokens consumed by the warm pass. */
  warm: number;
  /** Estimated tokens consumed by the hot pass. */
  hot: number;
  /** Sum of cold + warm + hot. */
  total: number;
}

/**
 * Structured context bundle returned by `buildRetrievalBundle`.
 *
 * Three passes correspond to three temporal + topical distances:
 *
 * - **cold**: stable identity context (user profile + peer instructions)
 * - **warm**: recent project memory scoped to this peer (learnings, patterns, decisions)
 * - **hot**: live session state (narrative + recent observations + active tasks)
 *
 * @task T1090
 * @epic T1083
 */
export interface RetrievalBundle {
  /**
   * Cold pass — identity + stable context.
   *
   * `userProfile` contains the user's known preferences and traits at
   * >= 0.5 confidence.  `peerInstructions` is a brief instruction string
   * derived from the peer's CANT definition (empty string when unavailable).
   */
  cold: {
    userProfile: import('./nexus-user-profile.js').UserProfileTrait[];
    peerInstructions: string;
  };

  /**
   * Warm pass — peer-scoped project memory.
   *
   * All entries are filtered to `peer_id = peerId OR peer_id = 'global'`
   * so each peer sees its own memory plus the shared global pool.
   */
  warm: {
    peerLearnings: RetrievalLearning[];
    peerPatterns: RetrievalPattern[];
    decisions: RetrievalDecision[];
  };

  /**
   * Hot pass — live session state.
   *
   * `sessionNarrative` is the rolling prose summary from `session_narrative`
   * (empty string when no narrative has been recorded yet).
   * `recentObservations` are the last N observations created in this session.
   * `activeTasks` are tasks with status `active` or `in_progress`.
   */
  hot: {
    sessionNarrative: string;
    recentObservations: RetrievalObservation[];
    activeTasks: RetrievalActiveTask[];
  };

  /** Per-pass and total token-budget accounting. */
  tokenCounts: RetrievalTokenCounts;
}

// ============================================================================
// Paginated result helper (for HTTP list surfaces that opt into LAFSPage)
// ============================================================================

/** Generic paginated envelope reused by future list variants. */
export interface MemoryPagedResult<T> {
  /** Items for this page. */
  items: T[];
  /** Total count across all pages. */
  total: number;
  /** Pagination descriptor. */
  page: LAFSPage;
}
