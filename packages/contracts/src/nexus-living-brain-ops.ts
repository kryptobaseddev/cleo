/**
 * Contract types for the Living Brain SDK traversal primitives (T1068).
 *
 * The Living Brain is the cross-substrate query surface for the CLEO agent
 * intelligence layer. It unifies five substrates — NEXUS (code graph),
 * BRAIN (memory), TASKS, SENTIENT (proposals), and CONDUIT (messages) — into
 * a single traversal API.
 *
 * These are LEAF types — zero runtime dependencies.
 *
 * @task T1068
 * @epic T1042
 */

// ---------------------------------------------------------------------------
// Sub-interfaces — each substrate's projection
// ---------------------------------------------------------------------------

/**
 * Caller or callee within the nexus code graph.
 */
export interface NexusEdgeRef {
  /** Nexus node ID. */
  nodeId: string;
  /** Human-readable display name. */
  name: string;
  /** Source file path (relative to project root). */
  filePath: string | null;
  /** Node kind ('function', 'class', 'method', etc.). */
  kind: string;
  /** Relation type ('calls', 'imports', 'accesses'). */
  relationType: string;
}

/**
 * Nexus context for a symbol: callers, callees, community, process membership.
 */
export interface NexusContext {
  /** Symbol's own nexus node ID. */
  symbolId: string;
  /** Display label. */
  label: string;
  /** File path. */
  filePath: string | null;
  /** Node kind. */
  kind: string;
  /** Community ID this symbol belongs to (if any). */
  communityId: string | null;
  /** Nodes that call/import this symbol. */
  callers: NexusEdgeRef[];
  /** Nodes this symbol calls/imports. */
  callees: NexusEdgeRef[];
  /** Process nodes this symbol participates in. */
  processes: string[];
}

/**
 * A brain memory node (observation, decision, pattern, learning) that
 * references a code symbol via one of the cross-substrate edge types.
 */
export interface BrainMemoryRef {
  /** Brain page node ID (e.g., 'observation:abc123'). */
  nodeId: string;
  /** Node type. */
  nodeType: string;
  /** Human-readable label for the memory entry. */
  label: string;
  /** Quality score of this memory entry (0.0–1.0). */
  qualityScore: number;
  /** Edge type used to connect this memory to the symbol. */
  edgeType: string;
  /** Edge weight. */
  weight: number;
}

/**
 * A task reference linking a task to a code symbol.
 */
export interface LbTaskRef {
  /** Task ID (e.g., 'T001'). */
  taskId: string;
  /** Display label for the task. */
  label: string;
  /** Edge weight (confidence). */
  weight: number;
  /** Strategy used to detect the link. */
  matchStrategy: string;
}

/**
 * A sentient proposal entry referencing a code symbol.
 */
export interface ProposalRef {
  /** Source system. */
  source: string;
  /** Source ID (nexus node ID for nexus proposals). */
  sourceId: string;
  /** Structured proposal title. */
  title: string;
  /** Proposal rationale. */
  rationale: string;
  /** Proposal weight in [0, 1]. */
  weight: number;
}

/**
 * A conduit message thread that mentions a symbol.
 *
 * Returns empty array when conduit.db is absent (T1071 schema not yet present).
 */
export interface ConduitThreadRef {
  /** Conduit message node ID (format: 'conduit:<id>'). */
  nodeId: string;
  /** Edge weight. */
  weight: number;
}

/**
 * Plasticity measurement for a symbol — aggregate edge weight from nexus_relations.
 */
export interface PlasticityMeasure {
  /** Sum of edge weights across all nexus_relations involving this symbol. */
  totalWeight: number;
  /** Number of edges included in the sum. */
  edgeCount: number;
}

// ---------------------------------------------------------------------------
// Primary return shapes
// ---------------------------------------------------------------------------

/**
 * Full cross-substrate context for a code symbol.
 *
 * Returned by {@link getSymbolFullContext}.
 */
export interface SymbolFullContext {
  /** Symbol identifier (nexus node ID or name). */
  symbolId: string;
  /** Nexus code graph context: callers, callees, community, process. */
  nexus: NexusContext | null;
  /** Brain memory nodes (observations, decisions, patterns, learnings) linked to this symbol. */
  brainMemories: BrainMemoryRef[];
  /** Tasks that touched files containing this symbol. */
  tasks: LbTaskRef[];
  /** Sentient proposals whose sourceId matches this symbol. */
  sentientProposals: ProposalRef[];
  /** Conduit message threads mentioning this symbol (empty if conduit.db absent). */
  conduitThreads: ConduitThreadRef[];
  /** Plasticity weight sum from nexus_relations. */
  plasticityWeight: PlasticityMeasure;
}

/**
 * Code impact analysis for a task.
 *
 * Returned by {@link getTaskCodeImpact}.
 */
export interface TaskCodeImpact {
  /** Task ID. */
  taskId: string;
  /** Files listed in the task's files_json array. */
  files: string[];
  /** Symbols in those files (from NEXUS). */
  symbols: SymbolImpactEntry[];
  /** Aggregate blast radius across all symbols. */
  blastRadius: BlastRadiusSummary;
  /** Brain observations with modified_by edges to the task's files. */
  brainObservations: BrainMemoryRef[];
  /** Brain decisions linked to this task via brain_memory_links. */
  decisions: DecisionRef[];
  /** Highest risk tier across all symbols. */
  riskScore: RiskTier;
}

/**
 * Impact entry for a single symbol in a task's footprint.
 */
export interface SymbolImpactEntry {
  /** Nexus node ID. */
  nexusNodeId: string;
  /** Display label. */
  label: string;
  /** Symbol kind. */
  kind: string;
  /** File path. */
  filePath: string | null;
  /** Risk tier from analyzeImpact BFS. */
  riskLevel: RiskTier;
  /** Total number of affected nodes in BFS. */
  totalAffected: number;
  /** Direct callers (d=1) count. */
  directCallers: number;
}

/**
 * Aggregate blast radius across all symbols in a task's footprint.
 */
export interface BlastRadiusSummary {
  /** Total unique affected nodes across all symbols. */
  totalAffected: number;
  /** Maximum risk tier observed. */
  maxRisk: RiskTier;
  /** Number of symbols analyzed. */
  symbolsAnalyzed: number;
}

/**
 * A brain decision linked to a task.
 */
export interface DecisionRef {
  /** Decision ID. */
  decisionId: string;
  /** Decision text. */
  decision: string;
  /** Link type. */
  linkType: string;
}

/**
 * Risk tier for a symbol's impact analysis.
 */
export type RiskTier = 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

// ---------------------------------------------------------------------------
// T1069 — Extended Code Reasoning types
// ---------------------------------------------------------------------------

/**
 * A single step in a code reasoning trace chain.
 */
export interface ReasonTraceStep {
  /** Step type discriminant. */
  type: 'decision' | 'observation' | 'task' | 'symbol';
  /** ID of this entry (brain ID, task ID, or nexus node ID). */
  id: string;
  /** Human-readable title or label for this entry. */
  title: string;
  /** References or related IDs (e.g., learning IDs for a decision step). */
  refs: string[];
}

/**
 * Full causal trace from a code symbol through brain decisions to tasks.
 *
 * Returned by {@link reasonWhySymbol}.
 */
export interface CodeReasonTrace {
  /** The nexus symbol ID queried. */
  symbolId: string;
  /** Human-readable narrative summarizing the trace. */
  narrative: string;
  /** Ordered chain of trace steps from symbol to root context. */
  chain: ReasonTraceStep[];
}

/**
 * A brain risk note associated with a symbol change.
 */
export interface BrainRiskNote {
  /** Brain node ID. */
  nodeId: string;
  /** Node type (observation, decision, etc.). */
  nodeType: string;
  /** Human-readable label. */
  label: string;
  /** Edge type that connects this note to the symbol. */
  edgeType: string;
  /** Risk contribution weight. */
  weight: number;
}

/**
 * Full merged impact report for a code symbol.
 *
 * Returned by {@link reasonImpactOfChange}.
 */
export interface ImpactFullReport {
  /** The nexus symbol ID analyzed. */
  symbolId: string;
  /** Structural blast radius from analyzeImpact BFS. */
  structural: {
    directCallers: number;
    likelyAffected: number;
    mayNeedTesting: number;
    totalAffected: number;
    riskLevel: RiskTier;
  };
  /** Open tasks that reference this symbol (from task_touches_symbol edges). */
  openTasks: Array<{
    taskId: string;
    label: string;
    weight: number;
  }>;
  /** Brain observations/decisions flagging risk for this symbol. */
  brainRiskNotes: BrainRiskNote[];
  /** Merged risk score (highest of structural, open-task count, brain notes). */
  mergedRiskScore: RiskTier;
  /** Human-readable narrative summarizing the combined risk. */
  narrative: string;
}

/**
 * Code anchor result for a brain memory entry.
 *
 * Returned by {@link getBrainEntryCodeAnchors}.
 */
export interface CodeAnchorResult {
  /** Brain entry ID that was queried. */
  entryId: string;
  /** Nexus nodes linked to this brain entry via code-reference edges. */
  nexusNodes: NexusNodeAnchor[];
  /** For each nexus node, which tasks touched it. */
  tasksForNodes: TasksForNodeEntry[];
  /** Sum of weights on all edges anchoring this brain entry to code. */
  plasticitySignal: number;
}

/**
 * A nexus node anchored to a brain entry.
 */
export interface NexusNodeAnchor {
  /** Nexus node ID. */
  nexusNodeId: string;
  /** Display label. */
  label: string;
  /** File path. */
  filePath: string | null;
  /** Node kind. */
  kind: string;
  /** Edge type connecting this node to the brain entry. */
  edgeType: string;
  /** Edge weight. */
  weight: number;
}

/**
 * Tasks that touched a specific nexus node.
 */
export interface TasksForNodeEntry {
  /** Nexus node ID. */
  nexusNodeId: string;
  /** Tasks that touched this node. */
  tasks: LbTaskRef[];
}
