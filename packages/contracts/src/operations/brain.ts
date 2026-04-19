/**
 * Brain Domain Operations (31 operations)
 *
 * Query operations: 21
 * Mutate operations: 10
 *
 * BRAIN is the cognitive memory subsystem backed by `brain.db` (SQLite + FTS5
 * + vector + graph). It surfaces observations, decisions, patterns, learnings,
 * a PageIndex graph, RRF hybrid search, causal reasoning, and quality/health
 * telemetry. CLI identifiers start with `brain.*`; the dispatch registry
 * routes these through the `memory` domain handler (legacy alias).
 *
 * SYNC: Canonical implementations at packages/core/src/memory/*.
 * Wire-format types live here; they are the contract for CLI + HTTP dispatch.
 *
 * @task T910 — Orchestration Coherence v4 (contract surface completion)
 * @see packages/cleo/src/dispatch/domains/memory.ts
 * @see packages/contracts/src/brain.ts
 */

import type { BrainCognitiveType, BrainMemoryTier, BrainSourceConfidence } from '../brain.js';
import type { LAFSPage } from '../lafs.js';

// ============================================================================
// Shared Brain types (API wire format)
// ============================================================================

/**
 * Cognitive type of a brain entry.
 *
 * @remarks
 * Mirrors the CLI-facing taxonomy accepted by `brain.observe`. Distinct from
 * `BrainCognitiveType` from `../brain.js` which carries the 3-axis
 * semantic/episodic/procedural cognitive model used internally.
 */
export type BrainEntryType = 'observation' | 'decision' | 'pattern' | 'learning' | 'reference';

/** Brain observation subtype categories (from `brain_observations.type`). */
export type BrainObservationKind =
  | 'discovery'
  | 'change'
  | 'feature'
  | 'bugfix'
  | 'decision'
  | 'refactor';

/** Origin tag distinguishing where an observation was captured. */
export type BrainObservationSourceType =
  | 'manual'
  | 'session-debrief'
  | 'observer'
  | 'reflector'
  | 'transcript';

/** Pattern taxonomy (from `brain_patterns.type`). */
export type BrainPatternType = 'workflow' | 'blocker' | 'success' | 'failure' | 'optimization';

/** Severity/impact level for a stored pattern. */
export type BrainPatternImpact = 'low' | 'medium' | 'high';

/** Compact hit returned from `brain.find` / `brain.search.hybrid` layer-0 search. */
export interface BrainCompactHit {
  /** Brain entry identifier (e.g. `O-abc123`, `D-def456`). */
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

/** Full brain entry body returned by `brain.fetch` (layer-2 retrieval). */
export interface BrainFetchedEntry {
  /** Brain entry identifier. */
  id: string;
  /** Table the entry was drawn from. */
  type: string;
  /** Raw entry payload — columns vary by table. */
  data: unknown;
}

/** Timeline neighbor tuple returned by `brain.timeline`. */
export interface BrainTimelineNeighbor {
  /** Brain entry identifier. */
  id: string;
  /** Entry table type. */
  type: string;
  /** ISO 8601 timestamp. */
  date: string;
}

/** Anchor entry (shape is table-dependent). */
export type BrainAnchor = Record<string, unknown>;

/** PageIndex graph node (projection of `brain_page_nodes`). */
export interface BrainGraphNode {
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
export interface BrainGraphEdge {
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
export interface BrainDecisionNode {
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
// brain.find → cross-table FTS5 / RRF search (handler: memory.find)
// --------------------------------------------------------------------------

/**
 * Parameters for `brain.find`.
 *
 * @remarks
 * Preconditions: `query` must be non-empty. Returns compact hits suitable for
 * follow-up `brain.fetch` batching (3-layer retrieval: find → filter → fetch).
 */
export interface BrainFindParams {
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
/** Result of `brain.find`. */
export interface BrainFindResult {
  /** Ranked matches. */
  results: BrainCompactHit[];
  /** Total match count (may exceed `results.length` when limit applied). */
  total: number;
  /** Estimated token weight of the payload. */
  tokensEstimated: number;
}

// --------------------------------------------------------------------------
// brain.timeline → chronological context around anchor
// --------------------------------------------------------------------------

/** Parameters for `brain.timeline`. */
export interface BrainTimelineParams {
  /** Anchor entry id (required). */
  anchor: string;
  /** Number of entries to retrieve before the anchor. */
  depthBefore?: number;
  /** Number of entries to retrieve after the anchor. */
  depthAfter?: number;
}
/** Result of `brain.timeline`. */
export interface BrainTimelineResult {
  /** The anchor entry (or null if not found). */
  anchor: BrainAnchor | null;
  /** Entries preceding the anchor (chronological). */
  before: BrainTimelineNeighbor[];
  /** Entries following the anchor (chronological). */
  after: BrainTimelineNeighbor[];
}

// --------------------------------------------------------------------------
// brain.fetch → batch fetch by IDs (layer-2 retrieval)
// --------------------------------------------------------------------------

/** Parameters for `brain.fetch`. */
export interface BrainFetchParams {
  /** One or more brain entry IDs to retrieve. Must be non-empty. */
  ids: string[];
}
/** Result of `brain.fetch`. */
export interface BrainFetchResult {
  /** Full entry bodies. */
  results: BrainFetchedEntry[];
  /** IDs that could not be located. */
  notFound: string[];
  /** Estimated token weight of the payload. */
  tokensEstimated: number;
}

// --------------------------------------------------------------------------
// brain.decision.find → decision memory search
// --------------------------------------------------------------------------

/** Parameters for `brain.decision.find`. */
export interface BrainDecisionFindParams {
  /** Optional free-text filter. */
  query?: string;
  /** Filter decisions linked to a specific task. */
  taskId?: string;
  /** Max results. */
  limit?: number;
}
/** A single decision entry returned by the API. */
export interface BrainDecisionEntry {
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
/** Result of `brain.decision.find`. */
export type BrainDecisionFindResult = BrainDecisionEntry[];

// --------------------------------------------------------------------------
// brain.pattern.find → pattern memory search
// --------------------------------------------------------------------------

/** Parameters for `brain.pattern.find`. */
export interface BrainPatternFindParams {
  /** Filter by pattern type. */
  type?: BrainPatternType;
  /** Filter by pattern impact. */
  impact?: BrainPatternImpact;
  /** Optional free-text query. */
  query?: string;
  /** Minimum reinforcement frequency. */
  minFrequency?: number;
  /** Max results. */
  limit?: number;
}
/** A single pattern entry returned by the API. */
export interface BrainPatternEntry {
  /** Pattern id (`P-...`). */
  id: string;
  /** Pattern classification. */
  type: BrainPatternType;
  /** Pattern description. */
  pattern: string;
  /** Surrounding context. */
  context: string;
  /** Impact level. */
  impact: BrainPatternImpact;
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
/** Result of `brain.pattern.find`. */
export interface BrainPatternFindResult {
  /** Matching pattern entries. */
  patterns: BrainPatternEntry[];
  /** Count of matches. */
  total: number;
}

// --------------------------------------------------------------------------
// brain.learning.find → learning memory search
// --------------------------------------------------------------------------

/** Parameters for `brain.learning.find`. */
export interface BrainLearningFindParams {
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
export interface BrainLearningEntry {
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
/** Result of `brain.learning.find`. */
export type BrainLearningFindResult = BrainLearningEntry[];

// --------------------------------------------------------------------------
// brain.graph.* → PageIndex graph queries
// --------------------------------------------------------------------------

/** Parameters for `brain.graph.show`. */
export interface BrainGraphShowParams {
  /** Node identifier. */
  nodeId: string;
}
/** Result of `brain.graph.show`. */
export interface BrainGraphShowResult {
  /** The node, if found. */
  node: BrainGraphNode | null;
  /** In-edges (node is target). */
  inEdges: BrainGraphEdge[];
  /** Out-edges (node is source). */
  outEdges: BrainGraphEdge[];
}

/** Parameters for `brain.graph.neighbors`. */
export interface BrainGraphNeighborsParams {
  /** Node identifier. */
  nodeId: string;
  /** Optional filter to a single edge type. */
  edgeType?: string;
}
/** Result of `brain.graph.neighbors`. */
export interface BrainGraphNeighbor {
  /** The neighbor node. */
  node: BrainGraphNode;
  /** Edge type connecting the query node to this neighbor. */
  edgeType: string;
  /** Relative to the queried node: `out` = outbound, `in` = inbound. */
  direction: 'out' | 'in';
  /** Edge weight/confidence. */
  weight: number;
}
/** Result payload for `brain.graph.neighbors`. */
export type BrainGraphNeighborsResult = BrainGraphNeighbor[];

/** Parameters for `brain.graph.trace` (BFS traversal). */
export interface BrainGraphTraceParams {
  /** Seed node identifier. */
  nodeId: string;
  /** Max traversal depth. */
  maxDepth?: number;
}
/** A node visited during BFS traversal. */
export interface BrainGraphTraceNode extends BrainGraphNode {
  /** Distance from the seed (0 = seed itself). */
  depth: number;
}
/** Result of `brain.graph.trace`. */
export type BrainGraphTraceResult = BrainGraphTraceNode[];

/** Parameters for `brain.graph.related` (1-hop typed neighbors). */
export interface BrainGraphRelatedParams {
  /** Node identifier. */
  nodeId: string;
  /** Optional filter to a single edge type. */
  edgeType?: string;
}
/** Result of `brain.graph.related`. */
export type BrainGraphRelatedResult = BrainGraphNeighbor[];

/** Parameters for `brain.graph.context` (360-degree view). */
export interface BrainGraphContextParams {
  /** Node identifier. */
  nodeId: string;
}
/** Result of `brain.graph.context`. */
export interface BrainGraphContextResult {
  /** The node itself. */
  node: BrainGraphNode;
  /** In-edges (this node is target). */
  inEdges: BrainGraphEdge[];
  /** Out-edges (this node is source). */
  outEdges: BrainGraphEdge[];
  /** Deduplicated neighbour list with direction + edge metadata. */
  neighbors: BrainGraphNeighbor[];
}

/** Parameters for `brain.graph.stats` — none. */
export type BrainGraphStatsParams = Record<string, never>;
/** Result of `brain.graph.stats`. */
export interface BrainGraphStatsResult {
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
// brain.reason.* → causal / similarity reasoning
// --------------------------------------------------------------------------

/** Parameters for `brain.reason.why` (causal trace). */
export interface BrainReasonWhyParams {
  /** Task identifier whose blocker chain should be traced. */
  taskId: string;
}
/** A single blocker in a causal trace. */
export interface BrainBlockerNode {
  /** Blocking task identifier. */
  taskId: string;
  /** Task status at time of trace. */
  status: string;
  /** Free-text reason (if captured). */
  reason?: string;
  /** Decisions linked to this blocker. */
  decisions: BrainDecisionNode[];
}
/** Result of `brain.reason.why`. */
export interface BrainReasonWhyResult {
  /** Root task ID that triggered the trace. */
  taskId: string;
  /** Walk of unresolved blockers (depth-ordered). */
  blockers: BrainBlockerNode[];
  /** Leaf blocker IDs flagged as root causes. */
  rootCauses: string[];
  /** Maximum traversal depth reached. */
  depth: number;
}

/** Parameters for `brain.reason.similar`. */
export interface BrainReasonSimilarParams {
  /** Source entry id to compare against. */
  entryId: string;
  /** Maximum results to return. */
  limit?: number;
}
/** A similar entry with a distance score. */
export interface BrainSimilarEntry {
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
/** Result of `brain.reason.similar`. */
export type BrainReasonSimilarResult = BrainSimilarEntry[];

// --------------------------------------------------------------------------
// brain.search.hybrid → FTS + vector + graph fusion (RRF)
// --------------------------------------------------------------------------

/** Parameters for `brain.search.hybrid`. */
export interface BrainSearchHybridParams {
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
export interface BrainHybridHit {
  /** Brain entry id. */
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
/** Result of `brain.search.hybrid`. */
export type BrainSearchHybridResult = BrainHybridHit[];

// --------------------------------------------------------------------------
// brain.quality → memory quality report
// --------------------------------------------------------------------------

/** Parameters for `brain.quality` — none. */
export type BrainQualityParams = Record<string, never>;
/** Result of `brain.quality`. */
export interface BrainQualityResult {
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
// brain.code.* → code_reference edges between brain & nexus
// --------------------------------------------------------------------------

/** Parameters for `brain.code.links` — none. */
export type BrainCodeLinksParams = Record<string, never>;
/** A single code_reference edge. */
export interface BrainCodeLink {
  /** Memory entry id. */
  memoryId: string;
  /** Nexus code symbol identifier. */
  codeSymbol: string;
  /** ISO 8601 creation timestamp. */
  createdAt: string;
}
/** Result of `brain.code.links`. */
export type BrainCodeLinksResult = BrainCodeLink[];

/** Parameters for `brain.code.memories-for-code`. */
export interface BrainCodeMemoriesForCodeParams {
  /** Code symbol identifier. */
  symbol: string;
}
/** Result of `brain.code.memories-for-code`. */
export interface BrainCodeMemoriesForCodeResult {
  /** Code symbol that was queried. */
  symbol: string;
  /** Memory entries referencing this symbol. */
  memories: Array<{ id: string; type: string; title: string }>;
}

/** Parameters for `brain.code.for-memory`. */
export interface BrainCodeForMemoryParams {
  /** Memory entry id. */
  memoryId: string;
}
/** Result of `brain.code.for-memory`. */
export interface BrainCodeForMemoryResult {
  /** Memory entry id that was queried. */
  memoryId: string;
  /** Code symbols referenced by this memory. */
  codeSymbols: string[];
}

// --------------------------------------------------------------------------
// brain.llm-status → LLM extraction backend status
// --------------------------------------------------------------------------

/** Parameters for `brain.llm-status` — none. */
export type BrainLlmStatusParams = Record<string, never>;
/** Result of `brain.llm-status`. */
export interface BrainLlmStatusResult {
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
// brain.pending-verify → unverified-but-cited entries queue
// --------------------------------------------------------------------------

/** Parameters for `brain.pending-verify`. */
export interface BrainPendingVerifyParams {
  /** Minimum citation count to surface an entry (default 5). */
  minCitations?: number;
  /** Max entries to return (default 50). */
  limit?: number;
}
/** A single pending-verify row. */
export interface BrainPendingEntry {
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
/** Result of `brain.pending-verify`. */
export interface BrainPendingVerifyResult {
  /** Count of entries returned. */
  count: number;
  /** Minimum citation threshold applied. */
  minCitations: number;
  /** Pending entries ordered by citation count desc. */
  items: BrainPendingEntry[];
  /** Human-readable next-step hint. */
  hint: string;
}

// ============================================================================
// Mutate Operations
// ============================================================================

// --------------------------------------------------------------------------
// brain.observe → save observation
// --------------------------------------------------------------------------

/** Parameters for `brain.observe`. */
export interface BrainObserveParams {
  /** Observation text body (required). */
  text: string;
  /** Short display title. */
  title?: string;
  /** Observation kind (default inferred from content). */
  type?: BrainObservationKind;
  /** Project context override. */
  project?: string;
  /** Originating session id. */
  sourceSessionId?: string;
  /** Observation source classification. */
  sourceType?: BrainObservationSourceType;
  /** Agent that captured this observation (T417 mental models). */
  agent?: string;
  /** Source confidence override (T549). */
  sourceConfidence?: BrainSourceConfidence;
  /** Attachment SHA-256 refs to link to this observation (T799). */
  attachmentRefs?: string[];
  /** Cross-reference to other brain or external IDs (T794). */
  crossRef?: string[];
}
/** Result of `brain.observe`. */
export interface BrainObserveResult {
  /** Newly-created observation id (`O-...`). */
  id: string;
  /** Entry table this was written to. */
  type: string;
  /** ISO 8601 creation timestamp. */
  createdAt: string;
}

// --------------------------------------------------------------------------
// brain.decision.store → store a decision
// --------------------------------------------------------------------------

/** Parameters for `brain.decision.store`. */
export interface BrainDecisionStoreParams {
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
/** Result of `brain.decision.store`. */
export interface BrainDecisionStoreResult {
  /** New decision id (`D-...` or sequential `D001`). */
  id: string;
  /** ISO 8601 creation timestamp. */
  createdAt: string;
}

// --------------------------------------------------------------------------
// brain.pattern.store → store a pattern
// --------------------------------------------------------------------------

/** Parameters for `brain.pattern.store`. */
export interface BrainPatternStoreParams {
  /** Pattern description (required). */
  pattern: string;
  /** Surrounding context (required). */
  context: string;
  /** Pattern classification (default `workflow`). */
  type?: BrainPatternType;
  /** Pattern impact level. */
  impact?: BrainPatternImpact;
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
/** Result of `brain.pattern.store`. */
export interface BrainPatternStoreResult {
  /** New pattern id (`P-...`). */
  id: string;
  /** True when this store call incremented frequency on a duplicate match. */
  deduplicated: boolean;
  /** ISO 8601 creation timestamp. */
  createdAt: string;
}

// --------------------------------------------------------------------------
// brain.learning.store → store a learning
// --------------------------------------------------------------------------

/** Parameters for `brain.learning.store`. */
export interface BrainLearningStoreParams {
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
/** Result of `brain.learning.store`. */
export interface BrainLearningStoreResult {
  /** New learning id (`L-...`). */
  id: string;
  /** True when this store call updated an existing duplicate. */
  deduplicated: boolean;
  /** ISO 8601 creation timestamp. */
  createdAt: string;
}

// --------------------------------------------------------------------------
// brain.link → link brain entry to a task
// --------------------------------------------------------------------------

/** Parameters for `brain.link`. */
export interface BrainLinkParams {
  /** Task id to link. */
  taskId: string;
  /** Brain entry id to link. */
  entryId: string;
}
/** Result of `brain.link`. */
export interface BrainLinkResult {
  /** Task id that was linked. */
  taskId: string;
  /** Entry id that was linked. */
  entryId: string;
  /** True when the edge was newly created (false if already present). */
  linked: boolean;
}

// --------------------------------------------------------------------------
// brain.graph.add / brain.graph.remove → PageIndex graph mutations
// --------------------------------------------------------------------------

/**
 * Parameters for `brain.graph.add`.
 *
 * @remarks
 * Either a node-insert shape (`nodeId` + `nodeType` + `label`) or an
 * edge-insert shape (`fromId` + `toId` + `edgeType`). Caller MUST supply
 * exactly one of those two variants.
 */
export interface BrainGraphAddParams {
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
/** Result of `brain.graph.add`. */
export interface BrainGraphAddResult {
  /** Variant applied. */
  mode: 'node' | 'edge';
  /** Id of the node or `fromId:toId:edgeType` edge key. */
  id: string;
  /** ISO 8601 creation timestamp. */
  createdAt: string;
}

/** Parameters for `brain.graph.remove`. */
export interface BrainGraphRemoveParams {
  /** Node id (node-remove mode). */
  nodeId?: string;
  /** Source node id (edge-remove mode). */
  fromId?: string;
  /** Target node id (edge-remove mode). */
  toId?: string;
  /** Edge type (edge-remove mode). */
  edgeType?: string;
}
/** Result of `brain.graph.remove`. */
export interface BrainGraphRemoveResult {
  /** Variant applied. */
  mode: 'node' | 'edge';
  /** Number of rows deleted. */
  removed: number;
}

// --------------------------------------------------------------------------
// brain.code.link / brain.code.auto-link → code_reference edges
// --------------------------------------------------------------------------

/** Parameters for `brain.code.link`. */
export interface BrainCodeLinkParams {
  /** Memory entry id. */
  memoryId: string;
  /** Nexus code symbol identifier. */
  codeSymbol: string;
}
/** Result of `brain.code.link`. */
export interface BrainCodeLinkResult {
  /** True when the edge was newly created (false when it already existed). */
  linked: boolean;
}

/** Parameters for `brain.code.auto-link` — none. */
export type BrainCodeAutoLinkParams = Record<string, never>;
/** Result of `brain.code.auto-link`. */
export interface BrainCodeAutoLinkResult {
  /** Count of memory entries scanned. */
  scanned: number;
  /** Count of new edges created by the scan. */
  linked: number;
  /** Count of edges skipped because they already existed. */
  skipped: number;
}

// --------------------------------------------------------------------------
// brain.verify → ground-truth promote (owner / cleo-prime only)
// --------------------------------------------------------------------------

/** Parameters for `brain.verify`. */
export interface BrainVerifyParams {
  /** Brain entry id to promote to verified=1. */
  id: string;
  /** Caller identity (`cleo-prime` or `owner`). Omit for terminal invocation. */
  agent?: string;
}
/** Result of `brain.verify`. */
export interface BrainVerifyResult {
  /** Entry id that was verified. */
  id: string;
  /** Table the entry lives in. */
  table: string;
  /** True when verified=0 → 1 transition occurred. False when already verified. */
  promoted: boolean;
  /** ISO 8601 timestamp of the verify attempt. */
  verifiedAt: string;
}

// ============================================================================
// Paginated result helper (for HTTP list surfaces that opt into LAFSPage)
// ============================================================================

/** Generic paginated envelope reused by future list variants. */
export interface BrainPagedResult<T> {
  /** Items for this page. */
  items: T[];
  /** Total count across all pages. */
  total: number;
  /** Pagination descriptor. */
  page: LAFSPage;
}
