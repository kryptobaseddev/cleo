/**
 * Type definitions for the CLEO Intelligence dimension.
 *
 * Covers quality prediction (risk scoring, validation outcome prediction),
 * pattern extraction (automatic detection, matching, storage), and
 * impact analysis (blast radius, change prediction).
 *
 * @task Wave3A
 * @epic T5149
 * @module intelligence
 */

import type { BrainLearningRow, BrainPatternRow } from '../store/memory-schema.js';

// ============================================================================
// Risk Scoring Types
// ============================================================================

/**
 * A single factor contributing to a task's overall risk score.
 *
 * Each factor has a weight (how much it matters) and a value (current level, 0-1).
 * The weighted sum of all factors produces the aggregate risk score.
 */
export interface RiskFactor {
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
 * Returned by {@link calculateTaskRisk}. The `riskScore` is the weighted
 * aggregate of all {@link RiskFactor} entries in `factors`.
 */
export interface RiskAssessment {
  /** The task ID this assessment applies to. */
  taskId: string;
  /** Aggregate risk score (0-1, where 1 = highest risk). */
  riskScore: number;
  /** Confidence in the assessment (0-1). Higher when more data is available. */
  confidence: number;
  /** Individual risk factors that contributed to the score. */
  factors: RiskFactor[];
  /** Human-readable recommendation based on the risk level. */
  recommendation: string;
}

/**
 * Predicted outcome for a lifecycle validation gate.
 *
 * Returned by {@link predictValidationOutcome}. Combines historical
 * pattern data with the task's current state to estimate pass likelihood.
 */
export interface ValidationPrediction {
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
// Pattern Extraction Types
// ============================================================================

/**
 * A pattern automatically detected from historical brain/task data.
 *
 * Detected patterns may be stored in the existing brain_patterns table
 * if they meet frequency and confidence thresholds.
 */
export interface DetectedPattern {
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
 * Includes the original pattern row and a relevance score indicating
 * how strongly the pattern applies to the target task.
 */
export interface PatternMatch {
  /** The matched brain_patterns row. */
  pattern: BrainPatternRow;
  /** How relevant this pattern is to the target task (0-1). */
  relevanceScore: number;
  /** Why this pattern was matched. */
  matchReason: string;
  /** Whether this is an anti-pattern match (warns about potential issues). */
  isAntiPattern: boolean;
}

/**
 * Options for pattern extraction from historical data.
 */
export interface PatternExtractionOptions {
  /** Minimum number of occurrences to consider something a pattern. Default: 2. */
  minFrequency?: number;
  /** Minimum confidence threshold (0-1). Default: 0.3. */
  minConfidence?: number;
  /** Maximum number of patterns to return. Default: 50. */
  limit?: number;
  /** Filter by pattern type. */
  type?: DetectedPattern['type'];
}

/**
 * Result of updating pattern statistics after an outcome.
 */
export interface PatternStatsUpdate {
  /** The pattern ID that was updated. */
  patternId: string;
  /** New frequency value. */
  newFrequency: number;
  /** New success rate (0-1). */
  newSuccessRate: number | null;
  /** Whether the outcome was successful. */
  outcomeSuccess: boolean;
}

/**
 * Summary of applicable learnings for a task, used in prediction.
 */
export interface LearningContext {
  /** Learnings that apply to this task's context. */
  applicable: BrainLearningRow[];
  /** Average confidence of applicable learnings. */
  averageConfidence: number;
  /** Count of actionable learnings. */
  actionableCount: number;
}

// ============================================================================
// Impact Assessment
// ============================================================================

/**
 * Full impact assessment for a task within its dependency graph.
 *
 * Captures direct dependents, transitive dependents, lifecycle pipeline
 * effects, blocked work counts, and critical path membership.
 */
export interface ImpactAssessment {
  /** The task being assessed. */
  taskId: string;

  /** Tasks that directly depend on this task. */
  directDependents: string[];

  /** All downstream tasks (direct + transitive). */
  transitiveDependents: string[];

  /** Epic IDs whose lifecycle pipelines are affected. */
  affectedPipelines: string[];

  /** Count of tasks that would be blocked if this task is not completed. */
  blockedWorkCount: number;

  /** Whether this task lies on the project's critical path. */
  isOnCriticalPath: boolean;

  /** Quantified scope of the impact. */
  blastRadius: BlastRadius;
}

// ============================================================================
// Change Impact
// ============================================================================

/** The type of change being analyzed. */
export type ChangeType = 'cancel' | 'block' | 'complete' | 'reprioritize';

/**
 * Predicted downstream effects of a specific change to a task.
 *
 * Models what happens when a task is cancelled, blocked, completed,
 * or reprioritized -- including cascading status changes and
 * recommendations.
 */
export interface ChangeImpact {
  /** The task being changed. */
  taskId: string;

  /** The type of change being analyzed. */
  changeType: ChangeType;

  /** Tasks affected by this change, with predicted new status. */
  affectedTasks: AffectedTask[];

  /** Maximum depth of cascading effects in the dependency graph. */
  cascadeDepth: number;

  /** Human-readable recommendation based on the analysis. */
  recommendation: string;
}

/**
 * A single task affected by a change, with its predicted new state.
 */
export interface AffectedTask {
  /** Task ID. */
  id: string;

  /** Task title. */
  title: string;

  /** Current status before the change. */
  currentStatus: string;

  /** Predicted new status after the change (if it would change). */
  newStatus?: string;

  /** Why this task is affected. */
  reason: string;
}

// ============================================================================
// Impact Prediction (free-text change description)
// ============================================================================

/**
 * A single task predicted to be affected by a free-text change description.
 *
 * Produced by {@link predictImpact} after matching candidate tasks against
 * the change description and running downstream dependency analysis.
 */
export interface ImpactedTask {
  /** Task ID. */
  id: string;

  /** Task title. */
  title: string;

  /** Current task status. */
  status: string;

  /** Current task priority. */
  priority: string;

  /**
   * Severity estimate for this task's exposure to the change.
   *
   * - `direct` — task title/description matched the change description
   * - `dependent` — task depends on a matched task
   * - `transitive` — downstream of a dependent via the dependency graph
   */
  exposure: 'direct' | 'dependent' | 'transitive';

  /**
   * Number of downstream tasks that depend on this task.
   * Higher values indicate higher cascading risk.
   */
  downstreamCount: number;

  /** Why this task is predicted to be affected. */
  reason: string;
}

/**
 * Full impact prediction report for a free-text change description.
 *
 * Returned by {@link predictImpact}. Combines fuzzy task search with
 * reverse dependency analysis to enumerate which tasks are at risk.
 */
export interface ImpactReport {
  /** The original free-text change description. */
  change: string;

  /**
   * Tasks directly matched by the change description (fuzzy search).
   * These are the "seed" tasks from which downstream impact is traced.
   */
  matchedTasks: ImpactedTask[];

  /**
   * All tasks predicted to be affected, ordered by exposure severity
   * (direct first, then dependents, then transitive) and then by
   * descending downstream count.
   */
  affectedTasks: ImpactedTask[];

  /**
   * Total count of distinct affected tasks (including direct matches).
   */
  totalAffected: number;

  /**
   * Human-readable summary of predicted impact scope.
   */
  summary: string;
}

// ============================================================================
// Blast Radius
// ============================================================================

/** Severity classification for blast radius. */
export type BlastRadiusSeverity = 'isolated' | 'moderate' | 'widespread' | 'critical';

/**
 * Quantified scope of a task's impact across the project.
 */
export interface BlastRadius {
  /** Number of direct dependents. */
  directCount: number;

  /** Number of transitive dependents (full downstream tree). */
  transitiveCount: number;

  /** Number of distinct epics affected. */
  epicCount: number;

  /** Percentage of the total project impacted (0-100). */
  projectPercentage: number;

  /** Classification of impact severity. */
  severity: BlastRadiusSeverity;
}
