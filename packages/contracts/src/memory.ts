/**
 * Memory bridge types for CLEO provider adapters.
 * Defines the shape of .cleo/memory-bridge.md content for cross-provider memory sharing.
 *
 * @task T5240
 */

// ============================================================================
// Dispatch Trace
// ============================================================================

/**
 * Telemetry record emitted at the agent-resolver decision point for every
 * successful resolution.
 *
 * Persisted to BRAIN via `verifyAndStore` with `memoryType='procedural'` and
 * `sourceConfidence='speculative'` (tier-2 training candidate). The record
 * is never written for resolutions that throw `AgentNotFoundError` — only
 * successful (including universal-fallback) resolutions are traced.
 *
 * Fields map 1-to-1 with `ResolvedAgent` metadata so operators can correlate
 * classifier output with registry outcomes across sessions.
 *
 * @task T1325
 */
export interface DispatchTrace {
  /** Task ID that triggered the resolution (passed through from the caller). */
  taskId: string;
  /** Agent ID that was predicted / requested by the classifier. */
  predictedAgentId: string;
  /**
   * Caller-supplied confidence score for the agent prediction (0.0–1.0).
   * Set to 0 when no classifier confidence is available (e.g. direct spawn).
   */
  confidence: number;
  /** Human-readable reason for the resolution outcome (tier hit, fallback path, etc.). */
  reason: string;
  /** `true` when the agent row was found in a registry tier (project/global/packaged). */
  registryHit: boolean;
  /**
   * `true` when the universal-base fallback (tier 5) was engaged because every
   * prior tier missed. Correlates with `ResolvedAgent.resolverWarning` being set.
   */
  fallbackUsed: boolean;
  /**
   * Structured warning message copied from `ResolvedAgent.resolverWarning` when
   * the universal-base fallback was engaged.
   *
   * `undefined` when `fallbackUsed` is `false`.
   */
  resolverWarning?: string;
  /** ISO 8601 timestamp at which the resolution completed. */
  resolvedAt: string;
}

export interface MemoryBridgeConfig {
  /** Maximum number of recent observations to include in the bridge. */
  maxObservations: number;
  /** Maximum number of key learnings to include. */
  maxLearnings: number;
  /** Maximum number of patterns (follow/avoid) to include. */
  maxPatterns: number;
  /** Maximum number of recent decisions to include. */
  maxDecisions: number;
  /** Whether to include the last session handoff summary. */
  includeHandoff: boolean;
  /** Whether to include anti-patterns alongside follow-patterns. */
  includeAntiPatterns: boolean;
}

/**
 * Structured content of the `.cleo/memory-bridge.md` file.
 *
 * @remarks
 * The memory bridge is auto-generated from brain.db and provides cross-session
 * memory context to agents. It is refreshed on session end, task completion,
 * and explicit `cleo refresh-memory` invocations.
 */
export interface MemoryBridgeContent {
  /** ISO 8601 timestamp of when this bridge content was generated. */
  generatedAt: string;
  /**
   * Summary of the most recent session.
   *
   * @defaultValue undefined
   */
  lastSession?: SessionSummary;
  /** Key learnings extracted from brain.db observations. */
  learnings: BridgeLearning[];
  /** Patterns to follow, identified from recurring successful outcomes. */
  patterns: BridgePattern[];
  /** Anti-patterns to avoid, identified from recurring failures. */
  antiPatterns: BridgePattern[];
  /** Recent decisions made during sessions. */
  decisions: BridgeDecision[];
  /** Most recent observations from brain.db. */
  recentObservations: BridgeObservation[];
}

/**
 * Summary of a completed session for the memory bridge.
 *
 * @remarks
 * Captures the essential outcomes of a session so subsequent sessions
 * can pick up where the previous one left off.
 */
export interface SessionSummary {
  /** Unique identifier of the summarized session. */
  sessionId: string;
  /** ISO 8601 date when the session occurred. */
  date: string;
  /** Task IDs that were completed during this session. */
  tasksCompleted: string[];
  /** Key decisions made during this session. */
  decisions: string[];
  /** Suggested next actions for the following session. */
  nextSuggested: string[];
}

/**
 * A key learning extracted from brain.db for the memory bridge.
 *
 * @remarks
 * Learnings are observations that have been validated or reinforced across
 * multiple sessions, with a confidence score reflecting their reliability.
 */
export interface BridgeLearning {
  /** Brain.db entry identifier (e.g. `"L-abc123"`). */
  id: string;
  /** Human-readable learning text. */
  text: string;
  /** Confidence score from 0.0 to 1.0. */
  confidence: number;
}

/**
 * A recurring pattern identified in brain.db entries.
 *
 * @remarks
 * Patterns are classified as either `"follow"` (positive patterns to repeat)
 * or `"avoid"` (anti-patterns to prevent).
 */
export interface BridgePattern {
  /** Brain.db entry identifier (e.g. `"P-abc123"`). */
  id: string;
  /** Human-readable pattern description. */
  text: string;
  /** Whether this is a pattern to follow or avoid. */
  type: 'follow' | 'avoid';
}

/**
 * A decision recorded in brain.db for the memory bridge.
 *
 * @remarks
 * Decisions are high-signal observations that capture architectural or
 * process choices made during sessions.
 */
export interface BridgeDecision {
  /** Brain.db entry identifier (e.g. `"D-abc123"`). */
  id: string;
  /** Short title summarizing the decision. */
  title: string;
  /** ISO 8601 date when the decision was made. */
  date: string;
}

/**
 * A recent observation from brain.db for the memory bridge.
 *
 * @remarks
 * Observations are the raw input to the brain memory system. Only the most
 * recent ones are included in the bridge to keep token cost low.
 */
export interface BridgeObservation {
  /** Brain.db entry identifier (e.g. `"O-abc123"`). */
  id: string;
  /** ISO 8601 date when the observation was recorded. */
  date: string;
  /** Truncated summary of the observation content. */
  summary: string;
}
