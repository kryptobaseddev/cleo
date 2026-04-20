/**
 * Intelligence Domain Operations (5 operations)
 *
 * Query operations: 5
 * Mutate operations: 0 (intelligence is read-only; writes happen via hooks)
 *
 * intelligence is the quality prediction and pattern matching subsystem backed by
 * brain.db + tasks.db. It surfaces risk scoring, validation outcome prediction,
 * error pattern extraction, confidence scoring, and pattern matching for verified
 * tasks. All operations are read-only query operations at the domain level.
 *
 * Distinct from other analysis domains — intelligence focuses on predictive
 * signals derived from task history, brain patterns, and learnings.
 *
 * SYNC: Canonical implementations at packages/core/src/intelligence/*.
 * Wire-format types live here; they are the contract for CLI + HTTP dispatch.
 *
 * @task T980 — Orchestration Contract Completion
 * @task T549 — Intelligence Domain Architecture
 * @see packages/cleo/src/dispatch/domains/intelligence.ts
 * @see packages/core/src/intelligence/types.ts
 */

// ============================================================================
// Risk Factor and Assessment Types (shared)
// ============================================================================

/**
 * A single factor contributing to a task's overall risk score.
 *
 * Each factor has a weight (how much it matters) and a value (current level, 0-1).
 * The weighted sum of all factors produces the aggregate risk score.
 */
export interface IntelligenceRiskFactor {
  /** Human-readable factor name (e.g., "complexity", "blocking_risk"). */
  name: string;
  /** How much this factor contributes to the total score (0-1). */
  weight: number;
  /** Current measured value for this factor (0-1, where 1 = highest risk). */
  value: number;
  /** Explanation of why this factor has its current value. */
  description: string;
}

/**
 * Complete risk assessment for a single task.
 *
 * Returned by `intelligence.predict` (no stage). The `riskScore` is the weighted
 * aggregate of all risk factors.
 */
export interface IntelligenceRiskAssessment {
  /** The task ID this assessment applies to. */
  taskId: string;
  /** Aggregate risk score (0-1, where 1 = highest risk). */
  riskScore: number;
  /** Confidence in the assessment (0-1). Higher when more data is available. */
  confidence: number;
  /** Individual risk factors that contributed to the score. */
  factors: IntelligenceRiskFactor[];
  /** Human-readable recommendation based on the risk level. */
  recommendation: string;
}

// ============================================================================
// Validation Prediction Types (shared)
// ============================================================================

/**
 * Predicted outcome for a lifecycle validation gate.
 *
 * Returned by `intelligence.predict` (with stage). Combines historical
 * pattern data with the task's current state to estimate pass likelihood.
 */
export interface IntelligenceValidationPrediction {
  /** The task ID being evaluated. */
  taskId: string;
  /** The lifecycle stage being predicted (e.g., "specification", "implementation"). */
  stage: string;
  /** Probability of passing the gate (0-1). */
  passLikelihood: number;
  /** Known blockers that may prevent passing. */
  blockers: string[];
  /** Actionable suggestions to improve pass likelihood. */
  suggestions: string[];
}

// ============================================================================
// Gate Focus and Validation Suggestion Types (shared)
// ============================================================================

/**
 * A single gate focus recommendation (priority-ordered).
 *
 * Produced by `intelligence.suggest` to guide which verification gates
 * should receive focus during review.
 */
export interface IntelligenceGateFocusRecommendation {
  /** Gate name (e.g., "implemented", "testsPassed", "documented"). */
  gateName: string;
  /** Priority level (1 = highest, 5 = lowest). */
  priority: number;
  /** Why this gate is recommended for focus. */
  reason: string;
  /** Estimated difficulty to pass (0-1, where 1 = most difficult). */
  estimatedDifficulty: number;
  /** Actionable tips to pass this gate. */
  tips: string[];
}

/**
 * Adaptive validation suggestion set for a task.
 *
 * Returned by `intelligence.suggest`. Includes ordered gate recommendations
 * and actionable tips to improve verification likelihood.
 */
export interface IntelligenceAdaptiveValidationSuggestion {
  /** Task ID this suggestion applies to. */
  taskId: string;
  /** Ordered gate recommendations (highest priority first). */
  gateFocus: IntelligenceGateFocusRecommendation[];
  /** Overall confidence that the task will pass all required gates. */
  overallConfidence: number;
  /**
   * Actionable tips derived from gate focus analysis.
   * Includes failure-pattern mitigations where available.
   */
  tips: string[];
}

// ============================================================================
// Verification Confidence Score Types (shared)
// ============================================================================

/**
 * A single verification gate result (passed/failed with metadata).
 */
export interface IntelligenceVerificationGate {
  /** Gate name (e.g., "implemented", "testsPassed"). */
  gateName: string;
  /** Whether this gate passed. */
  passed: boolean;
  /** ISO 8601 timestamp of gate evaluation. */
  evaluatedAt: string;
  /** Optional failure reason if gate did not pass. */
  failureReason?: string;
}

/**
 * Result of scoring and evaluating a completed verification round.
 *
 * Returned by `intelligence.confidence`. Includes confidence score,
 * pass/fail status, and detailed gate breakdown.
 */
export interface IntelligenceVerificationConfidenceScore {
  /** Task ID. */
  taskId: string;
  /**
   * Computed confidence score (0-1).
   *
   * Score derivation:
   *   - Gates passed vs required gates: up to 0.6
   *   - Failure log length (fewer failures = higher confidence): up to 0.2
   *   - Round number (fewer rounds = higher confidence): up to 0.2
   */
  confidenceScore: number;
  /** Whether the overall verification passed. */
  passed: boolean;
  /** IDs of gates that passed. */
  gatesPassed: IntelligenceVerificationGate[];
  /** IDs of gates that failed. */
  gatesFailed: IntelligenceVerificationGate[];
  /** Current verification round number. */
  round: number;
  /** Count of failures logged for this task. */
  failureCount: number;
}

// ============================================================================
// Pattern Types (shared)
// ============================================================================

/**
 * A pattern automatically detected from historical brain/task data.
 *
 * Detected patterns may be stored in the existing brain_patterns table
 * if they meet frequency and confidence thresholds.
 */
export interface IntelligenceDetectedPattern {
  /** Pattern type classification. */
  type: 'workflow' | 'blocker' | 'success' | 'failure' | 'optimization';
  /** Human-readable pattern description. */
  pattern: string;
  /** Context in which the pattern was observed. */
  context: string;
  /** How many times this pattern was observed. */
  frequency: number;
  /** Success rate when this pattern appears (0-1, null if unknown). */
  successRate: number | null;
  /** Estimated impact level. */
  impact: 'low' | 'medium' | 'high';
  /** If this is an anti-pattern, describe the negative behavior. */
  antiPattern: string | null;
  /** Recommended mitigation for anti-patterns. */
  mitigation: string | null;
  /** Example task IDs or descriptions where this pattern occurred. */
  examples: string[];
  /** Confidence in this pattern's validity (0-1). */
  confidence: number;
}

/**
 * Result of matching a task against known patterns from brain_patterns.
 *
 * Includes the original pattern and a relevance score indicating
 * how strongly the pattern applies to the target task.
 */
export interface IntelligencePatternMatch {
  /** The matched pattern data. */
  pattern: IntelligenceDetectedPattern;
  /** How relevant this pattern is to the target task (0-1). */
  relevanceScore: number;
  /** Why this pattern was matched. */
  matchReason: string;
  /** Whether this is an anti-pattern match (warns about potential issues). */
  isAntiPattern: boolean;
}

// ============================================================================
// Query Operations
// ============================================================================

// --------------------------------------------------------------------------
// intelligence.predict → risk scoring or validation outcome prediction
// --------------------------------------------------------------------------

/**
 * Parameters for `intelligence.predict`.
 *
 * @remarks
 * When `stage` is omitted, returns risk assessment. When `stage` is provided,
 * returns validation outcome prediction for that lifecycle stage.
 */
export interface IntelligencePredictParams {
  /** Task ID to assess (required). */
  taskId: string;
  /** Lifecycle stage for validation prediction (optional). When omitted, performs risk assessment. */
  stage?: string;
}

/**
 * Result of `intelligence.predict`.
 *
 * Union of risk assessment (no stage) or validation prediction (with stage).
 */
export type IntelligencePredictResult =
  | IntelligenceRiskAssessment
  | IntelligenceValidationPrediction;

// --------------------------------------------------------------------------
// intelligence.suggest → gate focus recommendations
// --------------------------------------------------------------------------

/**
 * Parameters for `intelligence.suggest`.
 *
 * @remarks
 * Requires a task ID. Returns prioritized gate focus recommendations
 * to guide which verification gates should receive attention.
 */
export interface IntelligenceSuggestParams {
  /** Task ID to generate suggestions for (required). */
  taskId: string;
}

/**
 * Result of `intelligence.suggest`.
 */
export type IntelligenceSuggestResult = IntelligenceAdaptiveValidationSuggestion;

// --------------------------------------------------------------------------
// intelligence.learn-errors → extract patterns from history
// --------------------------------------------------------------------------

/**
 * Parameters for `intelligence.learn-errors`.
 *
 * @remarks
 * Optional limit parameter to cap the number of patterns returned.
 * Returns detected patterns across all pattern types (workflow, blocker,
 * success, failure, optimization).
 */
export interface IntelligenceLearnErrorsParams {
  /** Maximum number of patterns to return. Default: 50. */
  limit?: number;
}

/**
 * Result of `intelligence.learn-errors`.
 */
export type IntelligenceLearnErrorsResult = IntelligenceDetectedPattern[];

// --------------------------------------------------------------------------
// intelligence.confidence → verification confidence scoring
// --------------------------------------------------------------------------

/**
 * Parameters for `intelligence.confidence`.
 *
 * @remarks
 * Requires a task ID. Returns a confidence score based on the task's
 * current verification state, including gate pass/fail status and
 * historical failure patterns.
 */
export interface IntelligenceConfidenceParams {
  /** Task ID to score confidence for (required). */
  taskId: string;
}

/**
 * Result of `intelligence.confidence`.
 */
export type IntelligenceConfidenceResult = IntelligenceVerificationConfidenceScore;

// --------------------------------------------------------------------------
// intelligence.match → pattern matching
// --------------------------------------------------------------------------

/**
 * Parameters for `intelligence.match`.
 *
 * @remarks
 * Requires a task ID. Returns all known patterns from brain_patterns
 * that are relevant to this task, sorted by relevance descending.
 */
export interface IntelligenceMatchParams {
  /** Task ID to match patterns against (required). */
  taskId: string;
}

/**
 * Result of `intelligence.match`.
 */
export type IntelligenceMatchResult = IntelligencePatternMatch[];

// ============================================================================
// Discriminated Union (TypedDomainHandler integration)
// ============================================================================

/**
 * Operation name literal union for the intelligence domain.
 *
 * @remarks
 * Used by TypedDomainHandler<IntelligenceOps> to dispatch to handler methods.
 */
export type IntelligenceOp =
  | 'intelligence.predict'
  | 'intelligence.suggest'
  | 'intelligence.learn-errors'
  | 'intelligence.confidence'
  | 'intelligence.match';

/**
 * Discriminated union of all intelligence domain operations.
 *
 * @remarks
 * Consumed by packages/cleo/src/dispatch/domains/intelligence.ts via
 * TypedDomainHandler<IntelligenceOps>.
 *
 * Each operation carries its own params and result types. The query gateway
 * uses this union to type-narrow dispatch based on the operation name.
 *
 * @task T980 — Orchestration Contract Completion
 */
export type IntelligenceOps =
  | {
      op: 'intelligence.predict';
      params: IntelligencePredictParams;
      result: IntelligencePredictResult;
    }
  | {
      op: 'intelligence.suggest';
      params: IntelligenceSuggestParams;
      result: IntelligenceSuggestResult;
    }
  | {
      op: 'intelligence.learn-errors';
      params: IntelligenceLearnErrorsParams;
      result: IntelligenceLearnErrorsResult;
    }
  | {
      op: 'intelligence.confidence';
      params: IntelligenceConfidenceParams;
      result: IntelligenceConfidenceResult;
    }
  | {
      op: 'intelligence.match';
      params: IntelligenceMatchParams;
      result: IntelligenceMatchResult;
    };
