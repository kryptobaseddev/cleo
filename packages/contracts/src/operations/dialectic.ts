/**
 * Wire-format contracts for the Dialectic Evaluator SDK operations.
 *
 * Exported types describe the parameter and result shapes for the
 * two primary dialectic evaluation functions shipped in T1087 (PSYCHE Wave 3).
 * They follow the same contract pattern as the rest of @cleocode/contracts/operations/.
 *
 * Operations:
 *   evaluateDialectic — analyse a single user↔system turn and extract insights
 *   applyInsights     — persist extracted insights to nexus.db and brain.db
 *
 * Design constraints (ADR-055 / D028 boundary rules):
 *  - Lives in `packages/contracts/` — ZERO runtime dependencies.
 *  - Consumed by `packages/core/src/memory/dialectic-evaluator.ts` and the CQRS
 *    dispatcher hook in `packages/cleo/src/dispatch/dispatcher.ts`.
 *  - No cross-package relative imports.
 *
 * @task T1087
 * @task T1088
 * @epic T1082
 */

// ============================================================================
// Core domain types
// ============================================================================

/**
 * A single conversational turn passed to the Dialectic Evaluator.
 *
 * Represents one exchange between a user and the system.  Both sides are
 * required so the evaluator can reason about what was asked, what the system
 * inferred, and whether any behavioural traits or session-level insights can
 * be extracted.
 *
 * @example
 * ```ts
 * const turn: DialecticTurn = {
 *   userMessage:    "always reuse existing helpers before creating new ones",
 *   systemResponse: "understood — I found `buildRetrievalBundle` which covers your case.",
 *   activePeerId:   "cleo-prime",
 *   sessionId:      "ses_20260422131135_5149eb",
 * };
 * ```
 */
export interface DialecticTurn {
  /** Raw text of the user's message in this turn. */
  userMessage: string;
  /** Raw text of the system's response in this turn. */
  systemResponse: string;
  /**
   * The CANT agent peer ID that is active for this turn.
   * Matches `PeerIdentity.peerId` from `packages/contracts/src/peer.ts`.
   * Defaults to `"global"` when no peer context is available.
   */
  activePeerId: string;
  /** Session ID from the CLEO session store (e.g. `ses_20260422131135_5149eb`). */
  sessionId: string;
}

/**
 * Structured insights extracted from a single dialectic turn.
 *
 * The Dialectic Evaluator populates this after analysing a conversational turn.
 * It is then consumed by `applyInsights` to route each sub-array to the
 * correct storage backend.
 *
 * Routing summary:
 *  - `globalTraits`     → `upsertUserProfileTrait` (nexus.db user_profile table)
 *  - `peerInsights`     → `observeBrain` with `peerId` set + source `"dialectic:<sessionId>"`
 *  - `sessionNarrativeDelta` → `appendNarrativeDelta` in session-narrative.ts
 */
export interface DialecticInsights {
  /**
   * User-level behavioural traits extracted from the turn.
   *
   * These are global, session-independent facts about the user — e.g.
   * "prefers-zero-deps", "verbose-git-logs".  Persisted to the user_profile
   * table in nexus.db via `upsertUserProfileTrait` (Wave 1).
   */
  globalTraits: Array<{
    /** Stable semantic key for the trait (kebab-case). */
    key: string;
    /** JSON-serialisable value string. */
    value: string;
    /** Bayesian confidence in [0.0, 1.0]. */
    confidence: number;
  }>;

  /**
   * Peer-scoped insights relevant only to the active CANT agent.
   *
   * Persisted to brain.db via `observeBrain` with the `peerId` field set
   * to the originating peer and `sourceType` set to `"dialectic"`.
   */
  peerInsights: Array<{
    /** Observation key or short title. */
    key: string;
    /** Observation detail text (max ~300 chars). */
    value: string;
    /** Peer the insight belongs to (copied from `DialecticTurn.activePeerId`). */
    peerId: string;
    /** Bayesian confidence in [0.0, 1.0]. */
    confidence: number;
  }>;

  /**
   * Short narrative description of what happened in this turn.
   *
   * Appended to the rolling `session_narrative` table via `appendNarrativeDelta`.
   * Omit (or leave undefined) when the turn has no meaningful narrative content
   * (e.g. short ack messages).
   *
   * Max length: 500 chars.
   */
  sessionNarrativeDelta?: string;
}

// ============================================================================
// Params / Result types (for registry-driven dispatch surface)
// ============================================================================

/**
 * Parameters for the `evaluateDialectic` SDK function.
 *
 * Wraps `DialecticTurn` in the standard params envelope so that the operation
 * can be registered in the dispatch registry if needed in the future.
 */
export interface EvaluateDialecticParams {
  /** The conversational turn to evaluate. */
  turn: DialecticTurn;
}

/**
 * Result returned by `evaluateDialectic`.
 *
 * Contains the extracted insights ready for downstream persistence.
 */
export interface EvaluateDialecticResult {
  /** Extracted insights from the evaluated turn. */
  insights: DialecticInsights;
  /** Name of the LLM backend that was used, or `"stub"` when no backend was available. */
  backend: 'anthropic' | 'ollama' | 'transformers' | 'stub';
}

/**
 * Parameters for the `applyInsights` SDK function.
 */
export interface ApplyInsightsParams {
  /** Insights to persist (produced by `evaluateDialectic`). */
  insights: DialecticInsights;
  /** Session ID used to build the `dialectic:<sessionId>` source tag. */
  sessionId: string;
  /** The CANT agent peer ID that produced these insights. */
  activePeerId: string;
}

/**
 * Result returned by `applyInsights`.
 */
export interface ApplyInsightsResult {
  /** Number of global traits upserted to nexus.db user_profile. */
  globalTraitsApplied: number;
  /** Number of peer insights stored to brain.db. */
  peerInsightsApplied: number;
  /** Whether a session narrative entry was written. */
  narrativeDeltaApplied: boolean;
}
